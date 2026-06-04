# RWA Terminal — Aave Horizon (Phase 1)

Live data terminal for tokenized RWAs. Phase 1 ingests **Aave Horizon** (Ethereum).
Built on the Datum Labs dashboard kit. **Everything in the stack is free-tier.**

```
                 ┌────────────────────────── ONE RPC (Alchemy) ──────────────────────────┐
                 │                                                                          │
   Cloudflare Cron Worker ──reads──▶ Horizon (RPC oracle) + Issuer APIs (Superstate/USYC)  │
        every 5 min            │                                                            │
                               ├──writes──▶ Cloudflare KV  ──polled by──▶ Dashboard (Pages) │
                               └──appends──▶ Neon (Postgres history)                         │
                                                                                            │
   Envio HyperIndex ──streams events──▶ Neon (flows/holders)  ◀── uses the same RPC ────────┘
```

worker (repo root) = state history + live snapshot · `indexer/` = event history · `db/` = schema · `dashboard/` = UI · `scripts/` = the Python reference enumerator.

---

## What you provide (all free)
1. **Cloudflare** account
2. **Neon** project → connection string
3. **Alchemy** Ethereum mainnet app → HTTPS RPC URL

## 1 — Database (Neon)
1. Create a Neon project → copy the connection string.
2. Load the schema (plain Postgres, no TimescaleDB needed):
   ```bash
   psql "<NEON_CONNECTION_STRING>" -f db/01_schema_neon.sql
   ```

## 2 — Worker (Cloudflare) — the live + state-history piece

**Option A — Git integration (the "Cloning git repository" flow you're in):**
1. Push this repo to GitHub (see bottom).
2. Cloudflare dashboard → Workers & Pages → Create → **Connect to Git** → pick this repo.
3. **Leave Root directory as default (repo root)** — the worker config is at the root. Cloudflare runs `npm install` + `npx wrangler deploy` automatically.
4. The build goes green with no extra setup (KV is optional). To make the endpoints *work*, add the `RPC_URL` secret (and optionally `DATABASE_URL`) in the Worker's **Settings → Variables and Secrets**.

**Option B — CLI (simplest to get running):**
Run each command on its own line — do NOT paste the trailing `# ...` notes (zsh
treats `#` as an argument, not a comment).
```bash
npm install
npx wrangler login
npx wrangler kv namespace create HORIZON_KV
```
Copy the `id` it prints into `wrangler.toml` (replace `REPLACE_WITH_KV_NAMESPACE_ID`), then:
```bash
npx wrangler secret put RPC_URL
npx wrangler secret put DATABASE_URL
npx wrangler deploy
```
`secret put` prompts `Enter a secret value:` — paste your Alchemy URL / Neon string there.
Test: open `https://<your-worker>.workers.dev/api/refresh` (manual pull), then `/api/snapshot`.
The cron (`*/5 * * * *`) then keeps KV + Neon updated automatically.

## 3 — Dashboard (Cloudflare Pages)
1. Edit `dashboard/horizon.html` → set `WORKER_URL` to your deployed worker origin.
2. Deploy `dashboard/` as a Pages project (Connect to Git, root `dashboard`, no build command).
   It polls `/api/snapshot` every 60s and auto-refreshes; falls back to the bundled `horizon.data.js` if the worker isn't set.

## 4 — Indexer (Envio) — event history (do when you want flows/holders)
```bash
cd indexer
# set start_block in config.yaml (Horizon Pool deploy block, from Etherscan)
npx envio codegen && npx envio dev        # local; or deploy to Envio Cloud
```

---

## Push this repo to GitHub
```bash
cd /Users/olusegunaborode/rwa-terminal
git add -A && git commit -m "RWA Terminal pipeline scaffold"
gh repo create rwa-terminal --private --source=. --push   # or create on github.com and: git remote add origin <url> && git push -u origin main
```

## Data sources (why each)
| Need | Source | Free? |
|---|---|---|
| Reserve enumeration, config, supply, rates | RPC (Alchemy) / AaveKit GraphQL | ✅ |
| NAV value + freshness (USTB, USCC, USYC) | Issuer APIs (Superstate, Hashnote) — timestamped | ✅ |
| NAV value (JTRSY, JAAA, VBILL, ACRED) | On-chain oracle via RPC | ✅ |
| State history (NAV/supply over time) | Worker → Neon | ✅ |
| Event history (flows, holders) | Envio indexer → Neon | ✅ self-host |
| AUM cross-check | DefiLlama free API (`aave-horizon-rwa`) | ✅ |
