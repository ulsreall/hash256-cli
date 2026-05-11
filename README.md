# HASH256 CLI Miner

GPU + CPU CLI miner for **$HASH** — a browser-mined post-quantum token on Ethereum mainnet. Source: [hash256.org](https://hash256.org)

## ⚡ Modes

| Mode | Command | Speed | Requirement |
|------|---------|-------|-------------|
| **GPU** | `npm run gpu` | ~500+ MH/s | NVIDIA GPU + CUDA |
| **CPU** | `npm start` | ~5-10 KH/s | Node.js 18+ |

## ✨ Features

### GPU Miner (CUDA)
- ⚡ **CUDA keccak-256** — runs PoW directly on GPU, ~100x faster than CPU
- 🎮 **Auto GPU detection** — picks best GPU, auto-selects architecture
- 📊 **Real-time hashrate** displayed in stderr
- 🔄 **Smart retry** — epoch changes, gas management

### CPU Miner (Node.js)
- 🧵 **Multi-threaded** — uses all CPU cores via `worker_threads`
- ⛏  **Real-time hashrate** with rolling average
- 📊 **CPU load display** in stats

### Both Modes
- 🎨 **Colored terminal output** with timestamps
- ⛽ **Gas management** — auto-wait if gas too high
- 🪙 **Wallet balance display** — ETH and HASH on start
- 🛑 **Graceful shutdown** — Ctrl+C shows final stats
- 🔄 **Auto re-challenge** — detects epoch changes

## ⚠️ Peringatan

- Mining memakai **Ethereum mainnet** — butuh ETH untuk gas
- **Jangan pakai private key wallet utama** — buat wallet khusus mining
- **Jangan commit file `.env`**
- Verifikasi kontrak: [Etherscan](https://etherscan.io/address/0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc)

## 🚀 Quick Start

### 1. Install

```bash
git clone https://github.com/ulsreall/hash256-cli
cd hash256-cli
npm install
```

### 2. Configure

```bash
cp .env.example .env
nano .env
```

Isi minimal:
```env
RPC_URL=https://ethereum-rpc.publicnode.com
PRIVATE_KEY=0xYOUR_PRIVATE_KEY
```

### 3. Run

**GPU Mining** (NVIDIA GPU required):
```bash
# Build CUDA binary first
bash build.sh

# Run
npm run gpu
```

**CPU Mining** (any machine):
```bash
npm start
```

**Check contract state:**
```bash
npm run check
```

## 🛠 Build GPU Miner

### Prerequisites
- NVIDIA GPU (RTX 20xx / 30xx / 40xx recommended)
- CUDA Toolkit 12+

### Install CUDA (Ubuntu)
```bash
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt update
sudo apt install -y cuda-toolkit-12-4
```

### Build
```bash
bash build.sh
```

Auto-detects GPU architecture (sm_75 for RTX 20xx, sm_86 for RTX 30xx, etc).

### Supported Architectures
| GPU | Architecture | Flag |
|-----|-------------|------|
| GTX 10xx | Pascal | sm_61 |
| RTX 20xx | Turing | sm_75 |
| RTX 30xx / A5000 | Ampere | sm_86 |
| RTX 40xx | Ada Lovelace | sm_89 |
| V100 | Volta | sm_70 |
| A100 | Ampere | sm_80 |

## 🖥 Run di Background

```bash
# tmux
tmux new -s hash256
npm run gpu    # atau npm start
# Detach: CTRL+B, D
# Reattach: tmux attach -t hash256

# screen
screen -S hash256
npm run gpu
# Detach: CTRL+A, D
# Reattach: screen -r hash256
```

## 🔧 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | (required) | Ethereum RPC endpoint |
| `PRIVATE_KEY` | (required) | Wallet private key (0x...) |
| `THREADS` | CPU count - 1 | Worker threads (CPU miner only) |
| `BATCH_SIZE` | 100000 | Hashes per worker report (CPU miner) |
| `MAX_GAS_GWEI` | 50 | Max gas price to submit TX |
| `GAS_LIMIT` | 300000 | TX gas limit |
| `RETRY_DELAY` | 5000 | Delay (ms) on error |

## 🔧 Error Umum

| Error | Penyebab | Solusi |
|-------|----------|--------|
| `gpu-miner not found` | Belum build | `bash build.sh` |
| `No CUDA devices` | Gak ada GPU | Pakai `npm start` (CPU) |
| `Missing RPC_URL` | `.env` kosong | `cp .env.example .env` |
| `insufficient funds` | ETH habis | Kirim ETH ke wallet |
| `InsufficientWork` | Nonce expired | Auto-retry |
| `nvcc not found` | CUDA belum install | Install CUDA toolkit |

## 📐 Tokenomics

| | |
|---|---|
| **Token** | $HASH |
| **Supply** | 21,000,000 |
| **Genesis (5%)** | 1,050,000 @ $0.03 |
| **Mining (90%)** | 18,900,000 (PoW) |
| **LP (5%)** | 1,050,000 (hook mints) |
| **Team/VC** | 0% — fair launch |

**Emission (halving setiap 100k mints):**
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
