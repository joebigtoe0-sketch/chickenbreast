/**
 * Live market stats from DexScreener — market cap, 24h change, liquidity.
 * Free public endpoint, no key. It indexes pump.fun curve pairs a little after
 * launch, so everything here is treated as an OVERLAY on the chain numbers:
 * present = better, absent = we fall back to the bonding curve.
 */
export async function fetchDexStats(mint) {
  if (!mint) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    const pairs = Array.isArray(j?.pairs) ? j.pairs : [];
    if (!pairs.length) return null;
    // best pair = deepest liquidity
    const p = pairs.sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
    const num = (v) => (typeof v === "number" && isFinite(v) ? v : v != null && isFinite(Number(v)) ? Number(v) : null);
    return {
      pairAddress: p?.pairAddress ?? null,
      priceUsd: num(p?.priceUsd),
      mcUsd: num(p?.marketCap) ?? num(p?.fdv),
      vol24Usd: num(p?.volume?.h24),
      chg24Pct: num(p?.priceChange?.h24),
      liqUsd: num(p?.liquidity?.usd),
      dexId: p?.dexId ?? null,
    };
  } catch {
    return null;
  }
}

/** pump.fun's own frontend API — creator, socials, image, curve completion. */
export async function fetchCoinInfo(mint) {
  if (!mint) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
        signal: controller.signal,
        headers: { accept: "application/json", origin: "https://pump.fun" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const j = await res.json();
      if (!j || typeof j !== "object") continue;
      return {
        name: String(j.name ?? "").slice(0, 60),
        symbol: String(j.symbol ?? "").slice(0, 16),
        image: j.image_uri ?? null,
        creator: j.creator ?? null,
        complete: Boolean(j.complete),
        usdMarketCap: typeof j.usd_market_cap === "number" ? j.usd_market_cap : null,
        twitter: j.twitter ?? null,
        telegram: j.telegram ?? null,
        website: j.website ?? null,
      };
    } catch {
      /* retry once, then null */
    }
  }
  return null;
}
