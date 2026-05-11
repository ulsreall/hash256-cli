//! CUDA mining backend via native binary.
//!
//! Spawns the `hash256-cuda` binary and parses JSON output (no serde_json needed).

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use alloy::primitives::{B256, U256};
use eyre::{eyre, Result};

pub struct CudaMiner {
    binary: PathBuf,
}

impl CudaMiner {
    pub fn new() -> Result<Self> {
        let binary = find_binary()?;
        Ok(Self { binary })
    }

    pub fn available(&self) -> bool {
        self.binary.exists()
    }

    /// Run the CUDA miner binary until a solution is found or stop_flag is set.
    pub fn mine(
        &self,
        challenge: B256,
        difficulty: U256,
        _start_nonce: u64,
        stop_flag: Arc<AtomicBool>,
        attempts_counter: Arc<AtomicU64>,
    ) -> Result<Option<u64>> {
        let challenge_hex = format!("{:?}", challenge);
        let difficulty_hex = format!("0x{}", hex::encode(difficulty.to_be_bytes::<32>()));

        let mut child = Command::new(&self.binary)
            .args([&challenge_hex, &difficulty_hex, "4194304"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| eyre!("Failed to spawn CUDA miner: {e}"))?;

        let stdout = child.stdout.take().expect("piped stdout");
        let reader = BufReader::new(stdout);

        for line in reader.lines() {
            if stop_flag.load(Ordering::Relaxed) {
                let _ = child.kill();
                return Ok(None);
            }

            let line = line?;
            let line = line.trim().to_string();
            if line.is_empty() { continue; }

            // Simple JSON parsing: look for "type":"found" or "type":"progress"
            if line.contains("\"found\"") && line.contains("\"nonce\"") {
                // Extract nonce: "nonce":"12345"
                if let Some(start) = line.find("\"nonce\":\"") {
                    let rest = &line[start + 9..];
                    if let Some(end) = rest.find('"') {
                        if let Ok(nonce) = rest[..end].parse::<u64>() {
                            let _ = child.kill();
                            return Ok(Some(nonce));
                        }
                    }
                }
            } else if line.contains("\"progress\"") && line.contains("\"hashes\"") {
                // Extract hashes: "hashes":"12345"
                if let Some(start) = line.find("\"hashes\":\"") {
                    let rest = &line[start + 10..];
                    if let Some(end) = rest.find('"') {
                        if let Ok(hashes) = rest[..end].parse::<u64>() {
                            attempts_counter.fetch_add(hashes, Ordering::Relaxed);
                        }
                    }
                }
            }
        }

        let _ = child.kill();
        Ok(None)
    }
}

fn find_binary() -> Result<PathBuf> {
    if let Ok(bin) = std::env::var("CUDA_MINER_BIN") {
        let p = PathBuf::from(bin);
        if p.exists() { return Ok(p); }
    }

    let candidates = [
        "bin/hash256-cuda",
        "../bin/hash256-cuda",
        "./bin/hash256-cuda",
        "native/bin/hash256-cuda",
    ];

    for c in &candidates {
        let p = PathBuf::from(c);
        if p.exists() { return Ok(p); }
    }

    Err(eyre!("CUDA miner binary not found. Build: cd native && bash build_cuda.sh"))
}
