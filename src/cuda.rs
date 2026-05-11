//! CUDA mining backend via native binary.
//!
//! Spawns the `hash256-cuda` binary and parses JSON output.
//! Progress lines go to stderr, found lines go to stdout.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

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
        // Format challenge as 64-char hex (no 0x prefix)
        let challenge_hex = hex::encode(challenge.as_slice());
        let difficulty_hex = format!("0x{}", hex::encode(difficulty.to_be_bytes::<32>()));

        let mut child = Command::new(&self.binary)
            .args([&challenge_hex, &difficulty_hex, "4194304"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| eyre!("Failed to spawn CUDA miner: {e}"))?;

        // Spawn thread to read stderr (progress updates)
        let stderr = child.stderr.take().expect("piped stderr");
        let attempts_counter_c = Arc::clone(&attempts_counter);
        let stop_flag_c = Arc::clone(&stop_flag);

        let stderr_handle = thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if stop_flag_c.load(Ordering::Relaxed) { break; }
                if let Ok(line) = line {
                    let line = line.trim();
                    // Parse progress: {"type":"progress","hashes":"12345","hashrate":...}
                    if line.contains("\"progress\"") && line.contains("\"hashes\"") {
                        if let Some(start) = line.find("\"hashes\":\"") {
                            let rest = &line[start + 10..];
                            if let Some(end) = rest.find('"') {
                                if let Ok(hashes) = rest[..end].parse::<u64>() {
                                    attempts_counter_c.fetch_add(hashes, Ordering::Relaxed);
                                }
                            }
                        }
                    }
                }
            }
        });

        // Read stdout for found result
        let stdout = child.stdout.take().expect("piped stdout");
        let reader = BufReader::new(stdout);

        let mut result: Option<u64> = None;

        for line in reader.lines() {
            if stop_flag.load(Ordering::Relaxed) {
                let _ = child.kill();
                stderr_handle.join().ok();
                return Ok(None);
            }

            let line = line?;
            let line = line.trim().to_string();
            if line.is_empty() { continue; }

            // Parse found: {"type":"found","nonce":"12345","hash":"0x..."}
            if line.contains("\"found\"") && line.contains("\"nonce\"") {
                if let Some(start) = line.find("\"nonce\":\"") {
                    let rest = &line[start + 9..];
                    if let Some(end) = rest.find('"') {
                        if let Ok(nonce) = rest[..end].parse::<u64>() {
                            result = Some(nonce);
                            break;
                        }
                    }
                }
            }
        }

        let _ = child.kill();
        stderr_handle.join().ok();

        Ok(result)
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
