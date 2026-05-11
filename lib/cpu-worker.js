const { parentPort } = require("worker_threads");
const { ethers } = require("ethers");

let stopped = false;

parentPort.on("message", (message) => {
  if (message.type === "stop") {
    stopped = true;
    return;
  }

  if (message.type !== "search") return;
  stopped = false;

  const challenge = message.challenge;
  const difficulty = BigInt(message.difficulty);
  let nonce = BigInt(message.start);
  const end = nonce + BigInt(message.count);

  while (!stopped && nonce < end) {
    const hash = ethers.solidityPackedKeccak256(["bytes32", "uint256"], [challenge, nonce]);
    if (BigInt(hash) < difficulty) {
      parentPort.postMessage({ type: "found", nonce: nonce.toString(), hash });
      return;
    }
    nonce++;
  }

  parentPort.postMessage({ type: stopped ? "stopped" : "done", hashes: (end - BigInt(message.start)).toString() });
});
