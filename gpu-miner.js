require("dotenv").config();

const { ethers } = require("ethers");
const { execFile } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || "50");
const GAS_LIMIT = parseInt(process.env.GAS_LIMIT || "300000", 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || "5000", 10);

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
${C.magenta}  GPU Miner v2.1 · CUDA keccak-256 · hash256.org${C.reset}
${C.dim}  ${cpuModel.trim().slice(0, 50)} · ${totalMem} GB RAM${C.reset}
`);
}

// ─── Stats ────────────────────────────────────────────────────────────────────
const stats = {
  startTime: Date.now(),
  solutionsFound: 0,
  txSuccess: 0,
  txFailed: 0,
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

// ─── Check GPU binary exists ──────────────────────────────────────────────────
function getGpuBinary() {
  const binPath = path.join(__dirname, "gpu-miner");
  if (fs.existsSync(binPath)) return binPath;
  log("✗", C.red, "gpu-miner binary not found!");
  log("→", C.yellow, "Run: bash build.sh");
  process.exit(1);
}

// ─── Gas Helpers ──────────────────────────────────────────────────────────────
async function checkGas(provider) {
  try {
    const feeData = await provider.getFeeData();
    const gasGwei = parseFloat(ethers.formatUnits(feeData.gasPrice || 0n, "gwei"));
    return { gasGwei, gasPrice: feeData.gasPrice };
  } catch {
    return { gasGwei: 0, gasPrice: 0n };
  }
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

// ─── Run GPU Miner ────────────────────────────────────────────────────────────
function runGpuMiner(binaryPath, challengeHex, difficultyHex, startNonce) {
  return new Promise((resolve, reject) => {
    const args = [challengeHex, difficultyHex, startNonce.toString()];
    const child = execFile(binaryPath, args, {
      timeout: 300_000,  // 5 min max per round
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err && err.killed) {
        resolve({ found: false, error: "timeout" });
        return;
      }

      // Parse stderr for hashrate
      const hrMatch = stderr.match(/⛏\s+([\d.]+)\s+(KH\/s|MH\/s|GH\/s|H\/s)/);
      if (hrMatch) stats.lastGpuHashrate = `${hrMatch[1]} ${hrMatch[2]}`;

      // Parse stdout for result JSON
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

    // Stream stderr to console for live GPU output
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        const lines = chunk.toString().split("\n");
        for (const line of lines) {
          if (line.includes("gpu-miner") || line.includes("GPU") || line.includes("╗")) {
            process.stderr.write(line + "\n");
          }
        }
      });
    }
  });
}

// ─── Main Mining Loop ─────────────────────────────────────────────────────────
async function main() {
  requireEnv();
  banner();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);
  const binaryPath = getGpuBinary();

  console.log(`${C.dim}┌─ Configuration ──────────────────────────────────────────────┐${C.reset}`);
  console.log(`${C.dim}│${C.reset}  🔑 Wallet    ${C.white}${wallet.address}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  📄 Contract  ${C.white}${CONTRACT_ADDRESS}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  ⚡ GPU Mode   ${C.white}${binaryPath}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  ⛽ Max Gas    ${C.white}${MAX_GAS_GWEI} gwei${C.reset}`);
  console.log(`${C.dim}│${C.reset}  📦 Gas Limit  ${C.white}${GAS_LIMIT.toLocaleString()}${C.reset}`);
  console.log(`${C.dim}└──────────────────────────────────────────────────────────────┘${C.reset}`);
  console.log();

  // Pre-flight
  const balance = await provider.getBalance(wallet.address);
  const ethBal = parseFloat(ethers.formatEther(balance));
  log("💰", C.cyan, `ETH Balance: ${C.white}${ethBal.toFixed(6)} ETH`);
  if (balance === 0n) {
    log("✗", C.red, "Wallet has no ETH! Fund it first.");
    process.exit(1);
  }

  try {
    const hashBal = await contract.balanceOf(wallet.address);
    log("🪙", C.cyan, `HASH Balance: ${C.white}${ethers.formatUnits(hashBal, 18)} HASH`);
  } catch {}

  const { gasGwei } = await checkGas(provider);
  log("⛽", C.cyan, `Current Gas:  ${C.white}${gasGwei.toFixed(1)} gwei`);
  console.log();
  log("⛏ ", C.magenta + C.bold, "GPU Mining started! Ctrl+C to stop.");
  console.log();

  const statsInterval = setInterval(printStats, 30_000);
  setTimeout(printStats, 5_000);

  let lastEpoch = "";

  while (true) {
    try {
      // Fetch state
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
      }

      // Prepare args for GPU miner
      // Challenge: remove 0x prefix if present
      const challengeHex = challenge.startsWith("0x") ? challenge.slice(2) : challenge;
      // Difficulty: 64 hex chars (32 bytes), big-endian
      const difficultyHex = difficulty.toString(16).padStart(64, "0");
      // Random start nonce
      const startNonce = BigInt("0x" + crypto.getRandomValues(new Uint8Array(8)).reduce((a, b) => a + b.toString(16).padStart(2, "0"), ""));

      // Run GPU miner
      const result = await runGpuMiner(binaryPath, challengeHex, difficultyHex, startNonce);
      stats.roundsCompleted++;

      if (result.found) {
        stats.solutionsFound++;
        const nonce = BigInt(result.nonce);
        console.log();
        log("🎯", C.green + C.bold, `FOUND nonce: ${C.white}${nonce}`);
        log("   ", C.dim, `Hash: ${result.hash}`);

        // Gas check
        const { gasGwei: currentGas } = await checkGas(provider);
        if (currentGas > MAX_GAS_GWEI) {
          await waitForLowGas(provider, MAX_GAS_GWEI);
        }

        // Submit TX
        try {
          const tx = await contract.mine(nonce, { gasLimit: GAS_LIMIT });
          log("📤", C.blue, `TX sent: ${C.white}https://etherscan.io/tx/${tx.hash}`);

          const receipt = await tx.wait();
          stats.txSuccess++;
          log("✅", C.green + C.bold, `Confirmed in block ${C.white}${receipt.blockNumber}`);
          console.log();

          try {
            const newBal = await contract.balanceOf(wallet.address);
            log("🪙", C.cyan, `HASH Balance: ${C.white}${ethers.formatUnits(newBal, 18)} HASH`);
          } catch {}
          console.log();
        } catch (err) {
          stats.txFailed++;
          const msg = err.shortMessage || err.message || String(err);
          if (msg.includes("InsufficientWork") || msg.includes("execution reverted")) {
            log("⏭", C.yellow, "Nonce invalid or already mined — retrying...");
          } else {
            log("✗", C.red, `TX failed: ${msg}`);
          }
        }

        await sleep(1000);
      }

      await sleep(500);

    } catch (err) {
      const msg = err.shortMessage || err.message || String(err);
      log("✗", C.red, `Error: ${msg}`);
      await sleep(RETRY_DELAY);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on("SIGINT", () => {
  console.log();
  log("🛑", C.yellow, "Shutting down...");
  printStats();
  process.exit(0);
});

process.on("SIGTERM", () => {
  printStats();
  process.exit(0);
});

// ─── Entry ────────────────────────────────────────────────────────────────────
main().catch(err => {
  log("✗", C.red, err.shortMessage || err.message || String(err));
  process.exit(1);
});
