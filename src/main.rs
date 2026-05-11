use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use alloy::network::EthereumWallet;
use alloy::primitives::{address, keccak256, Address, B256, U256};
use alloy::providers::{Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use eyre::{eyre, Result};
use rand::Rng;

mod cuda;

#[cfg(feature = "gpu")]
mod gpu;

const HASH_CONTRACT_ADDRESS: Address = address!("AC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc");
const DEFAULT_RPC_URL: &str = "https://eth.llamarpc.com";
const EPOCH_BLOCKS: u64 = 100;
const EPOCH_POLL_INTERVAL: Duration = Duration::from_secs(15);
const STATS_INTERVAL: Duration = Duration::from_secs(15);
const ERA_MINTS: u64 = 100_000;

sol! {
    #[sol(rpc)]
    contract HashToken {
        function currentDifficulty() external view returns (uint256);
        function totalMints() external view returns (uint256);
        function totalMiningMinted() external view returns (uint256);
        function genesisComplete() external view returns (bool);
        function getChallenge(address miner) external view returns (bytes32);
        function epochBlocksLeft() external view returns (uint256);
        function currentReward() external view returns (uint256);
        function miningState() external view returns (
            uint256 era, uint256 reward, uint256 difficulty,
            uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft
        );
        function mine(uint256 nonce) external;
        function balanceOf(address) external view returns (uint256);
    }
}

// ─── Stats ────────────────────────────────────────────────────────────────────
struct Stats {
    tx_sent: u64,
    tx_mined: u64,
    tx_reverted: u64,
    tx_failed: u64,
    tx_pending: u64,
    gas_skipped: u64,
    session_attempts: u64,
    session_success: u64,
    session_start: Instant,
    last_hashrate: String,
}

impl Stats {
    fn new() -> Self {
        Self {
            tx_sent: 0, tx_mined: 0, tx_reverted: 0, tx_failed: 0,
            tx_pending: 0, gas_skipped: 0, session_attempts: 0,
            session_success: 0, session_start: Instant::now(),
            last_hashrate: "N/A".into(),
        }
    }

    fn print_panel(&self) {
        let elapsed = self.session_start.elapsed().as_secs();
        let (h, m, s) = (elapsed / 3600, (elapsed % 3600) / 60, elapsed % 60);
        let uptime = if h > 0 { format!("{}h {}m {}s", h, m, s) }
                     else if m > 0 { format!("{}m {}s", m, s) }
                     else { format!("{}s", s) };
        let success_pct = if self.tx_sent > 0 { format!("{}%", self.tx_mined * 100 / self.tx_sent) }
                          else { "0%".into() };

        println!();
        println!("┌─────────────────────────────────────────────────────────────────┐");
        println!("│  📊 MINING STATUS                                               │");
        println!("├─────────────────────────────────────────────────────────────────┤");
        println!("│  ⚡ Hashrate    {:<20}│ 🕐 Uptime   {:<18}│", self.last_hashrate, uptime);
        println!("│  📤 TX Sent     {:<20}│ ✅ Rewarded  {:<18}│", self.tx_sent, self.tx_mined);
        println!("│  ⏮️ Reverted    {:<20}│ ❌ Failed    {:<18}│", self.tx_reverted, self.tx_failed);
        println!("│  ⏳ Pending     {:<20}│ ⛽ Skipped   {:<18}│", self.tx_pending, self.gas_skipped);
        println!("│  📈 Success %   {:<51}│", success_pct);
        println!("│  🎯 Session OK  {:<51}│", self.session_success);
        println!("└─────────────────────────────────────────────────────────────────┘");
        println!();
    }
}

// ─── CPU Mining ───────────────────────────────────────────────────────────────
#[inline]
fn check_proof(challenge: &B256, nonce: U256, difficulty: U256) -> bool {
    let mut buf = [0u8; 64];
    buf[..32].copy_from_slice(challenge.as_slice());
    buf[32..].copy_from_slice(&nonce.to_be_bytes::<32>());
    let hash = keccak256(buf);
    U256::from_be_bytes::<32>(hash.0) < difficulty
}

fn run_workers(
    challenge: B256, difficulty: U256, start_nonce: U256,
    stop_flag: Arc<AtomicBool>, attempts_counter: Arc<AtomicU64>, num_threads: usize,
) -> Option<U256> {
    let solution_slot: Mutex<Option<U256>> = Mutex::new(None);
    let stride = U256::from(num_threads);
    std::thread::scope(|s| {
        for tid in 0..num_threads {
            let stop_flag = &stop_flag;
            let attempts_counter = &attempts_counter;
            let solution_slot = &solution_slot;
            s.spawn(move || {
                let mut nonce = start_nonce + U256::from(tid);
                let mut local: u64 = 0;
                loop {
                    if check_proof(&challenge, nonce, difficulty) {
                        let mut slot = solution_slot.lock().unwrap();
                        if slot.is_none() { *slot = Some(nonce); }
                        stop_flag.store(true, Ordering::Relaxed);
                        attempts_counter.fetch_add(local, Ordering::Relaxed);
                        return;
                    }
                    nonce += stride;
                    local += 1;
                    if local & 0x3FFF == 0 {
                        attempts_counter.fetch_add(local, Ordering::Relaxed);
                        local = 0;
                        if stop_flag.load(Ordering::Relaxed) { return; }
                    }
                }
            });
        }
    });
    solution_slot.into_inner().ok().flatten()
}

fn hex_short(bytes: &[u8]) -> String {
    bytes.iter().take(8).map(|b| format!("{:02x}", b)).collect()
}

fn ts() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() % 86400;
    format!("{:02}:{:02}:{:02}", secs / 3600, (secs % 3600) / 60, secs % 60)
}

// ─── Main ─────────────────────────────────────────────────────────────────────
#[tokio::main(flavor = "multi_thread")]
async fn main() -> Result<()> {
    let _ = dotenvy::dotenv();

    println!("╔═══════════════════════════════════════════════════════════════════╗");
    println!("║  HASH256 Multi-GPU Miner  v8.0                                  ║");
    println!("╚═══════════════════════════════════════════════════════════════════╝");

    let raw_key = match std::env::var("PRIVATE_KEY") {
        Ok(v) => v,
        Err(_) => rpassword::prompt_password("Private Key: ")?,
    };
    let key_trimmed = raw_key.trim().trim_start_matches("0x");
    if key_trimmed.len() != 64 {
        return Err(eyre!("Invalid private key length (expected 64 hex chars)"));
    }
    let signer: PrivateKeySigner = key_trimmed.parse()?;
    let miner_address = signer.address();
    let wallet = EthereumWallet::from(signer);

    let rpc_url_str = std::env::var("RPC_URL").unwrap_or_else(|_| DEFAULT_RPC_URL.to_string());
    let provider = ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_http(rpc_url_str.parse()?);

    let contract = HashToken::new(HASH_CONTRACT_ADDRESS, provider.clone());

    let num_threads = std::env::var("MINER_THREADS")
        .ok().and_then(|s| s.parse::<usize>().ok())
        .unwrap_or_else(num_cpus::get);

    let priority_gwei: f64 = std::env::var("PRIORITY_GWEI")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(5.0);
    let max_gas_gwei: f64 = std::env::var("MAX_GAS_GWEI")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(50.0);
    let max_pending: u64 = std::env::var("MAX_PENDING")
        .ok().and_then(|s| s.parse().ok()).unwrap_or(2);

    let stats = Arc::new(Mutex::new(Stats::new()));
    let priority_wei = (priority_gwei * 1e9) as u128;

    // ─── Startup ──────────────────────────────────────────────────────────────
    println!();
    println!("[{}] 🔑 Wallet:   {}", ts(), miner_address);
    println!("[{}] 📄 Contract: {}", ts(), HASH_CONTRACT_ADDRESS);
    println!("[{}] ⚡ Backend:  {}", ts(), if cfg!(feature = "gpu") { "GPU (OpenCL) + CPU fallback" } else { "CPU only" });
    println!("[{}] 🧵 Threads:  {}", ts(), num_threads);
    println!("[{}] ⛽ Gas:      max {:.0} gwei | priority {:.1} gwei", ts(), max_gas_gwei, priority_gwei);
    println!("[{}] 📊 Strategy: fire-and-forget × {} concurrent + receipt status", ts(), max_pending);

    match contract.genesisComplete().call().await {
        Ok(g) if !g._0 => return Err(eyre!("Genesis not complete — mining is closed")),
        Ok(_) => println!("[{}] ✅ Genesis complete — mining is open", ts()),
        Err(e) => eprintln!("[{}] ⚠️ genesis check: {}", ts(), e),
    }

    match contract.miningState().call().await {
        Ok(s) => {
            let reward_hash = U256::from(s.reward) / U256::from(10u64.pow(18));
            println!("[{}] 🏆 Era: {} | Reward: {} HASH | Difficulty: {}", ts(), s.era, reward_hash, s.difficulty);
            println!("[{}] 📦 Minted: {} / {}", ts(), s.minted, s.minted + s.remaining);
        }
        Err(e) => eprintln!("[{}] ⚠️ miningState: {}", ts(), e),
    }

    // GPU init — try CUDA first, then OpenCL, then CPU
    let gpu_enabled = std::env::var("GPU").ok().as_deref() == Some("1");

    // Try CUDA
    let cuda_miner: Option<cuda::CudaMiner> = if gpu_enabled {
        match cuda::CudaMiner::new() {
            Ok(g) => {
                println!("[{}] 🎮 CUDA binary found", ts());
                Some(g)
            }
            Err(e) => {
                eprintln!("[{}] ⚠️ CUDA not available: {}", ts(), e);
                None
            }
        }
    } else { None };

    // Try OpenCL (fallback)
    #[cfg(feature = "gpu")]
    let gpu_miner: Option<Arc<gpu::GpuMiner>> = if cuda_miner.is_none() && gpu_enabled {
        let batch = std::env::var("GPU_BATCH").ok().and_then(|s| s.parse::<usize>().ok());
        match gpu::GpuMiner::new(batch) {
            Ok(g) => {
                println!("[{}] 🎮 OpenCL: {} (batch {})", ts(), g.device_name(), g.batch_size());
                match g.self_test() {
                    Ok(()) => println!("[{}] ✅ GPU self-test passed", ts()),
                    Err(e) => return Err(eyre!("GPU self-test FAILED: {e}")),
                }
                Some(Arc::new(g))
            }
            Err(e) => { eprintln!("[{}] ⚠️ OpenCL failed, CPU fallback: {}", ts(), e); None }
        }
    } else { None };
    #[cfg(not(feature = "gpu"))]
    let gpu_miner: Option<()> = { if gpu_enabled && cuda_miner.is_none() { eprintln!("⚠️ GPU=1 but no gpu feature"); } None };

    let backend_str = if cuda_miner.is_some() { "CUDA GPU" }
                      else if gpu_miner.is_some() { "OpenCL GPU" }
                      else { "CPU" };

    println!("[{}] 🚀 Mining backend: {}", ts(), backend_str);
    println!("[{}] ⛏️ Mining started! Ctrl+C to stop.", ts());
    println!();

    // Stats printer
    let stats_c = Arc::clone(&stats);
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(STATS_INTERVAL).await;
            stats_c.lock().unwrap().print_panel();
        }
    });

    // Shutdown
    let shutdown = Arc::new(AtomicBool::new(false));
    {
        let shutdown = Arc::clone(&shutdown);
        let stats = Arc::clone(&stats);
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                println!("\n🛑 Shutting down...");
                stats.lock().unwrap().print_panel();
                shutdown.store(true, Ordering::Relaxed);
            }
        });
    }

    // ─── Mining Loop ──────────────────────────────────────────────────────────
    while !shutdown.load(Ordering::Relaxed) {
        let block_num = match provider.get_block_number().await {
            Ok(n) => n,
            Err(e) => { eprintln!("[{}] ❌ RPC: {}", ts(), e); tokio::time::sleep(Duration::from_secs(5)).await; continue; }
        };
        let epoch = block_num / EPOCH_BLOCKS;

        let challenge = match contract.getChallenge(miner_address).call().await {
            Ok(v) => v._0,
            Err(e) => { eprintln!("[{}] ❌ Challenge: {}", ts(), e); tokio::time::sleep(Duration::from_secs(5)).await; continue; }
        };

        let difficulty = match contract.currentDifficulty().call().await {
            Ok(v) => v._0,
            Err(e) => { eprintln!("[{}] ❌ Difficulty: {}", ts(), e); tokio::time::sleep(Duration::from_secs(5)).await; continue; }
        };

        let backend = if cuda_miner.is_some() { "CUDA" } else if gpu_miner.is_some() { "OpenCL" } else { "CPU" };
        println!("[{}] ⛏️ Epoch {} | {} | Difficulty {}", ts(), epoch, backend, difficulty);
        println!("[{}]    Challenge: 0x{}...", ts(), hex_short(challenge.as_slice()));

        let start_nonce_u64: u64 = rand::thread_rng().gen();
        let start_nonce = U256::from(start_nonce_u64);

        let stop_flag = Arc::new(AtomicBool::new(false));
        let attempts_counter = Arc::new(AtomicU64::new(0));

        // Watchdog
        let watchdog = {
            let stop_flag = Arc::clone(&stop_flag);
            let attempts_counter = Arc::clone(&attempts_counter);
            let shutdown = Arc::clone(&shutdown);
            let provider = provider.clone();
            let stats = Arc::clone(&stats);
            let target_epoch = epoch;
            tokio::spawn(async move {
                let mut last_print = Instant::now();
                let mut last_attempts: u64 = 0;
                let mut last_poll = Instant::now();
                loop {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    if stop_flag.load(Ordering::Relaxed) || shutdown.load(Ordering::Relaxed) {
                        stop_flag.store(true, Ordering::Relaxed);
                        break;
                    }
                    if last_print.elapsed() >= Duration::from_secs(5) {
                        let total = attempts_counter.load(Ordering::Relaxed);
                        let delta = total.saturating_sub(last_attempts);
                        let secs = last_print.elapsed().as_secs_f64().max(0.001);
                        let rate = delta as f64 / secs;
                        stats.lock().unwrap().last_hashrate = format!("{:.2} GH/s", rate / 1e9);
                        last_attempts = total;
                        last_print = Instant::now();
                    }
                    if last_poll.elapsed() >= EPOCH_POLL_INTERVAL {
                        last_poll = Instant::now();
                        if let Ok(bn) = provider.get_block_number().await {
                            if bn / EPOCH_BLOCKS != target_epoch {
                                println!("[{}] 🔄 Epoch changed, restarting", ts());
                                stop_flag.store(true, Ordering::Relaxed);
                                break;
                            }
                        }
                    }
                }
            })
        };

        // Mine — CUDA > OpenCL > CPU
        let mining_result: Option<U256> = {
            let stop_flag = Arc::clone(&stop_flag);
            let attempts_counter = Arc::clone(&attempts_counter);

            let has_cuda = cuda_miner.is_some();
            let has_opencl = gpu_miner.is_some();

            if has_cuda {
                let stop_flag = Arc::clone(&stop_flag);
                let attempts_counter = Arc::clone(&attempts_counter);
                let res = tokio::task::spawn_blocking(move || {
                    let miner = cuda::CudaMiner::new().map_err(|e| eyre!("{e}"))?;
                    miner.mine(challenge, difficulty, start_nonce_u64, stop_flag, attempts_counter)
                }).await?;
                match res {
                    Ok(Some(nonce)) => Some(U256::from(nonce)),
                    Ok(None) => None,
                    Err(e) => { eprintln!("[{}] ❌ CUDA: {}", ts(), e); None }
                }
            } else if has_opencl {
                #[cfg(feature = "gpu")]
                {
                    let g = gpu_miner.as_ref().cloned().unwrap();
                    let stop_flag = Arc::clone(&stop_flag);
                    let attempts_counter = Arc::clone(&attempts_counter);
                    let res = tokio::task::spawn_blocking(move || {
                        g.mine(challenge, difficulty, start_nonce_u64, stop_flag, attempts_counter)
                    }).await?;
                    match res {
                        Ok(Some(nonce)) => Some(U256::from(nonce)),
                        Ok(None) => None,
                        Err(e) => { eprintln!("[{}] ❌ OpenCL: {}", ts(), e); None }
                    }
                }
                #[cfg(not(feature = "gpu"))]
                {
                    None
                }
            } else {
                tokio::task::spawn_blocking(move || {
                    run_workers(challenge, difficulty, start_nonce, stop_flag, attempts_counter, num_threads)
                }).await?
            }
        };

        stop_flag.store(true, Ordering::Relaxed);
        let _ = watchdog.await;

        let round_attempts = attempts_counter.load(Ordering::Relaxed);
        stats.lock().unwrap().session_attempts += round_attempts;

        let Some(nonce) = mining_result else { continue; };

        // Compute hash
        let mut buf = [0u8; 64];
        buf[..32].copy_from_slice(challenge.as_slice());
        buf[32..].copy_from_slice(&nonce.to_be_bytes::<32>());
        let hash_hex = format!("0x{}", hex::encode(keccak256(buf).as_slice()));

        println!();
        println!("[{}] 🎯 FOUND nonce: {}", ts(), nonce);
        println!("[{}]    Hash: {}", ts(), hash_hex);

        // Wait for TX slot
        loop {
            if stats.lock().unwrap().tx_pending < max_pending { break; }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }

        // Gas
        let max_fee_wei = match provider.get_block_by_number(Default::default(), alloy::rpc::types::BlockTransactionsKind::Hashes).await {
            Ok(Some(block)) => {
                if let Some(base) = block.header.base_fee_per_gas {
                    (base as u128) * 2 + priority_wei
                } else { (max_gas_gwei * 1e9) as u128 }
            }
            _ => (max_gas_gwei * 1e9) as u128,
        };

        // Fire-and-forget TX
        stats.lock().unwrap().tx_sent += 1;
        stats.lock().unwrap().tx_pending += 1;

        let short_hash: String = hash_hex.chars().take(10).collect();
        let contract_c = contract.clone();
        let stats_c = Arc::clone(&stats);

        tokio::spawn(async move {
            let tx = contract_c.mine(nonce)
                .max_priority_fee_per_gas(priority_wei)
                .max_fee_per_gas(max_fee_wei);

            match tx.send().await {
                Ok(pending) => {
                    let tx_hash = *pending.tx_hash();
                    let tx_str = format!("{:?}", tx_hash);
                    let short_tx: String = tx_str.chars().take(10).collect();
                    println!("[{}] 📤 {} → {}  [etherscan.io/tx/{}]",
                        ts(), short_hash, short_tx, tx_str);

                    let timeout = Duration::from_secs(60);
                    match tokio::time::timeout(timeout,
                        pending.with_required_confirmations(1).get_receipt()
                    ).await {
                        Ok(Ok(receipt)) => {
                            let mut s = stats_c.lock().unwrap();
                            s.tx_pending -= 1;
                            if receipt.status() {
                                s.tx_mined += 1;
                                println!("[{}] ✅ {} REWARDED in block {} [{}/{}]",
                                    ts(), short_tx, receipt.block_number.unwrap_or_default(),
                                    s.tx_mined, s.tx_sent);
                            } else {
                                s.tx_reverted += 1;
                                println!("[{}] ⏮️ {} REVERTED in block {} — too slow [{}/{}]",
                                    ts(), short_tx, receipt.block_number.unwrap_or_default(),
                                    s.tx_mined, s.tx_sent);
                            }
                        }
                        Ok(Err(e)) => {
                            let mut s = stats_c.lock().unwrap();
                            s.tx_pending -= 1;
                            s.tx_failed += 1;
                            println!("[{}] ❌ {} receipt error: {}", ts(), short_tx, e);
                        }
                        Err(_) => {
                            let mut s = stats_c.lock().unwrap();
                            s.tx_pending -= 1;
                            s.tx_failed += 1;
                            println!("[{}] ⏱️ {} timeout — may still confirm", ts(), short_tx);
                        }
                    }
                }
                Err(e) => {
                    let mut s = stats_c.lock().unwrap();
                    s.tx_pending -= 1;
                    s.tx_failed += 1;
                    let msg = format!("{}", e);
                    if msg.contains("nonce") {
                        println!("[{}] ⏭️ {} nonce conflict", ts(), short_hash);
                    } else {
                        let trunc: String = msg.chars().take(80).collect();
                        println!("[{}] ❌ {} error: {}", ts(), short_hash, trunc);
                    }
                }
            }
        });

        stats.lock().unwrap().session_success += 1;
    }

    stats.lock().unwrap().print_panel();
    Ok(())
}
