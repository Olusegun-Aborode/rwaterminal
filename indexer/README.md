# RWA Terminal — Envio indexer (event history)

The **event** half of the pipeline. The Cloudflare worker handles *state* history
(NAV/supply/AUM over time); this indexer handles *events* — which power the
**Active Addresses / Transfer Volume / Asset Holders** toggles on the overview.

No public Horizon subgraph exists, so we index the events ourselves.

## What it produces (entities → Postgres tables)
- **ReserveAction / ReserveFlow** — every Supply/Withdraw/Borrow/Repay on the Horizon Pool → flows + unique active addresses.
- **Holding / TokenHolders** — per-aToken holder balances + counts, reconstructed from **Mint/Burn/BalanceTransfer** (RwaATokens are non-transferable, so there are no free `Transfer` events).

Config is resolved on-chain (not hardcoded): `start_block` = Horizon Pool deploy block (23,125,535), and all 10 RwaAToken addresses are filled in `config.yaml`.

## Run it — pick one (this is the only part that needs your infra)
**A) Self-host (free, needs Docker):**
```bash
cd indexer
npm install
npx envio codegen          # generates typed handlers from config + schema
npx envio dev              # spins up Postgres + the indexer + a GraphQL endpoint (Docker)
```
GraphQL comes up at `http://localhost:8080` — the dashboard would read holders/flows from there.

**B) Envio Cloud (hosted, needs an Envio account):**
- Push this repo, connect it in the Envio dashboard (like the Cloudflare flow), set the network/RPC, deploy. You get a hosted GraphQL endpoint.

## Wiring it to the dashboard (after it's running)
The overview's `Holders / Active Addrs / Transfer Vol` toggles currently show a
"Phase 2 — indexer" placeholder. Point them at the indexer's GraphQL:
- **Asset Holders** ← `TokenHolders.holderCount` per aToken (map aToken → asset).
  *(Shortcut: JTRSY/JAAA holder counts are already available from Centrifuge GraphQL `tokenInstancePositions` — no indexer needed for those two.)*
- **Active Addresses** ← distinct `ReserveAction.user` over a window.
- **Transfer Volume / Flows** ← `ReserveFlow` totals (or `ReserveAction` summed per day).

A small worker route (e.g. `/api/events`) can proxy the indexer's GraphQL so the
dashboard reads it the same way it reads `/api/snapshot`.
