#!/bin/bash
# build.sh — Build HASH256 Multi-GPU Miner
# Auto-detects GPU architecture (Pascal → Blackwell)

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
    echo "  apt update && apt install -y cuda-toolkit-12-8"
    echo ""
    exit 1
fi

NVCC_VER=$(nvcc --version | grep release | awk '{print $6}' | cut -c2-)
echo "✅ nvcc: CUDA $NVCC_VER"

# Get supported architectures
echo "📋 Supported archs:"
nvcc --list-gpu-arch 2>/dev/null | head -20 || true
echo ""

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
        GPU_CC=$(nvidia-smi -i $i --query-gpu=compute_cap --format=csv,noheader | xargs)
        echo "  [$i] $GPU_NAME ($GPU_MEM) — Compute $GPU_CC"
    done
    echo ""

    # Use first GPU for arch detection
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1 | xargs)
    GPU_CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | xargs)
    GPU_LOWER=$(echo "$GPU_NAME" | tr '[:upper:]' '[:lower:]')

    # Map compute capability to arch flag
    # First try by compute capability (most reliable)
    case "$GPU_CC" in
        10.0|10.1|10.2|10.3)
            ARCH="sm_100"
            echo "   → Architecture: sm_100 (Blackwell) 🔥🔥🔥"
            ;;
        9.0|9.1|9.2|9.3)
            ARCH="sm_90"
            echo "   → Architecture: sm_90 (Hopper)"
            ;;
        8.9)
            ARCH="sm_89"
            echo "   → Architecture: sm_89 (Ada Lovelace)"
            ;;
        8.6)
            ARCH="sm_86"
            echo "   → Architecture: sm_86 (Ampere)"
            ;;
        8.0)
            ARCH="sm_80"
            echo "   → Architecture: sm_80 (Ampere)"
            ;;
        7.5)
            ARCH="sm_75"
            echo "   → Architecture: sm_75 (Turing)"
            ;;
        7.0)
            ARCH="sm_70"
            echo "   → Architecture: sm_70 (Volta)"
            ;;
        6.1)
            ARCH="sm_61"
            echo "   → Architecture: sm_61 (Pascal)"
            ;;
        *)
            # Fallback: detect by name
            echo "   → Unknown compute cap $GPU_CC, trying name detection..."
            if echo "$GPU_LOWER" | grep -q "5090\|5080\|5070\|5060\|b100\|b200"; then
                ARCH="sm_100"
                echo "   → Architecture: sm_100 (Blackwell)"
            elif echo "$GPU_LOWER" | grep -q "h100\|h200"; then
                ARCH="sm_90"
                echo "   → Architecture: sm_90 (Hopper)"
            elif echo "$GPU_LOWER" | grep -q "4090\|4080\|4070\|4060\|l40"; then
                ARCH="sm_89"
                echo "   → Architecture: sm_89 (Ada Lovelace)"
            elif echo "$GPU_LOWER" | grep -q "a100"; then
                ARCH="sm_80"
                echo "   → Architecture: sm_80 (Ampere)"
            elif echo "$GPU_LOWER" | grep -q "3090\|3080\|3070\|3060\|a5000\|a6000"; then
                ARCH="sm_86"
                echo "   → Architecture: sm_86 (Ampere)"
            else
                echo "   → Default: $ARCH"
            fi
            ;;
    esac

    if [ "$GPU_COUNT" -gt 1 ]; then
        echo "   → Multi-GPU mode: $GPU_COUNT GPUs 🔥"
    fi
else
    echo "⚠️  nvidia-smi not found, default: $ARCH"
fi

# Check if arch is supported by nvcc
if ! nvcc --list-gpu-arch 2>/dev/null | grep -q "$ARCH"; then
    echo ""
    echo "⚠️  $ARCH not supported by nvcc $NVCC_VER"
    echo "   Falling back to sm_90"
    ARCH="sm_90"
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
echo "🏗  Arch:    $ARCH"
echo ""
echo "🚀 Run:  npm run gpu"
echo ""
