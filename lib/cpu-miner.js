const path = require("path");
const { Worker } = require("worker_threads");

class CpuMiner {
  constructor({ workers, batchSize, onProgress }) {
    this.workerCount = workers;
    this.batchSize = batchSize;
    this.onProgress = onProgress;
    this.workers = [];
    this.stopped = false;
    this.nextNonce = 0n;
    this.hashes = 0n;
    this.startedAt = 0;
  }

  async search({ challenge, difficulty }) {
    this.stop();
    this.stopped = false;
    this.nextNonce = randomUint64();
    this.hashes = 0n;
    this.startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const assign = (entry) => {
        if (this.stopped) return;
        const start = this.nextNonce;
        this.nextNonce += this.batchSize;
        entry.worker.postMessage({
          type: "search",
          challenge,
          difficulty: difficulty.toString(),
          start: start.toString(),
          count: this.batchSize.toString()
        });
      };

      for (let i = 0; i < this.workerCount; i++) {
        const worker = new Worker(path.join(__dirname, "cpu-worker.js"));
        const entry = { worker };
        this.workers.push(entry);

        worker.on("message", (message) => {
          if (this.stopped) return;
          if (message.type === "found") {
            this.stopped = true;
            this.stop();
            resolve({ backend: "cpu", nonce: message.nonce, hash: message.hash });
            return;
          }

          if (message.type === "done") {
            this.hashes += BigInt(message.hashes);
            this.report();
            assign(entry);
          }
        });

        worker.on("error", reject);
        assign(entry);
      }
    });
  }

  report() {
    if (!this.onProgress) return;
    const elapsedSec = Math.max(0.001, (Date.now() - this.startedAt) / 1000);
    this.onProgress({
      backend: "cpu",
      hashes: this.hashes,
      hashrate: Number(this.hashes) / elapsedSec
    });
  }

  stop() {
    this.stopped = true;
    for (const entry of this.workers) {
      entry.worker.postMessage({ type: "stop" });
      entry.worker.terminate();
    }
    this.workers = [];
  }
}

function randomUint64() {
  const buffer = new BigUint64Array(1);
  require("crypto").webcrypto.getRandomValues(buffer);
  return buffer[0];
}

module.exports = { CpuMiner };
