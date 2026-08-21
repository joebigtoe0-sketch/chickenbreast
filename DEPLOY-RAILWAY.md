# Deploying to Railway

`railway.json` sets the build (Nixpacks), the start command, and a `/health`
check. No build step, no Dockerfile — it is a plain Node server.

The server already knows it is on Railway: when `RAILWAY_ENVIRONMENT` is present
it binds `0.0.0.0` and uses the injected `PORT`. **Do not set `SITE_PORT` or
`HOST`** — a pasted `SITE_PORT` from your local `.env` will make the healthcheck
fail and the deploy roll back.

## One-time setup

1. **New Project → Deploy from GitHub repo** → pick `chickenbreast`. Railway
   detects Node and reads `railway.json`.

2. **Variables** (service → Variables → Raw Editor):

   ```
   ADMIN_PASSWORD=<long random string>
   HELIUS_API_KEY=<your key>
   STATS_REFRESH_S=20
   ```

   `ADMIN_PASSWORD` is the only thing standing between the internet and a panel
   that accepts a private key and arms a trading bot. Generate one, don't reuse
   one. Without `HELIUS_API_KEY` the site still runs, but the holders tile shows
   a dash and RPC falls back to the public node.

3. **The buyer's wallet — use `WALLET_SECRET`.**

   ```
   WALLET_SECRET=<base58 key from a Phantom export, or [1,2,3,...]>
   ```

   This is the better of the two options. The key lives in Railway's variable
   store, never lands on the volume, and is never typed into a page on the
   public internet. The alternative — pasting it into `/admin` — sends the
   secret across the network to a web form, which is a step worth not taking.

   **The environment always wins.** While `WALLET_SECRET` is set the panel shows
   `KEY FROM WALLET_SECRET` with the install and remove controls disabled, and
   the API refuses both — better than accepting an edit that the next restart
   would silently throw away. Rotate by changing the variable and redeploying;
   go back to panel-managed by deleting it.

   Use a **burner** funded with only what the bot may lose. The boot log names
   the key that loaded:
   `[wallet] key loaded from WALLET_SECRET: <pubkey>` — check it is the wallet
   you meant before arming anything.

4. **Volume** (service → Settings → Volumes): mount at **`/app/data`**.

   This holds the contract address, the position book, and the holders history
   (plus the wallet key, if you did not use `WALLET_SECRET`). Without it **every
   redeploy resets the contract address to empty and forgets any open positions** — the site would come back up as a
   blank template mid-launch. This is the step people skip.

5. **Networking** → Generate Domain. You get `https://<name>.up.railway.app`,
   with TLS, which is what makes the admin panel safe to use at all.

## After it is up

- `/` the site · `/admin` the panel · `/health` the status JSON
- In `/admin`: set the **contract address**. Everything on the page follows it
  — links, market cap, holders, liquidity, the bonding-curve bar.
- Check `/health` reports `"feed":"connected"`. If it says `reconnecting` for
  more than a minute, PumpPortal is unreachable from the container.

## The lab video

`public/media/lab.mp4` is committed to the repo — Railway builds from git, so a
file that is not in the repo does not exist on the server. Keep it small: this
is a looping background clip, and every megabyte is in every clone and every
deploy. Under ~10 MB is comfortable, and GitHub hard-rejects single files over
100 MB.

If you would rather not carry it in git, host it anywhere public and set the
video URL in `/admin` instead — the page takes a full URL.

## First live run

The buyer ships **off and in dry run**, and a fresh deploy with a new volume
starts that way regardless of what your local config says. So:

1. Deploy, set the contract address, confirm the site looks right.
2. Leave the buyer in dry run for a while. Gold rows appear, positions open and
   close on paper, nothing is spent.
3. Fund a **burner** wallet with only what the bot may lose.
4. Set `WALLET_SECRET`, redeploy, confirm the boot log names the right pubkey,
   then turn dry run off.

The daily cap, the reserve, and the max-open-positions limit are the only things
bounding it after that. `SELL EVERYTHING NOW` in the panel closes the book.
