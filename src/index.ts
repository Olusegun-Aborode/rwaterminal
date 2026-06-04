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
const erc20Abi = [{ name: "totalSupply", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
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

  const issAll = await Promise.all(addrs.map((a: string) => fetchIssuer(a, now)));

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
      if ((navState === "value_only" || navState === null) && (now - iss.asof_ts) <= 259200) { navState = "fresh"; navFreshSrc = iss.source; navUpdated = iss.asof_ts; }
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
  return { market_id: "proto_horizon_v3", block: Number(block), fetched_at: now, reserves: out,
    totals: {
      // market size = asset-level AUM (lens: issuer-reported where available, else totalSupply x NAV)
      rwa_aum: rwaAum, stablecoin_aum: stableAum, total_aum: rwaAum + stableAum,
      by_class: groupAum("asset_class"), by_issuer: groupAum("issuer"),
      // venue lens (Horizon-supplied) kept distinct
      horizon_supplied_usd: suppliedTot, horizon_stablecoin_supplied_usd: suppliedStable,
      reserve_count: out.length, rwa_count: out.filter(r => !r.is_stable).length,
      grade, major_issues: major, minor_issues: minor, nav_value_only: minor,
      nav_stale: out.filter(r => r.nav_state === "stale").length, unknown_count: out.filter(r => !r.known).length } };
}

/** Append the snapshot to Neon as ONE batched transaction (1 subrequest).
 *  Assumes the issuer/asset/token spine is seeded (history rows look up ids by
 *  contract address); a reserve with no seeded token is simply skipped. */
async function persist(env: Env, snap: any) {
  if (!env.DATABASE_URL) return;
  const sql = neon(env.DATABASE_URL);
  const ts = new Date(snap.fetched_at * 1000).toISOString();
  const stmts: any[] = [];
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
  if (stmts.length) await sql.transaction(stmts);
}

export default {
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    const snap = await buildSnapshot(env);
    if (env.HORIZON_KV) await env.HORIZON_KV.put("latest", JSON.stringify(snap));
    if (env.DATABASE_URL) ctx.waitUntil(persist(env, snap).catch(err => console.error("persist failed:", err)));
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
        routes: ["/api/snapshot", "/api/refresh", "/api/health"],
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
               to_char(date_trunc('hour', h.ts), 'YYYY-MM-DD"T"HH24:00:00') AS hr,
               (array_agg(h.aum ORDER BY h.ts DESC))[1] AS aum
        FROM asset_aum_history h JOIN token t ON t.asset_id = h.asset_id
        WHERE h.ts > now() - interval '14 days'
        GROUP BY t.contract_address, date_trunc('hour', h.ts)
        ORDER BY hr`;
      return new Response(JSON.stringify({ points: rows }), { headers: cors });
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
      if (env.DATABASE_URL) await persist(env, snap).catch(e => console.error(e));
      return new Response(JSON.stringify({ ok: true, block: snap.block, reserves: snap.reserves.length }), { headers: cors });
    }
    return new Response(JSON.stringify({ error: "unknown route" }), { status: 404, headers: cors });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: cors });
    }
  },
};
