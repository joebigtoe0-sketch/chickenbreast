import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { log } from "./log.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

const num = (k, def) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : def;
};
const str = (k, def = "") => process.env[k] ?? def;

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(ROOT, process.env.DATA_DIR)
  : path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_FILE = path.join(DATA_DIR, "config.json");
export const WALLET_FILE = path.join(DATA_DIR, "wallet.json");
export const HISTORY_FILE = path.join(DATA_DIR, "history.json");
export const TRADES_FILE = path.join(DATA_DIR, "trades.json");

/** Env-level settings: secrets and host wiring. Never editable from the panel. */
/**
 * Are we hosted, or on a laptop?
 *
 * This used to key off RAILWAY_ENVIRONMENT, which meant the server bound
 * 127.0.0.1 on every OTHER host and was simply unreachable. NODE_ENV is the one
 * signal every container platform can set (and the Dockerfile sets it), so it
 * beats maintaining a list of provider-specific variables.
 */
const hosted = process.env.NODE_ENV === "production";

export const env = {
  // Hosted: the platform's injected PORT wins and we bind every interface.
  // Local: SITE_PORT wins and we stay on loopback, so the LAN cannot reach
  // /admin. HOST always overrides, for a VPS sitting behind nginx.
  port: hosted ? num("PORT", num("SITE_PORT", 8787)) : num("SITE_PORT", num("PORT", 8787)),
  host: str("HOST", hosted ? "0.0.0.0" : "127.0.0.1"),
  adminPassword: str("ADMIN_PASSWORD"),
  heliusKey: str("HELIUS_API_KEY"),
  rpcUrl:
    str("RPC_URL") ||
    (str("HELIUS_API_KEY")
      ? `https://mainnet.helius-rpc.com/?api-key=${str("HELIUS_API_KEY")}`
      : "https://api.mainnet-beta.solana.com"),
  statsRefreshS: num("STATS_REFRESH_S", 20),
};

const DEFAULTS = {
  contractAddress: "",
  tokenName: "SAUSAGE BOT",
  tokenSymbol: "SAUSAGE",
  tagline: "THE SAUSAGE BOT",
  videoUrl: "/media/lab.mp4",
  camLabel: "LAB CAM 01 — SAUSAGE TRENCHER",
  aboutTitle: "FUELING THE FUTURE. IN THE LAB.",
  aboutBody:
    "$SAUSAGE is a community driven experiment.\nWe don't follow the market, we test it.\n6 clips. 1 goal. Unlimited potential.",
  phaseLabel: "Experiment Phase 1: Neural Protein Interface... IN PROGRESS",
  twitter: "https://x.com/cbtonsol",
  telegram: "",
  // the lab has been running since first boot — sensor drift is anchored here
  experimentStart: Date.now(),
  autobuy: {
    enabled: false,
    dryRun: true,
    amountSol: 0.05,
    minIntervalS: 10,
    maxIntervalS: 30,
    dailyCapSol: 1,
    reserveSol: 0.02,
    slippagePct: 20,
    priorityFeeMicroLamports: 200_000,
    maxAgeS: 120, // only buy launches seen in the last N seconds
    // Don't buy something already dead on arrival.
    //
    // Every pump.fun curve opens at the SAME price — about 28 SOL of market cap
    // — so the launch mc in DOLLARS moves with SOL/USD: ~$2,550 at SOL $91,
    // ~$4,200 at SOL $150. A floor set from a screenshot taken at a different
    // SOL price silently rejects every coin (measured: $4,000 passed 0 of 22
    // live launches). Just above launch means "has not been dumped"; ~$3,000+
    // at this SOL price additionally demands real buying. Revisit it if SOL
    // moves a lot — the admin panel logs the best mc it saw when nothing passes.
    minMcUsd: 2700,
    // Mayhem-mode coins run different curve mechanics; the buyer leaves them
    // alone unless this is turned off.
    skipMayhem: true,
    maxOpenPositions: 30,
    // exits
    takeProfitPct: 70,
    stopLossPct: 40, // magnitude; the buyer sells at -40%
    sellSlippagePct: 30, // exits need more room than entries, especially on a dump
  },
};

function load() {
  try {
    const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return { ...DEFAULTS, ...disk, autobuy: { ...DEFAULTS.autobuy, ...(disk.autobuy ?? {}) } };
  } catch {
    return { ...DEFAULTS, autobuy: { ...DEFAULTS.autobuy } };
  }
}

/** Mutable runtime config — the admin panel writes this, everything reads it. */
export const cfg = load();

export function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log.err("config", `could not persist config: ${e.message}`);
  }
}

/** Patch + persist. Returns the merged config. */
export function updateConfig(patch) {
  const { autobuy, ...rest } = patch ?? {};
  Object.assign(cfg, rest);
  if (autobuy) Object.assign(cfg.autobuy, autobuy);
  saveConfig();
  return cfg;
}

/**
 * Stamp a local media URL with the file's modification time.
 *
 * Swapping a clip almost always reuses the same filename, so the URL never
 * changes and any cache between us and the viewer — the browser, a CDN, the
 * host's edge — can happily keep serving the old bytes. Stamping makes a new
 * file a genuinely new URL, so the swap lands everywhere immediately.
 */
function stamped(url) {
  const clean = String(url || "").split("?")[0];
  if (!clean.startsWith("/media/")) return url; // an external URL is not ours to stamp
  try {
    const st = fs.statSync(path.join(ROOT, "public", clean));
    return `${clean}?v=${Math.floor(st.mtimeMs)}`;
  } catch {
    return url; // not on disk yet — the NO SIGNAL card handles that
  }
}

/** Everything the public site is allowed to know. No secrets, no autobuy. */
export function publicConfig() {
  const ca = cfg.contractAddress || "";
  return {
    contractAddress: ca,
    tokenName: cfg.tokenName,
    tokenSymbol: cfg.tokenSymbol,
    tagline: cfg.tagline,
    videoUrl: stamped(cfg.videoUrl),
    camLabel: cfg.camLabel,
    aboutTitle: cfg.aboutTitle,
    aboutBody: cfg.aboutBody,
    phaseLabel: cfg.phaseLabel,
    twitter: cfg.twitter,
    telegram: cfg.telegram,
    buyUrl: ca ? `https://pump.fun/coin/${ca}` : "https://pump.fun",
    chartUrl: ca ? `https://dexscreener.com/solana/${ca}` : "https://dexscreener.com/solana",
  };
}

// first boot writes the file so the panel has something to edit
if (!fs.existsSync(CONFIG_FILE)) saveConfig();
