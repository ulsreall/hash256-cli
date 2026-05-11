# HASH256 Miner

GPU + CPU CLI miner for **$HASH** — a browser-mined post-quantum token on Ethereum mainnet. Source: [hash256.org](https://hash256.org)

## ⚡ Modes

| Mode | Command | Est. Speed | Requirement |
|------|---------|------------|-------------|
| **GPU** | `npm run gpu` | **10+ GH/s** (H100) | NVIDIA GPU + CUDA |
| **CPU** | `npm start` | ~10-30 KH/s (48 cores) | Node.js 18+ |

## ✨ Features

- ⚡ **CUDA keccak-256** — PoW langsung di GPU, ~1000x lebih cepat dari browser
- 🧵 **Multi-threaded CPU** — uses semua core via `worker_threads`
- 🎮 **Auto GPU detect** — picks GPU terbaik, auto arch (Pascal → Hopper)
- 🎨 **Colored terminal** — timestamps, formatted stats
- ⛽ **Gas management** — auto-wait kalau gas terlalu tinggi
- 🪙 **Wallet balance** — ETH + HASH tampil di awal
- 🛑 **Graceful shutdown** — Ctrl+C tampilin final stats
- 📊 **Supply progress bar** — visual mining progress

## 🚀 Quick Start (One Command!)

```bash
git clone https://github.com/ulsreall/hash256-cli
cd hash256-cli
bash setup.sh
```

Setup script otomatis:
1. ✅ Install Node.js (kalau belum ada)
2. ✅ Install CUDA toolkit (kalau GPU ada)
3. ✅ npm install
4. ✅ Build GPU miner (auto-detect arch)
5. ✅ Create .env dari template

Setelah setup selesai:
```bash
nano .env          # Isi PRIVATE_KEY
tmux new -s hash   # Buat session
npm run gpu        # Jalankan!
```

## 📖 Manual Install

### 1. Install Dependencies

**Node.js:**
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
```

**CUDA Toolkit (kalau punya GPU):**
```bash
# Ubuntu 22.04
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update
sudo apt install -y cuda-toolkit-12-4
```

### 2. Clone & Install

```bash
git clone https://github.com/ulsreall/hash256-cli
cd hash256-cli
npm install
```

### 3. Configure

```bash
cp .env.example .env
nano .env
```

```env
RPC_URL=https://ethereum-rpc.publicnode.com
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
```

### 4. Build GPU Miner

```bash
bash build.sh
```

Auto-detect GPU architecture:
| GPU Series | Arch Flag | Example GPUs |
|-----------|-----------|-------------|
| Pascal | sm_61 | GTX 1060/1070/1080 |
| Volta | sm_70 | V100 |
| Turing | sm_75 | RTX 2060/2070/2080 |
| Ampere | sm_80 | A100 |
| Ampere | sm_86 | RTX 3060/3070/3080/3090, A5000 |
| Ada Lovelace | sm_89 | RTX 4060/4070/4080/4090, L40 |
| **Hopper** | **sm_90** | **H100, H200** 🚀 |

### 5. Run

```bash
# GPU Mining (cepat!)
npm run gpu

# CPU Mining
npm start

# Check state
npm run check
```

## 🖥 Run di Background

```bash
# tmux (recommended)
tmux new -s hash256
npm run gpu
# Detach: CTRL+B → D
# Reattach: tmux attach -t hash256

# screen
screen -S hash256
npm run gpu
# Detach: CTRL+A → D
# Reattach: screen -r hash256
```

## ⚡ Expected Performance

| Hardware | Mode | Est. Hashrate | Era 1 (100 HASH) |
|----------|------|---------------|-------------------|
| **H100 80GB** | GPU | **10+ GH/s** | ~seconds |
| **A100 80GB** | GPU | ~5 GH/s | ~seconds |
| **RTX 4090** | GPU | ~2-3 GH/s | ~10-30 detik |
| **RTX 3090** | GPU | ~800 MH/s | ~30-60 detik |
| **RTX 3070** | GPU | ~400 MH/s | ~1-2 menit |
| 48-core EPYC | CPU | ~20-30 KH/s | ~1-2 jam |
| 16-core Xeon | CPU | ~5-6 KH/s | ~3-6 jam |
| 8-core | CPU | ~3-4 KH/s | ~6-12 jam |

## 🔧 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | (required) | Ethereum RPC endpoint |
| `PRIVATE_KEY` | (required) | Wallet private key (0x...) |
| `THREADS` | CPU-1 | Worker threads (CPU miner) |
| `BATCH_SIZE` | 100000 | Hashes per worker report |
| `MAX_GAS_GWEI` | 50 | Max gas price to submit TX |
| `GAS_LIMIT` | 300000 | TX gas limit |
| `RETRY_DELAY` | 5000 | Delay (ms) on error |

## 📁 File Structure

```
hash256-cli/
├── miner.js          # CPU miner (multi-threaded)
├── gpu-miner.cu      # CUDA kernel (keccak-256 PoW)
├── gpu-miner.js      # GPU miner wrapper (Node.js)
├── check-state.js    # Contract state checker
├── build.sh          # Build CUDA binary
├── setup.sh          # One-click VPS setup
├── .env.example      # Config template
├── package.json
└── README.md
```

## 🔧 Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `gpu-miner not found` | Not built | `bash build.sh` |
| `No CUDA devices` | No GPU | Use `npm start` |
| `nvcc not found` | No CUDA toolkit | Install CUDA toolkit |
| `Missing RPC_URL` | .env empty | `cp .env.example .env` |
| `insufficient funds` | No ETH | Send ETH to wallet |
| `InsufficientWork` | Nonce expired | Auto-retry |
| `Gas too high` | Gas spike | Auto-wait or lower limit |

## 📐 Tokenomics

| | |
|---|---|
| Token | $HASH |
| Supply | 21,000,000 |
| Genesis (5%) | 1,050,000 @ $0.03 |
| Mining (90%) | 18,900,000 (PoW) |
| LP (5%) | 1,050,000 |
| Team/VC | 0% — fair launch |

**Emission** (halving setiap 100k mints):
- Era 1: 100 HASH/mint (~69 days)
- Era 2: 50 HASH/mint
- Era 3: 25 HASH/mint
- Era 4: 12.5 HASH/mint

## 🔗 Links

- 🌐 [hash256.org](https://hash256.org)
- ⛏ [hash256.org/mine](https://hash256.org/mine)
- 📊 [hash256.org/pool](https://hash256.org/pool)
- 🐦 [@hash256dotorg](https://x.com/hash256dotorg)
- 📜 [Contract](https://etherscan.io/address/0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc)

## 📄 License

MIT
