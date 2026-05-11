require("dotenv").config();

const { ethers } = require("ethers");
const crypto = require("crypto");
const { ABI, CONTRACT_ADDRESS, readOptions } = require("./lib/config");
const { Stats } = require("./lib/stats");
const { GasManager } = require("./lib/gas");
const { TxManager } = require("./lib/tx-manager");
const { CpuMiner } = require("./lib/cpu-miner");
const { GpuMiner } = require("./lib/gpu-miner");
const { hashRate, shortHex } = require("./lib/format");

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

function ts() {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    console.error("✗ Missing RPC_URL or PRIVATE_KEY in .env");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length < 66) {
    console.error("✗ PRIVATE_KEY must start with 0x + 64 hex chars");
    process.exit(1);
  }
}

// ─── Find Solution (GPU → CPU fallback) ─────────────────────────────────────
async function findSolution({ challenge, difficulty, options, stats }) {
  // Try GPU first (if backend is gpu or auto)
  if (options.backend === "cuda" || options.backend === "auto") {
    const gpu = new GpuMiner({ binary: options.gpuBinary });

    if (gpu.available()) {
      try {
        const startNonce = BigInt("0x" + crypto.randomBytes(8).toString("hex"));
        const result = await gpu.search({ challenge, difficulty, startNonce });

        if (result.found !== false) {
          stats.lastGpuHashrate = result.hashrate || stats.lastGpuHashrate;
          return { backend: "gpu", nonce: result.nonce, hash: result.hash };
        }

        stats.lastGpuHashrate = result.hashrate || stats.lastGpuHashrate;
      } catch (err) {
        if (options.backend === "cuda") throw err;
        log(`⚠ GPU failed, fallback to CPU: ${err.message}`);
      }
    } else if (options.backend === "cuda") {
      throw new Error(`GPU miner not found. Run: bash build.sh`);
    }
  }

  // CPU fallback
  const cpu = new CpuMiner({
    workers: options.workers,
    batchSize: options.batchSize,
    onProgress: ({ hashrate }) => {
      stats.lastGpuHashrate = hashRate(hashrate);
    }
  });

  log(`CPU workers: ${options.workers}`);
  return cpu.search({ challenge, difficulty });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  requireEnv();
  const options = readOptions();

  console.log(`╔═══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  HASH256 Multi-GPU Miner                                        ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════════╝`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
  const stats = new Stats();

  const gasManager = new GasManager({
    provider,
    priorityFeeGwei: options.priorityFeeGwei,
    maxGasGwei: options.maxGasGwei,
    refreshMs: options.gasRefreshMs,
  });

  const txManager = new TxManager({
    contract,
    provider,
    wallet,
    gasManager,
    stats,
    options,
  });

  // ─── Startup ──────────────────────────────────────────────────────────────
  console.log();
  log(`🔑 Wallet:   ${wallet.address}`);
  log(`📄 Contract: ${CONTRACT_ADDRESS}`);
  log(`⛽ Gas:      max ${options.maxGasGwei} gwei | priority ${options.priorityFeeGwei} gwei`);
  log(`📊 Strategy: fire-and-forget × ${options.maxPending} concurrent + receipt status check`);
  log(`⚡ Backend:  ${options.backend}`);
  log(`⏱️ TX timeout: ${options.txTimeout / 1000}s`);

  // Pre-flight
  const [balance, gasParams] = await Promise.all([
    provider.getBalance(wallet.address),
    gasManager.get(),
  ]);

  if (balance === 0n) { log("✗ No ETH! Fund wallet."); process.exit(1); }

  stats.lastEthBal = `${parseFloat(ethers.formatEther(balance)).toFixed(6)} ETH`;
  stats.lastBaseGwei = `${gasParams.baseGwei.toFixed(1)} gwei`;

  try {
    const hashBal = await contract.balanceOf(wallet.address);
    stats.lastHashBal = parseFloat(ethers.formatUnits(hashBal, 18)).toFixed(1);
  } catch {}

  console.log();
  log(`🪙 HASH: ${stats.lastHashBal} | ETH: ${stats.lastEthBal}`);
  log(`⛽ Base fee: ${stats.lastBaseGwei}`);
  console.log();

  // Stats printer
  setInterval(() => stats.print(), options.statsInterval);
  setTimeout(() => stats.print(), 10_000);

  // ─── Mining Loop ──────────────────────────────────────────────────────────
  while (true) {
    try {
      // Parallel: fetch state + gas
      const [state, gasParams] = await Promise.all([
        contract.miningState(),
        gasManager.get(),
      ]);

      const difficulty = BigInt(state.difficulty.toString());
      const epoch = state.epoch.toString();
      const era = state.era.toString();
      const reward = ethers.formatUnits(state.reward, 18);
      const challenge = await contract.getChallenge(wallet.address);

      stats.lastBaseGwei = `${gasParams.baseGwei.toFixed(1)} gwei`;

      if (epoch !== stats.lastEpoch) {
        stats.lastEpoch = epoch;
        stats.lastEra = era;
        stats.lastReward = reward;

        if (epoch !== "0") {
          console.log();
          log(`🔄 New epoch ${epoch} | Era ${era} | Reward ${reward} HASH | Difficulty ${difficulty}`);
          console.log();
        }
      }

      // Find solution (GPU or CPU)
      const solution = await findSolution({ challenge, difficulty, options, stats });
      stats.roundsCompleted++;

      if (solution) {
        stats.solutionsFound++;
        const nonce = BigInt(solution.nonce);
        const hashHex = solution.hash;

        if (gasManager.isTooHigh()) {
          stats.gasSkipped++;
          const shortHash = hashHex.slice(0, 10) + "…";
          log(`⛽ ${shortHash} skipped — gas ${gasParams.baseGwei.toFixed(1)} > ${options.maxGasGwei} gwei`);
        } else {
          // Wait for slot if max pending reached
          if (stats.txPending >= options.maxPending) {
            log(`⏳ ${stats.txPending} pending TXs — waiting for slot...`);
            await txManager.waitForSlot();
          }

          // Fire-and-forget: submit TX and immediately mine next
          await txManager.fireAndForget(nonce, hashHex);
        }
      }

    } catch (err) {
      const msg = err.shortMessage || err.message || String(err);
      log(`✗ Error: ${msg}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ─── Shutdown ────────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log();
  log("🛑 Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => process.exit(0));

process.on("uncaughtException", (err) => {
  const msg = err.message || String(err);
  if (msg.includes("missing response") || msg.includes("BAD_DATA")) {
    log("⏭️ RPC batch error — continuing...");
    return;
  }
  log(`✗ Uncaught: ${msg}`);
  process.exit(1);
});

main().catch(err => {
  log(`✗ ${err.shortMessage || err.message || String(err)}`);
  process.exit(1);
});
