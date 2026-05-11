require("dotenv").config();

const { ethers } = require("ethers");

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
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

function log(emoji, color, msg) {
  console.log(`${C.dim}[${ts()}]${C.reset} ${color}${emoji} ${msg}${C.reset}`);
}

function banner() {
  console.log(`
${C.cyan}${C.bold}  ██╗  ██╗ █████╗ ███████╗██╗  ██╗  ${C.reset}
${C.cyan}${C.bold}  ██║  ██║██╔══██╗██╔════╝██║  ██║  ${C.reset}
${C.cyan}${C.bold}  ███████║███████║███████╗███████║  ${C.reset}
${C.cyan}${C.bold}  ██╔══██║██╔══██║╚════██║██╔══██║  ${C.reset}
${C.cyan}${C.bold}  ██║  ██║██║  ██║███████║██║  ██║  ${C.reset}
${C.cyan}${C.bold}  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝  ${C.reset}
${C.dim}  CLI Miner v2.0 · Ethereum Mainnet · hash256.org${C.reset}
`);
}

// ─── Stats Tracker ────────────────────────────────────────────────────────────
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
  stats._hashWindow.push({ count, time: Date.now() });
  // keep last 20 samples
  if (stats._hashWindow.length > 20) stats._hashWindow.shift();
}

function getHashrate() {
  const w = stats._hashWindow;
  if (w.length < 2) return 0;
  const first = w[0];
  const last = w[w.length - 1];
  const totalHashes = Number(stats.totalHashes);
  const dt = (last.time - first.time) / 1000;
  return dt > 0 ? totalHashes / dt : 0;
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
  const sep = `${C.dim}${"─".repeat(64)}${C.reset}`;
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
    if (i % 12 === 11) console.log(); // newline every ~60s
  }
  console.log();
  log("⛽", C.yellow, `Gas still high after 10min — submitting anyway`);
  return false;
}

// ─── Core Mining Function ─────────────────────────────────────────────────────
function findNonce(challengeHex, difficulty, startNonce, batchSize) {
  for (let i = 0; i < batchSize; i++) {
    const testNonce = startNonce + BigInt(i);
    const hash = ethers.solidityPackedKeccak256(
      ["bytes32", "uint256"],
      [challengeHex, testNonce]
    );
    const hashNum = BigInt(hash);
    if (hashNum < difficulty) {
      return { found: true, nonce: testNonce, hash };
    }
  }
  return { found: false };
}

// ─── Mining Loop ──────────────────────────────────────────────────────────────
async function main() {
  requireEnv();
  banner();

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, wallet);

  // Display config
  console.log(`${C.dim}┌─ Configuration ──────────────────────────────────────────┐${C.reset}`);
  console.log(`${C.dim}│${C.reset}  🔑 Wallet    ${C.white}${wallet.address}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  📄 Contract  ${C.white}${CONTRACT_ADDRESS}${C.reset}`);
  console.log(`${C.dim}│${C.reset}  ⛽ Max Gas    ${C.white}${MAX_GAS_GWEI} gwei${C.reset}`);
  console.log(`${C.dim}│${C.reset}  📦 Gas Limit  ${C.white}${GAS_LIMIT.toLocaleString()}${C.reset}`);
  console.log(`${C.dim}└───────────────────────────────────────────────────────────┘${C.reset}`);
  console.log();

  // Pre-flight checks
  const balance = await provider.getBalance(wallet.address);
  const ethBal = parseFloat(ethers.formatEther(balance));
  log("💰", C.cyan, `ETH Balance: ${C.white}${ethBal.toFixed(6)} ETH`);
  if (balance === 0n) {
    log("✗", C.red, "Wallet has no ETH for gas! Fund it first.");
    process.exit(1);
  }
  if (ethBal < 0.001) {
    log("⚠", C.yellow, "Low ETH balance — may run out of gas soon");
  }

  try {
    const hashBal = await contract.balanceOf(wallet.address);
    log("🪙", C.cyan, `HASH Balance: ${C.white}${ethers.formatUnits(hashBal, 18)} HASH`);
  } catch {
    log("🪙", C.dim, "HASH Balance: unable to fetch");
  }

  const { gasGwei } = await checkGas(provider);
  log("⛽", C.cyan, `Current Gas:  ${C.white}${gasGwei.toFixed(1)} gwei`);
  console.log();
  log("⛏ ", C.green + C.bold, "Mining started! Press Ctrl+C to stop.");
  console.log();

  // Stats printer
  const statsInterval = setInterval(printStats, 30_000);
  setTimeout(printStats, 5_000);

  // Main mining loop
  let lastEpoch = "";
  const BATCH_SIZE = 50_000;

  while (true) {
    try {
      // Fetch contract state
      const state = await contract.miningState();
      const difficulty = BigInt(state.difficulty.toString());
      const era = state.era.toString();
      const reward = ethers.formatUnits(state.reward, 18);
      const epoch = state.epoch.toString();
      const minted = state.minted.toString();
      const remaining = state.remaining.toString();

      // Get challenge
      const challenge = await contract.getChallenge(wallet.address);

      // Print round info if epoch changed
      if (epoch !== lastEpoch) {
        lastEpoch = epoch;
        console.log();
        log("🔄", C.blue, "New epoch · fetching fresh challenge");
        console.log(
          `  ${C.dim}Era:${C.reset} ${C.white}${era}${C.reset}  ${C.dim}│${C.reset} ` +
          `${C.dim}Reward:${C.reset} ${C.green}${reward} HASH${C.reset}  ${C.dim}│${C.reset} ` +
          `${C.dim}Epoch:${C.reset} ${C.white}${epoch}${C.reset}`
        );
        console.log(
          `  ${C.dim}Difficulty:${C.reset} ${C.white}${difficulty.toString().slice(0, 24)}...${C.reset}`
        );
        console.log(
          `  ${C.dim}Minted:${C.reset} ${C.white}${minted}${C.reset}  ${C.dim}│${C.reset} ` +
          `${C.dim}Remaining:${C.reset} ${C.white}${remaining}${C.reset}`
        );
      }

      // Generate random start nonce and search batch
      let nonce = randomNonce();
      let result = findNonce(challenge, difficulty, nonce, BATCH_SIZE);
      recordHashes(BATCH_SIZE);

      if (result.found) {
        stats.solutionsFound++;
        console.log();
        log("🎯", C.green + C.bold, `FOUND nonce: ${C.white}${result.nonce}`);
        log("   ", C.dim, `Hash: ${result.hash}`);

        // Gas check
        const { gasGwei: currentGas } = await checkGas(provider);
        if (currentGas > MAX_GAS_GWEI) {
          await waitForLowGas(provider, MAX_GAS_GWEI);
        }

        // Submit TX
        try {
          const tx = await contract.mine(result.nonce, { gasLimit: GAS_LIMIT });
          log("📤", C.blue, `TX sent: ${C.white}https://etherscan.io/tx/${tx.hash}`);

          const receipt = await tx.wait();
          stats.txSuccess++;
          log("✅", C.green + C.bold, `Confirmed in block ${C.white}${receipt.blockNumber}`);
          console.log();

          // Update HASH balance
          try {
            const newBal = await contract.balanceOf(wallet.address);
            log("🪙", C.cyan, `HASH Balance: ${C.white}${ethers.formatUnits(newBal, 18)} HASH`);
          } catch {}
          console.log();
        } catch (err) {
          stats.txFailed++;
          const msg = err.shortMessage || err.message || String(err);
          if (msg.includes("InsufficientWork")) {
            log("⏭", C.yellow, "InsufficientWork — nonce no longer valid, retrying...");
          } else if (msg.includes("execution reverted")) {
            log("⏭", C.yellow, "Already mined or state changed, retrying...");
          } else {
            log("✗", C.red, `TX failed: ${msg}`);
          }
        }

        // Brief pause before next round
        await sleep(1000);
      }

      // Yield to event loop
      await sleep(10);

    } catch (err) {
      const msg = err.shortMessage || err.message || String(err);
      log("✗", C.red, `Error: ${msg}`);
      await sleep(RETRY_DELAY);
    }
  }
}

function randomNonce() {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return BigInt("0x" + Buffer.from(buf).toString("hex"));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
main().catch((err) => {
  log("✗", C.red, err.shortMessage || err.message || String(err));
  process.exit(1);
});
