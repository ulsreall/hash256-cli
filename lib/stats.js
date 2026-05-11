class Stats {
  constructor() {
    this.startTime = Date.now();
    this.solutionsFound = 0;
    this.txSent = 0;
    this.txMined = 0;      // receipt.status === 1 (rewarded!)
    this.txReverted = 0;    // receipt.status === 0 (someone else got it)
    this.txFailed = 0;      // send error
    this.txPending = 0;
    this.roundsCompleted = 0;
    this.lastGpuHashrate = "N/A";
    this.gasSkipped = 0;
    this.lastEpoch = "";
    this.lastReward = "0";
    this.lastEra = "0";
    this.lastHashBal = "?";
    this.lastEthBal = "?";
    this.lastBaseGwei = "—";
  }

  get uptime() {
    const s = Math.floor((Date.now() - this.startTime) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  get successRate() {
    return this.txSent > 0 ? ((this.txMined / this.txSent) * 100).toFixed(0) : "0";
  }

  print() {
    const S = (v, w) => String(v).padEnd(w);
    const { uptime, successRate } = this;

    console.log();
    console.log(`┌─────────────────────────────────────────────────────────────────┐`);
    console.log(`│  📊 MINING STATUS                                               │`);
    console.log(`├─────────────────────────────────────────────────────────────────┤`);
    console.log(`│  ⚡ Hashrate    ${S(this.lastGpuHashrate, 20)}│ 🕐 Uptime   ${S(uptime, 18)}│`);
    console.log(`│  🔄 Rounds      ${S(this.roundsCompleted, 20)}│ 🎯 Found    ${S(this.solutionsFound, 18)}│`);
    console.log(`│  📤 TX Sent     ${S(this.txSent, 20)}│ ✅ Rewarded  ${S(this.txMined, 18)}│`);
    console.log(`│  ⏮️ Reverted    ${S(this.txReverted, 20)}│ ❌ Failed    ${S(this.txFailed, 18)}│`);
    console.log(`│  ⏳ Pending     ${S(this.txPending, 20)}│ ⛽ Skipped   ${S(this.gasSkipped, 18)}│`);
    console.log(`│  📈 Success %   ${S(successRate + "%", 51)}│`);
    console.log(`├─────────────────────────────────────────────────────────────────┤`);
    console.log(`│  🪙 HASH Balance: ${S(this.lastHashBal, 48)}│`);
    console.log(`│  💰 ETH Balance:  ${S(this.lastEthBal, 48)}│`);
    console.log(`│  ⛽ Base Fee:     ${S(this.lastBaseGwei, 48)}│`);
    console.log(`│  🔄 Epoch:        ${S(this.lastEpoch || "—", 48)}│`);
    console.log(`│  🏆 Reward:       ${S(this.lastReward + " HASH", 48)}│`);
    console.log(`└─────────────────────────────────────────────────────────────────┘`);
    console.log();
  }
}

module.exports = { Stats };
