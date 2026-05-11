# HASH256 CLI Miner

CLI miner for **$HASH** — a browser-mined post-quantum token on Ethereum mainnet. Source: [hash256.org](https://hash256.org)

Script ini mengambil challenge dari smart contract, mencari nonce yang memenuhi difficulty target, lalu submit transaksi `mine(nonce)` ke Ethereum mainnet.

> **v2.0** — major improvements: colored output, real-time hashrate stats, gas management, graceful shutdown, wallet balance display, supply progress bar.

## ✨ Features

- 🎨 **Colored terminal output** with timestamps and formatted stats
- ⛏  **Real-time hashrate tracking** with rolling average
- ⛽ **Gas management** — skip TX if gas too high, auto-wait for drop
- 📊 **Live stats** — hashes, found, TX success/fail, uptime
- 🔄 **Auto re-challenge** — detects epoch changes and fetches fresh challenge
- 🪙 **Wallet balance display** — ETH and HASH balance on start
- 📈 **Supply progress bar** in check-state
- 🛑 **Graceful shutdown** — Ctrl+C shows final stats

## ⚠️ Peringatan

- Mining ini memakai **Ethereum mainnet** — butuh ETH untuk gas
- **Jangan pakai private key wallet utama** — buat wallet baru khusus mining
- **Jangan commit file `.env`** — sudah di `.gitignore`
- Verifikasi kontrak: [Etherscan](https://etherscan.io/address/0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc)

## 📦 Kebutuhan

- Ubuntu / VPS / macOS / Windows (WSL)
- Node.js 18+
- npm
- Wallet Ethereum dengan ETH untuk gas
- RPC endpoint (gratis: PublicNode, Alchemy, Infura)

## 🚀 Install

### 1. Install Node.js

**Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install -y curl ca-certificates gnupg
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt install -y nodejs
node -v  # should be v18+
```

**macOS:**
```bash
brew install node
```

### 2. Setup Project

```bash
git clone https://github.com/mrfunntastiic/hash256-cli
cd hash256-cli
npm install
cp .env.example .env
nano .env
```

### 3. Configure `.env`

```env
RPC_URL=https://ethereum-rpc.publicnode.com
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
```

**Optional config:**
```env
MAX_GAS_GWEI=50        # Skip TX if gas > this (default: 50)
GAS_LIMIT=300000        # TX gas limit (default: 300000)
RETRY_DELAY=5000        # Delay on error in ms (default: 5000)
```

Simpan di nano: `CTRL + X` → `Y` → `Enter`

## 📊 Cek State Kontrak

```bash
npm run check
```

Output:
```
────────────────────────────────────────────────────────────────
  🌍 GENESIS STATE
────────────────────────────────────────────────────────────────
  Total Sold:      1,050,000 HASH
  Total Raised:    10.5 ETH
  Max Supply:      1,050,000 HASH
  Complete:        ✓ Yes

────────────────────────────────────────────────────────────────
  ⛏  MINING STATE
────────────────────────────────────────────────────────────────
  Era:              Era 1
  Reward:           100 HASH per mint
  Total Minted:     12,345
  Remaining:        18,887,655
  Epoch:            1

  Supply Progress:
  [█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0.07%

────────────────────────────────────────────────────────────────
  🔑 WALLET
────────────────────────────────────────────────────────────────
  Address:     0x...
  ETH Balance:  0.1 ETH
  HASH Balance: 200 HASH
```

## ⛏ Jalankan Miner

```bash
npm start
```

Atau langsung:
```bash
node miner.js
```

Contoh output:

```
  ██╗  ██╗ █████╗ ███████╗██╗  ██╗
  ██║  ██║██╔══██╗██╔════╝██║  ██║
  ███████║███████║███████╗███████║
  ██╔══██║██╔══██║╚════██║██╔══██║
  ██║  ██║██║  ██║███████║██║  ██║
  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
  CLI Miner v2.0 · Ethereum Mainnet · hash256.org

[10:30:45] 💰 ETH Balance: 0.100000 ETH
[10:30:45] 🪙 HASH Balance: 0 HASH
[10:30:46] ⛽ Current Gas: 12.3 gwei
[10:30:46] ⛏  Mining started! Press Ctrl+C to stop.

[10:31:00] 🔄 New epoch · fetching fresh challenge
  Era: 1  │  Reward: 100 HASH  │  Epoch: 1

  ⛏  Hashrate  1,234 H/s    │  Hashes  615,000         │  Uptime  5m 30s
  🎯 Found  0                │  TX OK  0                │  TX Fail  0

[10:35:12] 🎯 FOUND nonce: 8472915643
[10:35:12]    Hash: 0x0000000a3f...
[10:35:13] 📤 TX sent: https://etherscan.io/tx/0x...
[10:35:20] ✅ Confirmed in block 19234567
[10:35:20] 🪙 HASH Balance: 100 HASH
```

## 🖥 Run di Background (tmux/screen)

```bash
# Pakai tmux
tmux new -s hash256
npm start
# Detach: CTRL+B, D
# Reattach: tmux attach -t hash256

# Atau pakai screen
screen -S hash256
npm start
# Detach: CTRL+A, D
# Reattach: screen -r hash256
```

## 🔧 Error Umum

| Error | Penyebab | Solusi |
|-------|----------|--------|
| `Missing RPC_URL or PRIVATE_KEY` | `.env` belum diisi | `cp .env.example .env && nano .env` |
| `PRIVATE_KEY must be valid hex` | Format key salah | Harus `0x` + 64 hex chars |
| `insufficient funds` | ETH habis | Kirim ETH ke wallet mining |
| `InsufficientWork` | Nonce sudah expired | Normal — miner auto-retry |
| `execution reverted` | State berubah | Normal — miner auto-retry |
| `Gas too high` | Gas > MAX_GAS_GWEI | Miner auto-wait, atau turunkan limit |
| `npm: command not found` | Node.js belum install | `sudo apt install -y nodejs npm` |

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
- 📄 [Whitepaper](https://hash256.org)
- 📜 [Contract (Etherscan)](https://etherscan.io/address/0xAC7b5d06fa1e77D08aea40d46cB7C5923A87A0cc)

## 📄 License

MIT
