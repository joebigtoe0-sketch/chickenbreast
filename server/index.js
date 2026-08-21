import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import { PublicKey } from "@solana/web3.js";
import { ROOT, cfg, env, publicConfig, updateConfig } from "./config.js";
import { log } from "./log.js";
import { startSensors, getSensors, onSensors, resetExperiment } from "./sensors.js";
import { startStats, getStats, onStats, refreshNow } from "./stats.js";
import { startFeed, getFeed, onFeed, feedConnected } from "./feed.js";
import { startAutobuy, autobuyStatus, getTrades, onTrade } from "./autobuy.js";
import { startPositions, positionsSummary, getPositions, closeAll } from "./positions.js";
import { loadWallet, setWalletSecret, clearWallet, walletPubkey, solBalance, walletSource } from "./wallet.js";
import { executeBuy } from "./pump.js";

const app = express();
app.use(express.json({ limit: "64kb" }));

// ---------------------------------------------------------------- admin auth
// Single shared password (ADMIN_PASSWORD) traded for a bearer token. Tokens
// live in memory only, so a restart logs the panel out — which is what you
// want for a page that can hand a private key to a trading bot.
const SESSION_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const attempts = new Map();

function issueToken() {
  const t = crypto.randomBytes(24).toString("hex");
  sessions.set(t, Date.now() + SESSION_MS);
  return t;
}

function validToken(t) {
  const exp = sessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(t);
    return false;
  }
  return true;
}

function requireAdmin(req, res, next) {
  const t = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!validToken(t)) return res.status(401).json({ error: "unauthorized" });
  next();
}

app.post("/api/admin/login", (req, res) => {
  const ip = req.ip ?? "?";
  const rec = attempts.get(ip) ?? { n: 0, until: 0 };
  if (Date.now() < rec.until) return res.status(429).json({ error: "too many attempts, wait a minute" });

  if (!env.adminPassword) return res.status(500).json({ error: "ADMIN_PASSWORD is not set in .env" });
  const given = String(req.body?.password ?? "");
  const ok =
    given.length === env.adminPassword.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(env.adminPassword));
  if (!ok) {
    rec.n++;
    if (rec.n >= 5) {
      rec.n = 0;
      rec.until = Date.now() + 60_000;
    }
    attempts.set(ip, rec);
    return res.status(401).json({ error: "wrong password" });
  }
  attempts.delete(ip);
  res.json({ token: issueToken() });
});

/**
 * Railway healthcheck. Deliberately thin: this URL is public, so it reports
 * whether the process is doing its job and nothing about the wallet, the book,
 * or whether the buyer is armed.
 */
app.get("/health", (_req, res) => {
  const sensors = getSensors();
  const stats = getStats();
  res.json({
    ok: true,
    uptimeS: Math.round(process.uptime()),
    feed: feedConnected() ? "connected" : "reconnecting",
    sensorsAgeS: sensors.ts ? Math.round((Date.now() - sensors.ts) / 1000) : null,
    statsAgeS: stats.updatedAt ? Math.round((Date.now() - stats.updatedAt) / 1000) : null,
    contractSet: Boolean(cfg.contractAddress),
  });
});

// --------------------------------------------------------------- public data
app.get("/api/bootstrap", (_req, res) => {
  res.json({ config: publicConfig(), stats: getStats(), sensors: getSensors(), feed: getFeed(), feedConnected: feedConnected() });
});

// ------------------------------------------------------------- admin actions
app.get("/api/admin/state", requireAdmin, async (_req, res) => {
  const pk = walletPubkey();
  res.json({
    config: cfg,
    wallet: { address: pk?.toBase58() ?? null, balanceSol: pk ? await solBalance() : 0, source: walletSource() },
    autobuy: autobuyStatus(),
    positions: { summary: positionsSummary(), list: getPositions(40) },
    trades: getTrades(30),
    stats: getStats(),
    log: log.tail(80),
  });
});

app.post("/api/admin/config", requireAdmin, (req, res) => {
  const patch = req.body ?? {};
  if (patch.contractAddress != null) {
    const ca = String(patch.contractAddress).trim();
    if (ca) {
      try {
        new PublicKey(ca);
      } catch {
        return res.status(400).json({ error: "that is not a valid Solana address" });
      }
    }
    patch.contractAddress = ca;
  }
  const before = cfg.contractAddress;
  updateConfig(patch);
  if (cfg.contractAddress !== before) {
    log.ok("admin", `contract address set to ${cfg.contractAddress || "(cleared)"}`);
    refreshNow();
  }
  broadcast("config", publicConfig());
  res.json({ ok: true, config: cfg });
});

/** Restart the experiment: uptime to zero, clips back to opening readings. */
app.post("/api/admin/reset-experiment", requireAdmin, (_req, res) => {
  const at = resetExperiment();
  log.warn("admin", "experiment clock reset — uptime back to zero, clips re-seeded");
  broadcast("config", publicConfig());
  res.json({ ok: true, experimentStart: at });
});

app.post("/api/admin/wallet", requireAdmin, (req, res) => {
  try {
    const address = setWalletSecret(req.body?.secret);
    res.json({ ok: true, address });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

app.delete("/api/admin/wallet", requireAdmin, (_req, res) => {
  try {
    clearWallet();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

app.post("/api/admin/autobuy", requireAdmin, (req, res) => {
  const a = req.body ?? {};
  const clean = {};
  if (a.enabled != null) clean.enabled = Boolean(a.enabled);
  if (a.dryRun != null) clean.dryRun = Boolean(a.dryRun);
  const nums = {
    takeProfitPct: [1, 10_000],
    stopLossPct: [1, 99],
    minMcUsd: [0, 10_000_000],
    maxOpenPositions: [1, 200],
    sellSlippagePct: [1, 100],
    amountSol: [0.001, 5],
    minIntervalS: [5, 3600],
    maxIntervalS: [5, 3600],
    dailyCapSol: [0, 1000],
    reserveSol: [0, 100],
    slippagePct: [1, 100],
    priorityFeeMicroLamports: [0, 5000000],
    maxAgeS: [10, 3600],
  };
  for (const [k, [lo, hi]] of Object.entries(nums)) {
    if (a[k] == null) continue;
    const v = Number(a[k]);
    if (!Number.isFinite(v) || v < lo || v > hi) {
      return res.status(400).json({ error: `${k} must be between ${lo} and ${hi}` });
    }
    clean[k] = v;
  }
  const min = clean.minIntervalS ?? cfg.autobuy.minIntervalS;
  const max = clean.maxIntervalS ?? cfg.autobuy.maxIntervalS;
  if (min > max) return res.status(400).json({ error: "min interval cannot exceed max interval" });
  const goingLive = (clean.enabled ?? cfg.autobuy.enabled) && !(clean.dryRun ?? cfg.autobuy.dryRun);
  if (goingLive && !loadWallet()) {
    return res.status(400).json({ error: "install a wallet key before arming live buys" });
  }
  updateConfig({ autobuy: clean });
  const mode = cfg.autobuy.enabled ? (cfg.autobuy.dryRun ? "ON (dry run)" : "ON - LIVE MONEY") : "OFF";
  log.warn("admin", `autobuy is now ${mode}`);
  res.json({ ok: true, autobuy: autobuyStatus(), config: cfg });
});

/** Panic button: sell every open position now, whatever the P&L. */
app.post("/api/admin/positions/close-all", requireAdmin, async (_req, res) => {
  try {
    const n = await closeAll();
    res.json({ ok: true, closed: n });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

/** One-off manual buy: proves the trade route works without arming the loop. */
app.post("/api/admin/testbuy", requireAdmin, async (req, res) => {
  const mint = String(req.body?.mint ?? "").trim();
  const sol = Number(req.body?.sol ?? 0.01);
  if (!mint) return res.status(400).json({ error: "mint required" });
  if (!Number.isFinite(sol) || sol <= 0 || sol > 1) return res.status(400).json({ error: "sol must be 0-1" });
  const payer = loadWallet();
  if (!payer) return res.status(400).json({ error: "no wallet key installed" });
  try {
    const out = await executeBuy(payer, new PublicKey(mint), sol, cfg.autobuy.slippagePct, cfg.autobuy.priorityFeeMicroLamports);
    log.ok("admin", `test buy ${sol} SOL of ${mint.slice(0, 8)} - ${out.sig}`);
    res.json({ ok: true, sig: out.sig, venue: out.venue });
  } catch (e) {
    res.status(400).json({ error: String(e.message ?? e) });
  }
});

// ------------------------------------------------------------------- statics
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));
app.get("/admin", (_req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));

// ----------------------------------------------------------------- websocket
const server = app.listen(env.port, env.host, () => {
  log.ok("http", `lab online at http://${env.host}:${env.port} (admin: /admin)`);
  if (!env.adminPassword) {
    log.warn("http", "ADMIN_PASSWORD is empty in .env - the admin panel cannot be opened until you set it");
  }
  if (!env.heliusKey) {
    log.warn("http", "no HELIUS_API_KEY - holder count stays blank and RPC falls back to the public node");
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on("connection", (ws) => {
  const hello = { config: publicConfig(), stats: getStats(), sensors: getSensors(), feed: getFeed(), feedConnected: feedConnected() };
  ws.send(JSON.stringify({ event: "hello", payload: hello }));
});

onSensors((p) => broadcast("sensors", p));
onStats((p) => broadcast("stats", p));
onFeed((event, payload) => broadcast(event, payload));
onTrade(() => broadcast("autobuy", autobuyStatus()));

// --------------------------------------------------------------------- start
startSensors();
startStats();
startFeed();
startAutobuy();
startPositions();

process.on("unhandledRejection", (e) => log.err("proc", `unhandled: ${String(e?.message ?? e).slice(0, 200)}`));
