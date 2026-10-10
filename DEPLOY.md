# Deploying Sift on Railway

Sift runs as one Railway service built from `server/Dockerfile`. The same server serves the website (`web/index.html`), the API and the WebSocket stream, so there is nothing else to host.

The repo is already set up for Railway:

- `railway.json` (repo root) builds `server/Dockerfile` with the repo root as build context, health-checks `GET /api/health`, and restarts the service on failure (up to 10 times).
- The image defaults to `SOURCE=demo`, `LIVE_TRADING_ENABLED=false`, `DATABASE_PATH=/data/sift.db`. With those defaults the site works fully in paper mode: sign in with a wallet, pick a style, start the agent, watch it buy and sell on a simulated Pons market.
- The server creates `/data` if it is missing. Without a volume the database is wiped on every deploy, so add the volume (step 3).

Railway renames buttons from time to time. If a label below doesn't match exactly, look for the closest one in the same place.

---

## 1. Create the project from GitHub

1. Go to https://railway.com and sign in (GitHub login is easiest).
2. Click **New Project** → **Deploy from GitHub repo**.
3. If `fourtisf/sift` isn't listed, click **Configure GitHub App**, give Railway access to the `sift` repository, then come back to the list.
4. Pick **fourtisf/sift**. Railway creates a service and starts the first build straight away.
   - It reads `railway.json` automatically, so you don't need to set a builder, Dockerfile path, start command or healthcheck by hand.
   - Leave **Root Directory** empty. The build context must be the repo root because the Dockerfile copies both `server/` and `web/`.

## 2. Check the branch

1. Click the service → **Settings** → **Source**.
2. **Branch connected to production** should be `main`. Every push to `main` now redeploys. Commits that only touch docs or contracts don't trigger a build (see `watchPatterns` in `railway.json`).

## 3. Add the volume at /data

1. In the project canvas, right-click the service → **Attach Volume**. Alternatively, use **+ Create** (top right) → **Volume** and pick the service.
2. **Mount path:** `/data`
3. Save. Railway redeploys the service with the volume mounted.

Notes:
- A volume can be attached to only one replica. Keep **Replicas = 1** (Settings → Deploy). SQLite and the Telegram bot also expect a single instance.
- Services with a volume have a few seconds of downtime on each deploy. That's expected.

## 4. Set the variables

Click the service → **Variables** → **+ New Variable** (or **Raw Editor** and paste the block below).

**Required for this first deploy** (these match the image defaults, but set them explicitly so they show in the dashboard):

```
SOURCE=demo
LIVE_TRADING_ENABLED=false
DATABASE_PATH=/data/sift.db
```

**Optional:**

| Variable | What it does |
|---|---|
| `DEMO_SPEED` | Simulated market speed. Default `10` (ten simulated seconds per real second). |
| `PAPER_START_ETH` | Paper balance for new users. Default `1`. |
| `ANTHROPIC_API_KEY` | Uses the Claude API for the AI conviction score. Without it a built-in heuristic is used. |
| `AI_MODEL` | Model for the AI score. Default `claude-haiku-5-5`. |
| `TELEGRAM_BOT_TOKEN` | Enables trade alerts and `/start <code>` linking. |

**Do not set:**
- `PORT`: Railway injects it and the server reads it.
- `AGENT_PRIVATE_KEY`, `VAULT_FACTORY`: not needed for paper mode. Only add them when going live (section 7).

Click **Deploy** (or **Apply changes**) after editing variables.

## 5. Get a public URL and check it works

1. Service → **Settings** → **Networking** → **Generate Domain**. If Railway asks for a port, leave the one it detects (the server listens on `$PORT`).
2. Open `https://<your-service>.up.railway.app/api/health`. You should see:
   ```json
   {"ok":true,"source":"demo","chainId":4663,"agent":null,"factory":null,"live":false}
   ```
3. Open the root URL, press **Meet your agent**, sign in with a browser wallet and switch the agent on. In demo mode the first paper buy usually appears within a minute or two.
4. Redeploy once (service → **Deployments** → ⋮ → **Redeploy**), sign in again with the same wallet, and check your paper trades are still there. That confirms the volume works.

If a deploy fails: service → **Deployments** → click the deploy → **Build Logs** / **Deploy Logs**. The server logs `[api] Sift listening on ... (source: demo)` when it is up.

## 6. Add a custom domain

1. Service → **Settings** → **Networking** → **+ Custom Domain**.
2. Enter the domain, e.g. `sift.example.com` (or the root `example.com`), and confirm.
3. Railway shows the DNS records to add, usually a **CNAME** pointing at a `*.up.railway.app` target, sometimes plus a **TXT** record for verification. Add exactly those records at your DNS provider.
   - Root/apex domain: your DNS provider must support CNAME flattening or ALIAS/ANAME (Cloudflare does). Otherwise use a subdomain such as `app.example.com`.
   - Cloudflare: set the record to **DNS only** (grey cloud) until Railway shows the domain as verified and the certificate is issued. After that you can turn the proxy on with SSL mode **Full**.
4. Wait for the green check next to the domain in Railway. HTTPS is issued automatically. The site and WebSocket (`wss://`) work on the custom domain with no code change, because the web app uses the page's own origin.
5. Optional: set `PUBLIC_ORIGIN=https://sift.example.com` in Variables to record the canonical URL. The current server doesn't use it for anything yet.

---

## 7. Later: switch to live chain data (still paper trading)

Do this only after `npm run check:live` has passed against Robinhood Chain (see `CLAUDE.md`, "Next tasks", step 1).

1. **Get a paid RPC** for Robinhood Chain (chain id 4663) from Alchemy, QuickNode, Dwellir or Chainstack. The public RPC is rate-limited.
2. Service → **Variables**, set:
   ```
   SOURCE=live
   RPC_HTTP=https://<your paid RPC URL>
   LIVE_TRADING_ENABLED=false
   DATABASE_PATH=/data/sift-live.db
   ```
   - A new database file keeps demo users, simulated positions and fake deployer "rug history" out of the live data. The volume keeps the old `sift.db` in case you want to switch back.
   - Optional: `BACKFILL_BLOCKS` (default `36000` ≈ 1 hour of blocks), `POLL_MS` (default `1000`), `BLOCKSCOUT_API`, `SMART_WALLETS`.
3. Deploy. In live mode the server backfills recent blocks **before** it starts answering HTTP, and the healthcheck allows 300 s for that. If the deploy fails its healthcheck, lower `BACKFILL_BLOCKS` (e.g. `6000`) or use a faster RPC.
4. Check `/api/health` shows `"source":"live"`. Then watch the decisions in the app for a while (holders, market cap, bundle %, curve %) and fix any metric that looks wrong before going further.

To go back to the demo market, set `SOURCE=demo` and `DATABASE_PATH=/data/sift.db` and redeploy.

## 8. Much later: real-money trading

Not part of this deploy. Follow `CLAUDE.md` "Next tasks" steps 3–6 first: deploy the vault contracts, allowlist the curve code hash, do a 0.01 ETH test, and get an audit. Then add:

```
AGENT_PRIVATE_KEY=0x...      # keep it in Railway Variables (sealed), never in the repo
VAULT_FACTORY=0x...
LIVE_TRADING_ENABLED=true
```

Watch the agent key's ETH balance; it pays gas for every live trade.

## Website only: GitHub Pages (demo, no server)

`.github/workflows/pages.yml` publishes `web/` to GitHub Pages on every push to `main` that changes `web/`. With no server behind it, the site runs its browser-only demo (simulated market, nothing saved on a server).

One-time setup: on GitHub open **fourtisf/sift → Settings → Pages**, set **Source** to **GitHub Actions**. Then open **Actions → Deploy website to GitHub Pages → Run workflow**. The site appears at `https://fourtisf.github.io/sift/`.

For real wallet sign-in, saved paper trades and live chain data, use the Railway deploy above.

---

## Building and running the image yourself

```bash
# from the repo root
docker build -f server/Dockerfile -t sift .
docker run --rm -p 8787:8787 -v sift-data:/data sift
# → http://localhost:8787  (SOURCE=demo, paper only, DB in the sift-data volume)
```
