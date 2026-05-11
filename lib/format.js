function shortHex(value) {
  const text = String(value);
  return text.length <= 18 ? text : `${text.slice(0, 10)}…${text.slice(-6)}`;
}

function hashRate(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 H/s";
  const units = ["H/s", "KH/s", "MH/s", "GH/s", "TH/s"];
  let n = value;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  return `${n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)} ${units[unit]}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function pad(v, w) {
  return String(v).padEnd(w);
}

module.exports = { shortHex, hashRate, formatUptime, pad };
