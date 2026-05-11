#!/bin/bash
# build.sh — Build HASH256 Multi-GPU Miner
# Auto-detects GPU architecture

set -e

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  HASH256 Multi-GPU Miner — Build Script                     ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

# Check nvcc
if ! command -v nvcc &>/dev/null; then
    echo "❌ nvcc not found!"
    echo ""
    echo "Install CUDA toolkit:"
    echo "  apt update && apt install -y wget"
    echo "  wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb"
    echo "  dpkg -i cuda-keyring_1.1-1_all.deb"
    echo "  apt update && apt install -y cuda-toolkit-12-4"
    echo ""
    exit 1
fi

NVCC_VER=$(nvcc --version | grep release | awk '{print $6}' | cut -c2-)
echo "✅ nvcc: CUDA $NVCC_VER"

# Default
ARCH="sm_89"
GPU_COUNT=0

# Detect GPUs
if command -v nvidia-smi &>/dev/null; then
    GPU_COUNT=$(nvidia-smi --query-gpu=count --format=csv,noheader | head -1 | xargs)
    echo "🎮 GPU Count: $GPU_COUNT"
    echo ""

    for i in $(seq 0 $((GPU_COUNT - 1))); do
        GPU_NAME=$(nvidia-smi -i $i --query-gpu=name --format=csv,noheader | xargs)
        GPU_MEM=$(nvidia-smi -i $i --query-gpu=memory.total --format=csv,noheader | xargs)
        echo "  [$i] $GPU_NAME ($GPU_MEM)"
    done
    echo ""

    # Use first GPU for arch detection
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1 | xargs)
    GPU_LOWER=$(echo "$GPU_NAME" | tr '[:upper:]' '[:lower:]')

    if echo "$GPU_LOWER" | grep -q "h100\|h200"; then
        ARCH="sm_90"
    elif echo "$GPU_LOWER" | grep -q "l40\|l40s"; then
        ARCH="sm_89"
    elif echo "$GPU_LOWER" | grep -q "a100"; then
        ARCH="sm_80"
    elif echo "$GPU_LOWER" | grep -q "4090\|4080\|4070\|4060"; then
        ARCH="sm_89"
    elif echo "$GPU_LOWER" | grep -q "3090\|3080\|3070\|3060\|a5000\|a4000\|a6000"; then
        ARCH="sm_86"
    elif echo "$GPU_LOWER" | grep -q "v100"; then
        ARCH="sm_70"
    elif echo "$GPU_LOWER" | grep -q "2080\|2070\|2060\|titan"; then
        ARCH="sm_75"
    elif echo "$GPU_LOWER" | grep -q "1080\|1070\|1060"; then
        ARCH="sm_61"
    fi

    echo "   → Architecture: $ARCH"
    if [ "$GPU_COUNT" -gt 1 ]; then
        echo "   → Multi-GPU mode: $GPU_COUNT GPUs 🔥"
    fi
else
    echo "⚠️  nvidia-smi not found, default: $ARCH"
fi

echo ""
echo "🔨 Compiling gpu-miner (arch=$ARCH, multi-GPU, pthread)..."
echo ""

nvcc -O3 \
    -arch="$ARCH" \
    --use_fast_math \
    -maxrregcount=64 \
    -t 0 \
    -o gpu-miner \
    gpu-miner.cu \
    -lcudart \
    -lpthread

echo ""
echo "✅ Build successful!"
echo ""
echo "📦 Binary: ./gpu-miner ($(du -h gpu-miner | cut -f1))"
echo "🎮 GPUs:   $GPU_COUNT"
echo ""
echo "🚀 Run:  npm run gpu"
echo ""
