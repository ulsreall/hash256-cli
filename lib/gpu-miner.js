const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

class GpuMiner {
  constructor({ binary, onProgress }) {
    this.binary = binary || defaultBinary();
    this.onProgress = onProgress;
    this.child = null;
  }

  available() {
    return fs.existsSync(this.binary);
  }

  search({ challenge, difficulty, startNonce }) {
    if (!this.available()) {
      throw new Error(`GPU miner not found: ${this.binary}`);
    }

    const challengeHex = challenge.startsWith("0x") ? challenge.slice(2) : challenge;
    const difficultyHex = difficulty.toString(16).padStart(64, "0");

    const args = [challengeHex, difficultyHex, startNonce.toString()];
    this.child = spawn(this.binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    return new Promise((resolve, reject) => {
      let stderr = "";
      this.child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      let stdout = "";
      this.child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      this.child.on("error", reject);
      this.child.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(stderr.trim() || `GPU miner exit ${code}`));
          return;
        }

        // Parse hashrate from stderr
        const hrMatch = stderr.match(/⛏\s+([\d.]+)\s+(KH\/s|MH\/s|GH\/s|H\/s)/);
        const hashrate = hrMatch ? `${hrMatch[1]} ${hrMatch[2]}` : "N/A";

        // Parse found nonce from stdout JSON
        try {
          const lines = stdout.trim().split("\n");
          for (const line of lines) {
            const json = JSON.parse(line);
            if (json.found) {
              resolve({
                backend: "gpu",
                nonce: json.nonce,
                hash: json.hash,
                hashrate
              });
              return;
            }
          }
          resolve({ found: false, hashrate });
        } catch {
          resolve({ found: false, hashrate, error: "parse_error" });
        }
      });
    });
  }

  stop() {
    if (this.child) this.child.kill();
    this.child = null;
  }
}

function defaultBinary() {
  const exe = process.platform === "win32" ? "gpu-miner.exe" : "gpu-miner";
  return path.join(__dirname, "..", exe);
}

module.exports = { GpuMiner };
