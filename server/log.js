const COLORS = { info: "\x1b[36m", warn: "\x1b[33m", err: "\x1b[31m", ok: "\x1b[32m" };
const RESET = "\x1b[0m";

/** Ring buffer of recent lines so the admin panel can show a live tail. */
const RING = [];
const RING_MAX = 400;

function emit(level, tag, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  const line = `${ts} [${tag}] ${msg}`;
  RING.push({ ts: Date.now(), level, tag, msg });
  if (RING.length > RING_MAX) RING.shift();
  const c = COLORS[level] ?? "";
  console.log(`${c}${line}${RESET}`);
}

export const log = {
  info: (tag, msg) => emit("info", tag, msg),
  warn: (tag, msg) => emit("warn", tag, msg),
  err: (tag, msg) => emit("err", tag, msg),
  ok: (tag, msg) => emit("ok", tag, msg),
  tail: (n = 120) => RING.slice(-n),
};
