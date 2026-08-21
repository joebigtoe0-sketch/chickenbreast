import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { fetch as undiciFetch, Agent } from "undici";
import { env } from "./config.js";
import { log } from "./log.js";

// Vendored from quant/server/src/chain/solana.js — throttled, pooled, with a
// public fallback RPC so the site survives a Helius hiccup.

let _connection = null;

const MIN_RPC_GAP_MS = 110;
let nextRpcSlot = 0;
function throttleSlot() {
  const now = Date.now();
  const at = Math.max(now, nextRpcSlot);
  nextRpcSlot = at + MIN_RPC_GAP_MS;
  return new Promise((r) => setTimeout(r, at - now));
}

const rpcAgent = new Agent({
  connect: { timeout: 20_000 },
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 300_000,
  connections: 6,
});

const FALLBACK_RPC = "https://api.mainnet-beta.solana.com";
let primaryFailStreak = 0;

async function rpcFetch(input, init) {
  try {
    const res = await undiciFetch(input, { ...init, dispatcher: rpcAgent });
    primaryFailStreak = 0;
    return res;
  } catch {
    primaryFailStreak++;
    if (primaryFailStreak === 5) log.warn("rpc", "primary unreachable — using public fallback");
    return await undiciFetch(FALLBACK_RPC, { ...init, dispatcher: rpcAgent });
  }
}

export function getConnection() {
  if (!_connection) {
    _connection = new Connection(env.rpcUrl, {
      commitment: "confirmed",
      fetch: rpcFetch,
      fetchMiddleware: (info, init, fetch) => {
        void throttleSlot().then(() => fetch(info, init));
      },
    });
  }
  return _connection;
}

export async function sendIxs(ixs, payer, priorityFeeMicroLamports = 200_000) {
  const connection = getConnection();
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }),
    ...ixs,
  ];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: all,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  let sig;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    // "Transaction simulation failed" alone is undebuggable — surface the real
    // program log lines (slippage, insufficient funds, wrong account...).
    let logs = [];
    try {
      logs = (typeof e?.getLogs === "function" ? await e.getLogs(connection) : e?.logs) ?? [];
    } catch {}
    const tail = logs.filter((l) => /error|failed|insufficient|slippage|exceed/i.test(l)).slice(-3).join(" | ");
    throw new Error(`${String(e?.message ?? e).slice(0, 160)}${tail ? ` :: ${tail.slice(0, 220)}` : ""}`);
  }
  // Don't trust a single websocket wait: under congestion it throws
  // blockhash-expired even when the tx LANDED. Poll before declaring failure.
  let confErr = null;
  try {
    const conf = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) throw new Error(`tx failed on-chain: ${JSON.stringify(conf.value.err)} (${sig})`);
    return sig;
  } catch (e) {
    confErr = e;
  }
  for (let i = 0; i < 12; i++) {
    try {
      const st = (await connection.getSignatureStatuses([sig])).value[0];
      if (st?.err) throw new Error(`tx failed on-chain: ${JSON.stringify(st.err)} (${sig})`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return sig;
    } catch (e) {
      if (String(e).includes("tx failed on-chain")) throw e;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw confErr instanceof Error ? confErr : new Error(`tx not confirmed after polling: ${sig}`);
}

// ---------- SOL/USD ----------
let solUsdCache = null;

export async function getSolUsd() {
  if (solUsdCache && Date.now() - solUsdCache.ts < 60_000) return solUsdCache.price;
  const sol = "So11111111111111111111111111111111111111112";
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${sol}`);
    if (r.ok) {
      const j = await r.json();
      const p = j?.[sol]?.usdPrice;
      if (typeof p === "number" && p > 0) {
        solUsdCache = { price: p, ts: Date.now() };
        return p;
      }
    }
  } catch {}
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (r.ok) {
      const j = await r.json();
      const p = j?.solana?.usd;
      if (typeof p === "number" && p > 0) {
        solUsdCache = { price: p, ts: Date.now() };
        return p;
      }
    }
  } catch {}
  return solUsdCache?.price ?? 0;
}

/** Circulating supply straight off the mint account (pump.fun mints 1B, 6dp). */
export async function getTokenSupply(mint) {
  try {
    const r = await getConnection().getTokenSupply(new PublicKey(mint), "confirmed");
    return Number(r.value.uiAmount ?? 0);
  } catch {
    return null;
  }
}
