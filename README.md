# chickenbreast — the $LABRAT lab dashboard

A one-screen site for a pump.fun coin: a looping lab cam, six sensor clips on the
subject, live token stats pulled off the chain, every pump.fun launch scored by
"AI", and a bot that buys some of them for real.

```
npm install
cp .env.example .env      # then set ADMIN_PASSWORD (and HELIUS_API_KEY if you have one)
npm start                 # → http://127.0.0.1:8787   admin at /admin
```

Drop your looping clip at `public/media/lab.mp4`. Until it exists the cam shows
NO SIGNAL, which is deliberate — nothing else on the page depends on it.

---

## Where every number comes from

| On screen | Source | Notes |
|---|---|---|
| TOTAL SUPPLY | `getTokenSupply` on the mint | real supply, so burns show up |
| MARKET CAP | DexScreener, else the bonding curve | curve answers instantly at launch; DexScreener takes a few minutes to index |
| 24h change | DexScreener `priceChange.h24` | falls back to our own samples if the pair is not indexed yet |
| HOLDERS | Helius DAS `getTokenAccounts`, paginated | curve ATA + PumpSwap pool ATA excluded, so it matches pump.fun |
| LIQUIDITY | DexScreener, else SOL in the curve / pool | label switches: IN BONDING CURVE → POOL LOCKED 100% |
| Bonding curve % | `realQuoteReserves / 85 SOL` off the curve account | the footer bar; 100% once it graduates |
| Token analysis feed | PumpPortal `subscribeNewToken` websocket | same feed the sniper bots use; watchdogged (see below) |
| Sensor readings | simulated server-side (`server/sensors.js`) | see below |

Chain first, DexScreener as an overlay — that combination is why the dashboard is
never blank on launch day. Everything is polled server-side every
`STATS_REFRESH_S` seconds and pushed to every visitor over one websocket, so a
thousand viewers cost one set of RPC calls.

### The sensors are simulated, but not lazily

Temperature starts near room temp and warms under the lamps toward a ceiling it
never crosses (exponential approach, ~6h constant). Humidity does the same
downward as the surface dries, with a floor. Impulses are a mean-reverting
(Ornstein-Uhlenbeck) walk per clip with occasional spikes, so they wander without
ever running away. A clip that loses lock turns its dot red and gets visibly
noisier until it re-locks. Drift is anchored to `experimentStart` in
`data/config.json`, so it survives restarts and keeps drifting across days.

All six clips are computed once on the server, so every visitor sees the same
readings — two phones side by side match.

### The confidence bars

Every launch gets a random 0-99 target. The bar climbs from zero, overshoots, and
settles on its number within ten seconds (damped oscillation, `1 - e^-4t·cos 8t`).
Rows analyse independently and in parallel — new coins keep landing every 2-4s
while earlier ones are still climbing, so several sit in ANALYZING at once.
Coins the buyer actually buys run to 100%, turn gold, and read BOUGHT ✓ — and the
row lifts to the top of the feed stamped with the time of the buy, because at
this cadence a gold row left in place would scroll away before anyone saw it.
Your own coin walks past the sensors every few minutes and, naturally, scores
96-99.

---

## Admin panel — `/admin`

Password is `ADMIN_PASSWORD` from `.env`; there is no other way in. Sessions live
in memory, so a restart logs you out.

- **Contract address** — set it once and every link, stat, and the bonding curve
  bar follow it. `pump.fun/coin/<ca>` for BUY, `dexscreener.com/solana/<ca>` for
  CHART, copy button on the panel.
- **Copy** — name, symbol, tagline, cam label, about text, footer phase line.
- **Wallet** — two sources, and **the environment always wins**:
  - `WALLET_SECRET` (preferred when hosted): the key stays in the host's
    variable store, never touches the volume, and is never typed into a public
    web page. While it is set the panel shows `KEY FROM WALLET_SECRET` and
    refuses to install or remove — an edit the next restart would discard is
    worse than a refusal. Rotate by changing the variable.
  - The panel itself: base58 (Phantom export) or a `[1,2,3,...]` array, written
    to `data/wallet.json` mode 600.

  Either way the secret never leaves the process — no route returns it, no
  websocket frame carries it, and the panel only ever sees the pubkey and
  balance.
- **Auto-buyer** — the settings below.
- **Test buy** — one manual buy, to prove the trade route works before arming
  anything.

## The auto-buyer

Picks a random coin off the live feed every 10-30 seconds and buys 0.05 SOL of
it, which lights that row gold on the site. It buys through the official
`@pump-fun/pump-sdk` — bonding curve or graduated PumpSwap pool, whichever the
coin is on — the same path `quant` and the other bots use. No PumpPortal trading
API, no third party holding the key.

It ships **disabled and in dry run**. Dry run marks rows gold without touching the
chain, which is the right way to rehearse. Live buying needs both switches flipped
and a key installed.

Rails, all enforced server-side:

- daily SOL cap on **live** buys, reset at UTC midnight (a dry run spends nothing, so it never consumes the cap — paper mode runs as long as you leave it on)
- a reserve balance it will never spend below (fees have to clear)
- one buy in flight at a time
- only coins seen in the last `maxAgeS` seconds
- every attempt — dry or live, win or fail — appended to `data/trades.json`

## What happens after a buy

Every fill opens a position, held until **take profit +70%** or **stop loss -40%**
(both set in `/admin`), then sold through the same pump SDK.

P&L is **sellback value against what was paid** — what the position is worth if
closed right now, fees and the price impact of our own exit included. So +70%
means +70% in the wallet, not +70% on a chart that quietly loses several percent
on the way out.

The book is priced in a single RPC (`sellValueBatch`) and swept every 5 seconds.
That matters more than it sounds: a stop is only as tight as the poll behind it,
and at a 15s poll a -4% test stop was measured closing at -18%. Fresh curves move
that fast, so a slow loop turns a stop loss into a suggestion.

Two guards worth knowing:

- `executeSell` **hard-refuses the lab's own token**, at the bottom of the stack,
  not in config. The buyer works off the public launch feed and on launch day
  your own coin is on that feed — a take-profit dumping the project's own bag out
  of the project's own wallet is not something anyone gets to explain afterwards.
- A rugged coin can be genuinely unsellable. After 4 failed sells the position is
  parked as **stuck** and left alone rather than burning fees forever; it shows in
  the panel for a human to deal with.

`SELL EVERYTHING NOW` in the panel closes the whole book at market, ignoring both
bounds.

### The market cap floor

Coins that die on the gate are skipped: the floor is checked **on-chain at buy
time**, because the market cap on the launch feed is the price at creation and is
identical for every coin.

The number needs care. Every pump.fun curve opens at the same price *in SOL*
(~28 SOL of market cap), so its **dollar** value tracks SOL/USD:

| SOL price | a brand-new coin's market cap |
|---|---|
| $91 | ~$2,550 |
| $150 | ~$4,200 |

Measured against 22 live launches at SOL $91: a $4,000 floor passed **0 of 22**,
while $2,500 passed 20 of 22 — the two it rejected were down ~90% from launch,
which is exactly the population worth skipping. The default is **$2,700**: just
above launch, so "has not been dumped". Around $3,000 at this SOL price it starts
demanding real buying instead. If SOL moves a lot, revisit it — and when nothing
passes, the log says what the best coin on the feed was actually worth, so a
badly-set floor announces itself instead of looking like a dead buyer.

**This spends real money unattended.** Use a burner wallet funded with only what
you are willing to feed it, and serve `/admin` over https or localhost only — a
plain-http admin page hands the private key to the network.

---

## Layout of the code

```
server/
  index.js       express + websocket hub + admin API
  config.js      .env + data/config.json (what the panel edits)
  sensors.js     the six clips
  feed.js        PumpPortal → the analysis feed
  stats.js       the four tiles + the curve bar
  pump.js        token state, curve progress, executeBuy      (from quant)
  solana.js      throttled RPC, tx send/confirm, SOL/USD      (from quant)
  holders.js     Helius DAS holder count
  dexscreener.js market overlay + pump frontend API
  wallet.js      key install/load, never leaves the process
  autobuy.js     the loop and its rails
public/
  index.html  styles.css  app.js      the site
  admin.html                          the control room
  media/lab.mp4                       your clip goes here (gitignored)
data/                                 runtime state, gitignored
```

`data/` holds `config.json`, `wallet.json`, `history.json`, `trades.json`. Nothing
in it is in git; back up `config.json` if you have tuned the copy.

### Deploying

It is a plain Node server with no build step — `npm start` is the whole thing.
On Railway: set `ADMIN_PASSWORD`, `HELIUS_API_KEY`, and `HOST=0.0.0.0` (the
injected `PORT` is picked up automatically), and mount a volume at `data/` so the
contract address and wallet survive redeploys. Put it behind https before you
paste a key into `/admin`.

### The feed watchdog

A dead websocket does not reliably emit `close`. A sleeping laptop or a proxy
dropping the connection without a FIN leaves a **half-open socket**: it reads as
connected forever and delivers nothing, so plain reconnect-on-close never fires.
This bit us once already — the feed went quiet at 23:50 and was still "connected"
fourteen hours later, while sensors and stats kept running, so the site looked
frozen rather than broken.

`startFeed` therefore treats silence as the failure signal: pump.fun never goes
75 seconds without a launch, so past that the socket is terminated deliberately
and the close handler reconnects. It also pings every 25s to stop idle proxies
dropping it in the first place. When the feed is down the site says so — the scan
line under the analysis feed turns amber and reads LAUNCH FEED OFFLINE.

### One thing that will bite you

`@pump-fun/pump-sdk` ships ESM files inside a CommonJS-typed package, so a plain
`import` resolves to code node then refuses to parse. Both `pump.js` and
`holders.js` load it through `createRequire` instead. Don't "fix" those imports
back.
