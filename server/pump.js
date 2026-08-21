import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { createRequire } from "node:module";
// The pump SDKs ship ESM files inside a CommonJS-typed package, so node's
// "import" condition lands on code it then refuses to parse. Load them through
// the "require" condition instead, which points at a real CJS build.
const require = createRequire(import.meta.url);
const pumpSdk = require("@pump-fun/pump-sdk");
const pumpSwapSdk = require("@pump-fun/pump-swap-sdk");
import { NATIVE_MINT, AccountLayout, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConnection, sendIxs } from "./solana.js";
import { cfg } from "./config.js";

const {
  PUMP_SDK,
  OnlinePumpSdk,
  bondingCurvePda,
  canonicalPumpPoolPda,
  getBuyTokenAmountFromSolAmount,
  bondingCurveMarketCap,
  PUMP_PROGRAM_ID,
  PUMP_AMM_PROGRAM_ID,
} = pumpSdk;
const { PUMP_AMM_SDK, OnlinePumpAmmSdk } = pumpSwapSdk;

// Vendored from quant/server/src/chain/pump.ts (which vendored it from
// tggroupbuybot). Buy path only — this site never sells.

const TOKEN_DECIMALS = 6;
const TOTAL_SUPPLY_UI = 1_000_000_000;
/** SOL of real quote reserves a curve must raise to graduate. */
const GRADUATION_SOL = 85;

let onlinePump = null;
function pumpOnline() {
  if (!onlinePump) onlinePump = new OnlinePumpSdk(getConnection());
  return onlinePump;
}
let onlineAmm = null;
function ammOnline() {
  if (!onlineAmm) onlineAmm = new OnlinePumpAmmSdk(getConnection());
  return onlineAmm;
}

let globalCache = null;
async function getGlobals() {
  if (globalCache && Date.now() - globalCache.ts < 10 * 60_000) return globalCache;
  const [global, feeConfig] = await Promise.all([pumpOnline().fetchGlobal(), pumpOnline().fetchFeeConfig()]);
  globalCache = { global, feeConfig, ts: Date.now() };
  return globalCache;
}

const mintTokenProgramCache = new Map();
async function getMintTokenProgram(mint) {
  const key = mint.toBase58();
  const cached = mintTokenProgramCache.get(key);
  if (cached) return cached;
  const info = await getConnection().getAccountInfo(mint);
  const program = info?.owner ?? TOKEN_PROGRAM_ID;
  mintTokenProgramCache.set(key, program);
  return program;
}

const isSolQuote = (quoteMint) => quoteMint.equals(NATIVE_MINT) || quoteMint.equals(PublicKey.default);

/**
 * Where the token lives right now and what it's worth.
 *  kind "curve" — still bonding. progress 0..1, curveSol = SOL sitting in the curve.
 *  kind "amm"   — graduated to a PumpSwap pool. poolSol = SOL side of the pool.
 */
export async function getTokenState(mint) {
  const connection = getConnection();
  const curvePda = bondingCurvePda(mint);
  const poolKey = canonicalPumpPoolPda(mint);
  const [curveInfo, poolInfo] = await connection.getMultipleAccountsInfo([curvePda, poolKey]);

  if (curveInfo && curveInfo.owner.equals(PUMP_PROGRAM_ID) && curveInfo.data.length > 8) {
    let bc = null;
    try {
      bc = PUMP_SDK.decodeBondingCurveNullable(curveInfo);
    } catch {}
    if (bc && !bc.complete) {
      if (!isSolQuote(bc.quoteMint)) return { kind: "unsupported", why: "non-SOL quote token" };
      const vQuote = Number(bc.virtualQuoteReserves.toString());
      const vToken = Number(bc.virtualTokenReserves.toString());
      if (vToken <= 0) return { kind: "unsupported", why: "empty curve" };
      const priceSol = vQuote / LAMPORTS_PER_SOL / (vToken / 10 ** TOKEN_DECIMALS);
      const mcSol =
        Number(
          bondingCurveMarketCap({
            mintSupply: bc.tokenTotalSupply,
            virtualQuoteReserves: bc.virtualQuoteReserves,
            virtualTokenReserves: bc.virtualTokenReserves,
          }).toString(),
        ) / LAMPORTS_PER_SOL;
      const curveSol = Number(bc.realQuoteReserves.toString()) / LAMPORTS_PER_SOL;
      return {
        kind: "curve",
        bondingCurve: bc,
        priceSol,
        mcSol,
        curveSol,
        progress: Math.min(1, curveSol / GRADUATION_SOL),
        complete: false,
      };
    }
  }

  if (poolInfo && poolInfo.owner.equals(PUMP_AMM_PROGRAM_ID)) {
    let pool = null;
    try {
      pool = PUMP_AMM_SDK.decodePoolNullable(poolInfo);
    } catch {}
    if (pool) {
      if (!pool.quoteMint.equals(NATIVE_MINT)) return { kind: "unsupported", why: "non-SOL quote pool" };
      const [baseAcc, quoteAcc] = await connection.getMultipleAccountsInfo([
        pool.poolBaseTokenAccount,
        pool.poolQuoteTokenAccount,
      ]);
      if (!baseAcc || !quoteAcc) return { kind: "unsupported", why: "pool token accounts missing" };
      const baseUi = Number(AccountLayout.decode(baseAcc.data).amount) / 10 ** TOKEN_DECIMALS;
      const quoteUi = Number(AccountLayout.decode(quoteAcc.data).amount) / LAMPORTS_PER_SOL;
      if (baseUi <= 0) return { kind: "unsupported", why: "empty pool" };
      const priceSol = quoteUi / baseUi;
      return {
        kind: "amm",
        poolKey,
        priceSol,
        mcSol: priceSol * TOTAL_SUPPLY_UI,
        poolSol: quoteUi,
        progress: 1,
        complete: true,
      };
    }
  }

  return { kind: "none" };
}

/** Bonding progress (0..1) for MANY mints in a few RPC calls. Completed = 1. */
export async function curveProgressBatch(mints) {
  const out = new Map();
  const conn = getConnection();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    let infos = [];
    try {
      infos = await conn.getMultipleAccountsInfo(chunk.map((m) => bondingCurvePda(new PublicKey(m))));
    } catch {
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      if (!info) continue;
      try {
        const bc = PUMP_SDK.decodeBondingCurveNullable(info);
        if (!bc) continue;
        if (bc.complete) {
          out.set(chunk[j], 1);
          continue;
        }
        out.set(chunk[j], Math.min(1, Number(bc.realQuoteReserves.toString()) / LAMPORTS_PER_SOL / GRADUATION_SOL));
      } catch {}
    }
  }
  return out;
}

/** Buy `solAmount` of `mint` — bonding curve or graduated PumpSwap pool. */
export async function executeBuy(payer, mint, solAmount, slippagePct = 20, priorityFeeMicroLamports = 200_000) {
  const state = await getTokenState(mint);
  if (state.kind === "none") throw new Error("token not found on pump.fun or PumpSwap");
  if (state.kind === "unsupported") throw new Error(`token unsupported: ${state.why}`);

  const lamports = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
  const user = payer.publicKey;
  let ixs;

  if (state.kind === "curve") {
    const { global, feeConfig } = await getGlobals();
    const tokenProgram = await getMintTokenProgram(mint);
    const buyState = await pumpOnline().fetchBuyState(mint, user, tokenProgram);
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: buyState.bondingCurve.tokenTotalSupply,
      bondingCurve: buyState.bondingCurve,
      amount: lamports,
      quoteMint: NATIVE_MINT,
    });
    if (amount.lten(0)) throw new Error("buy quote returned 0 tokens");
    ixs = await PUMP_SDK.buyInstructions({
      global,
      bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
      bondingCurve: buyState.bondingCurve,
      associatedUserAccountInfo: buyState.associatedUserAccountInfo,
      mint,
      user,
      amount,
      solAmount: lamports,
      slippage: slippagePct,
      tokenProgram,
    });
  } else {
    const swapState = await ammOnline().swapSolanaState(canonicalPumpPoolPda(mint), user);
    ixs = await PUMP_AMM_SDK.buyQuoteInput(swapState, lamports, slippagePct);
  }

  const sig = await sendIxs(ixs, payer, priorityFeeMicroLamports);
  return { sig, mcSol: state.mcSol, venue: state.kind };
}

/** Raw token balance for `owner`; 0 when the token account does not exist. */
export async function getTokenBalanceRaw(mint, owner) {
  try {
    const tokenProgram = await getMintTokenProgram(mint);
    const ata = getAssociatedTokenAddressSync(mint, owner, false, tokenProgram);
    const bal = await getConnection().getTokenAccountBalance(ata, "confirmed");
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

/**
 * Tokens a `solAmount` buy would yield right now, without buying anything.
 * Paper positions are sized with this — the exact same quote the real buy uses —
 * so a dry run and a live run value and exit identically.
 */
export async function quoteBuyTokens(mint, solAmount) {
  const state = await getTokenState(mint);
  const lamports = new BN(Math.round(solAmount * LAMPORTS_PER_SOL));
  if (state.kind === "curve") {
    const { global, feeConfig } = await getGlobals();
    const amount = getBuyTokenAmountFromSolAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: lamports,
      quoteMint: NATIVE_MINT,
    });
    return BigInt(amount.toString());
  }
  if (state.kind === "amm") {
    // 0.25% pool fee, close enough for a paper fill
    return BigInt(Math.floor(((solAmount * 0.9975) / state.priceSol) * 10 ** TOKEN_DECIMALS));
  }
  return 0n;
}

/** SOL you would receive selling `tokensRaw` right now (curve fees exact, AMM ~1%). */
export async function estimateSellSolFor(mint, tokensRaw) {
  if (tokensRaw <= 0n) return 0;
  const state = await getTokenState(mint);
  if (state.kind === "curve") {
    const { global, feeConfig } = await getGlobals();
    const out = pumpSdk.getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: state.bondingCurve.tokenTotalSupply,
      bondingCurve: state.bondingCurve,
      amount: new BN(tokensRaw.toString()),
    });
    return Number(out.toString()) / LAMPORTS_PER_SOL;
  }
  if (state.kind === "amm") {
    return (Number(tokensRaw) / 10 ** TOKEN_DECIMALS) * state.priceSol * 0.99;
  }
  return 0; // rugged, migrated away, or never existed — worth nothing to us
}

/**
 * Sell `tokensRaw` of `mint`.
 *
 * HARD REFUSES the lab's own token. The auto-buyer works off the public launch
 * feed, and on launch day your own coin is on that feed — a take-profit dumping
 * the project's own bag out of the project's own wallet is not a bug anyone
 * gets to explain away afterwards. Enforced here, at the bottom, not by config.
 */
export async function executeSell(payer, mint, tokensRaw, slippagePct = 25, priorityFeeMicroLamports = 200_000) {
  const own = (cfg.contractAddress || "").trim();
  if (own && mint.toBase58() === own) throw new Error("REFUSED: this wallet never sells the lab's own token");
  if (tokensRaw <= 0n) throw new Error("nothing to sell");

  const state = await getTokenState(mint);
  if (state.kind === "none") throw new Error("token not found");
  if (state.kind === "unsupported") throw new Error(`unsupported: ${state.why}`);

  const user = payer.publicKey;
  const amount = new BN(tokensRaw.toString());
  let ixs;

  if (state.kind === "curve") {
    const { global, feeConfig } = await getGlobals();
    const tokenProgram = await getMintTokenProgram(mint);
    const sellState = await pumpOnline().fetchSellState(mint, user, tokenProgram);
    const solAmount = pumpSdk.getSellSolAmountFromTokenAmount({
      global,
      feeConfig,
      mintSupply: sellState.bondingCurve.tokenTotalSupply,
      bondingCurve: sellState.bondingCurve,
      amount,
    });
    ixs = await PUMP_SDK.sellInstructions({
      global,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: sellState.bondingCurve,
      mint,
      user,
      amount,
      solAmount,
      slippage: slippagePct,
      tokenProgram,
      mayhemMode: sellState.bondingCurve.isMayhemMode,
      cashback: sellState.bondingCurve.isCashbackCoin,
    });
  } else {
    const swapState = await ammOnline().swapSolanaState(state.poolKey, user);
    ixs = await PUMP_AMM_SDK.sellBaseInput(swapState, amount, slippagePct);
  }

  const before = await getConnection().getBalance(user, "confirmed");
  const sig = await sendIxs(ixs, payer, priorityFeeMicroLamports);
  const after = await getConnection().getBalance(user, "confirmed");
  return { sig, solReceived: Math.max(0, (after - before) / LAMPORTS_PER_SOL), venue: state.kind };
}

/**
 * Sellback value for MANY positions in one or two RPC calls.
 *
 * Valuing positions one at a time costs an RPC each, which caps how often the
 * book can be checked — and a stop loss is only as tight as the poll behind it
 * (measured: a 15s poll turned a -4% stop into a -18% exit on a fresh curve).
 * Bonding curves are the common case and decode from a single
 * getMultipleAccountsInfo, so the whole book prices in one round trip and the
 * sweep can run every few seconds. Graduated pools are rare here and fall back
 * to the per-position path.
 *
 * items: [{ mint, tokensRaw }] → Map mint → SOL
 */
export async function sellValueBatch(items) {
  const out = new Map();
  if (!items.length) return out;
  const conn = getConnection();
  const { global, feeConfig } = await getGlobals();
  const leftovers = [];

  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    let infos = [];
    try {
      infos = await conn.getMultipleAccountsInfo(chunk.map((it) => bondingCurvePda(new PublicKey(it.mint))));
    } catch {
      leftovers.push(...chunk);
      continue;
    }
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      const it = chunk[j];
      let bc = null;
      try {
        bc = info ? PUMP_SDK.decodeBondingCurveNullable(info) : null;
      } catch {}
      if (!bc || bc.complete) {
        leftovers.push(it); // graduated or not a curve — price it the slow way
        continue;
      }
      try {
        const sol = pumpSdk.getSellSolAmountFromTokenAmount({
          global,
          feeConfig,
          mintSupply: bc.tokenTotalSupply,
          bondingCurve: bc,
          amount: new BN(String(it.tokensRaw)),
        });
        out.set(it.mint, Number(sol.toString()) / LAMPORTS_PER_SOL);
      } catch {
        leftovers.push(it);
      }
    }
  }

  for (const it of leftovers) {
    try {
      out.set(it.mint, await estimateSellSolFor(new PublicKey(it.mint), BigInt(it.tokensRaw)));
    } catch {
      /* leave it unpriced; the sweep keeps the last known value */
    }
  }
  return out;
}
