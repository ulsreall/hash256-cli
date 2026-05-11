#!/bin/bash
# Build CUDA miner binary
# No hardcoded architecture — auto-detects from system
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$PROJECT_DIR/bin"

mkdir -p "$BIN_DIR"

echo "Building CUDA miner..."
nvcc --version 2>&1 | head -4
echo ""

# Compile without -arch (uses nvcc's default target)
# The binary will JIT-compile for the actual GPU at runtime
nvcc -O3 \
    -Xcompiler -Wall \
    "$SCRIPT_DIR/cuda_miner.cu" \
    -o "$BIN_DIR/hash256-cuda" \
    -lcudart

echo ""
echo "✅ Built: $BIN_DIR/hash256-cuda"
