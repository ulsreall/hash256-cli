require("dotenv").config();

const { ethers } = require("ethers");

// ─── Config ───────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era, uint256 reward, uint256 difficulty, uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft_)",
  "function genesisState() view returns (uint256 totalSold, uint256 totalRaised, uint256 maxSupply, bool complete)",
  "function balanceOf(address) view returns (uint256)",
];

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function banner() {
  console.log(`
${C.cyan}${C.bold}  ██╗  ██╗ █████╗ ███████╗██╗  ██╗  ${C.reset}
${C.cyan}${C.bold}  ██║  ██║██╔══██╗██╔════╝██║  ██║  ${C.reset}
${C.cyan}${C.bold}  ███████║███████║███████╗███████║  ${C.reset}
${C.cyan}${C.bold}  ██╔══██║██╔══██║╚════██║██╔══██║  ${C.reset}
${C.cyan}${C.bold}  ██║  ██║██║  ██║███████║██║  ██║  ${C.reset}
${C.cyan}${C.bold}  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝  ${C.reset}
${C.dim}  State Checker v2.0 · hash256.org${C.reset}
`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  banner();

  if (!RPC_URL) {
    console.error(`${C.red}✗ Missing RPC_URL in .env${C.reset}`);
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

  const sep = `${C.dim}${"─".repeat(62)}${C.reset}`;

  // ── Genesis State ──
  try {
    const gs = await contract.genesisState();
    const totalSold = ethers.formatUnits(gs[0], 18);
    const totalRaised = ethers.formatUnits(gs[1], 18);
    const maxSupply = ethers.formatUnits(gs[2], 18);
    const complete = gs[3];

    console.log(sep);
    console.log(`${C.bold}  🌍 GENESIS STATE${C.reset}`);
    console.log(sep);
    console.log(`  ${C.dim}Total Sold:${C.reset}    ${C.white}${totalSold} HASH${C.reset}`);
    console.log(`  ${C.dim}Total Raised:${C.reset}  ${C.white}${totalRaised} ETH${C.reset}`);
    console.log(`  ${C.dim}Max Supply:${C.reset}    ${C.white}${maxSupply} HASH${C.reset}`);
    console.log(`  ${C.dim}Complete:${C.reset}      ${complete ? `${C.green}✓ Yes` : `${C.yellow}⏳ No`}${C.reset}`);
    console.log();
  } catch (err) {
    console.log(`${C.yellow}⚠ Could not fetch genesis state${C.reset}`);
    console.log();
  }

  // ── Mining State ──
  try {
    const ms = await contract.miningState();
    const era = ms[0].toString();
    const reward = ethers.formatUnits(ms[1], 18);
    const difficulty = ms[2].toString();
    const minted = ms[3].toString();
    const remaining = ms[4].toString();
    const epoch = ms[5].toString();
    const epochBlocksLeft = ms[6].toString();

    console.log(sep);
    console.log(`${C.bold}  ⛏  MINING STATE${C.reset}`);
    console.log(sep);
    console.log(`  ${C.dim}Era:${C.reset}              ${C.white}Era ${era}${C.reset}`);
    console.log(`  ${C.dim}Reward:${C.reset}           ${C.green}${reward} HASH per mint${C.reset}`);
    console.log(`  ${C.dim}Difficulty:${C.reset}       ${C.white}${difficulty.slice(0, 20)}...${C.reset}`);
    console.log(`  ${C.dim}Total Minted:${C.reset}     ${C.white}${Number(minted).toLocaleString()}${C.reset}`);
    console.log(`  ${C.dim}Remaining:${C.reset}        ${C.white}${Number(remaining).toLocaleString()}${C.reset}`);
    console.log(`  ${C.dim}Epoch:${C.reset}            ${C.white}${epoch}${C.reset}`);
    console.log(`  ${C.dim}Epoch Blocks Left:${C.reset} ${C.white}${epochBlocksLeft}${C.reset}`);
    console.log();

    // Supply progress bar
    const total = Number(minted) + Number(remaining);
    const pct = total > 0 ? (Number(minted) / total * 100) : 0;
    const barLen = 40;
    const filled = Math.round(pct / 100 * barLen);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    console.log(`  ${C.dim}Supply Progress:${C.reset}`);
    console.log(`  ${C.cyan}[${bar}]${C.reset} ${C.white}${pct.toFixed(2)}%${C.reset}`);
    console.log();
  } catch (err) {
    console.log(`${C.red}✗ Could not fetch mining state: ${err.shortMessage || err.message}${C.reset}`);
    console.log();
  }

  // ── Wallet Info (if PRIVATE_KEY set) ──
  if (PRIVATE_KEY) {
    try {
      const wallet = new ethers.Wallet(PRIVATE_KEY);
      const ethBal = await provider.getBalance(wallet.address);
      const hashBal = await contract.balanceOf(wallet.address);

      console.log(sep);
      console.log(`${C.bold}  🔑 WALLET${C.reset}`);
      console.log(sep);
      console.log(`  ${C.dim}Address:${C.reset}     ${C.white}${wallet.address}${C.reset}`);
      console.log(`  ${C.dim}ETH Balance:${C.reset}  ${C.white}${ethers.formatEther(ethBal)} ETH${C.reset}`);
      console.log(`  ${C.dim}HASH Balance:${C.reset} ${C.white}${ethers.formatUnits(hashBal, 18)} HASH${C.reset}`);
      console.log();

      // Pending challenge
      try {
        const challenge = await contract.getChallenge(wallet.address);
        console.log(`  ${C.dim}Current Challenge:${C.reset} ${C.white}${challenge}${C.reset}`);
        console.log();
      } catch {}
    } catch (err) {
      console.log(`${C.yellow}⚠ Could not fetch wallet info: ${err.message}${C.reset}`);
      console.log();
    }
  } else {
    console.log(`${C.dim}  💡 Set PRIVATE_KEY in .env to see wallet balance and challenge${C.reset}`);
    console.log();
  }

  // ── Contract Links ──
  console.log(sep);
  console.log(`${C.bold}  🔗 LINKS${C.reset}`);
  console.log(sep);
  console.log(`  ${C.dim}Contract:${C.reset} https://etherscan.io/address/${CONTRACT_ADDRESS}`);
  console.log(`  ${C.dim}Mine:${C.reset}      https://hash256.org/mine`);
  console.log(`  ${C.dim}Pool:${C.reset}      https://hash256.org/pool`);
  console.log(`  ${C.dim}X/Twitter:${C.reset} https://x.com/hash256dotorg`);
  console.log(sep);
}

main().catch((err) => {
  console.error(`${C.red}✗ ${err.shortMessage || err.message || err}${C.reset}`);
  process.exit(1);
});
