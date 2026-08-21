import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { cfg, env, HISTORY_FILE } from "./config.js";
import { log } from "./log.js";
import { getSolUsd, getTokenSupply } from "./solana.js";
import { getTokenState } from "./pump.js";
import { fetchDexStats, fetchCoinInfo } from "./dexscreener.js";
import { holderCount } from "./holders.js";

/**
 * The four stat tiles + the bonding-curve bar, refreshed on a timer.
 *
 * Chain first, DexScreener as an overlay: the bonding curve answers the second
 * the coin exists, DexScreener needs a few minutes to index it. Whichever is
 * richer wins per field, so launch day never shows an empty dashboard.
 */

const DEFAULT_SUPPLY = 1_000_000_000;
const SPARK_POINTS = 40;

let stats = emptyStats();
let history = loadHistory();
let listeners = [];

function emptyStats() {
  return {
    ready: false,
    mint: null,
    totalSupply: DEFAULT_SUPPLY,
    mcUsd: null,
    mcChangePct: null,
    holders: null,
    holdersToday: null,
    holdersSpark: [],
    liqUsd: null,
    liqNote: "AWAITING LAUNCH",
    liqPct: null,
    priceUsd: null,
    vol24Usd: null,
    progressPct: 0,
    graduated: false,
    venue: "none",
    solUsd: 0,
    updatedAt: 0,
  };
}

function loadHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return { mint: h.mint ?? null, day: h.day ?? "", holdersAtDayStart: h.holdersAtDayStart ?? null, samples: h.samples ?? [] };
  } catch {
    return { mint: null, day: "", holdersAtDayStart: null, samples: [] };
  }
}

let lastSaved = 0;
function saveHistory() {
  if (Date.now() - lastSaved < 30_000) return;
  lastSaved = Date.now();
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch {}
}

const today = () => new Date().toISOString().slice(0, 10);

/** Record a holders/mc sample; keeps ~6h at one point a minute. */
function recordSample(mint, holders, mcUsd) {
  if (history.mint !== mint) history = { mint, day: "", holdersAtDayStart: null, samples: [] };
  const day = today();
  if (history.day !== day) {
    history.day = day;
    history.holdersAtDayStart = holders ?? history.holdersAtDayStart;
  }
  if (history.holdersAtDayStart == null && holders != null) history.holdersAtDayStart = holders;
  const last = history.samples[history.samples.length - 1];
  if (!last || Date.now() - last.t > 60_000) {
    history.samples.push({ t: Date.now(), h: holders ?? null, m: mcUsd ?? null });
    if (history.samples.length > 360) history.samples.shift(); // 6h of minutes
    saveHistory();
  }
}

async function refresh() {
  const mint = (cfg.contractAddress || "").trim();
  if (!mint) {
    stats = { ...emptyStats(), updatedAt: Date.now() };
    return emit();
  }

  let mintPk;
  try {
    mintPk = new PublicKey(mint);
  } catch {
    log.warn("stats", `contract address is not a valid pubkey: ${mint}`);
    stats = { ...emptyStats(), updatedAt: Date.now(), liqNote: "INVALID CONTRACT" };
    return emit();
  }

  const [solUsd, state, dex, supply, holders, coin] = await Promise.all([
    getSolUsd(),
    getTokenState(mintPk).catch(() => ({ kind: "none" })),
    fetchDexStats(mint),
    getTokenSupply(mint),
    holderCount(mint),
    fetchCoinInfo(mint),
  ]);

  const onCurve = state.kind === "curve";
  const graduated = state.kind === "amm" || Boolean(coin?.complete);

  // market cap: DexScreener when it has the pair, else straight off the curve
  const chainMcUsd = state.mcSol != null && solUsd ? state.mcSol * solUsd : null;
  const mcUsd = dex?.mcUsd ?? coin?.usdMarketCap ?? chainMcUsd;

  // liquidity: the pool's SOL side counts both ways, the curve's does not
  let liqUsd = dex?.liqUsd ?? null;
  let liqNote = "LIVE";
  if (liqUsd == null && solUsd) {
    if (onCurve) liqUsd = (state.curveSol ?? 0) * solUsd;
    else if (state.kind === "amm") liqUsd = (state.poolSol ?? 0) * solUsd * 2;
  }
  if (onCurve) liqNote = "IN BONDING CURVE";
  else if (graduated) liqNote = "POOL LOCKED 100%";
  else if (state.kind === "none") liqNote = "AWAITING LAUNCH";

  // 24h change: DexScreener's own number, else derived from our own samples
  let mcChangePct = dex?.chg24Pct ?? null;
  if (mcChangePct == null && mcUsd) {
    const old = history.samples.find((s) => s.m && Date.now() - s.t > 20 * 60_000);
    if (old?.m) mcChangePct = ((mcUsd - old.m) / old.m) * 100;
  }

  recordSample(mint, holders, mcUsd);
  const holdersToday = holders != null && history.holdersAtDayStart != null ? holders - history.holdersAtDayStart : null;
  const spark = history.samples.slice(-SPARK_POINTS).map((s) => s.m ?? 0).filter((n) => n > 0);

  stats = {
    ready: true,
    mint,
    totalSupply: supply ?? DEFAULT_SUPPLY,
    mcUsd,
    mcChangePct,
    holders,
    holdersToday,
    holdersSpark: spark,
    liqUsd,
    liqNote,
    priceUsd: dex?.priceUsd ?? (state.priceSol != null && solUsd ? state.priceSol * solUsd : null),
    vol24Usd: dex?.vol24Usd ?? null,
    progressPct: Math.round((state.progress ?? (graduated ? 1 : 0)) * 1000) / 10,
    graduated,
    venue: state.kind,
    solUsd,
    updatedAt: Date.now(),
  };
  emit();
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(stats);
    } catch {}
  }
}

export const getStats = () => stats;
export const onStats = (fn) => listeners.push(fn);

/** Force an immediate refresh (used right after the admin sets a new CA). */
export function refreshNow() {
  refresh().catch((e) => log.err("stats", String(e.message ?? e)));
}

export function startStats() {
  refreshNow();
  setInterval(refreshNow, Math.max(5, env.statsRefreshS) * 1000);
  log.info("stats", `polling every ${env.statsRefreshS}s`);
}
