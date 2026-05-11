const { ethers } = require("ethers");
const { estimateGasLimit } = require("./gas");

class TxManager {
  constructor({ contract, provider, wallet, gasManager, stats, options }) {
    this.contract = contract;
    this.provider = provider;
    this.wallet = wallet;
    this.gas = gasManager;
    this.stats = stats;
    this.gasLimit = options.gasLimit;
    this.txTimeout = options.txTimeout;
    this.maxPending = options.maxPending;
  }

  log(msg) {
    const ts = () => new Date().toLocaleTimeString("en-GB", { hour12: false });
    console.log(`[${ts()}] ${msg}`);
  }

  // Wait for pending slot
  waitForSlot() {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.stats.txPending < this.maxPending) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });
  }

  // Fire-and-forget TX + background receipt poll
  async fireAndForget(nonce, hashHex) {
    this.stats.txSent++;
    this.stats.txPending++;
    const shortHash = hashHex.slice(0, 10) + "…";

    try {
      const gasParams = await this.gas.get();
      const gasLimit = await estimateGasLimit(this.contract, nonce);

      const tx = await this.contract.mine(nonce, {
        gasLimit,
        type: 2,
        maxFeePerGas: gasParams.maxFeePerGas,
        maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
      });

      const shortTx = tx.hash.slice(0, 10) + "…";
      this.log(`📤 ${shortHash} → ${shortTx}  [etherscan.io/tx/${tx.hash}]`);

      // Background receipt poll
      this.pollReceipt(tx.hash, shortHash, shortTx);

      return true;
    } catch (err) {
      this.stats.txFailed++;
      this.stats.txPending--;
      const msg = err.shortMessage || err.message || String(err);
      if (msg.includes("nonce")) {
        this.log(`⏭️ ${shortHash} nonce conflict — skipping`);
      } else {
        this.log(`❌ ${shortHash} TX error: ${msg.slice(0, 80)}`);
      }
      return false;
    }
  }

  pollReceipt(txHash, shortHash, shortTx) {
    const startTime = Date.now();

    const poll = async () => {
      try {
        const receipt = await this.provider.getTransactionReceipt(txHash);

        if (receipt) {
          this.stats.txPending--;

          if (receipt.status === 1) {
            this.stats.txMined++;
            this.log(`✅ ${shortTx} REWARDED in block ${receipt.blockNumber}  [${this.stats.txMined}/${this.stats.txSent}]`);

            // Refresh HASH balance
            try {
              const bal = await this.contract.balanceOf(this.wallet.address);
              this.stats.lastHashBal = parseFloat(ethers.formatUnits(bal, 18)).toFixed(1);
            } catch {}
          } else {
            this.stats.txReverted++;
            this.log(`⏮️ ${shortTx} REVERTED in block ${receipt.blockNumber} — too slow  [${this.stats.txMined}/${this.stats.txSent}]`);
          }
          return;
        }

        if (Date.now() - startTime < this.txTimeout) {
          setTimeout(poll, 2000);
        } else {
          this.stats.txPending--;
          this.stats.txFailed++;
          this.log(`⏱️ ${shortTx} timeout ${this.txTimeout / 1000}s — may still confirm`);
        }
      } catch {
        if (Date.now() - startTime < this.txTimeout) {
          setTimeout(poll, 3000);
        } else {
          this.stats.txPending--;
        }
      }
    };

    setTimeout(poll, 3000);
  }
}

module.exports = { TxManager };
