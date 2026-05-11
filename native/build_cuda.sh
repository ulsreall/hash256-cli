#!/bin/bash
# Build CUDA miner binary
# Requires: nvidia-cuda-toolkit (apt install nvidia-cuda-toolkit)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_DIR/bin"

mkdir -p "$BIN_DIR"

echo "Building CUDA miner..."
nvcc -O3 -arch=sm_70 \
    "$SCRIPT_DIR/cuda_miner.cu" \
    -o "$BIN_DIR/hash256-cuda" \
    -lcudart

echo "✅ Built: $BIN_DIR/hash256-cuda"
