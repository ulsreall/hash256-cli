#!/bin/bash
# setup.sh — One-command setup for HASH256 Miner on any VPS
# Run: bash setup.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

echo ""
echo -e "${CYAN}${BOLD}  ██╗  ██╗ █████╗ ███████╗██╗  ██╗${NC}"
echo -e "${CYAN}${BOLD}  ██║  ██║██╔══██╗██╔════╝██║  ██║${NC}"
echo -e "${CYAN}${BOLD}  ███████║███████║███████╗███████║${NC}"
echo -e "${CYAN}${BOLD}  ██╔══██║██╔══██║╚════██║██╔══██║${NC}"
echo -e "${CYAN}${BOLD}  ██║  ██║██║  ██║███████║██║  ██║${NC}"
echo -e "${CYAN}${BOLD}  ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝${NC}"
echo -e "${DIM}  One-click VPS Setup · GPU + CPU Miner${NC}"
echo ""

# ─── System Info ─────────────────────────────────────────────────
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}📋 System Info${NC}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "  OS:     $(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d= -f2 | tr -d '"' || uname -s)"
echo -e "  Kernel: $(uname -r)"
echo -e "  CPU:    $(nproc) cores · $(cat /proc/cpuinfo 2>/dev/null | grep 'model name' | head -1 | cut -d: -f2 | xargs || echo 'Unknown')"
echo -e "  RAM:    $(free -h | awk '/Mem:/ {print $2}')"
echo -e "  Disk:   $(df -h / | awk 'NR==2 {print $2 " total, " $4 " free"}')"

if command -v nvidia-smi &>/dev/null; then
    echo -e "  GPU:    $(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
    echo -e "  VRAM:   $(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -1)"
else
    echo -e "  GPU:    ${YELLOW}Not detected (CPU mining only)${NC}"
fi
echo ""

# ─── Step 1: Install Node.js ────────────────────────────────────
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}📦 Step 1/5: Node.js${NC}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if command -v node &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Node.js $(node -v) already installed"
else
    echo -e "  ${YELLOW}→${NC} Installing Node.js 22..."
    apt update -qq && apt install -y -qq curl ca-certificates gnupg > /dev/null 2>&1
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
    apt install -y -qq nodejs > /dev/null 2>&1
    echo -e "  ${GREEN}✓${NC} Node.js $(node -v) installed"
fi

# ─── Step 2: Install CUDA ───────────────────────────────────────
echo ""
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}🎮 Step 2/5: CUDA Toolkit${NC}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if command -v nvcc &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} CUDA $(nvcc --version | grep release | awk '{print $6}' | cut -c2-) already installed"
else
    if command -v nvidia-smi &>/dev/null; then
        echo -e "  ${YELLOW}→${NC} Installing CUDA toolkit..."
        # Detect Ubuntu version
        UBUNTU_VER=$(lsb_release -rs 2>/dev/null | cut -d. -f1)
        if [ -z "$UBUNTU_VER" ]; then UBUNTU_VER="22"; fi

        wget -q https://developer.download.nvidia.com/compute/cuda/repos/ubuntu${UBUNTU_VER}04/x86_64/cuda-keyring_1.1-1_all.deb
        dpkg -i cuda-keyring_1.1-1_all.deb > /dev/null 2>&1
        apt update -qq > /dev/null 2>&1
        apt install -y -qq cuda-toolkit-12-4 > /dev/null 2>&1
        rm -f cuda-keyring_1.1-1_all.deb

        # Add to PATH
        export PATH="/usr/local/cuda/bin:$PATH"
        echo 'export PATH="/usr/local/cuda/bin:$PATH"' >> ~/.bashrc
        echo -e "  ${GREEN}✓${NC} CUDA toolkit installed"
    else
        echo -e "  ${YELLOW}⚠${NC}  No NVIDIA GPU detected — skipping CUDA"
        echo -e "  ${DIM}   CPU mining will be used${NC}"
    fi
fi

# ─── Step 3: Setup Project ──────────────────────────────────────
echo ""
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}📁 Step 3/5: Project Setup${NC}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

cd "$(dirname "$0")"

echo -e "  ${YELLOW}→${NC} Installing dependencies..."
npm install --silent 2>/dev/null
echo -e "  ${GREEN}✓${NC} Dependencies installed"

# ─── Step 4: Build GPU Miner ────────────────────────────────────
echo ""
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}🔨 Step 4/5: Build GPU Miner${NC}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if command -v nvcc &>/dev/null; then
    bash build.sh
else
    echo -e "  ${YELLOW}⚠${NC}  Skipping — no CUDA toolkit"
    echo -e "  ${DIM}   Use: npm start (CPU mode)${NC}"
fi

# ─── Step 5: Configure .env ─────────────────────────────────────
echo ""
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}⚙️  Step 5/5: Configuration${NC}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [ -f .env ]; then
    echo -e "  ${GREEN}✓${NC} .env already exists"
else
    cp .env.example .env
    echo -e "  ${GREEN}✓${NC} Created .env from template"
    echo -e "  ${YELLOW}⚠${NC}  You MUST edit .env and add your PRIVATE_KEY!"
    echo ""
    echo -e "  ${BOLD}Edit now:${NC}"
    echo -e "  ${CYAN}nano .env${NC}"
    echo ""
    echo -e "  ${DIM}Set RPC_URL and PRIVATE_KEY, then save (CTRL+X → Y → Enter)${NC}"
fi

# ─── Done ────────────────────────────────────────────────────────
echo ""
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  ✅ Setup Complete!${NC}"
echo -e "${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo ""
echo -e "  1. Edit .env:    ${CYAN}nano .env${NC}"
echo -e "  2. Run GPU:      ${CYAN}npm run gpu${NC}"
echo -e "     Run CPU:      ${CYAN}npm start${NC}"
echo -e "  3. Check state:  ${CYAN}npm run check${NC}"
echo ""
echo -e "  ${DIM}Tip: use tmux/screen to keep mining after disconnect:${NC}"
echo -e "  ${CYAN}tmux new -s hash${NC} → ${CYAN}npm run gpu${NC} → ${CYAN}CTRL+B, D${NC}"
echo ""
