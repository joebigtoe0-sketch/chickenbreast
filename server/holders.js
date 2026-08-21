import { PublicKey } from "@solana/web3.js";
import { createRequire } from "node:module";
// The pump SDKs ship ESM files inside a CommonJS-typed package, so node's
// "import" condition lands on code it then refuses to parse. Load them through
// the "require" condition instead, which points at a real CJS build.
const require = createRequire(import.meta.url);
const pumpSdk = require("@pump-fun/pump-sdk");
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { env } from "./config.js";
import { log } from "./log.js";

const { bondingCurvePda, canonicalPumpPoolPda } = pumpSdk;

/**
 * Real holder count via the Helius DAS `getTokenAccounts` method, paginated.
 * The bonding curve's own ATA and the PumpSwap pool ATA are float, not people,
 * so they're excluded — this matches the number pump.fun shows.
 *
 * Needs HELIUS_API_KEY (or an RPC_URL that speaks DAS). Without one this
 * returns null and the tile shows a dash rather than a wrong number.
 */
const PAGE = 1000;
const MAX_PAGES = 60; // 60k holders is far past anything this site will see

let cache = { mint: null, count: null, ts: 0 };
const TTL_MS = 60_000;

export async function holderCount(mint) {
  if (!mint) return null;
  if (cache.mint === mint && Date.now() - cache.ts < TTL_MS) return cache.count;
  if (!/helius/i.test(env.rpcUrl)) return null;

  const mintPk = new PublicKey(mint);
  const excluded = new Set();
  for (const owner of [bondingCurvePda(mintPk), canonicalPumpPoolPda(mintPk)]) {
    for (const program of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      excluded.add(getAssociatedTokenAddressSync(mintPk, owner, true, program).toBase58());
    }
  }

  let count = 0;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetch(env.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "holders",
          method: "getTokenAccounts",
          params: { mint, limit: PAGE, page, options: { showZeroBalance: false } },
        }),
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const j = await res.json();
      const accounts = j?.result?.token_accounts;
      if (!Array.isArray(accounts)) throw new Error(j?.error?.message ?? "no token_accounts in response");
      for (const a of accounts) {
        if (Number(a?.amount ?? 0) <= 0) continue;
        if (excluded.has(String(a?.address))) continue;
        count++;
      }
      if (accounts.length < PAGE) break;
    }
    cache = { mint, count, ts: Date.now() };
    return count;
  } catch (e) {
    log.warn("holders", `count failed: ${String(e.message ?? e).slice(0, 120)}`);
    // serve the last good number rather than blanking the tile
    return cache.mint === mint ? cache.count : null;
  }
}
