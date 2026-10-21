# Deploying

## What this app actually needs

Read this bit before picking a host, because it rules most of them out.

This is **not a website**. It is a long-running process that:

- holds a persistent websocket open to PumpPortal
- runs timers every 1s (sensors), 5s (position sweep) and 10-30s (the buyer)
- serves its own websocket to every browser watching
- keeps state on disk: the contract address, the position book, holders history

So the host must give you:

1. **A process that stays up.** Not a function that wakes per request.
2. **Websockets**, inbound and outbound.
3. **A persistent disk** mounted at `/app/data`.
4. **No idle-sleep.** A suspended machine means a dead feed, a frozen sensor
   clock, and open positions nobody is watching for their stop loss.

### Netlify, Vercel and Cloudflare Pages will not work

Not "will be awkward" — will not work. They host static files plus
**request-scoped** serverless functions. A function is spawned for a request and
destroyed after it. There is nowhere for the PumpPortal socket to live, nothing
to run the timers, and no disk. The site's shell would render and nothing behind
it would ever happen.

(Cloudflare *Workers* plus Durable Objects could technically hold a socket, but
that is a rewrite of the whole server, not a deploy target.)

---

## Fly.io — the closest match to Railway

`Dockerfile` and `fly.toml` are already in the repo.

```bash
fly launch --no-deploy          # accept the existing fly.toml
fly volumes create labrat_data --size 1 --region ams   # name kept: the live volume already uses it
fly secrets set ADMIN_PASSWORD=... HELIUS_API_KEY=... WALLET_SECRET=...
fly deploy
```

`fly.toml` already sets the thing people get wrong: `auto_stop_machines = false`
and `min_machines_running = 1`. Without those, Fly suspends the machine when HTTP
traffic stops — and this bot does its work when nobody is looking.

## Render — easiest dashboard

`render.yaml` is in the repo: New → Blueprint, point it at the repo, fill in the
three secrets.

**Not the free tier.** Free services spin down when idle and have no persistent
disk at all, which breaks both requirements above. `starter` is the floor.

## A VPS (Hetzner, DigitalOcean, Vultr) — cheapest always-on

Most control, most work: you own nginx, TLS and the restart policy.

```bash
docker build -t sausage .
docker run -d --restart=always -p 127.0.0.1:8787:8787 \
  -v /srv/sausage-data:/app/data \
  -e NODE_ENV=production -e ADMIN_PASSWORD=... \
  -e HELIUS_API_KEY=... -e WALLET_SECRET=... \
  --name sausage sausage
```

Then put Caddy or nginx in front for TLS. Keep the container bound to
`127.0.0.1` so only the reverse proxy can reach it.

---

## Settings, on any host

```
NODE_ENV=production          # the Dockerfile sets this
ADMIN_PASSWORD=<long random>
HELIUS_API_KEY=<your key>
WALLET_SECRET=<burner key, base58 or [1,2,3,...]>
STATS_REFRESH_S=20
```

`ADMIN_PASSWORD` is the only thing between the internet and a panel that accepts
a private key and arms a trading bot. Generate one; don't reuse one.

**Do not set `SITE_PORT` or `HOST`.** With `NODE_ENV=production` the server binds
`0.0.0.0` and takes the platform's injected `PORT`. A stale `HOST=127.0.0.1`
pasted from a local `.env` makes the container unreachable and the healthcheck
fail — which is exactly what it looks like when a deploy "doesn't work".

### The wallet

`WALLET_SECRET` is the better of the two options: the key lives in the host's
secret store, never lands on the volume, and is never typed into a page on the
public internet. The alternative — pasting it into `/admin` — sends the secret
across the network to a web form.

While it is set the panel shows `KEY FROM WALLET_SECRET` with the install and
remove controls disabled, and the API refuses both, rather than accepting an edit
the next restart would throw away. Rotate by changing the secret and redeploying.

Use a **burner** funded with only what the bot may lose. The boot log names the
key that loaded — `[wallet] key loaded from WALLET_SECRET: <pubkey>` — check it
is the wallet you meant before arming anything.

### The volume

Mount at **`/app/data`**. It holds the contract address, the position book and
the holders history. Without it every redeploy resets the contract address to
empty and forgets any open positions, and the site comes back up as a blank
template mid-launch. This is the step people skip.

---

## After it is up

- `/` the site · `/admin` the panel · `/health` the status JSON
- In `/admin`: set the **contract address**. Every link and stat follows it.
- Check `/health` reports `"feed":"connected"`. If it says `reconnecting` for
  more than a minute, the host cannot reach PumpPortal.

## First live run

The buyer ships **off and in dry run**, and a fresh deploy with a new volume
starts that way regardless of what your local config says.

1. Deploy, set the contract address, confirm the site looks right.
2. Leave it in dry run a while. Gold rows appear, positions open and close on
   paper, nothing is spent.
3. Fund a burner with only what the bot may lose.
4. Set `WALLET_SECRET`, redeploy, confirm the boot log names the right pubkey,
   then turn dry run off.

The daily cap, the reserve and the max-open-positions limit are the only things
bounding it after that. `SELL EVERYTHING NOW` in the panel closes the book.

**Known issue:** the max-open-positions cap counts paper positions too, so a long
dry-run rehearsal fills all 30 slots and live buys then do nothing but log once
every ten minutes. Clear the book or raise the cap before going live.
