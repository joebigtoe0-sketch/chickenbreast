import WebSocket from "ws";
import { cfg } from "./config.js";
import { log } from "./log.js";

/**
 * TOKEN ANALYSIS FEED — every coin that launches on pump.fun, run past the
 * chicken.
 *
 * Source is the PumpPortal data websocket (same feed the sniper bots use).
 * Launches arrive in bursts of several per second, which is unreadable, so
 * they land in a buffer and get published on a human cadence — one every
 * 4-9 seconds, which also gives each row time to finish its confidence
 * animation before the next one pushes in.
 */

// Cadence is a DISPLAY throttle and nothing to do with how long a row analyses.
// Launches arrive several per second, which is unreadable, so rows enter every
// 2-4s. Each row then runs its own analysis clock client-side, independently —
// several coins sit in ANALYZING at the same time and the belt never waits.
const PUBLISH_MIN_MS = 2000;
const PUBLISH_MAX_MS = 4000;
// How long a row spends climbing to its number (client-side; keep in sync with
// ANALYSIS_MS in public/app.js). Only used here to decide when a row has
// settled enough for the auto-buyer to pick it.
const ANALYSIS_MS = 10_000;
// A launch ripens briefly before publishing so its ipfs image has time to land.
// Past that we take the NEWEST pending launch, not the oldest — this is a live
// feed, not a queue; under a burst the surplus ages out instead of going stale.
const RIPE_MS = 4000;
const STALE_MS = 90_000;
const PENDING_MAX = 120;
// pump.fun never goes a minute without a launch, so silence this long means the
// socket is dead even though it still looks open (see startFeed).
const SILENCE_MS = 75_000;
const PING_MS = 25_000;
const FEED_MAX = 60;
// our own coin walks past the sensors every few minutes and, naturally, aces it
const OWN_INJECT_MIN_MS = 150_000;
const OWN_INJECT_MAX_MS = 260_000;

const GATEWAYS = ["https://pump.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];
const ipfsHash = (u) => u.match(/^ipfs:\/\/(.+)$/)?.[1] ?? u.match(/\/ipfs\/([^/?#]+)/)?.[1] ?? null;

/** Token metadata json (ipfs) → image URL. Two gateways, best effort. */
async function enrichImage(uri) {
  if (!uri) return null;
  const hash = ipfsHash(uri);
  const urls = hash ? GATEWAYS.map((g) => g + hash) : [uri];
  for (const u of urls) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(u, { signal: controller.signal, headers: { accept: "application/json" } });
      clearTimeout(t);
      if (!res.ok) continue;
      const j = await res.json();
      const img = typeof j?.image === "string" ? j.image : null;
      if (!img) return null;
      const imgHash = ipfsHash(img);
      return imgHash ? GATEWAYS[0] + imgHash : /^https?:\/\//.test(img) ? img : null;
    } catch {
      /* next gateway */
    }
  }
  return null;
}

const rand = (a, b) => a + Math.random() * (b - a);

export function verdictFor(confidence) {
  if (confidence >= 90) return "OPTIMAL RESPONSE";
  if (confidence >= 65) return "STRONG RESPONSE";
  if (confidence >= 30) return "MODERATE RESPONSE";
  return "LOW BIOELECTRIC RESPONSE";
}

let connected = false;
const pending = [];
const feed = []; // newest first
const seen = new Set();
let listeners = [];

const emit = (event, payload) => {
  for (const fn of listeners) {
    try {
      fn(event, payload);
    } catch {}
  }
};

export const getFeed = () => feed;
export const feedConnected = () => connected;
export const onFeed = (fn) => listeners.push(fn);
/** Recent, still-fresh coins the auto-buyer may pick from. A row only becomes
 *  eligible once its analysis has settled, so a buy never cuts the climb short —
 *  gold always lands on a row that already showed its verdict. */
export const buyableFeed = (maxAgeS) =>
  feed.filter((i) => {
    const age = Date.now() - i.ts;
    return !i.own && !i.bought && !i.buying && age >= ANALYSIS_MS && age <= maxAgeS * 1000;
  });

export function findItem(mint) {
  return feed.find((i) => i.mint === mint) ?? null;
}

/**
 * Mark a row as bought: the bar runs to 100% and turns gold on every screen.
 *
 * The row also LIFTS to the top of the feed, stamped with the moment of the
 * buy. Rows land every couple of seconds, so a gold row left where it was
 * would scroll out of sight inside twenty seconds and nobody would ever catch
 * one. The buy is itself the newest event, so the feed stays in time order.
 */
export function markBought(mint, buySig, solAmount, dryRun) {
  const item = findItem(mint);
  if (!item) return null;
  item.bought = true;
  item.buying = false;
  item.buySig = buySig;
  item.buySol = solAmount;
  item.dryRun = Boolean(dryRun);
  item.confidence = 100;
  item.verdict = "BOUGHT";
  item.ts = Date.now();
  item.boughtAt = item.ts;

  const at = feed.indexOf(item);
  if (at > 0) {
    feed.splice(at, 1);
    feed.unshift(item);
  }
  emit("feed:update", item);
  return item;
}

/** The position closed — the row comes back one last time with the result. */
export function markSold(mint, { pnlPct, reason, sellSig, dryRun }) {
  const item = findItem(mint);
  if (!item) return null;
  item.sold = true;
  item.pnlPct = pnlPct;
  item.exitReason = reason;
  item.sellSig = sellSig ?? null;
  item.dryRun = Boolean(dryRun);
  item.ts = Date.now();
  item.verdict = reason === "tp" ? "TAKE PROFIT" : reason === "sl" ? "STOP LOSS" : "CLOSED";

  const at = feed.indexOf(item);
  if (at > 0) {
    feed.splice(at, 1);
    feed.unshift(item);
  }
  emit("feed:update", item);
  return item;
}

export function markBuying(mint, on = true) {
  const item = findItem(mint);
  if (item) {
    item.buying = on;
    emit("feed:update", item);
  }
  return item;
}

function publish(item) {
  if (seen.has(item.mint)) return;
  seen.add(item.mint);
  feed.unshift(item);
  if (feed.length > FEED_MAX) {
    const dropped = feed.pop();
    seen.delete(dropped.mint);
  }
  emit("feed:new", item);
}

/** Newest ripe launch, dropping anything that sat too long to still be news. */
function takeNext() {
  const now = Date.now();
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].seenAt > STALE_MS) pending.splice(i, 1);
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    if (now - pending[i].seenAt >= RIPE_MS) return pending.splice(i, 1)[0];
  }
  return null;
}

function publishLoop() {
  const next = () => setTimeout(publishLoop, rand(PUBLISH_MIN_MS, PUBLISH_MAX_MS));
  const raw = takeNext();
  if (!raw) return next();

  const confidence = Math.round(rand(0, 99));
  const item = {
    mint: raw.mint,
    name: raw.name,
    symbol: raw.symbol,
    image: raw.image ?? null,
    sig: raw.sig ?? null,
    dev: raw.dev ?? null,
    mcSol: raw.mcSol ?? null,
    ts: Date.now(),
    confidence,
    verdict: verdictFor(confidence),
    bought: false,
    buying: false,
    own: false,
  };
  publish(item);
  next();
}

/** Slot our own coin into the feed, always acing the test. */
function injectOwn() {
  const ca = (cfg.contractAddress || "").trim();
  if (ca && !feed.some((i) => i.own && Date.now() - i.ts < OWN_INJECT_MIN_MS)) {
    const confidence = Math.round(rand(96, 99));
    // the row re-enters the feed each time, so it can't be deduped by mint
    feed.unshift({
      mint: ca,
      name: cfg.tokenName,
      symbol: cfg.tokenSymbol,
      image: cfg.ownImage ?? null,
      sig: null,
      ts: Date.now(),
      confidence,
      verdict: "OPTIMAL RESPONSE",
      bought: false,
      buying: false,
      own: true,
    });
    if (feed.length > FEED_MAX) feed.pop();
    emit("feed:new", feed[0]);
  }
  setTimeout(injectOwn, rand(OWN_INJECT_MIN_MS, OWN_INJECT_MAX_MS));
}

export function startFeed() {
  let ws = null;
  let alive = false;
  let lastDataAt = Date.now();

  const connect = () => {
    try {
      ws = new WebSocket("wss://pumpportal.fun/api/data");
    } catch {
      return setTimeout(connect, 5000);
    }
    ws.on("open", () => {
      alive = true;
      connected = true;
      lastDataAt = Date.now();
      log.ok("feed", "pumpportal connected — subscribing to new launches");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      emit("feed:status", { connected: true });
    });
    ws.on("message", (data) => {
      lastDataAt = Date.now();
      try {
        const m = JSON.parse(String(data));
        if (!m?.mint || !(m.txType === "create" || m.name)) return;
        // standard pump launches only — no mayhem/other pools
        if (String(m.pool ?? "pump").toLowerCase() !== "pump") return;
        if (seen.has(String(m.mint)) || pending.some((p) => p.mint === m.mint)) return;

        const raw = {
          mint: String(m.mint),
          name: String(m.name ?? "").slice(0, 40) || String(m.mint).slice(0, 6),
          symbol: String(m.symbol ?? "").slice(0, 12) || "?",
          sig: typeof m.signature === "string" ? m.signature : null,
          dev: typeof m.traderPublicKey === "string" ? m.traderPublicKey : null,
          mcSol: typeof m.marketCapSol === "number" ? m.marketCapSol : null,
          image: null,
          seenAt: Date.now(),
        };
        pending.push(raw);
        if (pending.length > PENDING_MAX) pending.shift();
        // the coin's face, fetched while it waits its turn in the queue
        void enrichImage(String(m.uri ?? ""))
          .then((image) => {
            if (image) raw.image = image;
          })
          .catch(() => {});
      } catch {}
    });
    ws.on("close", () => {
      if (alive) log.warn("feed", "pumpportal disconnected — retrying in 5s");
      alive = false;
      connected = false;
      emit("feed:status", { connected: false });
      setTimeout(connect, 5000);
    });
    ws.on("error", () => {});
  };

  /**
   * A dead websocket does not always emit "close". A sleeping laptop or a proxy
   * that drops the connection without a FIN leaves a HALF-OPEN socket: it looks
   * connected forever and delivers nothing, so the reconnect above never fires.
   * (Seen in the wild: the feed went quiet at 23:50 and was still "connected"
   * fourteen hours later.) Silence is the only reliable signal — pump.fun always
   * has launches — so past SILENCE_MS we terminate the socket ourselves and let
   * the close handler reconnect.
   */
  setInterval(() => {
    if (!ws || Date.now() - lastDataAt < SILENCE_MS) return;
    const quiet = Math.round((Date.now() - lastDataAt) / 1000);
    log.warn("feed", `no launches for ${quiet}s — socket looks half-open, forcing a reconnect`);
    lastDataAt = Date.now(); // don't re-fire while the replacement connects
    try {
      ws.terminate();
    } catch {}
  }, 15_000);

  // keep NAT and proxies from silently dropping an idle connection in the first place
  setInterval(() => {
    try {
      if (ws?.readyState === 1) ws.ping();
    } catch {}
  }, PING_MS);

  connect();
  publishLoop();
  setTimeout(injectOwn, 20_000);
}
