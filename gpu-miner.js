require("dotenv").config();

const { ethers } = require("ethers");
const { execFile } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// ─── Config ───────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || "100");
const GAS_LIMIT = parseInt(process.env.GAS_LIMIT || "300000", 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "1000", 10);
const PRIORITY_FEE_GWEI = parseFloat(process.env.PRIORITY_FEE_GWEI || "3");

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era, uint256 reward, uint256 difficulty, uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)",
  "function balanceOf(address) view returns (uint256)",
];

// ─── Colors & Logging ─────────────────────────────────────────────────────────
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
  const cpuModel = os.cpus()[0]?.model || "Unknown";
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
  console.log(`
${C.cyan}${C.bold}  ██╗  ██╗ █████╗ ███████╗██╗  ██╗  ${C.reset}
${C.cyan}${C.bold}  ██║  ██║██╔══██╗██╔════╝██║  ██║  ${C.reset}
${C.cyan}${C.bold}  ███████║███████║███████╗███████║  ${C.reset}
${C.cyan}${C.bold}  ██╔══██║██╔══██║╚════██║██╔══██║  ${C.reset}
${C.cyan}${C.bold}  ██║  ██║██║  ██║███████║██║  ██║  ${C.reset}
${C.cyan}${C.bold}  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝  ${C.reset}
${C.magenta}  GPU Miner v3.5 · High-Speed TX · hash256.org${C.reset}
${C.dim}  ${cpuModel.trim().slice(0, 50)} · ${totalMem} GB RAM${C.reset}
`);
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
};

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

function printStats() {
  const uptime = formatDuration(Date.now() - stats.startTime);
  const sep = `${C.dim}${"─".repeat(66)}${C.reset}`;
  console.log(sep);
  console.log(
    `  ${C.magenta}⚡ GPU${C.white} ${stats.lastGpuHashrate.padEnd(16)}${C.dim}│${C.reset} ` +
    `${C.cyan}Rounds${C.white} ${String(stats.roundsCompleted).padEnd(14)}${C.dim}│${C.reset} ` +
    `${C.cyan}Uptime${C.white} ${uptime}`
  );
  console.log(
    `  ${C.cyan}🎯 Found${C.green} ${String(stats.solutionsFound).padEnd(13)}${C.dim}│${C.reset} ` +
    `${C.cyan}TX OK${C.green} ${String(stats.txSuccess).padEnd(15)}${C.dim}│${C.reset} ` +
    `${C.cyan}TX Fail${C.red} ${stats.txFailed}`
  );
  if (stats.txPending > 0) {
    console.log(
      `  ${C.yellow}⏳ Pending TXs: ${stats.txPending}${C.reset}`
    );
  }
  console.log(sep);
}

// ─── Validation ───────────────────────────────────────────────────────────────
function requireEnv() {
  if (!RPC_URL || !PRIVATE_KEY) {
    log("✗", C.red, "Missing RPC_URL or PRIVATE_KEY in .env");
    process.exit(1);
  }
  if (!PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length < 66) {
    log("✗", C.red, "PRIVATE_KEY must start with 0x + 64 hex chars");
    process.exit(1);
  }
}

function getGpuBinary() {
  const binPath = path.join(__dirname, "gpu-miner");
  if (fs.existsSync(binPath)) return binPath;
  log("✗", C.red, "gpu-miner binary not found!");
  log("→", C.yellow, "Run: bash build.sh");
  process.exit(1);
}

// ─── Gas Helpers ──────────────────────────────────────────────────────────────
async function getGasParams(provider) {
  try {
    const feeData = await provider.getFeeData();
    const baseFee = feeData.gasPrice || 0n;
    const baseGwei = parseFloat(ethers.formatUnits(baseFee, "gwei"));

    // EIP-1559: priority fee on top of base fee for faster inclusion
    const priorityFee = ethers.parseUnits(PRIORITY_FEE_GWEI.toString(), "gwei");
    const maxFee = baseFee + priorityFee + priorityFee; // 2x priority as buffer

    return {
      baseGwei,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      type: 2, // EIP-1559
    };
  } catch {
    return { baseGwei: 0, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, type: 0 };
  }
}

// ─── Fire-and-forget TX submit ────────────────────────────────────────────────
// Don't wait for receipt — just fire TX and immediately start next mining round
async function submitMineTx(contract, nonce, gasParams) {
  stats.txPending++;

  try {
    const tx = await contract.mine(nonce, {
      gasLimit: GAS_LIMIT,
      type: gasParams.type,
      maxFeePerGas: gasParams.maxFeePerGas,
      maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
    });

    log("📤", C.blue, `TX sent: ${C.white}https://etherscan.io/tx/${tx.hash}`);

    // Fire-and-forget: wait for receipt in background
    tx.wait()
      .then((receipt) => {
        stats.txSuccess++;
        stats.txPending--;
        log("✅", C.green + C.bold, `Confirmed block ${C.white}${receipt.blockNumber}`);
      })
      .catch((err) => {
        stats.txFailed++;
        stats.txPending--;
        const msg = err.shortMessage || err.message || String(err);
        if (msg.includes("InsufficientWork") || msg.includes("execution reverted") || msg.includes("already mined")) {
          log("⏭", C.yellow, "InsufficientWork — already mined by someone else");
        } else {
          log("✗", C.red, `TX failed: ${msg.slice(0, 100)}`);
        }
      });

    return true;
  } catch (err) {
    stats.txFailed++;
    stats.txPending--;
    const msg = err.shortMessage || err.message || String(err);
    if (msg.includes("nonce")) {
      log("⏭", C.yellow, "Nonce conflict — skipping");
    } else {
      log("✗", C.red, `TX submit error: ${msg.slice(0, 100)}`);
    }
    return false;
  }
}

// ─── Run GPU Miner ────────────────────────────────────────────────────────────
function runGpuMiner(binaryPath, challengeHex, difficultyHex, startNonce) {
  return new Promise((resolve) => {
    const args = [challengeHex, difficultyHex, startNonce.toString()];
    execFile(binaryPath, args, {
      timeout: 300_000,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve({ found: false, error: "timeout" });
        return;
      }

      const hrMatch = stderr.match(/⛏\s+([\d.]+)\s+(KH\/s|MH\/s|GH\/s|H\/s)/);
      if (hrMatch) stats.lastGpuHashrate = `${hrMatch[1]} ${hrMatch[2]}`;

      try {
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          const json = JSON.parse(line);
          if (json.found) {
            resolve(json);
            return;
          }
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
  banner();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
  const binaryPath = getGpuBinary();

  console.log(`${C.dim}┌─ Configuration ──────────────────────────────────────────────┐${C.reset}`);
  console.log(`${C.dim}│${C.reset}  🔑 Wallet     ${C.white}${wallet.address}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  📄 Contract   ${C.white}${CONTRACT_ADDRESS}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  ⚡ GPU Mode    ${C.white}CUDA keccak-256${C.reset}`);
  console.log(`${C.dim}│${C.reset}  ⛽ Max Gas     ${C.white}${MAX_GAS_GWEI} gwei${C.reset}`);
  console.log(`${C.dim}│${C.reset}  💨 Priority    ${C.white}${PRIORITY_FEE_GWEI} gwei (EIP-1559)${C.reset}`);
  console.log(`${C.dim}│${C.reset}  📦 Gas Limit   ${C.white}${GAS_LIMIT.toLocaleString()}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  🔄 Fire&Forget ${C.white}ON (TX runs in background)${C.reset}`);
  console.log(`${C.dim}└──────────────────────────────────────────────────────────────┘${C.reset}`);
  console.log();

  // Pre-flight
  const balance = await provider.getBalance(wallet.address);
  const ethBal = parseFloat(ethers.formatEther(balance));
  log("💰", C.cyan, `ETH Balance: ${C.white}${ethBal.toFixed(6)} ETH`);
  if (balance === 0n) { log("✗", C.red, "No ETH! Fund wallet."); process.exit(1); }

  try {
    const hashBal = await contract.balanceOf(wallet.address);
    log("🪙", C.cyan, `HASH Balance: ${C.white}${ethers.formatUnits(hashBal, 18)} HASH`);
  } catch {}

  const { baseGwei } = await getGasParams(provider);
  log("⛽", C.cyan, `Base Fee:     ${C.white}${baseGwei.toFixed(1)} gwei`);
  console.log();
  log("⛏ ", C.magenta + C.bold, "GPU Mining started! Fire-and-forget TX mode. Ctrl+C to stop.");
  console.log();

  setInterval(printStats, 30_000);
  setTimeout(printStats, 5_000);

  // Track pending nonces to avoid re-mining same challenge
  let lastEpoch = "";
  let mining = false;

  while (true) {
    try {
      if (mining) {
        await sleep(500);
        continue;
      }

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
        stats.roundsCompleted = 0;
        console.log();
        log("🔄", C.blue, "New epoch · fresh challenge loaded");
        console.log(
          `  ${C.dim}Era:${C.reset} ${C.white}${era}${C.reset}  ${C.dim}│${C.reset} ` +
          `${C.dim}Reward:${C.reset} ${C.green}${reward} HASH${C.reset}  ${C.dim}│${C.reset} ` +
          `${C.dim}Epoch:${C.reset} ${C.white}${epoch}${C.reset}`
        );
        console.log(
          `  ${C.dim}Minted:${C.reset} ${C.white}${Number(minted).toLocaleString()}${C.reset}  ${C.dim}│${C.reset} ` +
          `${C.dim}Remaining:${C.reset} ${C.white}${Number(remaining).toLocaleString()}${C.reset}`
        );
      }

      const challengeHex = challenge.startsWith("0x") ? challenge.slice(2) : challenge;
      const difficultyHex = difficulty.toString(16).padStart(64, "0");
      const startNonce = BigInt("0x" + crypto.randomBytes(8).toString("hex"));

      mining = true;

      // Run GPU miner
      const result = await runGpuMiner(binaryPath, challengeHex, difficultyHex, startNonce);
      stats.roundsCompleted++;
      mining = false;

      if (result.found) {
        stats.solutionsFound++;
        const nonce = BigInt(result.nonce);
        console.log();
        log("🎯", C.green + C.bold, `FOUND nonce: ${C.white}${nonce}`);
        log("   ", C.dim, `Hash: ${result.hash}`);

        // Get gas params — with EIP-1559 priority fee for fast inclusion
        const gasParams = await getGasParams(provider);

        if (gasParams.baseGwei > MAX_GAS_GWEI) {
          log("⛽", C.yellow, `Gas ${gasParams.baseGwei.toFixed(1)} > ${MAX_GAS_GWEI} gwei — still submitting (fire-and-forget)`);
        }

        // Fire-and-forget: submit TX and immediately continue mining
        await submitMineTx(contract, nonce, gasParams);

        // Don't sleep — immediately start next mining round!
        // The GPU can find another solution before this TX is even confirmed
      }

      // Small yield (no sleep if found — go fast!)
      if (!result.found) await sleep(500);

    } catch (err) {
      const msg = err.shortMessage || err.message || String(err);
      log("✗", C.red, `Error: ${msg}`);
      mining = false;
      await sleep(RETRY_DELAY);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

process.on("SIGINT", () => {
  console.log();
  log("🛑", C.yellow, "Shutting down...");
  if (stats.txPending > 0) log("⏳", C.yellow, `${stats.txPending} TXs still pending`);
  printStats();
  process.exit(0);
});

process.on("SIGTERM", () => {
  printStats();
  process.exit(0);
});

main().catch(err => {
  log("✗", C.red, err.shortMessage || err.message || String(err));
  process.exit(1);
});
