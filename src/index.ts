/**
 * RWA Terminal — Cloudflare Cron Worker
 * Every 5 min: read Aave Horizon (RPC oracle + issuer APIs), write the latest
 * snapshot to KV (powers the live dashboard) and append history rows to Neon.
 *
 * Data sources (per the sourcing plan):
 *   - RPC (Alchemy): reserve enumeration + config + NAV oracle value/updatedAt
 *   - Issuer APIs (Superstate, Hashnote): timestamped NAV freshness for value-only feeds
 *   - (optional) AaveKit GraphQL: cross-check Aave-side supply/rates — see fetchAaveKit()
 *   - Neon (Postgres): history; KV: latest snapshot
 *
 * NOTE: this is a scaffold. The RPC read logic mirrors scripts/enumerate_horizon.py
 * (already proven against mainnet). Verify AaveKit GraphQL field names in the
 * playground before relying on fetchAaveKit().
 */
import { createPublicClient, http, getAddress } from "viem";
import { mainnet } from "viem/chains";
import { neon } from "@neondatabase/serverless";

export interface Env {
  HORIZON_KV?: KVNamespace;   // optional — add after first deploy for caching
  RPC_URL: string;            // secret (required)
  DATABASE_URL?: string;      // optional secret — set to enable Neon history
  HORIZON_POOL: string;
  HORIZON_ORACLE: string;
  HORIZON_DATA_PROVIDER: string;
}

const KNOWN: Record<string, [string, string]> = {
  "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e": ["USTB", "Superstate"],
  "0x14d60e7fdc0d71d8611742720e4c50e7a974020c": ["USCC", "Superstate"],
  "0x8c213ee79581ff4984583c6a801e5263418c4b86": ["JTRSY", "Janus Henderson / Anemoy / Centrifuge"],
  "0x5a0f93d040de44e78f251b03c43be9cf317dcf64": ["JAAA", "Janus Henderson / Anemoy / Centrifuge"],
  "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b": ["USYC", "Circle (Hashnote)"],
  "0x2255718832bc9fd3be1caf75084f4803da14ff01": ["VBILL", "VanEck (Securitize)"],
  "0x17418038ecf73ba4026c4f428547bf099706f27b": ["ACRED", "Apollo / Securitize"],
  "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f": ["GHO", "Aave"],
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ["USDC", "Circle"],
  "0x8292bb45bf1ee4d140127049757c2e0ff06317ed": ["RLUSD", "Ripple"],
};
const STABLE = new Set(["GHO", "USDC", "RLUSD"]);
const ASSET_CLASS: Record<string, string> = {
  USTB: "US Treasuries", JTRSY: "US Treasuries", USYC: "US Treasuries", VBILL: "US Treasuries",
  USCC: "Crypto Carry", JAAA: "Private Credit (CLO)", ACRED: "Private Credit",
  GHO: "Stablecoin", USDC: "Stablecoin", RLUSD: "Stablecoin",
};
const erc20Abi = [
  { name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
// Labeled-address registry for usage/utilisation: where each RWA token's supply physically sits.
// We read the token's balanceOf(address) for every entry, then bucket by protocol; the unlabeled
// remainder (totalSupply minus all labeled balances) is "held elsewhere". Indexer-free — pure RPC,
// runs in the existing cron. EXTEND IT: add a DEX pool / Pendle / perp-margin / vault address here
// and that slice immediately appears in the breakdown. (Aave v3 custodies the underlying in its
// aToken; Morpho Blue is a singleton that custodies all collateral + supplied.)
const USAGE_REGISTRY: { address: string; protocol: string; kind: string }[] = [
  // Aave Horizon aTokens (each custodies its own underlying)
  { address: "0x946281a2d0dd6e650d08f74833323d66ae4c8b12", protocol: "Aave Horizon", kind: "lending" }, // aGHO
  { address: "0x68215b6533c47ff9f7125ac95adf00fe4a62f79e", protocol: "Aave Horizon", kind: "lending" }, // aUSDC
  { address: "0xe3190143eb552456f88464662f0c0c4ac67a77eb", protocol: "Aave Horizon", kind: "lending" }, // aRLUSD
  { address: "0x4e58a2e433a739726134c83d2f07b2562e8dfdb3", protocol: "Aave Horizon", kind: "lending" }, // aUSTB
  { address: "0x08b798c40b9ab931356d9ab4235f548325c4cb80", protocol: "Aave Horizon", kind: "lending" }, // aUSCC
  { address: "0xc167932ac4eec2b65844ef00d31b4550250536a5", protocol: "Aave Horizon", kind: "lending" }, // aUSYC
  { address: "0x844f07ab09aa5dbdce6a9b1206ce150e1eadaccb", protocol: "Aave Horizon", kind: "lending" }, // aJTRSY
  { address: "0xb0ec6c4482ac1ef77be239c0ac833cf37a27c876", protocol: "Aave Horizon", kind: "lending" }, // aJAAA
  { address: "0xe1cfd16b8e4b1c86bb5b7a104cfefbc7b09326dd", protocol: "Aave Horizon", kind: "lending" }, // aVBILL
  { address: "0xc293744ffbcf46696d589f5c415e71bc491519cd", protocol: "Aave Horizon", kind: "lending" }, // aACRED
  // Morpho Blue singleton (custodies all collateral + supplied across markets)
  { address: "0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb", protocol: "Morpho", kind: "lending" },
];
const ISSUER: Record<string, { kind: "superstate"; fund: number } | { kind: "usyc" }> = {
  "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e": { kind: "superstate", fund: 1 },
  "0x14d60e7fdc0d71d8611742720e4c50e7a974020c": { kind: "superstate", fund: 2 },
  "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b": { kind: "usyc" },
};

const dpAbi = [
  { name: "getAllReservesTokens", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "tuple[]", components: [{ name: "symbol", type: "string" }, { name: "tokenAddress", type: "address" }] }] },
  { name: "getReserveConfigurationData", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }, { type: "bool" }, { type: "bool" }, { type: "bool" }, { type: "bool" }] },
  { name: "getReserveData", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint40" }] },
] as const;
const oracleAbi = [
  { name: "getSourceOfAsset", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { name: "getAssetPrice", type: "function", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const aggAbi = [
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { name: "latestAnswer", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "int256" }] },
  { name: "latestRoundData", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] },
] as const;

async function fetchIssuer(addr: string, now: number) {
  const cfg = ISSUER[addr.toLowerCase()];
  if (!cfg) return null;
  try {
    if (cfg.kind === "superstate") {
      const r: any = await (await fetch(`https://api.superstate.com/v1/funds/${cfg.fund}/nav-daily`, { headers: { "User-Agent": "rwa-terminal/1.0" } })).json();
      const rec = Array.isArray(r) ? r[0] : (r.data?.[0] ?? r);
      const ts = Math.floor(Date.parse(rec.net_asset_value_date) / 1000);
      return { source: "superstate_api", nav: Number(rec.net_asset_value), asof_ts: ts, aum: Number(rec.assets_under_management || 0) };
    } else {
      const r: any = await (await fetch("https://usyc.hashnote.com/api/price-reports", { headers: { "User-Agent": "rwa-terminal/1.0" } })).json();
      const rec = Array.isArray(r) ? r[0] : (r.data?.[0] ?? r);
      return { source: "hashnote_api", nav: Number(rec.price), asof_ts: Number(rec.timestamp), aum: Number(rec.totalSupply) * Number(rec.price) };
    }
  } catch { return null; }
}

// Centrifuge GraphQL — NAV + freshness for JTRSY/JAAA (the on-chain LlamaGuard
// adapters are value-only; this is the real source, like centrifuge.io itself).
async function fetchCentrifuge(): Promise<Record<string, { nav: number; computedAt: number }>> {
  const out: Record<string, { nav: number; computedAt: number }> = {};
  try {
    const r: any = await (await fetch("https://api.centrifuge.io", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ tokens { items { symbol tokenPrice tokenPriceComputedAt } } }" }),
    })).json();
    for (const t of (r?.data?.tokens?.items || [])) {
      if ((t.symbol === "JTRSY" || t.symbol === "JAAA") && t.tokenPrice) {
        out[t.symbol] = { nav: Number(t.tokenPrice) / 1e18, computedAt: Math.floor(Number(t.tokenPriceComputedAt) / 1000) };
      }
    }
  } catch {}
  return out;
}

// Envio HyperIndex — event-history projection (holders, active addresses, flows).
// Keyed: TokenHolders by aToken; ReserveFlow/ReserveAction by reserve (= underlying).
const INDEXER_GRAPHQL = "https://indexer.dev.hyperindex.xyz/3609531/v1/graphql";
const ATOKEN_TO_UNDERLYING: Record<string, string> = {
  "0x946281a2d0dd6e650d08f74833323d66ae4c8b12": "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f", // GHO
  "0x68215b6533c47ff9f7125ac95adf00fe4a62f79e": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
  "0xe3190143eb552456f88464662f0c0c4ac67a77eb": "0x8292bb45bf1ee4d140127049757c2e0ff06317ed", // RLUSD
  "0x4e58a2e433a739726134c83d2f07b2562e8dfdb3": "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e", // USTB
  "0x08b798c40b9ab931356d9ab4235f548325c4cb80": "0x14d60e7fdc0d71d8611742720e4c50e7a974020c", // USCC
  "0xc167932ac4eec2b65844ef00d31b4550250536a5": "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b", // USYC
  "0x844f07ab09aa5dbdce6a9b1206ce150e1eadaccb": "0x8c213ee79581ff4984583c6a801e5263418c4b86", // JTRSY
  "0xb0ec6c4482ac1ef77be239c0ac833cf37a27c876": "0x5a0f93d040de44e78f251b03c43be9cf317dcf64", // JAAA
  "0xe1cfd16b8e4b1c86bb5b7a104cfefbc7b09326dd": "0x2255718832bc9fd3be1caf75084f4803da14ff01", // VBILL
  "0xc293744ffbcf46696d589f5c415e71bc491519cd": "0x17418038ecf73ba4026c4f428547bf099706f27b", // ACRED
};
async function fetchEvents(): Promise<any> {
  const query = `{
    TokenHolders { token holderCount lastBlock }
    ReserveFlow { reserve totalSupplied totalWithdrawn totalBorrowed totalRepaid actionCount }
    ReserveAction(distinct_on: [reserve, user], order_by: [{reserve: asc}, {user: asc}]) { reserve }
    chain_metadata { latest_processed_block }
  }`;
  const r: any = await (await fetch(INDEXER_GRAPHQL, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  })).json();
  const d = r?.data;
  if (!d) return { ok: false, error: r?.errors ?? "no data", by_asset: {} };
  const by: Record<string, any> = {};
  const ensure = (a: string) => (by[a] ||= { holders: 0, active: 0, supplied: "0", withdrawn: "0", borrowed: "0", repaid: "0", action_count: 0 });
  for (const t of (d.TokenHolders || [])) {
    const u = ATOKEN_TO_UNDERLYING[(t.token || "").toLowerCase()];
    if (u) ensure(u).holders = Number(t.holderCount) || 0;
  }
  for (const f of (d.ReserveFlow || [])) {
    const e = ensure((f.reserve || "").toLowerCase());
    e.supplied = String(f.totalSupplied); e.withdrawn = String(f.totalWithdrawn);
    e.borrowed = String(f.totalBorrowed); e.repaid = String(f.totalRepaid); e.action_count = Number(f.actionCount) || 0;
  }
  for (const a of (d.ReserveAction || [])) ensure((a.reserve || "").toLowerCase()).active += 1;
  const vals = Object.values(by) as any[];
  return {
    ok: true, synced_block: Number(d.chain_metadata?.[0]?.latest_processed_block) || null,
    by_asset: by,
    totals: { holders: vals.reduce((s, v) => s + v.holders, 0), active_addresses: vals.reduce((s, v) => s + v.active, 0), actions: vals.reduce((s, v) => s + v.action_count, 0) },
  };
}

// Daily transfer-volume time series from ReserveAction (powers the Transfer Volume
// area chart). Hasura caps 1000 rows/query + exposes no aggregates, so we page in
// parallel and bucket by (day, reserve) into raw token units (UI converts to USD).
async function fetchFlows(): Promise<any> {
  const PAGE = 1000, MAX_PAGES = 12; // 12k-action headroom; offsets past the data return []
  const pages = await Promise.all(Array.from({ length: MAX_PAGES }, (_, p) =>
    fetch(INDEXER_GRAPHQL, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ ReserveAction(limit: ${PAGE}, offset: ${p * PAGE}, order_by: {timestamp: asc}) { timestamp reserve amount } }` }),
    }).then(r => r.json()).catch(() => null)
  ));
  const daily: Record<string, Record<string, number>> = {};
  let total = 0;
  for (const pg of pages) {
    const rows = (pg as any)?.data?.ReserveAction || [];
    total += rows.length;
    for (const a of rows) {
      const day = new Date(Number(a.timestamp) * 1000).toISOString().slice(0, 10);
      const res = (a.reserve || "").toLowerCase();
      (daily[day] ||= {});
      daily[day][res] = (daily[day][res] || 0) + Number(a.amount); // raw token base units
    }
  }
  return { ok: true, actions: total, days: Object.keys(daily).length, daily };
}

// Asset-class lookup for the event-history aggregations.
function classOfUnderlying(addr: string): string {
  const [label] = KNOWN[addr.toLowerCase()] ?? ["?", ""];
  return ASSET_CLASS[label] ?? "Other";
}
function classOfAToken(aTok: string): string {
  const u = ATOKEN_TO_UNDERLYING[aTok.toLowerCase()];
  return u ? classOfUnderlying(u) : "Other";
}

// Holder count per asset class over time — last HolderPoint per token per day, carried
// forward. Powers the Holders trend line + real 30d delta (backfilled from genesis).
async function fetchHoldersHistory(): Promise<any> {
  const PAGE = 1000, MAX = 20;
  const pages = await Promise.all(Array.from({ length: MAX }, (_, p) =>
    fetch(INDEXER_GRAPHQL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ HolderPoint(limit: ${PAGE}, offset: ${p * PAGE}, order_by: {timestamp: asc}) { token holderCount timestamp } }` }) }).then(r => r.json()).catch(() => null)));
  const pts: any[] = [];
  for (const pg of pages) for (const r of ((pg as any)?.data?.HolderPoint || [])) pts.push(r);
  pts.sort((a, b) => a.timestamp - b.timestamp);
  const ptsByDay: Record<string, any[]> = {};
  for (const p of pts) { const d = new Date(p.timestamp * 1000).toISOString().slice(0, 10); (ptsByDay[d] ||= []).push(p); }
  const days = Object.keys(ptsByDay).sort();
  const lastByTok: Record<string, number> = {};
  const out: any[] = [];
  for (const d of days) {
    for (const p of ptsByDay[d]) lastByTok[(p.token || "").toLowerCase()] = Number(p.holderCount);
    const byClass: Record<string, number> = {};
    for (const [tok, c] of Object.entries(lastByTok)) { const cls = classOfAToken(tok); byClass[cls] = (byClass[cls] || 0) + c; }
    out.push({ d, byClass, total: Object.values(byClass).reduce((s, v) => s + v, 0) });
  }
  return { ok: true, points: out };
}

// Cumulative distinct active addresses per asset class over time (from ReserveAction).
async function fetchActiveHistory(): Promise<any> {
  const PAGE = 1000, MAX = 12;
  const pages = await Promise.all(Array.from({ length: MAX }, (_, p) =>
    fetch(INDEXER_GRAPHQL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: `{ ReserveAction(limit: ${PAGE}, offset: ${p * PAGE}, order_by: {timestamp: asc}) { timestamp reserve user } }` }) }).then(r => r.json()).catch(() => null)));
  const acts: any[] = [];
  for (const pg of pages) for (const r of ((pg as any)?.data?.ReserveAction || [])) acts.push(r);
  acts.sort((a, b) => a.timestamp - b.timestamp);
  const ptsByDay: Record<string, any[]> = {};
  for (const a of acts) { const d = new Date(a.timestamp * 1000).toISOString().slice(0, 10); (ptsByDay[d] ||= []).push(a); }
  const days = Object.keys(ptsByDay).sort();
  const seen = new Set<string>();
  const cum: Record<string, number> = {};
  const out: any[] = [];
  for (const d of days) {
    for (const a of ptsByDay[d]) {
      const key = `${a.reserve}-${a.user}`.toLowerCase();
      if (!seen.has(key)) { seen.add(key); const cls = classOfUnderlying(a.reserve); cum[cls] = (cum[cls] || 0) + 1; }
    }
    out.push({ d, byClass: { ...cum }, total: Object.values(cum).reduce((s, v) => s + v, 0) });
  }
  return { ok: true, points: out };
}

// ── Morpho venue (Phase 2) ────────────────────────────────────────────────
// Morpho is a singleton-market protocol; "RWA" here is a CURATED allowlist of the
// real tokenized-RWA / RWA-backed collateral on Morpho (the `rwa` API tag is noisy,
// so we don't use it). Each asset is labelled with what it is + class + issuer.
const MORPHO_GRAPHQL = "https://blue-api.morpho.org/graphql";
// tier: "fund" = discrete tokenized fund (Horizon-parity); "backed" = RWA-backed dollar / commodity (broader).
const MORPHO_RWA: Record<string, { label: string; asset_class: string; issuer: string; what: string; tier: "fund" | "backed" }> = {
  "0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b": { label: "syrupUSDC", asset_class: "Private Credit", issuer: "Maple Finance", what: "Institutional private-credit pool token", tier: "backed" },
  "0xc139190f447e929f090edeb554d95abb8b18ac1c": { label: "USDtb", asset_class: "US Treasuries", issuer: "Ethena", what: "T-bill-backed dollar (holds BlackRock BUIDL)", tier: "backed" },
  "0x238a700ed6165261cf8b2e544ba797bc11e466ba": { label: "mF-ONE", asset_class: "Private Credit", issuer: "Midas / Fasanara", what: "Tokenized private-credit certificate", tier: "fund" },
  "0x09ad9c6dcadcc3ab0b3e107e8e7da69c2eea8599": { label: "muBOND", asset_class: "Bonds", issuer: "Midas", what: "Tokenized bond product", tier: "fund" },
  "0x86b495e4cb00ab18ad94bfd7920479cc79e8ebfe": { label: "wJAAA", asset_class: "Private Credit (CLO)", issuer: "Janus Henderson / Centrifuge", what: "Wrapped JAAA (AAA CLO fund)", tier: "fund" },
  "0xa0769f7a8fc65e47de93797b4e21c073c117fc80": { label: "EUTBL", asset_class: "Govt Bonds (EU)", issuer: "Spiko", what: "EU T-bill money-market fund (EUR)", tier: "fund" },
  "0x68749665ff8d2d112fa859aa293f07a622782f38": { label: "XAUt", asset_class: "Commodities (Gold)", issuer: "Tether", what: "Tokenized gold (1 oz = 1 XAUt)", tier: "backed" },
  "0x45804880de22913dafe09f4980848ece6ecbaf78": { label: "PAXG", asset_class: "Commodities (Gold)", issuer: "Paxos", what: "Tokenized gold (1 oz = 1 PAXG)", tier: "backed" },
};
async function fetchMorpho(env: Env): Promise<any> {
  const addrs = Object.keys(MORPHO_RWA);
  const query = `{ markets(first: 1000, where: {chainId_in: [1]}) { items { marketId lltv loanAsset { symbol address } collateralAsset { symbol address } oracle { address } state { supplyAssetsUsd borrowAssetsUsd collateralAssetsUsd utilization supplyApy borrowApy } } } }`;
  // In parallel: Morpho markets (on-venue value) + DefiLlama prices (for full AUM = supply × price).
  const [mr, llama] = await Promise.all([
    fetch(MORPHO_GRAPHQL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) }).then(r => r.json()).catch(() => null),
    fetch(`https://coins.llama.fi/prices/current/${addrs.map(a => "ethereum:" + a).join(",")}`).then(r => r.json()).then((j: any) => j?.coins || {}).catch(() => ({})),
  ]);
  const priceOf: Record<string, number> = {};
  for (const [k, v] of Object.entries(llama as Record<string, any>)) priceOf[k.toLowerCase().replace("ethereum:", "")] = v?.price;
  // On-chain totalSupply + decimals (one multicall) → full AUM = supply/10^dec × price.
  const aumByAddr: Record<string, number> = {};
  if (env.RPC_URL) {
    try {
      const client = createPublicClient({ chain: mainnet, transport: http(env.RPC_URL) });
      const calls = addrs.flatMap((a) => [
        { address: getAddress(a), abi: erc20Abi, functionName: "totalSupply" },
        { address: getAddress(a), abi: erc20Abi, functionName: "decimals" },
      ]);
      const res: any[] = await client.multicall({ contracts: calls, allowFailure: true });
      addrs.forEach((a, i) => {
        const ts = res[i * 2]?.status === "success" ? res[i * 2].result : null;
        const dec = res[i * 2 + 1]?.status === "success" ? Number(res[i * 2 + 1].result) : 18;
        const price = priceOf[a];
        if (ts != null && price != null) aumByAddr[a] = (Number(ts) / 10 ** dec) * price;
      });
    } catch {}
  }
  const items = (mr as any)?.data?.markets?.items || [];
  const by: Record<string, any> = {};
  for (const [addr, meta] of Object.entries(MORPHO_RWA)) by[addr] = { ...meta, address: addr, collateral_usd: 0, supplied_usd: 0, borrow_usd: 0, markets: 0, markets_detail: [], price: priceOf[addr] ?? null, aum: aumByAddr[addr] ?? null };
  // Morpho Blue liquidation incentive factor (LIF) from LLTV: LIF = min(1.15, 1/(0.3·LLTV + 0.7)).
  const lifOf = (lltvFrac: number) => Math.min(1.15, 1 / (0.3 * lltvFrac + 0.7));
  const mkDetail = (m: any, role: string) => {
    const st = m.state || {}, lltv = m.lltv ? Number(m.lltv) / 1e18 : null;
    return {
      market_id: m.marketId, role, // 'collateral' = our RWA is the collateral; 'loan' = our asset is supplied/lent
      collateral_symbol: m.collateralAsset?.symbol || "?", loan_symbol: m.loanAsset?.symbol || "?",
      lltv, liq_incentive: lltv != null ? lifOf(lltv) : null,
      supply_usd: st.supplyAssetsUsd || 0, borrow_usd: st.borrowAssetsUsd || 0, collateral_usd: st.collateralAssetsUsd || 0,
      utilization: st.utilization || 0, supply_apy: st.supplyApy || 0, borrow_apy: st.borrowApy || 0,
      oracle: m.oracle?.address || null,
    };
  };
  for (const m of items) {
    const ca = (m.collateralAsset?.address || "").toLowerCase(), la = (m.loanAsset?.address || "").toLowerCase();
    const st = m.state || {};
    if (by[ca]) { by[ca].collateral_usd += st.collateralAssetsUsd || 0; by[ca].borrow_usd += st.borrowAssetsUsd || 0; by[ca].markets++; by[ca].markets_detail.push(mkDetail(m, "collateral")); }
    if (by[la]) { by[la].supplied_usd += st.supplyAssetsUsd || 0; by[la].markets++; by[la].markets_detail.push(mkDetail(m, "loan")); }
  }
  // Drop dust + degenerate/broken-oracle markets (e.g. ~$0 collateral but huge borrow at absurd APY),
  // then recompute each asset's aggregates from the clean market set so totals exclude ghosts.
  for (const a of Object.values(by) as any[]) {
    a.markets_detail = a.markets_detail
      .filter((d: any) => (d.collateral_usd + d.supply_usd) > 1000 && (d.borrow_apy == null || d.borrow_apy < 5) && !(d.role === "collateral" && d.collateral_usd < 1000))
      .sort((x: any, y: any) => (y.collateral_usd + y.borrow_usd) - (x.collateral_usd + x.borrow_usd));
    const coll = a.markets_detail.filter((d: any) => d.role === "collateral");
    const loan = a.markets_detail.filter((d: any) => d.role === "loan");
    a.collateral_usd = coll.reduce((s: number, d: any) => s + d.collateral_usd, 0);
    a.borrow_usd = coll.reduce((s: number, d: any) => s + d.borrow_usd, 0);
    a.supplied_usd = loan.reduce((s: number, d: any) => s + d.supply_usd, 0);
    a.markets = a.markets_detail.length;
  }
  const assets = (Object.values(by) as any[])
    .map((a) => ({ ...a, morpho_usd: a.collateral_usd + a.supplied_usd, role: a.collateral_usd >= a.supplied_usd ? "collateral" : "supplied" }))
    .filter((a) => a.morpho_usd > 1000).sort((a, b) => b.morpho_usd - a.morpho_usd);
  // Flattened RWA-collateral markets (the liquidation-risk lens) across all assets.
  const collateralMarkets = assets.flatMap((a: any) =>
    (a.markets_detail || []).filter((d: any) => d.role === "collateral").map((d: any) => ({
      ...d, asset_label: a.label, asset_class: a.asset_class, issuer: a.issuer, tier: a.tier,
    }))).sort((x: any, y: any) => (y.collateral_usd + y.borrow_usd) - (x.collateral_usd + x.borrow_usd));
  const byClass: Record<string, number> = {};
  for (const a of assets) byClass[a.asset_class] = (byClass[a.asset_class] || 0) + a.morpho_usd;
  const lltvs = collateralMarkets.map((m: any) => m.lltv).filter((v: any) => v != null);
  return {
    ok: true, venue: "morpho", fetched_at: Math.floor(Date.now() / 1000), assets, collateral_markets: collateralMarkets,
    total_usd: assets.reduce((s, a) => s + a.morpho_usd, 0),
    total_borrow: assets.reduce((s, a) => s + (a.borrow_usd || 0), 0),
    total_aum: assets.reduce((s, a) => s + (a.aum || 0), 0), asset_count: assets.length,
    market_count: collateralMarkets.length,
    avg_lltv: lltvs.length ? lltvs.reduce((s: number, v: number) => s + v, 0) / lltvs.length : null,
    by_class: Object.entries(byClass).map(([name, usd]) => ({ name, usd })).sort((a, b) => b.usd - a.usd),
  };
}

// Per-asset 7D/30D change in Total Value (AUM). Total Value = on-chain totalSupply × price,
// so we read totalSupply at the current block and at ~7d / ~30d-ago blocks (archive eth_call)
// and pair each with that date's DefiLlama price. Captures BOTH issuance growth and price drift
// (issuance is the dominant signal for NAV-stable RWA; price matters for gold). Robust fallbacks:
// missing archive supply → hold supply constant (price-only delta); brand-new token → null delta.
async function fetchDeltas(env: Env): Promise<any> {
  if (!env.RPC_URL) return { ok: false, deltas: {} };
  const client = createPublicClient({ chain: mainnet, transport: http(env.RPC_URL) });
  let horizonAddrs: string[] = [];
  try {
    const dp = getAddress(env.HORIZON_DATA_PROVIDER);
    const toks = (await client.readContract({ address: dp, abi: dpAbi, functionName: "getAllReservesTokens" })) as any[];
    horizonAddrs = toks.map((t) => String(t.tokenAddress).toLowerCase());
  } catch {}
  const addrs = Array.from(new Set([...horizonAddrs, ...Object.keys(MORPHO_RWA)]));
  if (!addrs.length) return { ok: false, deltas: {} };
  let blockNow = 0n, tsNow = Math.floor(Date.now() / 1000);
  try { const blk = await client.getBlock(); blockNow = blk.number; tsNow = Number(blk.timestamp); } catch {}
  const B7 = blockNow > 0n ? blockNow - 7n * 7200n : undefined;
  const B30 = blockNow > 0n ? blockNow - 30n * 7200n : undefined;
  const TS7 = tsNow - 7 * 86400, TS30 = tsNow - 30 * 86400;
  const supplyCalls = addrs.map((a) => ({ address: getAddress(a), abi: erc20Abi, functionName: "totalSupply" }));
  const decCalls = addrs.map((a) => ({ address: getAddress(a), abi: erc20Abi, functionName: "decimals" }));
  const coinKeys = addrs.map((a) => "ethereum:" + a).join(",");
  const pmap = (obj: any) => { const m: Record<string, number> = {}; for (const [k, v] of Object.entries(obj || {})) m[k.toLowerCase().replace("ethereum:", "")] = (v as any)?.price; return m; };
  const [sNow, dRes, s7, s30, pNow, p7, p30] = await Promise.all([
    client.multicall({ contracts: supplyCalls, allowFailure: true }).catch(() => []),
    client.multicall({ contracts: decCalls, allowFailure: true }).catch(() => []),
    B7 ? client.multicall({ contracts: supplyCalls, allowFailure: true, blockNumber: B7 }).catch(() => []) : Promise.resolve([]),
    B30 ? client.multicall({ contracts: supplyCalls, allowFailure: true, blockNumber: B30 }).catch(() => []) : Promise.resolve([]),
    fetch(`https://coins.llama.fi/prices/current/${coinKeys}`).then((r) => r.json()).then((j: any) => pmap(j?.coins)).catch(() => ({})),
    fetch(`https://coins.llama.fi/prices/historical/${TS7}/${coinKeys}`).then((r) => r.json()).then((j: any) => pmap(j?.coins)).catch(() => ({})),
    fetch(`https://coins.llama.fi/prices/historical/${TS30}/${coinKeys}`).then((r) => r.json()).then((j: any) => pmap(j?.coins)).catch(() => ({})),
  ]);
  const supAt = (res: any[], i: number, dec: number) => (res[i]?.status === "success" ? Number(res[i].result) / 10 ** dec : null);
  const deltas: Record<string, any> = {};
  addrs.forEach((a, i) => {
    const dec = (dRes as any[])[i]?.status === "success" ? Number((dRes as any[])[i].result) : 18;
    const supN = supAt(sNow as any[], i, dec), sup7 = supAt(s7 as any[], i, dec), sup30 = supAt(s30 as any[], i, dec);
    const prN = (pNow as any)[a], pr7 = (p7 as any)[a] ?? prN, pr30 = (p30 as any)[a] ?? prN;
    const vN = supN != null && prN != null ? supN * prN : null;
    // Fall back to current supply when archive read missing, so we still surface a price-only delta.
    const v7 = (sup7 ?? supN) != null && pr7 != null ? (sup7 ?? supN!) * pr7 : null;
    const v30 = (sup30 ?? supN) != null && pr30 != null ? (sup30 ?? supN!) * pr30 : null;
    deltas[a] = {
      val_now: vN,
      chg7d: vN != null && v7 != null && v7 > 0 ? (vN - v7) / v7 : null,
      chg30d: vN != null && v30 != null && v30 > 0 ? (vN - v30) / v30 : null,
    };
  });
  return { ok: true, fetched_at: tsNow, block: Number(blockNow), deltas };
}

// Usage / utilisation: where each RWA token's supply physically sits across DeFi.
// Reads balanceOf(registryAddress) for every (token × labeled-contract) pair in ONE multicall,
// buckets by protocol, and treats the remainder (totalSupply − labeled) as "Held elsewhere".
// No indexer — just RPC, so it runs free in the cron. Coverage grows by adding registry entries.
async function fetchUsage(env: Env): Promise<any> {
  if (!env.RPC_URL) return { ok: false, tokens: [] };
  const client = createPublicClient({ chain: mainnet, transport: http(env.RPC_URL) });
  let horizonAddrs: string[] = [];
  const symBy: Record<string, string> = {}, classBy: Record<string, string> = {};
  try {
    const dp = getAddress(env.HORIZON_DATA_PROVIDER);
    const toks = (await client.readContract({ address: dp, abi: dpAbi, functionName: "getAllReservesTokens" })) as any[];
    for (const t of toks) { const a = String(t.tokenAddress).toLowerCase(); horizonAddrs.push(a); symBy[a] = t.symbol; }
  } catch {}
  for (const [a, m] of Object.entries(MORPHO_RWA)) { symBy[a] = symBy[a] || m.label; classBy[a] = m.asset_class; }
  const addrs = Array.from(new Set([...horizonAddrs, ...Object.keys(MORPHO_RWA)]));
  if (!addrs.length) return { ok: false, tokens: [] };
  const coinKeys = addrs.map((a) => "ethereum:" + a).join(",");
  const pmap = (obj: any) => { const m: Record<string, number> = {}; for (const [k, v] of Object.entries(obj || {})) m[k.toLowerCase().replace("ethereum:", "")] = (v as any)?.price; return m; };
  // One multicall: per token → totalSupply + decimals + balanceOf(each registry address).
  const calls: any[] = [];
  for (const a of addrs) {
    const ta = getAddress(a);
    calls.push({ address: ta, abi: erc20Abi, functionName: "totalSupply" });
    calls.push({ address: ta, abi: erc20Abi, functionName: "decimals" });
    for (const r of USAGE_REGISTRY) calls.push({ address: ta, abi: erc20Abi, functionName: "balanceOf", args: [getAddress(r.address)] });
  }
  const [res, prices] = await Promise.all([
    client.multicall({ contracts: calls, allowFailure: true }).catch(() => []),
    fetch(`https://coins.llama.fi/prices/current/${coinKeys}`).then((r) => r.json()).then((j: any) => pmap(j?.coins)).catch(() => ({})),
  ]);
  const R = USAGE_REGISTRY.length, stride = 2 + R;
  const tokens: any[] = [];
  const agg: Record<string, number> = {};
  let totalUsd = 0, elsewhereUsd = 0;
  addrs.forEach((a, i) => {
    const base = i * stride;
    const ts = (res as any[])[base]?.status === "success" ? Number((res as any[])[base].result) : null;
    const dec = (res as any[])[base + 1]?.status === "success" ? Number((res as any[])[base + 1].result) : 18;
    const price = (prices as any)[a];
    if (ts == null || price == null) return;
    const totalTok = ts / 10 ** dec, total = totalTok * price;
    const byProto: Record<string, number> = {};
    let labeledTok = 0;
    USAGE_REGISTRY.forEach((r, k) => {
      const cell = (res as any[])[base + 2 + k];
      const bal = cell?.status === "success" ? Number(cell.result) / 10 ** dec : 0;
      if (bal > 0) { byProto[r.protocol] = (byProto[r.protocol] || 0) + bal * price; labeledTok += bal; }
    });
    const elsewhere = Math.max(0, (totalTok - labeledTok)) * price;
    const composition = { ...byProto, "Held elsewhere": elsewhere };
    const deployed = Object.entries(byProto).reduce((s, [, v]) => s + v, 0);
    tokens.push({
      address: a, symbol: symBy[a] || a.slice(0, 6), asset_class: classBy[a] || (KNOWN[a] ? ASSET_CLASS[KNOWN[a][0]] : null) || "Other",
      total_usd: total, composition, deployed_usd: deployed, deployed_pct: total > 0 ? deployed / total : 0,
    });
    totalUsd += total; elsewhereUsd += elsewhere;
    for (const [p, v] of Object.entries(composition)) agg[p] = (agg[p] || 0) + v;
  });
  tokens.sort((a, b) => b.total_usd - a.total_usd);
  return {
    ok: true, fetched_at: Math.floor(Date.now() / 1000), tokens,
    by_protocol: Object.entries(agg).map(([protocol, usd]) => ({ protocol, usd })).sort((a, b) => b.usd - a.usd),
    total_usd: totalUsd, deployed_usd: totalUsd - elsewhereUsd, elsewhere_usd: elsewhereUsd,
    registry_count: USAGE_REGISTRY.length,
  };
}

// DefiLlama — independent Horizon TVL for Tier-3 reconciliation. Gross supplied =
// net Ethereum TVL + borrowed (matches our horizon_supplied_usd methodology).
async function fetchDefiLlamaHorizon(): Promise<number | null> {
  try {
    const r: any = await (await fetch("https://api.llama.fi/protocol/aave-horizon-rwa")).json();
    const c = r?.currentChainTvls || {};
    const gross = (c["Ethereum"] || 0) + (c["borrowed"] || 0);
    return gross > 0 ? gross : null;
  } catch { return null; }
}

async function buildSnapshot(env: Env) {
  if (!env.RPC_URL) throw new Error("RPC_URL secret is not set on this Worker — add it under Settings > Variables and Secrets (type: Secret).");
  const client = createPublicClient({ chain: mainnet, transport: http(env.RPC_URL) });
  const DP = getAddress(env.HORIZON_DATA_PROVIDER), OR = getAddress(env.HORIZON_ORACLE);
  const now = Math.floor(Date.now() / 1000);
  const block = await client.getBlockNumber();
  const reserves = (await client.readContract({ address: DP, abi: dpAbi, functionName: "getAllReservesTokens" })) as any[];

  const addrs = reserves.map((r: any) => getAddress(r.tokenAddress));

  // ── Reads via multicall: Cloudflare's free plan caps a Worker at 50 subrequests,
  //    so we batch ~65 contract reads into 2 multicalls instead of 65 fetches. ──
  const c1: any[] = [];
  for (const a of addrs) {
    c1.push({ address: DP, abi: dpAbi, functionName: "getReserveConfigurationData", args: [a] });
    c1.push({ address: DP, abi: dpAbi, functionName: "getReserveData", args: [a] });
    c1.push({ address: OR, abi: oracleAbi, functionName: "getAssetPrice", args: [a] });
    c1.push({ address: OR, abi: oracleAbi, functionName: "getSourceOfAsset", args: [a] });
    c1.push({ address: a, abi: erc20Abi, functionName: "totalSupply" });
  }
  const r1: any[] = await client.multicall({ contracts: c1, allowFailure: true });
  const sources: (string | null)[] = addrs.map((_: any, i: number) => r1[i * 5 + 3]?.status === "success" ? (r1[i * 5 + 3].result as string) : null);

  const oc: any[] = []; const ocMap: number[] = [];
  sources.forEach((src, i) => {
    if (src && BigInt(src) !== 0n) {
      const sa = getAddress(src); ocMap.push(i);
      oc.push({ address: sa, abi: aggAbi, functionName: "decimals" });
      oc.push({ address: sa, abi: aggAbi, functionName: "latestRoundData" });
      oc.push({ address: sa, abi: aggAbi, functionName: "latestAnswer" });
    }
  });
  const r2: any[] = oc.length ? await client.multicall({ contracts: oc, allowFailure: true }) : [];
  const oracleBy: Record<number, any> = {};
  ocMap.forEach((ri, k) => {
    const dec = r2[k * 3]?.status === "success" ? Number(r2[k * 3].result) : 8;
    const lr = r2[k * 3 + 1], la = r2[k * 3 + 2];
    let nav: number | null = null, navTs: number | null = null, answer: number | null = null;
    if (lr?.status === "success") { const t = lr.result as any[]; navTs = Number(t[3]); nav = Number(t[1]) / 10 ** dec; }
    if (la?.status === "success") answer = Number(la.result) / 10 ** dec;
    oracleBy[ri] = { dec, nav, navTs, answer };
  });

  const [issAll, centri, defiHorizon] = await Promise.all([
    Promise.all(addrs.map((a: string) => fetchIssuer(a, now))),
    fetchCentrifuge(),
    fetchDefiLlamaHorizon(),
  ]);

  const out: any[] = [];
  for (let i = 0; i < reserves.length; i++) {
    const symbol = reserves[i].symbol; const addr = addrs[i];
    const [label, issuer] = KNOWN[addr.toLowerCase()] ?? [symbol, "? UNKNOWN"];
    const cfg = r1[i * 5]?.status === "success" ? (r1[i * 5].result as any[]) : [8, 0, 0];
    const dec = Number(cfg[0]); const ltv = Number(cfg[1]) / 100; const lqt = Number(cfg[2]) / 100;
    const rd = r1[i * 5 + 1]?.status === "success" ? (r1[i * 5 + 1].result as any[]) : null;
    const supplied = rd ? Number(rd[2]) / 10 ** dec : 0;
    const supplyApy = rd ? Number(rd[5]) / 1e27 * 100 : 0;
    const price = r1[i * 5 + 2]?.status === "success" ? Number(r1[i * 5 + 2].result) / 1e8 : 0;
    const totalSupply = r1[i * 5 + 4]?.status === "success" ? Number(r1[i * 5 + 4].result) / 10 ** dec : null;
    const src = sources[i];
    const ob = oracleBy[i];
    let navState: string | null = null, navUpdated: number | null = null, navFreshSrc: string | null = null, navValue: number | null = null;
    if (ob) {
      if (ob.nav != null) { navUpdated = ob.navTs; navValue = ob.nav; navFreshSrc = "onchain_roundData"; navState = (now - (ob.navTs ?? 0)) > 172800 ? "stale" : "fresh"; }
      else if (ob.answer != null) { navValue = ob.answer; navFreshSrc = "onchain_latestAnswer_no_ts"; navState = "value_only"; }
      else navState = "unreadable";
    }
    const iss = issAll[i];
    let offNav = null, offAsofTs = null, offAum = null, offSrc = null;
    if (iss) {
      offNav = iss.nav; offAsofTs = iss.asof_ts; offAum = iss.aum; offSrc = iss.source;
      // 6-day window: these funds publish NAV on business days only, so a 3-4 day-old
      // NAV over a weekend/holiday is current — a tight 3-day window caused a daily A/B flicker.
      if ((navState === "value_only" || navState === null) && (now - iss.asof_ts) <= 518400) { navState = "fresh"; navFreshSrc = iss.source; navUpdated = iss.asof_ts; }
    }
    // Centrifuge GraphQL — authoritative NAV + freshness for JTRSY/JAAA (value-only on-chain)
    const cf = centri[label];
    if (cf && (navState === "value_only" || navState === "unreadable" || navState === null) && (now - cf.computedAt) <= 604800) {
      navValue = cf.nav; navState = "fresh"; navFreshSrc = "centrifuge_graphql"; navUpdated = cf.computedAt;
    }
    const suppliedUsd = price * supplied;
    const navForAum = navValue ?? price;
    const assetAum = (iss && iss.aum) ? iss.aum : (totalSupply != null ? totalSupply * navForAum : null);
    const aumSource = (iss && iss.aum) ? iss.source : (totalSupply != null ? "onchain_derived" : null);
    const assetClass = ASSET_CLASS[label] ?? "Other";
    out.push({ symbol_onchain: symbol, label, issuer, asset_class: assetClass, address: addr, decimals: dec, ltv_pct: ltv, liq_threshold_pct: lqt,
      token_total_supply: totalSupply, asset_aum: assetAum, aum_source: aumSource,
      total_supplied: supplied, supplied_usd: suppliedUsd, supply_apy_pct: +supplyApy.toFixed(3), oracle_price_usd: price,
      oracle_source: src, nav_value: navValue, nav_state: navState, nav_freshness_source: navFreshSrc, nav_updated_at: navUpdated,
      offchain_nav: offNav, offchain_nav_asof_ts: offAsofTs, offchain_aum: offAum, offchain_source: offSrc,
      is_stable: STABLE.has(label), known: label !== "?" && !issuer.startsWith("?") });
  }

  const sum = (arr: any[], f: (r: any) => number) => arr.reduce((s, r) => s + (f(r) || 0), 0);
  const suppliedTot = sum(out, r => r.supplied_usd);
  const suppliedStable = sum(out.filter(r => r.is_stable), r => r.supplied_usd);
  // ASSET-LEVEL AUM (the market-size number; venue-supplied is a separate lens)
  const rwaAum = sum(out.filter(r => !r.is_stable), r => r.asset_aum);
  const stableAum = sum(out.filter(r => r.is_stable), r => r.asset_aum);
  const groupAum = (key: string) => {
    const g: Record<string, { aum: number; count: number }> = {};
    for (const r of out) { const k = r[key] || "Other"; (g[k] ||= { aum: 0, count: 0 }); g[k].aum += r.asset_aum || 0; g[k].count++; }
    return Object.entries(g).map(([name, v]) => ({ name, aum: v.aum, count: v.count })).sort((a, b) => b.aum - a.aum);
  };
  const major = out.filter(r => !r.is_stable && (!r.known || r.nav_state === "stale" || r.nav_state === "unreadable")).length;
  const minor = out.filter(r => !r.is_stable && r.nav_state === "value_only").length;
  const grade = major === 0 && minor === 0 ? "A" : major === 0 ? "B" : major <= 2 ? "C" : "D";
  // Tier-3 reconciliation: our on-chain Horizon TVL vs DefiLlama's independent number
  const recon = defiHorizon ? {
    source: "defillama", defillama_supplied_usd: defiHorizon,
    gap_pct: +(((suppliedTot - defiHorizon) / defiHorizon) * 100).toFixed(2),
    status: Math.abs((suppliedTot - defiHorizon) / defiHorizon) <= 0.05 ? "verified" : "degraded",
  } : null;
  return { market_id: "proto_horizon_v3", block: Number(block), fetched_at: now, reserves: out,
    totals: {
      // market size = asset-level AUM (lens: issuer-reported where available, else totalSupply x NAV)
      rwa_aum: rwaAum, stablecoin_aum: stableAum, total_aum: rwaAum + stableAum,
      by_class: groupAum("asset_class"), by_issuer: groupAum("issuer"),
      // venue lens (Horizon-supplied) kept distinct
      horizon_supplied_usd: suppliedTot, horizon_stablecoin_supplied_usd: suppliedStable,
      reconciliation: recon,
      reserve_count: out.length, rwa_count: out.filter(r => !r.is_stable).length,
      grade, major_issues: major, minor_issues: minor, nav_value_only: minor,
      nav_stale: out.filter(r => r.nav_state === "stale").length, unknown_count: out.filter(r => !r.known).length } };
}

/** Append the snapshot to Neon as ONE batched transaction (1 subrequest).
 *  Assumes the issuer/asset/token spine is seeded (history rows look up ids by
 *  contract address); a reserve with no seeded token is simply skipped. */
async function persist(env: Env, snap: any, ev?: any) {
  if (!env.DATABASE_URL) return;
  const sql = neon(env.DATABASE_URL);
  const ts = new Date(snap.fetched_at * 1000).toISOString();
  const stmts: any[] = [];
  // Self-migrating market-totals history — powers 30d deltas + holder/active trends.
  stmts.push(sql`CREATE TABLE IF NOT EXISTS market_history (
    ts timestamptz PRIMARY KEY, rwa_aum double precision, stablecoin_aum double precision,
    total_aum double precision, horizon_supplied_usd double precision,
    holders integer, active_addresses integer, actions integer, issuers integer)`);
  for (const r of snap.reserves) {
    const addr = r.address.toLowerCase();
    if (r.nav_value != null)
      stmts.push(sql`INSERT INTO asset_nav_history (asset_id, ts, nav, source, updated_at_onchain, is_stale)
        SELECT t.asset_id, ${ts}, ${r.nav_value}, ${r.nav_freshness_source ?? "onchain"},
               ${r.nav_updated_at ? new Date(r.nav_updated_at * 1000).toISOString() : null}, ${r.nav_state === "stale"}
        FROM token t WHERE t.contract_address = ${addr} ON CONFLICT DO NOTHING`);
    if (r.asset_aum != null)
      stmts.push(sql`INSERT INTO asset_aum_history (asset_id, ts, aum, source)
        SELECT t.asset_id, ${ts}, ${r.asset_aum}, ${r.aum_source ?? "onchain_derived"}
        FROM token t WHERE t.contract_address = ${addr} ON CONFLICT DO NOTHING`);
    stmts.push(sql`INSERT INTO token_supply_history (token_id, ts, total_supply)
      SELECT t.token_id, ${ts}, ${r.total_supplied}
      FROM token t WHERE t.contract_address = ${addr} ON CONFLICT DO NOTHING`);
  }
  const t = snap.totals, e = ev?.totals || {};
  stmts.push(sql`INSERT INTO market_history
      (ts, rwa_aum, stablecoin_aum, total_aum, horizon_supplied_usd, holders, active_addresses, actions, issuers)
    VALUES (${ts}, ${t.rwa_aum}, ${t.stablecoin_aum}, ${t.total_aum}, ${t.horizon_supplied_usd},
            ${e.holders ?? null}, ${e.active_addresses ?? null}, ${e.actions ?? null}, ${t.by_issuer?.length ?? null})
    ON CONFLICT (ts) DO NOTHING`);
  if (stmts.length) await sql.transaction(stmts);
}

export default {
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    const snap = await buildSnapshot(env);
    if (env.HORIZON_KV) await env.HORIZON_KV.put("latest", JSON.stringify(snap));
    if (env.DATABASE_URL) {
      const ev = await fetchEvents().catch(() => null);
      ctx.waitUntil(persist(env, snap, ev).catch(err => console.error("persist failed:", err)));
    }
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (url.pathname === "/" || url.pathname === "/api/health") {
      return new Response(JSON.stringify({
        status: "rwa-terminal-worker",
        secrets_visible: { RPC_URL: !!env.RPC_URL, DATABASE_URL: !!env.DATABASE_URL },
        kv_bound: !!env.HORIZON_KV,
        rpc_host: env.RPC_URL ? new URL(env.RPC_URL).host : "(none — falling back to public default)",
        routes: ["/api/snapshot", "/api/history", "/api/market-history", "/api/events", "/api/flows", "/api/holders-history", "/api/active-history", "/api/morpho", "/api/refresh", "/api/health"],
      }), { headers: cors });
    }
    try {
    if (url.pathname === "/api/history") {
      if (!env.DATABASE_URL) return new Response(JSON.stringify({ points: [] }), { headers: cors });
      const sql = neon(env.DATABASE_URL);
      // hourly last-value AUM per asset (joined to contract address so the UI can
      // group by class). Metric = total RWA value over time; holders/active/transfer
      // are NOT here — they need the event indexer (Phase 2).
      const rows = await sql`
        SELECT t.contract_address AS addr,
               to_char(date_trunc('day', h.ts), 'YYYY-MM-DD') AS hr,
               (array_agg(h.aum ORDER BY h.ts DESC))[1] AS aum
        FROM asset_aum_history h JOIN token t ON t.asset_id = h.asset_id
        GROUP BY t.contract_address, date_trunc('day', h.ts)
        ORDER BY hr`;
      return new Response(JSON.stringify({ points: rows }), { headers: cors });
    }
    if (url.pathname === "/api/market-history") {
      if (!env.DATABASE_URL) return new Response(JSON.stringify({ points: [] }), { headers: cors });
      const sql = neon(env.DATABASE_URL);
      try {
        const rows = await sql`
          SELECT to_char(date_trunc('day', ts), 'YYYY-MM-DD') AS d,
                 (array_agg(rwa_aum ORDER BY ts DESC))[1] AS rwa_aum,
                 (array_agg(stablecoin_aum ORDER BY ts DESC))[1] AS stablecoin_aum,
                 (array_agg(horizon_supplied_usd ORDER BY ts DESC))[1] AS horizon_supplied_usd,
                 (array_agg(holders ORDER BY ts DESC))[1] AS holders,
                 (array_agg(active_addresses ORDER BY ts DESC))[1] AS active_addresses
          FROM market_history GROUP BY date_trunc('day', ts) ORDER BY d`;
        return new Response(JSON.stringify({ points: rows }), { headers: { ...cors, "cache-control": "max-age=120" } });
      } catch { return new Response(JSON.stringify({ points: [] }), { headers: cors }); } // table not seeded yet
    }
    if (url.pathname === "/api/events") {
      const ev = await fetchEvents();
      return new Response(JSON.stringify(ev), { headers: { ...cors, "cache-control": "max-age=60" } });
    }
    if (url.pathname === "/api/flows") {
      const fl = await fetchFlows();
      return new Response(JSON.stringify(fl), { headers: { ...cors, "cache-control": "max-age=300" } });
    }
    if (url.pathname === "/api/holders-history") {
      return new Response(JSON.stringify(await fetchHoldersHistory()), { headers: { ...cors, "cache-control": "max-age=300" } });
    }
    if (url.pathname === "/api/active-history") {
      return new Response(JSON.stringify(await fetchActiveHistory()), { headers: { ...cors, "cache-control": "max-age=300" } });
    }
    if (url.pathname === "/api/morpho") {
      return new Response(JSON.stringify(await fetchMorpho(env)), { headers: { ...cors, "cache-control": "max-age=120" } });
    }
    if (url.pathname === "/api/deltas") {
      // 7D/30D Total-Value change per asset; archive reads are slow + slow-moving, so cache 1h.
      return new Response(JSON.stringify(await fetchDeltas(env)), { headers: { ...cors, "cache-control": "max-age=3600" } });
    }
    if (url.pathname === "/api/usage") {
      // Where each RWA's supply sits across DeFi (balanceOf vs labeled-address registry). Slow-moving.
      return new Response(JSON.stringify(await fetchUsage(env)), { headers: { ...cors, "cache-control": "max-age=1800" } });
    }
    if (url.pathname === "/api/snapshot") {
      const latest = env.HORIZON_KV ? await env.HORIZON_KV.get("latest") : null;
      if (latest) return new Response(latest, { headers: cors });
      const snap = await buildSnapshot(env);            // no KV cache yet -> compute live
      if (env.HORIZON_KV) await env.HORIZON_KV.put("latest", JSON.stringify(snap));
      return new Response(JSON.stringify(snap), { headers: cors });
    }
    if (url.pathname === "/api/refresh") { // manual trigger for testing
      const snap = await buildSnapshot(env);
      if (env.HORIZON_KV) await env.HORIZON_KV.put("latest", JSON.stringify(snap));
      const ev = await fetchEvents().catch(() => null);
      if (env.DATABASE_URL) await persist(env, snap, ev).catch(e => console.error(e));
      return new Response(JSON.stringify({ ok: true, block: snap.block, reserves: snap.reserves.length, events: !!ev }), { headers: cors });
    }
    return new Response(JSON.stringify({ error: "unknown route" }), { status: 404, headers: cors });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: cors });
    }
  },
};
