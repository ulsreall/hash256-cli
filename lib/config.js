const CONTRACT_ADDRESS = "0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc";

const ABI = [
  "function getChallenge(address miner) view returns (bytes32)",
  "function miningState() view returns (uint256 era, uint256 reward, uint256 difficulty, uint256 minted, uint256 remaining, uint256 epoch, uint256 epochBlocksLeft_)",
  "function mine(uint256 nonce)",
  "function balanceOf(address) view returns (uint256)",
  "function genesisState() view returns (uint256, uint256, uint256, bool)"
];

function readOptions(env = process.env) {
  const opts = {
    backend: env.MINER_BACKEND || "auto",
    workers: Number(env.CPU_WORKERS || Math.max(1, (require("os").cpus().length || 2) - 1)),
    batchSize: BigInt(env.CPU_BATCH_SIZE || "50000"),
    gpuBinary: env.GPU_MINER_BIN || "",
    gpuBatchSize: BigInt(env.GPU_BATCH_SIZE || "67108864"),
    priorityFeeGwei: env.PRIORITY_FEE_GWEI || "5",
    maxGasGwei: parseFloat(env.MAX_GAS_GWEI || "50"),
    gasLimit: parseInt(env.GAS_LIMIT || "300000", 10),
    gasRefreshMs: parseInt(env.GAS_REFRESH_MS || "4000", 10),
    txTimeout: parseInt(env.TX_TIMEOUT || "45000", 10),
    maxPending: parseInt(env.MAX_PENDING || "2", 10),
    statsInterval: parseInt(env.STATS_INTERVAL || "15000", 10),
    keepMining: env.KEEP_MINING !== "false",
  };

  if (!["auto", "cpu", "cuda"].includes(opts.backend)) {
    throw new Error("MINER_BACKEND must be: auto, cpu, cuda");
  }

  opts.workers = Number.isFinite(opts.workers)
    ? Math.max(1, Math.min(64, Math.floor(opts.workers)))
    : 1;

  return opts;
}

module.exports = { ABI, CONTRACT_ADDRESS, readOptions };
