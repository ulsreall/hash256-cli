# HASH256 GPU Miner

High-performance Rust GPU miner for HASH256 (`hash256.org`).

## Backends (auto-detected, priority order)

1. **CUDA** — standalone binary, fastest (~31 GH/s on RTX 5090)
2. **OpenCL** — built-in Rust `ocl` crate (~5 GH/s on RTX 5090)
3. **CPU** — multi-threaded fallback (~500 MH/s)

## Quick Start

```bash
git clone https://github.com/ulsreall/hash256-cli.git
cd hash256-cli
cp .env.example .env
nano .env  # fill PRIVATE_KEY and RPC_URL
```

### Build CUDA (recommended)

```bash
# Install CUDA toolkit
sudo apt install -y nvidia-cuda-toolkit

# Build CUDA binary
cd native && bash build_cuda.sh && cd ..

# Build Rust binary
cargo build --release

# Run
GPU=1 ./target/release/hash256-miner
```

### Build OpenCL (alternative)

```bash
sudo apt install -y build-essential ocl-icd-opencl-dev
cargo build --release --features gpu
GPU=1 ./target/release/hash256-miner
```

### CPU only

```bash
cargo build --release --no-default-features
GPU=0 ./target/release/hash256-miner
```

## Environment Variables

```env
# Required
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# GPU
GPU=1                          # 1 = enable GPU, 0 = CPU only
CUDA_MINER_BIN=./bin/hash256-cuda  # CUDA binary path
GPU_BATCH=4194304              # OpenCL batch size

# CPU
MINER_THREADS=8

# Gas
PRIORITY_GWEI=5
MAX_GAS_GWEI=50

# TX Strategy
MAX_PENDING=2
```

## TX Strategy

```
GPU/CPU finds nonce
  ↓
Fire TX immediately (don't wait for receipt)
  ↓
Background receipt poll (60s timeout)
  ├── status=1 → ✅ REWARDED
  └── status=0 → ⏮️ REVERTED (someone else was faster)
```

## Architecture

```
src/main.rs           ← Mining loop + TX management (Rust + alloy)
src/cuda.rs           ← CUDA backend wrapper (spawns binary)
src/gpu.rs            ← OpenCL backend (ocl crate)
src/keccak_kernel.cl  ← OpenCL kernel
native/cuda_miner.cu  ← CUDA kernel
native/build_cuda.sh  ← CUDA build script
Cargo.toml            ← alloy, ocl, tokio
```

## Benchmarks

| Backend | GPU | Hashrate |
|---------|-----|----------|
| CUDA    | RTX 5090 | ~31 GH/s |
| CUDA    | RTX 4090 | ~22 GH/s |
| OpenCL  | RTX 5090 | ~5.2 GH/s |
| CPU     | 8-core | ~500 MH/s |

## License

MIT
