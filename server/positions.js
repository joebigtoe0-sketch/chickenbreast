import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { cfg, DATA_DIR } from "./config.js";
import { log } from "./log.js";
import { loadWallet } from "./wallet.js";
import { sellValueBatch, executeSell } from "./pump.js";
import { markSold } from "./feed.js";

/**
 * What happens after a buy: hold until take profit or stop loss, then sell.
 *
 * P&L is measured as SELLBACK VALUE against what we actually paid — what the
 * position is worth if we close it right now, not what the chart says. That
 * folds in the curve's fees and the price impact of our own exit, so +70% here
 * means +70% in the wallet, not +70% on a screen that quietly loses 6% on the
 * way out.
 *
 * Paper positions are sized with the same buy quote as a real fill and valued
 * through the same code, so a dry run behaves like the live one in everything
 * but the signature.
 */

const FILE = path.join(DATA_DIR, "positions.json");
// A stop loss is only as tight as the poll behind it. The whole book prices in
// one RPC (see sellValueBatch), so this can be seconds rather than a compromise.
const POLL_MS = 5_000;
const MAX_SELL_FAILURES = 4;

let positions = load();
let listeners = [];
let timer = null;
let sweeping = false; // a sweep that is signing exits must not be re-entered

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

let saveQueued = false;
function save() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    try {
      fs.writeFileSync(FILE, JSON.stringify(positions.slice(0, 400), null, 2));
    } catch (e) {
      log.err("positions", `could not persist: ${e.message}`);
    }
  }, 500);
}

const emit = (event, payload) => {
  for (const fn of listeners) {
    try {
      fn(event, payload);
    } catch {}
  }
};

export const onPosition = (fn) => listeners.push(fn);
export const openPositions = () => positions.filter((p) => p.status === "open");
export const getPositions = (n = 60) => positions.slice(0, n);

export function positionsSummary() {
  const open = openPositions();
  const closed = positions.filter((p) => p.status === "closed");
  const wins = closed.filter((p) => p.pnlPct > 0).length;
  const realised = closed.reduce((s, p) => s + ((p.exitSol ?? 0) - p.costSol), 0);
  return {
    open: open.length,
    stuck: positions.filter((p) => p.status === "stuck").length,
    exposureSol: Math.round(open.reduce((s, p) => s + p.costSol, 0) * 1000) / 1000,
    unrealisedSol: Math.round(open.reduce((s, p) => s + ((p.valueSol ?? p.costSol) - p.costSol), 0) * 1000) / 1000,
    closed: closed.length,
    wins,
    losses: closed.length - wins,
    realisedSol: Math.round(realised * 1000) / 1000,
    takeProfitPct: cfg.autobuy.takeProfitPct,
    stopLossPct: cfg.autobuy.stopLossPct,
  };
}

/** Record a fill. `tokensRaw` is a BigInt; it is stored as a string. */
export function openPosition({ mint, symbol, image, costSol, tokensRaw, entryPriceSol, entryMcUsd, buySig, dryRun }) {
  const p = {
    mint,
    symbol: symbol || "?",
    image: image ?? null,
    costSol,
    tokensRaw: String(tokensRaw),
    entryPriceSol: entryPriceSol ?? null,
    entryMcUsd: entryMcUsd ?? null,
    buySig: buySig ?? null,
    dryRun: Boolean(dryRun),
    openedAt: Date.now(),
    status: "open",
    valueSol: costSol,
    pnlPct: 0,
    failures: 0,
  };
  positions.unshift(p);
  save();
  emit("position:open", p);
  return p;
}

const closing = new Set();

/**
 * Close one position. `reason` is "tp" | "sl" | "manual".
 * A dry-run position closes at its current sellback value; a live one closes at
 * whatever the transaction actually returned.
 */
async function close(p, reason) {
  if (p.status !== "open" || closing.has(p.mint)) return;
  closing.add(p.mint);
  try {
    let exitSol = p.valueSol ?? 0;
    let sellSig = null;

    if (!p.dryRun) {
      const payer = loadWallet();
      if (!payer) throw new Error("no wallet key installed — cannot close");
      const out = await executeSell(
        payer,
        new PublicKey(p.mint),
        BigInt(p.tokensRaw),
        cfg.autobuy.sellSlippagePct ?? 30,
        cfg.autobuy.priorityFeeMicroLamports ?? 200_000,
      );
      exitSol = out.solReceived;
      sellSig = out.sig;
    }

    p.status = "closed";
    p.closedAt = Date.now();
    p.exitSol = exitSol;
    p.pnlPct = p.costSol > 0 ? ((exitSol - p.costSol) / p.costSol) * 100 : 0;
    p.reason = reason;
    p.sellSig = sellSig;
    save();

    const sign = p.pnlPct >= 0 ? "+" : "";
    const label = reason === "tp" ? "TAKE PROFIT" : reason === "sl" ? "STOP LOSS" : "CLOSED";
    log[p.pnlPct >= 0 ? "ok" : "warn"](
      "positions",
      `${label} ${p.symbol} ${sign}${p.pnlPct.toFixed(1)}% (${p.costSol} → ${exitSol.toFixed(4)} SOL)${p.dryRun ? " [paper]" : ` — ${sellSig}`}`,
    );
    markSold(p.mint, { pnlPct: p.pnlPct, reason, sellSig, dryRun: p.dryRun });
    emit("position:close", p);
  } catch (e) {
    p.failures = (p.failures ?? 0) + 1;
    const err = String(e?.message ?? e).slice(0, 160);
    // A rugged coin can be genuinely unsellable — the curve has nothing left to
    // pay out. Retrying that forever burns fees and log space, so after a few
    // tries the position is parked as stuck and left for a human.
    if (p.failures >= MAX_SELL_FAILURES) {
      p.status = "stuck";
      p.lastError = err;
      save();
      log.err("positions", `${p.symbol} could not be sold after ${p.failures} tries — parked as stuck: ${err}`);
      emit("position:close", p);
    } else {
      log.warn("positions", `${p.symbol} sell failed (${p.failures}/${MAX_SELL_FAILURES}): ${err}`);
    }
  } finally {
    closing.delete(p.mint);
  }
}

/** Value every open position and fire whichever bound it crossed. */
async function sweep() {
  const open = openPositions();
  if (!open.length) return;
  const tp = Number(cfg.autobuy.takeProfitPct);
  const sl = Math.abs(Number(cfg.autobuy.stopLossPct));

  let values;
  try {
    values = await sellValueBatch(open.map((p) => ({ mint: p.mint, tokensRaw: p.tokensRaw })));
  } catch (e) {
    // a valuation blip is not a reason to touch the book
    log.warn("positions", `valuation sweep failed: ${String(e?.message ?? e).slice(0, 120)}`);
    return;
  }

  const due = [];
  for (const p of open) {
    if (closing.has(p.mint)) continue;
    const value = values.get(p.mint);
    if (value == null) continue; // unpriced this round; keep the last known value
    p.valueSol = value;
    p.pnlPct = p.costSol > 0 ? ((value - p.costSol) / p.costSol) * 100 : 0;
    if (Number.isFinite(tp) && p.pnlPct >= tp) due.push([p, "tp"]);
    else if (Number.isFinite(sl) && sl > 0 && p.pnlPct <= -sl) due.push([p, "sl"]);
  }
  // exits are sequential: they sign transactions, and a burst of parallel sells
  // from one wallet just fights itself over blockhashes and nonces
  for (const [p, reason] of due) await close(p, reason);
  emit("positions", positionsSummary());
  save();
}

/** Panic button: close everything open, right now. */
export async function closeAll() {
  const open = openPositions();
  log.warn("positions", `closing all ${open.length} open positions on request`);
  for (const p of open) await close(p, "manual");
  return open.length;
}

export function startPositions() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (sweeping) return; // an exit can take seconds to confirm; don't stack sweeps
    sweeping = true;
    sweep()
      .catch((e) => log.err("positions", String(e?.message ?? e)))
      .finally(() => {
        sweeping = false;
      });
  }, POLL_MS);
  const open = openPositions().length;
  log.info(
    "positions",
    `watching ${open} open · TP +${cfg.autobuy.takeProfitPct}% / SL -${Math.abs(cfg.autobuy.stopLossPct)}%, checked every ${POLL_MS / 1000}s`,
  );
}
