import fs from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { cfg, TRADES_FILE } from "./config.js";
import { log } from "./log.js";
import { loadWallet, solBalance } from "./wallet.js";
import { executeBuy, getTokenState, quoteBuyTokens, getTokenBalanceRaw } from "./pump.js";
import { getSolUsd } from "./solana.js";
import { buyableFeed, markBought, markBuying } from "./feed.js";
import { openPosition, openPositions } from "./positions.js";

/**
 * THE LAB RAT: picks a coin off the live feed every 10-30s and puts 0.05 SOL
 * into it, which lights that row gold on the site.
 *
 * This spends real money on autopilot, so it is deliberately hard to leave
 * running by accident:
 *   - ships DISABLED and in DRY RUN; both have to be turned off in /admin
 *   - a daily SOL cap that resets at UTC midnight
 *   - a reserve it will never spend below (fees still need to clear)
 *   - one buy in flight at a time, ever
 * Every attempt — dry or live, win or fail — is appended to data/trades.json.
 */

const FEE_HEADROOM_SOL = 0.003; // priority fee + rent for the token account

let timer = null;
let inFlight = false;
let spentToday = 0; // live SOL only — the cap bounds real spend
let paperToday = 0; // dry-run tally, kept separate so rehearsals never stall
let spentDay = "";
let lastCapWarn = 0;
let lastFullWarn = 0;
let lastFloorWarn = 0;
let lastRejected = null;
let mayhemSkips = 0;
let lastMayhemLog = 0;
let trades = loadTrades();
let listeners = [];

function loadTrades() {
  try {
    return JSON.parse(fs.readFileSync(TRADES_FILE, "utf8"));
  } catch {
    return [];
  }
}

function recordTrade(t) {
  trades.unshift(t);
  if (trades.length > 500) trades.pop();
  try {
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch {}
  for (const fn of listeners) {
    try {
      fn(t);
    } catch {}
  }
}

export const getTrades = (n = 50) => trades.slice(0, n);
export const onTrade = (fn) => listeners.push(fn);

const utcDay = () => new Date().toISOString().slice(0, 10);

function budgetLeft() {
  if (spentDay !== utcDay()) {
    spentDay = utcDay();
    spentToday = 0;
    paperToday = 0;
  }
  return Math.max(0, (cfg.autobuy.dailyCapSol ?? 0) - spentToday);
}

export function autobuyStatus() {
  const a = cfg.autobuy;
  return {
    enabled: Boolean(a.enabled),
    dryRun: Boolean(a.dryRun),
    amountSol: a.amountSol,
    minIntervalS: a.minIntervalS,
    maxIntervalS: a.maxIntervalS,
    dailyCapSol: a.dailyCapSol,
    spentToday: Math.round(spentToday * 1000) / 1000,
    paperToday: Math.round(paperToday * 1000) / 1000,
    budgetLeft: Math.round(budgetLeft() * 1000) / 1000,
    inFlight,
    running: timer != null,
  };
}

/**
 * Pick a coin worth buying: fresh, still tradeable, and still above the floor.
 *
 * The market cap on the launch feed is the price at CREATION — every pump.fun
 * coin looks identical there and it says nothing about whether the thing died
 * ten seconds later. So the floor is checked on-chain, at buy time. Coins open
 * around $4k, which makes the default floor read as "has not already dumped
 * below where it started".
 */
async function pickCandidate(a) {
  const pool = buyableFeed(a.maxAgeS ?? 120);
  if (!pool.length) return null;

  const minMcUsd = Number(a.minMcUsd) || 0;
  const solUsd = minMcUsd ? await getSolUsd() : 0;
  // shuffled, so a rejected coin doesn't bias the next pick toward its neighbours
  const shortlist = pool
    .slice()
    .sort(() => Math.random() - 0.5)
    .slice(0, 6);

  let rejected = 0;
  let best = 0;
  for (const item of shortlist) {
    let state;
    try {
      state = await getTokenState(new PublicKey(item.mint));
    } catch {
      continue;
    }
    if (state.kind !== "curve" && state.kind !== "amm") continue; // gone, or not a pump coin
    if (a.skipMayhem && state.mayhem) {
      mayhemSkips++;
      continue;
    }
    const mcUsd = solUsd ? state.mcSol * solUsd : null;
    if (minMcUsd && mcUsd != null && mcUsd < minMcUsd) {
      rejected++;
      best = Math.max(best, mcUsd);
      continue;
    }
    return { item, state, mcUsd };
  }
  if (rejected) lastRejected = { at: Date.now(), n: rejected, floor: minMcUsd, best };
  return null;
}

async function attempt() {
  const a = cfg.autobuy;
  if (!a.enabled || inFlight) return;

  const amount = Number(a.amountSol) || 0.05;

  const openCount = openPositions().length;
  if (openCount >= (a.maxOpenPositions ?? 30)) {
    if (Date.now() - lastFullWarn > 10 * 60_000) {
      lastFullWarn = Date.now();
      log.warn("autobuy", `holding ${openCount} positions (max ${a.maxOpenPositions}) — pausing buys until some close`);
    }
    return;
  }

  if (!a.dryRun && budgetLeft() < amount) {
    // say it once, not every 10 seconds until midnight
    if (Date.now() - lastCapWarn > 30 * 60_000) {
      lastCapWarn = Date.now();
      log.warn("autobuy", `daily cap reached (${cfg.autobuy.dailyCapSol} SOL) — idling until UTC midnight`);
    }
    return;
  }

  const found = await pickCandidate(a);
  if (mayhemSkips && Date.now() - lastMayhemLog > 10 * 60_000) {
    lastMayhemLog = Date.now();
    log.info("autobuy", "skipped " + mayhemSkips + " mayhem-mode coin(s) since the last note");
    mayhemSkips = 0;
  }
  if (!found) {
    if (lastRejected && Date.now() - lastRejected.at < 2000 && Date.now() - lastFloorWarn > 5 * 60_000) {
      lastFloorWarn = Date.now();
      log.info(
        "autobuy",
        `nothing above the ${lastRejected.floor} floor — best on the feed was ${Math.round(lastRejected.best)}` +
          ` (pump coins open near ${Math.round(lastRejected.best ? lastRejected.best : 0)}; lower the floor if this keeps repeating)`,
      );
    }
    return;
  }
  const { item: pick, state, mcUsd } = found;
  const mintPk = new PublicKey(pick.mint);

  if (a.dryRun) {
    paperToday += amount;
    // sized with the same quote a real fill would get, so the paper position
    // values and exits exactly like a live one
    const tokensRaw = await quoteBuyTokens(mintPk, amount).catch(() => 0n);
    markBought(pick.mint, null, amount, true);
    recordTrade({ ts: Date.now(), mint: pick.mint, symbol: pick.symbol, sol: amount, sig: null, dryRun: true, ok: true });
    if (tokensRaw > 0n) {
      openPosition({
        mint: pick.mint,
        symbol: pick.symbol,
        image: pick.image,
        costSol: amount,
        tokensRaw,
        entryPriceSol: state.priceSol,
        entryMcUsd: mcUsd,
        buySig: null,
        dryRun: true,
      });
    }
    log.info("autobuy", `DRY RUN ${amount} SOL → ${pick.symbol} @ $${Math.round(mcUsd ?? 0)} mc`);
    return;
  }

  const payer = loadWallet();
  if (!payer) {
    log.err("autobuy", "no wallet key installed — set one in /admin or turn the buyer off");
    return;
  }

  const bal = await solBalance();
  if (bal < amount + (a.reserveSol ?? 0) + FEE_HEADROOM_SOL) {
    log.warn("autobuy", `balance ${bal.toFixed(4)} SOL below buy + reserve — skipping`);
    return;
  }

  inFlight = true;
  markBuying(pick.mint, true);
  try {
    // the delta is the real fill: quotes drift, and the position has to be
    // opened with the tokens we actually received or the exit sells the wrong size
    const before = await getTokenBalanceRaw(mintPk, payer.publicKey);
    const { sig, venue } = await executeBuy(
      payer,
      mintPk,
      amount,
      a.slippagePct ?? 20,
      a.priorityFeeMicroLamports ?? 200_000,
    );
    const after = await getTokenBalanceRaw(mintPk, payer.publicKey);
    const tokensRaw = after > before ? after - before : after;

    spentToday += amount;
    markBought(pick.mint, sig, amount, false);
    recordTrade({ ts: Date.now(), mint: pick.mint, symbol: pick.symbol, sol: amount, sig, venue, dryRun: false, ok: true });
    if (tokensRaw > 0n) {
      openPosition({
        mint: pick.mint,
        symbol: pick.symbol,
        image: pick.image,
        costSol: amount,
        tokensRaw,
        entryPriceSol: state.priceSol,
        entryMcUsd: mcUsd,
        buySig: sig,
        dryRun: false,
      });
    } else {
      log.err("autobuy", `${pick.symbol}: buy landed but no tokens arrived — no position opened, check ${sig}`);
    }
    log.ok("autobuy", `bought ${amount} SOL of ${pick.symbol} @ $${Math.round(mcUsd ?? 0)} mc — ${sig}`);
  } catch (e) {
    const err = String(e?.message ?? e).slice(0, 200);
    markBuying(pick.mint, false);
    recordTrade({ ts: Date.now(), mint: pick.mint, symbol: pick.symbol, sol: amount, sig: null, dryRun: false, ok: false, error: err });
    log.err("autobuy", `${pick.symbol} failed: ${err}`);
  } finally {
    inFlight = false;
  }
}

function schedule() {
  const a = cfg.autobuy;
  const min = Math.max(5, Number(a.minIntervalS) || 10);
  const max = Math.max(min, Number(a.maxIntervalS) || 30);
  const delay = (min + Math.random() * (max - min)) * 1000;
  timer = setTimeout(() => {
    attempt()
      .catch((e) => log.err("autobuy", String(e?.message ?? e)))
      .finally(schedule);
  }, delay);
}

export function startAutobuy() {
  spentDay = utcDay();
  if (timer) clearTimeout(timer);
  schedule();
  const a = cfg.autobuy;
  log.info(
    "autobuy",
    a.enabled
      ? `armed — ${a.amountSol} SOL every ${a.minIntervalS}-${a.maxIntervalS}s${a.dryRun ? " (DRY RUN)" : " LIVE"}`
      : "loaded but disabled — arm it in /admin",
  );
}
