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
const STATS_INTERVAL = parseInt(process.env.STATS_INTERVAL || "15000", 10);

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era, uint256 reward, uint256 difficulty, uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)",
  "function balanceOf(address) view returns (uint256)",
];

// ─── Logging ──────────────────────────────────────────────────────────────────
const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
const S = (v, w) => String(v).padEnd(w);

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
const stats = {
  startTime: Date.now(),
  solutionsFound: 0,
  txSent: 0,
  txSuccess: 0,
  txFailed: 0,
  txPending: 0,
  roundsCompleted: 0,
  lastGpuHashrate: "N/A",
  gasSkipped: 0,
  lastEpoch: "",
  lastReward: "0",
  lastEra: "0",
  lastHashBal: "?",
  lastEthBal: "?",
  lastBaseGwei: "—",
};

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function printStats() {
  const uptime = formatUptime(Date.now() - stats.startTime);
  const hr = stats.lastGpuHashrate;
  const sent = stats.txSent;
  const ok = stats.txSuccess;
  const fail = stats.txFailed;
  const confirmRate = sent > 0 ? ((ok / sent) * 100).toFixed(0) : "0";

  console.log();
  console.log(`┌─────────────────────────────────────────────────────────────────┐`);
  console.log(`│  📊 MINING STATUS                                               │`);
  console.log(`├─────────────────────────────────────────────────────────────────┤`);
  console.log(`│  ⚡ Hashrate    ${S(hr, 20)}│ 🕐 Uptime   ${S(uptime, 18)}│`);
  console.log(`│  🔄 Rounds      ${S(stats.roundsCompleted, 20)}│ 🎯 Found    ${S(stats.solutionsFound, 18)}│`);
  console.log(`│  📤 TX Sent     ${S(sent, 20)}│ ✅ Confirmed ${S(ok, 18)}│`);
  console.log(`│  ❌ Failed      ${S(fail, 20)}│ ⏳ Pending   ${S(stats.txPending, 18)}│`);
  console.log(`│  ⛽ Gas-skipped ${S(stats.gasSkipped, 20)}│ 📈 Confirm % ${S(confirmRate + "%", 18)}│`);
  console.log(`├─────────────────────────────────────────────────────────────────┤`);
  console.log(`│  🪙 HASH Balance: ${S(stats.lastHashBal, 48)}│`);
  console.log(`│  💰 ETH Balance:  ${S(stats.lastEthBal, 48)}│`);
  console.log(`│  ⛽ Base Fee:     ${S(stats.lastBaseGwei, 48)}│`);
  console.log(`│  🔄 Epoch:        ${S(stats.lastEpoch || "—", 48)}│`);
  console.log(`│  🏆 Reward:       ${S(stats.lastReward + " HASH", 48)}│`);
  console.log(`└─────────────────────────────────────────────────────────────────┘`);
  console.log();
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
// Uses txProvider for send, provider for receipt (fixes Flashbots hang)
async function submitMineTx(txContract, provider, nonce, gasParams, hashHex) {
  stats.txSent++;
  stats.txPending++;

  const shortHash = hashHex.slice(0, 10) + "…";

  try {
    const tx = await txContract.mine(nonce, {
      gasLimit: GAS_LIMIT,
      type: gasParams.type,
      maxFeePerGas: gasParams.maxFeePerGas,
      maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
    });

    const shortTx = tx.hash.slice(0, 10) + "…";
    log(`📤 ${shortHash} → ${shortTx}  [etherscan.io/tx/${tx.hash}]`);

    // Wait for receipt on regular provider (not Flashbots — avoids hang)
    provider.waitForTransaction(tx.hash, 1, 120_000)
      .then((receipt) => {
        if (receipt) {
          stats.txSuccess++;
          stats.txPending--;
          log(`✅ ${shortTx} confirmed in block ${receipt.blockNumber}  [${stats.txSuccess}/${stats.txSent}]`);
        } else {
          stats.txFailed++;
          stats.txPending--;
          log(`⏭️ ${shortTx} receipt null — TX may have failed`);
        }
      })
      .catch((err) => {
        stats.txFailed++;
        stats.txPending--;
        const msg = err.shortMessage || err.message || String(err);
        if (msg.includes("InsufficientWork") || msg.includes("already mined")) {
          log(`⏭️ ${shortTx} already mined — skipped`);
        } else if (msg.includes("timeout") || msg.includes("Timed out")) {
          log(`⏱️ ${shortTx} receipt timeout — may still confirm later`);
        } else {
          log(`❌ ${shortTx} failed: ${msg.slice(0, 80)}`);
        }
      });

    return true;
  } catch (err) {
    stats.txFailed++;
    stats.txPending--;
    const msg = err.shortMessage || err.message || String(err);
    if (msg.includes("nonce")) {
      log(`⏭️ ${shortHash} nonce conflict — skipping`);
    } else {
      log(`❌ ${shortHash} TX error: ${msg.slice(0, 80)}`);
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

  console.log(`╔═══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  HASH256 Multi-GPU Miner                                        ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════════╝`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const txProvider = TX_RPC_URL !== RPC_URL
    ? new ethers.JsonRpcProvider(TX_RPC_URL, undefined, { batchMaxCount: 1 })
    : provider;
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const txWallet = new ethers.Wallet(PRIVATE_KEY, txProvider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
  const txContract = new ethers.Contract(CONTRACT_ADDRESS, ABI, txWallet);
  const binaryPath = getGpuBinary();

  // ─── Startup ────────────────────────────────────────────────────────────────
  console.log();
  log(`🔑 Wallet:  ${wallet.address}`);
  log(`📄 Contract: ${CONTRACT_ADDRESS}`);
  if (TX_RPC_URL !== RPC_URL) log(`🚀 TX RPC:  ${TX_RPC_URL}`);
  log(`⛽ Gas:     max ${MAX_GAS_GWEI} gwei | priority ${PRIORITY_FEE_GWEI} gwei`);
  log(`⚡ GPU:     Starting 1 GPU thread(s). Ctrl+C to stop.`);

  // Pre-flight
  const [balance, gasParams] = await Promise.all([
    provider.getBalance(wallet.address),
    getGasParams(provider),
  ]);

  if (balance === 0n) { log("✗ No ETH! Fund wallet."); process.exit(1); }

  try {
    const hashBal = await contract.balanceOf(wallet.address);
    stats.lastHashBal = ethers.formatUnits(hashBal, 18);
  } catch {}
  stats.lastEthBal = `${parseFloat(ethers.formatEther(balance)).toFixed(6)} ETH`;
  stats.lastBaseGwei = `${gasParams.baseGwei.toFixed(1)} gwei`;

  console.log();
  log(`🪙 HASH: ${stats.lastHashBal} | ETH: ${stats.lastEthBal}`);
  log(`⛽ Base fee: ${stats.lastBaseGwei}`);
  console.log();

  setInterval(printStats, STATS_INTERVAL);
  setTimeout(printStats, 10_000);

  // ─── Mining Loop ────────────────────────────────────────────────────────────
  while (true) {
    try {
      const [{ state, challenge }, gasParams] = await Promise.all([
        fetchChainState(contract, wallet.address),
        getGasParams(provider),
      ]);

      const difficulty = BigInt(state.difficulty.toString());
      const epoch = state.epoch.toString();
      const era = state.era.toString();
      const reward = ethers.formatUnits(state.reward, 18);

      if (epoch !== stats.lastEpoch) {
        stats.lastEpoch = epoch;
        stats.lastEra = era;
        stats.lastReward = reward;
        stats.lastBaseGwei = `${gasParams.baseGwei.toFixed(1)} gwei`;

        if (epoch !== "0") {
          console.log();
          log(`🔄 New epoch ${epoch} | Era ${era} | Reward ${reward} HASH | Difficulty ${difficulty}`);
          console.log();
        }
      }

      const challengeHex = challenge.startsWith("0x") ? challenge.slice(2) : challenge;
      const difficultyHex = difficulty.toString(16).padStart(64, "0");
      const startNonce = BigInt("0x" + crypto.randomBytes(8).toString("hex"));

      const result = await runGpuMiner(binaryPath, challengeHex, difficultyHex, startNonce);
      stats.roundsCompleted++;

      if (result.found) {
        stats.solutionsFound++;
        const nonce = BigInt(result.nonce);
        const hashHex = result.hash;

        if (gasParams.baseGwei > MAX_GAS_GWEI) {
          stats.gasSkipped++;
          const shortHash = hashHex.slice(0, 10) + "…";
          log(`⛽ ${shortHash} skipped — gas ${gasParams.baseGwei.toFixed(1)} > ${MAX_GAS_GWEI} gwei`);
        } else {
          // Pass regular provider for receipt polling (fixes Flashbots hang)
          await submitMineTx(txContract, provider, nonce, gasParams, hashHex);
        }
      }

    } catch (err) {
      const msg = err.shortMessage || err.message || String(err);
      log(`✗ Error: ${msg}`);
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }
}

// ─── Shutdown ─────────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log();
  log("🛑 Shutting down...");
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
