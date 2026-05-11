#!/bin/bash
# build.sh — Build HASH256 GPU Miner
# Auto-detects GPU architecture for optimal performance

set -e

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  HASH256 GPU Miner — Build Script                           ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Check nvcc
if ! command -v nvcc &>/dev/null; then
    echo "❌ nvcc not found! Install CUDA toolkit:"
    echo ""
    echo "  # Ubuntu/Debian:"
    echo "  wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb"
    echo "  sudo dpkg -i cuda-keyring_1.1-1_all.deb"
    echo "  sudo apt update && sudo apt install -y cuda-toolkit-12-4"
    echo ""
    exit 1
fi

echo "✅ nvcc: $(nvcc --version | grep release)"

# Detect GPU architecture
ARCH="sm_86"
if command -v nvidia-smi &>/dev/null; then
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
    GPU_MEM=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -1)
    GPU_SMS=$(nvidia-smi --query-gpu=count --format=csv,noheader | head -1)
    echo "🎮 GPU: $GPU_NAME ($GPU_MEM VRAM)"
    echo "📊 GPUs: $GPU_SMS"

    GPU_LOWER=$(echo "$GPU_NAME" | tr '[:upper:]' '[:lower:]')
    if echo "$GPU_LOWER" | grep -qi "h100\|h200"; then
        ARCH="sm_90"
        echo "   → Architecture: sm_90 (Hopper) 🚀"
    elif echo "$GPU_LOWER" | grep -qi "l40"; then
        ARCH="sm_89"
        echo "   → Architecture: sm_89 (Ada Lovelace)"
    elif echo "$GPU_LOWER" | grep -qi "a100"; then
        ARCH="sm_80"
        echo "   → Architecture: sm_80 (Ampere)"
    elif echo "$GPU_LOWER" | grep -qi "4090\|4080\|4070\|4060"; then
        ARCH="sm_89"
        echo "   → Architecture: sm_89 (Ada Lovelace)"
    elif echo "$GPU_LOWER" | grep -qi "3090\|3080\|3070\|3060\|a5000\|a4000\|a6000"; then
        ARCH="sm_86"
        echo "   → Architecture: sm_86 (Ampere)"
    elif echo "$GPU_LOWER" | grep -qi "v100"; then
        ARCH="sm_70"
        echo "   → Architecture: sm_70 (Volta)"
    elif echo "$GPU_LOWER" | grep -qi "2080\|2070\|2060\|titan"; then
        ARCH="sm_75"
        echo "   → Architecture: sm_75 (Turing)"
    elif echo "$GPU_LOWER" | grep -qi "1080\|1070\|1060"; then
        ARCH="sm_61"
        echo "   → Architecture: sm_61 (Pascal)"
    else
        echo "   → Unknown GPU, default: sm_86"
    fi
else
    echo "⚠️  nvidia-smi not found, default: $ARCH"
fi

echo ""
echo "🔨 Compiling gpu-miner (arch=$ARCH)..."
echo ""

nvcc -O3 \
    -arch="$ARCH" \
    --use_fast_math \
    -maxrregcount=64 \
    -t 0 \
    -o gpu-miner \
    gpu-miner.cu \
    -lcudart

echo ""
echo "✅ Build successful!"
echo ""
echo "📦 Binary: ./gpu-miner ($(du -h gpu-miner | cut -f1))"
echo ""
echo "🚀 Quick start:"
echo "   cp .env.example .env && nano .env"
echo "   npm run gpu"
echo ""
