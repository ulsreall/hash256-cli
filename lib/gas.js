const { ethers } = require("ethers");

class GasManager {
  constructor({ provider, priorityFeeGwei, maxGasGwei, refreshMs }) {
    this.provider = provider;
    this.priorityFeeGwei = priorityFeeGwei;
    this.maxGasGwei = maxGasGwei;
    this.refreshMs = refreshMs;
    this.cached = { baseGwei: 0, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, ts: 0 };
  }

  async refresh() {
    try {
      const block = await this.provider.getBlock("latest");
      if (block?.baseFeePerGas) {
        const baseFee = block.baseFeePerGas;
        const baseGwei = parseFloat(ethers.formatUnits(baseFee, "gwei"));
        const priority = ethers.parseUnits(this.priorityFeeGwei, "gwei");
        const maxFee = baseFee * 2n + priority; // 2x base + priority buffer
        this.cached = { baseGwei, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, ts: Date.now() };
      }
    } catch {}
  }

  async get() {
    if (Date.now() - this.cached.ts > this.refreshMs) await this.refresh();
    return this.cached;
  }

  isTooHigh() {
    return this.cached.baseGwei > this.maxGasGwei;
  }
}

async function estimateGasLimit(contract, nonce) {
  try {
    const estimate = await contract.mine.estimateGas(nonce);
    const padded = (estimate * 3n) / 2n;
    if (padded < 200000n) return 200000n;
    if (padded > 450000n) return 450000n;
    return padded;
  } catch {
    return 300000n;
  }
}

module.exports = { GasManager, estimateGasLimit };
