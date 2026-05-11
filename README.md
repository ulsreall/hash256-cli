# HASH256 GPU Miner

High-performance Rust + OpenCL GPU miner for HASH256 (`hash256.org`).

## What's New (v8.0)

- **Rust + OpenCL** — native GPU mining, no Node.js overhead
- **Fire-and-forget TX** — submit and mine immediately, don't wait for confirm
- **Receipt status tracking** — REWARDED vs REVERTED in real-time stats
- **CPU fallback** — auto-fallback if GPU not available
- **Smart gas management** — EIP-1559, baseFee×2 + priority
- **Epoch watchdog** — auto-restart on epoch change via block polling
- **GPU self-test** — verifies kernel correctness at startup

## Quick Start

```bash
git clone https://github.com/ulsreall/hash256-cli.git
cd hash256-cli
cp .env.example .env
nano .env  # fill PRIVATE_KEY and RPC_URL
```

### Build (GPU)

```bash
# Install OpenCL (Ubuntu/Debian)
sudo apt install -y build-essential ocl-icd-opencl-dev

# NVIDIA: install driver + OpenCL runtime
# AMD: install ROCm/OpenCL runtime

# Build
cargo build --release
```

### Run

```bash
# GPU mode (default)
GPU=1 ./target/release/hash256-miner

# CPU only
GPU=0 ./target/release/hash256-miner

# GPU with custom batch size
GPU=1 GPU_BATCH=8388608 ./target/release/hash256-miner
```

## Environment Variables

```env
# Required
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# GPU
GPU=1                    # 1 = enable OpenCL GPU, 0 = CPU only
GPU_BATCH=4194304        # Nonces per GPU dispatch (default: 4M)

# CPU
MINER_THREADS=8          # CPU threads (default: num CPUs)

# Gas
PRIORITY_GWEI=5          # EIP-1559 priority fee
MAX_GAS_GWEI=50          # Skip TX if base fee > this

# TX Strategy
MAX_PENDING=2            # Max concurrent pending TXs
```

## Architecture

```
src/main.rs           ← Mining loop + TX management (Rust + alloy)
src/gpu.rs            ← OpenCL GPU backend
src/keccak_kernel.cl  ← Keccak-256 OpenCL kernel
Cargo.toml            ← Dependencies (alloy, ocl, tokio)
build.rs              ← Windows OpenCL linking
```

## TX Strategy

```
GPU/CPU finds nonce
  ↓
Gas too high? → Skip (save ETH)
  ↓
Too many pending? → Wait for slot (max 2)
  ↓
Fire TX immediately (don't wait for receipt)
  ↓
Background receipt poll (60s timeout)
  ├── status=1 → ✅ REWARDED (HASH received!)
  └── status=0 → ⏮️ REVERTED (someone else was faster)
```

## Mining Algorithm

1. Fetch `challenge` and `difficulty` from contract
2. GPU/CPU tries nonces: `keccak256(abi.encode(challenge, nonce)) < difficulty`
3. Found nonce → `mine(nonce)` TX
4. Repeat for next epoch

## Benchmarks

| Backend | GPU | Hashrate |
|---------|-----|----------|
| OpenCL  | RTX 5090 | ~5.2 GH/s |
| OpenCL  | RTX 4090 | ~3.8 GH/s |
| CPU     | 8-core | ~500 MH/s |

> Note: CUDA backend coming in future update for higher hashrate.

## Error Reference

| Error | Cause | Fix |
|-------|-------|-----|
| `InsufficientWork` | Someone else mined first | Normal — keep mining |
| `insufficient funds` | No ETH for gas | Fund wallet |
| `GPU self-test FAILED` | Kernel bug | Report issue |
| `GenesisNotComplete` | Mining not open yet | Wait for genesis |
| `clGetDeviceIDs(GPU)` | No OpenCL driver | Install GPU driver |

## License

MIT
