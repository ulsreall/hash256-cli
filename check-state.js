require("dotenv").config();

const { ethers } = require("ethers");
const { ABI, CONTRACT_ADDRESS } = require("./lib/config");

const RPC_URL = process.env.RPC_URL;

if (!RPC_URL) {
  console.error("✗ Isi RPC_URL di file .env dulu.");
  process.exit(1);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);

  console.log("Contract:", CONTRACT_ADDRESS);
  console.log();

  const genesisState = await contract.genesisState();
  console.log("Genesis State:", genesisState);

  const miningState = await contract.miningState();

  console.log();
  console.log("Mining State:");
  console.log("  Era:       ", miningState.era.toString());
  console.log("  Reward:    ", ethers.formatUnits(miningState.reward, 18), "HASH");
  console.log("  Difficulty:", miningState.difficulty.toString());
  console.log("  Minted:    ", miningState.minted.toString());
  console.log("  Remaining: ", miningState.remaining.toString());
  console.log("  Epoch:     ", miningState.epoch.toString());
  console.log("  Blocks Left:", miningState.epochBlocksLeft_.toString());
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
