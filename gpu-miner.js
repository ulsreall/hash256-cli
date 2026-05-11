require("dotenv").config();

const { ethers } = require("ethers");
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ─── Config ───────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const TX_RPC_URL = process.env.TX_RPC_URL || RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || "20");
const GAS_LIMIT = parseInt(process.env.GAS_LIMIT || "300000", 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "1000", 10);
const PRIORITY_FEE_GWEI = parseFloat(process.env.PRIORITY_FEE_GWEI || "10");
const GAS_REFRESH_MS = parseInt(process.env.GAS_REFRESH_MS || "12000", 10);

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era, uint256 reward, uint256 difficulty, uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)",
  "function balanceOf(address) view returns (uint256)",
];

// ─── Logging ──────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
const stats = {
  startTime: Date.now(),
  solutionsFound: 0,
  txSuccess: 0,
  txFailed: 0,
  txPending: 0,
  roundsCompleted: 0,
  lastGpuHashrate: "N/A",
  gasSkipped: 0,
};

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function printStats() {
  const uptime = formatUptime(Date.now() - stats.startTime);
  const gpuHr = stats.lastGpuHashrate.padEnd(16);
  const rounds = String(stats.roundsCompleted).padEnd(18);
  const found = String(stats.solutionsFound).padEnd(19);
  const ok = String(stats.txSuccess).padEnd(19);
  const fail = stats.txFailed;

  console.log(`──────────────────────────────────────────────────────────────────`);
  console.log(`  ⚡️ GPU ${gpuHr}│ Rounds ${rounds}│ Uptime ${uptime}`);
  console.log(`  🎯 Found ${found}│ TX OK ${ok}│ TX Fail ${fail}`);
  if (stats.txPending > 0 || stats.gasSkipped > 0) {
    console.log(`  ⏳ Pending: ${stats.txPending}     │ ⛽ Gas-skipped: ${stats.gasSkipped}`);
  }
  console.log(`──────────────────────────────────────────────────────────────────`);
}

// ─── Validation ───────────────────────────────────────────────────────────────
function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    log("✗ Missing RPC_URL or PRIVATE_KEY in .env");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length < 66) {
    log("✗ PRIVATE_KEY must start with 0x + 64 hex chars");
    process.exit(1);
  }
}

function getGpuBinary() {
  const binPath = path.join(__dirname, "gpu-miner");
  if (fs.existsSync(binPath)) return binPath;
  log("✗ gpu-miner binary not found! Run: bash build.sh");
  process.exit(1);
}

// ─── Gas Cache ────────────────────────────────────────────────────────────────
let cachedGas = { baseGwei: 0, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, type: 2, ts: 0 };

async function refreshGas(provider) {
  try {
    const feeData = await provider.getFeeData();
    const baseFee = feeData.gasPrice || 0n;
    const baseGwei = parseFloat(ethers.formatUnits(baseFee, "gwei"));
    const priorityFee = ethers.parseUnits(PRIORITY_FEE_GWEI.toString(), "gwei");
    const maxFee = baseFee + priorityFee + priorityFee + priorityFee;

    cachedGas = { baseGwei, maxFeePerGas: maxFee, maxPriorityFeePerGas: priorityFee, type: 2, ts: Date.now() };
  } catch {}
}

async function getGasParams(provider) {
  if (Date.now() - cachedGas.ts > GAS_REFRESH_MS) await refreshGas(provider);
  return cachedGas;
}

// ─── TX Submit ────────────────────────────────────────────────────────────────
async function submitMineTx(contract, nonce, gasParams) {
  stats.txPending++;

  try {
    const tx = await contract.mine(nonce, {
      gasLimit: GAS_LIMIT,
      type: gasParams.type,
      maxFeePerGas: gasParams.maxFeePerGas,
      maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
    });

    log(`📤 TX sent: https://etherscan.io/tx/${tx.hash}`);

    tx.wait()
      .then((receipt) => {
        stats.txSuccess++;
        stats.txPending--;
        log(`✅ Confirmed in block ${receipt.blockNumber}`);
      })
      .catch((err) => {
        stats.txFailed++;
        stats.txPending--;
        const msg = err.shortMessage || err.message || String(err);
        if (msg.includes("InsufficientWork") || msg.includes("already mined")) {
          log("⏭️ Already mined — skipping");
        } else if (msg.includes("missing response") || msg.includes("BAD_DATA")) {
          log("⏭️ RPC rate limited — TX may still confirm");
        } else {
          log(`✗ TX failed: ${msg.slice(0, 100)}`);
        }
      });

    return true;
  } catch (err) {
    stats.txFailed++;
    stats.txPending--;
    const msg = err.shortMessage || err.message || String(err);
    if (msg.includes("nonce")) {
      log("⏭️ Nonce conflict — skipping");
    } else {
      log(`✗ TX error: ${msg.slice(0, 100)}`);
    }
    return false;
  }
}

// ─── Parallel RPC ────────────────────────────────────────────────────────────
async function fetchChainState(contract, walletAddr) {
  const [state, challenge] = await Promise.all([
    contract.miningState(),
    contract.getChallenge(walletAddr),
  ]);
  return { state, challenge };
}

// ─── GPU Miner ────────────────────────────────────────────────────────────────
function runGpuMiner(binaryPath, challengeHex, difficultyHex, startNonce) {
  return new Promise((resolve) => {
    const args = [challengeHex, difficultyHex, startNonce.toString()];
    execFile(binaryPath, args, { timeout: 300_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) return resolve({ found: false, error: "timeout" });

      const hrMatch = stderr.match(/⛏\s+([\d.]+)\s+(KH\/s|MH\/s|GH\/s|H\/s)/);
      if (hrMatch) stats.lastGpuHashrate = `${hrMatch[1]} ${hrMatch[2]}`;

      try {
        for (const line of stdout.trim().split("\n")) {
          const json = JSON.parse(line);
          if (json.found) return resolve(json);
        }
        resolve({ found: false });
      } catch {
        resolve({ found: false, error: "parse_error" });
      }
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  requireEnv();

  console.log(`╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  HASH256 Multi-GPU Miner                                    ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const txProvider = TX_RPC_URL !== RPC_URL
    ? new ethers.JsonRpcProvider(TX_RPC_URL, undefined, { batchMaxCount: 1 })
    : provider;
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const txWallet = new ethers.Wallet(PRIVATE_KEY, txProvider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
  const txContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, txWallet);
  const binaryPath = getGpuBinary();

  const gpuThreads = parseInt(process.env.GPU_THREADS || "1", 10);
  log(`[miner] Starting ${gpuThreads} GPU thread(s). Ctrl+C to stop.`);
  console.log();

  // Pre-flight
  const balance = await provider.getBalance(wallet.address);
  if (balance === 0n) { log("✗ No ETH! Fund wallet."); process.exit(1); }

  try {
    const hashBal = await contract.balanceOf(wallet.address);
    const ethBal = parseFloat(ethers.formatEther(balance));
    log(`🪙 HASH: ${ethers.formatUnits(hashBal, 18)} | ETH: ${ethBal.toFixed(6)}`);
  } catch {}

  if (TX_RPC_URL !== RPC_URL) log(`🚀 TX RPC: ${TX_RPC_URL}`);
  console.log();

  setInterval(printStats, 30_000);
  setTimeout(printStats, 5_000);

  let lastEpoch = "";

  while (true) {
    try {
      const [{ state, challenge }, gasParams] = await Promise.all([
        fetchChainState(contract, wallet.address),
        getGasParams(provider),
      ]);

      const difficulty = BigInt(state.difficulty.toString());
      const epoch = state.epoch.toString();

      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        const reward = ethers.formatUnits(state.reward, 18);
        const era = state.era.toString();
        console.log();
        log(`🔄 New epoch ${epoch} | Era ${era} | Reward ${reward} HASH`);
      }

      const challengeHex = challenge.startsWith("0x") ? challenge.slice(2) : challenge;
      const difficultyHex = difficulty.toString(16).padStart(64, "0");
      const startNonce = BigInt("0x" + crypto.randomBytes(8).toString("hex"));

      const result = await runGpuMiner(binaryPath, challengeHex, difficultyHex, startNonce);
      stats.roundsCompleted++;

      if (result.found) {
        stats.solutionsFound++;
        const nonce = BigInt(result.nonce);
        log(`🎯 FOUND nonce: ${nonce}`);
        log(`    Hash: ${result.hash}`);

        if (gasParams.baseGwei > MAX_GAS_GWEI) {
          stats.gasSkipped++;
          log(`⛽ Gas ${gasParams.baseGwei.toFixed(1)} > ${MAX_GAS_GWEI} gwei — skipped`);
        } else {
          await submitMineTx(txContract, nonce, gasParams);
        }
      }

    } catch (err) {
      const msg = err.shortMessage || err.message || String(err);
      log(`✗ Error: ${msg}`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
}

process.on("SIGINT", () => {
  console.log();
  log("🛑 Shutting down...");
  if (stats.txPending > 0) log(`⏳ ${stats.txPending} TXs still pending`);
  printStats();
  process.exit(0);
});

process.on("SIGTERM", () => {
  printStats();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  const msg = err.message || String(err);
  if (msg.includes("missing response") || msg.includes("BAD_DATA")) {
    log("⏭️ RPC batch error caught — continuing...");
    return; // don't crash
  }
  log(`✗ Uncaught: ${msg}`);
  process.exit(1);
});

main().catch(err => {
  log(`✗ ${err.shortMessage || err.message || String(err)}`);
  process.exit(1);
});
