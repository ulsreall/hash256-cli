require("dotenv").config();

const { ethers } = require("ethers");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const os = require("os");

// ─── Config ───────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const NUM_THREADS = parseInt(process.env.THREADS || String(Math.max(1, os.cpus().length - 1)), 10);
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || "50");
const GAS_LIMIT = parseInt(process.env.GAS_LIMIT || "300000", 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "5000", 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "100000", 10);

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era, uint256 reward, uint256 difficulty, uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)",
  "function balanceOf(address) view returns (uint256)",
];

// ═════════════════════════════════════════════════════════════════════════════
// WORKER THREAD
// ═════════════════════════════════════════════════════════════════════════════
if (!isMainThread) {
  const { solidityPackedKeccak256 } = ethers;
  const { challengeHex, difficultyHex, batchSize, startNonce } = workerData;

  const difficulty = BigInt(difficultyHex);
  let nonce = BigInt(startNonce);

  for (let i = 0; ; i++) {
    const hash = solidityPackedKeccak256(
      ["bytes32", "uint256"],
      [challengeHex, nonce]
    );
    const hashNum = BigInt(hash);

    if (hashNum < difficulty) {
      parentPort.postMessage({
        found: true,
        nonce: nonce.toString(),
        hash,
      });
      process.exit(0);
    }

    nonce++;

    if ((i + 1) % batchSize === 0) {
      parentPort.postMessage({ found: false, count: batchSize });
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN THREAD
// ═════════════════════════════════════════════════════════════════════════════

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m",
  blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", white: "\x1b[37m",
};

const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
function log(emoji, color, msg) {
  console.log(`${C.dim}[${ts()}]${C.reset} ${color}${emoji} ${msg}${C.reset}`);
}

function banner() {
  const cpuCount = os.cpus().length;
  const cpuModel = os.cpus()[0]?.model || "Unknown";
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  console.log(`
${C.cyan}${C.bold}  ██╗  ██╗ █████╗ ███████╗██╗  ██╗  ${C.reset}
${C.cyan}${C.bold}  ██║  ██║██╔══██╗██╔════╝██║  ██║  ${C.reset}
${C.cyan}${C.bold}  ███████║███████║███████╗███████║  ${C.reset}
${C.cyan}${C.bold}  ██╔══██║██╔══██║╚════██║██╔══██║  ${C.reset}
${C.cyan}${C.bold}  ██║  ██║██║  ██║███████║██║  ██║  ${C.reset}
${C.cyan}${C.bold}  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝  ${C.reset}
${C.dim}  CPU Miner v3.0 · Ethereum Mainnet · hash256.org${C.reset}
${C.dim}  ${cpuCount} CPUs · ${cpuModel.trim().slice(0, 50)} · ${totalMem} GB RAM${C.reset}
`);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
const stats = {
  startTime: Date.now(),
  totalHashes: 0n,
  solutionsFound: 0,
  txSuccess: 0,
  txFailed: 0,
  _hashWindow: [],
};

function recordHashes(count) {
  stats.totalHashes += BigInt(count);
  stats._hashWindow.push({ count: BigInt(count), time: Date.now() });
  if (stats._hashWindow.length > 50) stats._hashWindow.shift();
}

function getHashrate() {
  const w = stats._hashWindow;
  if (w.length < 2) return 0;
  const first = w[0];
  const last = w[w.length - 1];
  const dt = (last.time - first.time) / 1000;
  return dt > 0 ? Number(stats.totalHashes) / dt : 0;
}

function formatDuration(ms) {
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

function formatHashrate(hps) {
  if (hps >= 1_000_000) return `${(hps / 1_000_000).toFixed(2)} MH/s`;
  if (hps >= 1_000) return `${(hps / 1_000).toFixed(2)} KH/s`;
  return `${Math.round(hps)} H/s`;
}

function printStats() {
  const uptime = formatDuration(Date.now() - stats.startTime);
  const hr = getHashrate();
  const hrStr = formatHashrate(hr);
  const load = os.loadavg();
  const sep = `${C.dim}${"─".repeat(66)}${C.reset}`;
  console.log(sep);
  console.log(
    `  ${C.cyan}⛏  Hashrate${C.white} ${hrStr.padEnd(14)}${C.dim}│${C.reset} ` +
    `${C.cyan}Hashes${C.white} ${stats.totalHashes.toLocaleString().padEnd(16)}${C.dim}│${C.reset} ` +
    `${C.cyan}Uptime${C.white} ${uptime}`
  );
  console.log(
    `  ${C.cyan}🎯 Found${C.green} ${String(stats.solutionsFound).padEnd(13)}${C.dim}│${C.reset} ` +
    `${C.cyan}TX OK${C.green} ${String(stats.txSuccess).padEnd(15)}${C.dim}│${C.reset} ` +
    `${C.cyan}TX Fail${C.red} ${stats.txFailed}`
  );
  console.log(
    `  ${C.cyan}🧵 Threads${C.white} ${String(NUM_THREADS).padEnd(12)}${C.dim}│${C.reset} ` +
    `${C.cyan}CPU Load${C.white} ${load[0].toFixed(1)} / ${load[1].toFixed(1)} / ${load[2].toFixed(1)}`
  );
  console.log(sep);
}

// ─── Validation ───────────────────────────────────────────────────────────────
function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    log("✗", C.red, "Missing RPC_URL or PRIVATE_KEY in .env");
    log("→", C.yellow, "Run: cp .env.example .env && nano .env");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length < 66) {
    log("✗", C.red, "PRIVATE_KEY must be a valid hex private key (0x + 64 hex chars)");
    process.exit(1);
  }
}

// ─── Gas Helpers ──────────────────────────────────────────────────────────────
async function checkGas(provider) {
  try {
    const feeData = await provider.getFeeData();
    return { gasGwei: parseFloat(ethers.formatUnits(feeData.gasPrice || 0n, "gwei")), gasPrice: feeData.gasPrice };
  } catch { return { gasGwei: 0, gasPrice: 0n }; }
}

async function waitForLowGas(provider, maxGwei) {
  log("⛽", C.yellow, `Gas too high — waiting for ≤ ${maxGwei} gwei...`);
  for (let i = 0; i < 120; i++) {
    await sleep(5_000);
    const { gasGwei } = await checkGas(provider);
    process.stdout.write(`${C.dim}${gasGwei.toFixed(1)}g ${C.reset}`);
    if (gasGwei <= maxGwei) {
      console.log();
      log("⛽", C.green, `Gas now ${gasGwei.toFixed(1)} gwei ✓`);
      return true;
    }
    if (i % 12 === 11) console.log();
  }
  console.log();
  log("⛽", C.yellow, `Gas still high after 10min — submitting anyway`);
  return false;
}

// ─── Multi-Thread Mining ──────────────────────────────────────────────────────
function mineMultiThread(challengeHex, difficulty) {
  return new Promise((resolve) => {
    let resolved = false;
    const workers = [];

    const stopAll = () => { for (const w of workers) { try { w.terminate(); } catch {} } };

    for (let i = 0; i < NUM_THREADS; i++) {
      const startNonce = randomNonce() + BigInt(i) * 10_000_000_000n;
      const worker = new Worker(__filename, {
        workerData: {
          challengeHex,
          difficultyHex: difficulty.toString(),
          batchSize: BATCH_SIZE,
          startNonce: startNonce.toString(),
        },
      });

      worker.on("message", (msg) => {
        if (resolved) return;
        if (msg.found) {
          resolved = true;
          stopAll();
          resolve({ found: true, nonce: msg.nonce, hash: msg.hash });
        } else {
          recordHashes(msg.count);
        }
      });

      worker.on("error", (err) => { if (!resolved) log("✗", C.red, `Worker error: ${err.message}`); });
      workers.push(worker);
    }
  });
}

// ─── Main Loop ────────────────────────────────────────────────────────────────
async function main() {
  requireEnv();
  banner();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  console.log(`${C.dim}┌─ Configuration ──────────────────────────────────────────────┐${C.reset}`);
  console.log(`${C.dim}│${C.reset}  🔑 Wallet    ${C.white}${wallet.address}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  📄 Contract  ${C.white}${CONTRACT_ADDRESS}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  🧵 Threads   ${C.white}${NUM_THREADS} / ${os.cpus().length} CPUs${C.reset}`);
  console.log(`${C.dim}│${C.reset}  ⛽ Max Gas    ${C.white}${MAX_GAS_GWEI} gwei${C.reset}`);
  console.log(`${C.dim}│${C.reset}  📦 Gas Limit  ${C.white}${GAS_LIMIT.toLocaleString()}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  🔄 Batch/Thread ${C.white}${BATCH_SIZE.toLocaleString()}${C.reset}`);
  console.log(`${C.dim}└──────────────────────────────────────────────────────────────┘${C.reset}`);
  console.log();

  const balance = await provider.getBalance(wallet.address);
  const ethBal = parseFloat(ethers.formatEther(balance));
  log("💰", C.cyan, `ETH Balance: ${C.white}${ethBal.toFixed(6)} ETH`);
  if (balance === 0n) { log("✗", C.red, "No ETH! Fund wallet first."); process.exit(1); }
  if (ethBal < 0.001) log("⚠", C.yellow, "Low ETH — may run out of gas");

  try {
    const hashBal = await contract.balanceOf(wallet.address);
    log("🪙", C.cyan, `HASH Balance: ${C.white}${ethers.formatUnits(hashBal, 18)} HASH`);
  } catch { log("🪙", C.dim, "HASH Balance: unable to fetch"); }

  const { gasGwei } = await checkGas(provider);
  log("⛽", C.cyan, `Current Gas:  ${C.white}${gasGwei.toFixed(1)} gwei`);
  console.log();
  log("⛏ ", C.green + C.bold, `Mining with ${NUM_THREADS} threads! Ctrl+C to stop.`);
  console.log();

  setInterval(printStats, 30_000);
  setTimeout(printStats, 5_000);

  let lastEpoch = "";

  while (true) {
    try {
      const state = await contract.miningState();
      const difficulty = BigInt(state.difficulty.toString());
      const era = state.era.toString();
      const reward = ethers.formatUnits(state.reward, 18);
      const epoch = state.epoch.toString();
      const minted = state.minted.toString();
      const remaining = state.remaining.toString();
      const challenge = await contract.getChallenge(wallet.address);

      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        console.log();
        log("🔄", C.blue, "New epoch · fresh challenge");
        console.log(`  ${C.dim}Era:${C.reset} ${C.white}${era}${C.reset}  ${C.dim}│${C.reset} ${C.dim}Reward:${C.reset} ${C.green}${reward} HASH${C.reset}  ${C.dim}│${C.reset} ${C.dim}Epoch:${C.reset} ${C.white}${epoch}${C.reset}`);
        console.log(`  ${C.dim}Minted:${C.reset} ${C.white}${Number(minted).toLocaleString()}${C.reset}  ${C.dim}│${C.reset} ${C.dim}Remaining:${C.reset} ${C.white}${Number(remaining).toLocaleString()}${C.reset}`);
      }

      const result = await mineMultiThread(challenge, difficulty);

      if (result.found) {
        stats.solutionsFound++;
        console.log();
        log("🎯", C.green + C.bold, `FOUND nonce: ${C.white}${result.nonce}`);
        log("   ", C.dim, `Hash: ${result.hash}`);

        const { gasGwei: currentGas } = await checkGas(provider);
        if (currentGas > MAX_GAS_GWEI) await waitForLowGas(provider, MAX_GAS_GWEI);

        try {
          const tx = await contract.mine(BigInt(result.nonce), { gasLimit: GAS_LIMIT });
          log("📤", C.blue, `TX sent: ${C.white}https://etherscan.io/tx/${tx.hash}`);
          const receipt = await tx.wait();
          stats.txSuccess++;
          log("✅", C.green + C.bold, `Block ${C.white}${receipt.blockNumber}`);
          console.log();
          try {
            const newBal = await contract.balanceOf(wallet.address);
            log("🪙", C.cyan, `HASH: ${C.white}${ethers.formatUnits(newBal, 18)} HASH`);
          } catch {}
          console.log();
        } catch (err) {
          stats.txFailed++;
          const msg = err.shortMessage || err.message || String(err);
          if (msg.includes("InsufficientWork") || msg.includes("execution reverted")) {
            log("⏭", C.yellow, "Nonce invalid — retrying...");
          } else { log("✗", C.red, `TX failed: ${msg}`); }
        }
        await sleep(1000);
      }

    } catch (err) {
      log("✗", C.red, `Error: ${err.shortMessage || err.message}`);
      await sleep(RETRY_DELAY);
    }
  }
}

function randomNonce() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return BigInt("0x" + Buffer.from(buf).toString("hex"));
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

process.on("SIGINT", () => { console.log(); log("🛑", C.yellow, "Shutting down..."); printStats(); process.exit(0); });
process.on("SIGTERM", () => { printStats(); process.exit(0); });

main().catch((err) => { log("✗", C.red, err.shortMessage || err.message || String(err)); process.exit(1); });
