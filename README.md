# HASH256 GPU Miner

High-performance CLI miner for HASH256 (`hash256.org`). Mines on Ethereum mainnet
with GPU (CUDA/OpenCL) or CPU fallback. Modular architecture for easy extension.

## Features

- **GPU Mining** — CUDA keccak-256 with automatic CPU fallback
- **CPU Multi-threaded** — worker_threads for CPU-only setups
- **Smart TX Management** — fire-and-forget with receipt status tracking
- **Gas Optimization** — cached gas params, EIP-1559, configurable limits
- **Real-time Stats** — hashrate, TX success rate, reward tracking
- **Clean modular code** — separated concerns (config, gas, tx, stats, miners)

## Quick Start

```bash
git clone https://github.com/ulsreall/hash256-cli.git
cd hash256-cli
npm install
cp .env.example .env
nano .env  # fill in RPC_URL and PRIVATE_KEY
```

### Check contract state:
```bash
npm run check
```

### Run miner:
```bash
# Auto-detect GPU, fallback to CPU
npm start

# CPU only
npm run start:cpu

# GPU only
npm run start:gpu
```

## Environment Variables

```env
# Required
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
PRIVATE_KEY=0xYOUR_PRIVATE_KEY

# Backend
MINER_BACKEND=auto           # auto | cpu | cuda
CPU_WORKERS=8                # CPU threads (default: cores - 1)
GPU_MINER_BIN=./gpu-miner    # Path to GPU binary

# Gas
MAX_GAS_GWEI=50              # Skip TX if base fee > this
PRIORITY_FEE_GWEI=5          # EIP-1559 priority fee
GAS_LIMIT=300000             # TX gas limit
GAS_REFRESH_MS=4000          # Gas cache refresh interval

# TX Strategy
MAX_PENDING=2                # Max concurrent pending TXs
TX_TIMEOUT=45000             # Receipt poll timeout (ms)

# Stats
STATS_INTERVAL=15000         # Stats panel refresh (ms)
```

## Architecture

```
miner.js              ← Main entry point + mining loop
├── lib/config.js     ← ABI, contract address, env options
├── lib/format.js     ← Display utilities (hashrate, uptime, hex)
├── lib/gas.js        ← Gas manager with caching
├── lib/stats.js      ← Stats tracking + formatted panel
├── lib/tx-manager.js ← Fire-and-forget TX + receipt polling
├── lib/gpu-miner.js  ← GPU (CUDA) miner wrapper
├── lib/cpu-miner.js  ← CPU multi-thread miner
├── lib/cpu-worker.js ← CPU worker thread
├── gpu-miner.cu      ← CUDA kernel source
├── check-state.js    ← Contract state checker
└── build.sh          ← GPU binary build script
```

## TX Strategy

```
GPU/CPU finds nonce
  ↓
Gas too high? → Skip (save ETH)
  ↓
Too many pending? → Wait for slot
  ↓
Fire TX (don't wait for receipt)
  ↓
Background receipt poll every 2s
  ├── status=1 → ✅ REWARDED (HASH received!)
  └── status=0 → ⏮️ REVERTED (someone else was faster)
```

## Build GPU Binary

### Linux (CUDA)
```bash
# Install CUDA toolkit
sudo apt install nvidia-cuda-toolkit

# Build
bash build.sh

# Run
npm run start:gpu
```

## Error Reference

| Error | Cause | Fix |
|-------|-------|-----|
| `InsufficientWork` | Someone else mined first | Normal — keep mining |
| `insufficient funds` | No ETH for gas | Fund wallet |
| `GPU miner not found` | Binary not built | Run `bash build.sh` |
| `GenesisNotComplete` | Mining not open yet | Wait for genesis |

## License

MIT
