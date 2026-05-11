#!/bin/bash
# build.sh — Build HASH256 Multi-GPU Miner
# Auto-detects GPU architecture (Pascal → Blackwell)

set -e

echo "╔═══════════════════════════════════════════════════════════════╗"
echo "║  HASH256 Multi-GPU Miner — Build Script                     ║"
echo "╚═══════════════════════════════════════════════════════════════╝"
echo ""

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

# Build list of supported SM archs from nvcc
SUPPORTED=""
while IFS= read -r line; do
    arch=$(echo "$line" | sed 's/compute_/sm_/')
    SUPPORTED="$SUPPORTED $arch"
done < <(nvcc --list-gpu-arch 2>/dev/null | grep compute_ || true)
echo "📋 Supported: $(echo $SUPPORTED | tr ' ' '\n' | sort -u | tr '\n' ' ')"
echo ""

# Default
ARCH="sm_90"
GPU_COUNT=0

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

    # Get first GPU compute capability
    GPU_CC=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1 | xargs)
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1 | xargs)
    GPU_LOWER=$(echo "$GPU_NAME" | tr '[:upper:]' '[:lower:]')

    # Convert compute capability to SM arch
    # CC "12.0" → "sm_120", CC "8.9" → "sm_89", etc.
    CC_MAJOR=$(echo "$GPU_CC" | cut -d. -f1)
    CC_MINOR=$(echo "$GPU_CC" | cut -d. -f2)
    CANDIDATE="sm_${CC_MAJOR}${CC_MINOR}"

    # Check if this arch is supported by nvcc
    if echo "$SUPPORTED" | grep -q "$CANDIDATE"; then
        ARCH="$CANDIDATE"
        echo "   → Architecture: $ARCH (compute $GPU_CC)"
    else
        # Try dropping minor version (e.g., sm_120 → sm_120, but sm_100 if sm_100 exists)
        CANDIDATE_MAJOR="sm_${CC_MAJOR}0"
        if echo "$SUPPORTED" | grep -q "$CANDIDATE_MAJOR"; then
            ARCH="$CANDIDATE_MAJOR"
            echo "   → Architecture: $ARCH (compute $GPU_CC, fallback to major)"
        else
            # Fallback to name-based
            echo "   → CC $GPU_CC ($CANDIDATE) not in nvcc supported list"
            if echo "$GPU_LOWER" | grep -q "5090\|5080\|5070\|5060\|b100\|b200"; then
                ARCH="sm_100"
            elif echo "$GPU_LOWER" | grep -q "h100\|h200"; then
                ARCH="sm_90"
            elif echo "$GPU_LOWER" | grep -q "4090\|4080\|4070\|4060\|l40"; then
                ARCH="sm_89"
            elif echo "$GPU_LOWER" | grep -q "a100"; then
                ARCH="sm_80"
            elif echo "$GPU_LOWER" | grep -q "3090\|3080\|3070\|3060\|a5000\|a6000"; then
                ARCH="sm_86"
            fi

            # Final check
            if ! echo "$SUPPORTED" | grep -q "$ARCH"; then
                echo "   → $ARCH not supported, falling back to sm_90"
                ARCH="sm_90"
            fi
            echo "   → Architecture: $ARCH (name-based fallback)"
        fi
    fi

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
echo "📦 Binary:  ./gpu-miner ($(du -h gpu-miner | cut -f1))"
echo "🎮 GPUs:    $GPU_COUNT"
echo "🏗  Arch:     $ARCH"
echo ""
echo "🚀 Run:  npm run gpu"
echo ""
