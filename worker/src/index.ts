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
  HORIZON_KV: KVNamespace;
  RPC_URL: string;          // secret
  DATABASE_URL: string;     // secret
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
      return { source: "hashnote_api", nav: Number(rec.price), asof_ts: Number(rec.timestamp), aum: null };
    }
  } catch { return null; }
}

async function buildSnapshot(env: Env) {
  const client = createPublicClient({ chain: mainnet, transport: http(env.RPC_URL) });
  const DP = getAddress(env.HORIZON_DATA_PROVIDER), OR = getAddress(env.HORIZON_ORACLE);
  const now = Math.floor(Date.now() / 1000);
  const block = await client.getBlockNumber();
  const reserves = (await client.readContract({ address: DP, abi: dpAbi, functionName: "getAllReservesTokens" })) as any[];

  const out: any[] = [];
  for (const { symbol, tokenAddress } of reserves) {
    const addr = getAddress(tokenAddress);
    const [label, issuer] = KNOWN[addr.toLowerCase()] ?? [symbol, "? UNKNOWN"];
    const cfg = (await client.readContract({ address: DP, abi: dpAbi, functionName: "getReserveConfigurationData", args: [addr] })) as any[];
    const dec = Number(cfg[0]); const ltv = Number(cfg[1]) / 100; const lqt = Number(cfg[2]) / 100;
    const rd = (await client.readContract({ address: DP, abi: dpAbi, functionName: "getReserveData", args: [addr] })) as any[];
    const supplied = Number(rd[2]) / 10 ** dec;
    const supplyApy = Number(rd[5]) / 1e27 * 100;
    let price = 0; try { price = Number(await client.readContract({ address: OR, abi: oracleAbi, functionName: "getAssetPrice", args: [addr] })) / 1e8; } catch {}
    const src = (await client.readContract({ address: OR, abi: oracleAbi, functionName: "getSourceOfAsset", args: [addr] })) as string;

    let navState: string | null = null, navUpdated: number | null = null, navFreshSrc: string | null = null, navValue: number | null = null;
    if (src && BigInt(src) !== 0n) {
      const agg = getAddress(src);
      let aggDec = 8; try { aggDec = Number(await client.readContract({ address: agg, abi: aggAbi, functionName: "decimals" })); } catch {}
      try {
        const lr = (await client.readContract({ address: agg, abi: aggAbi, functionName: "latestRoundData" })) as any[];
        navUpdated = Number(lr[3]); navValue = Number(lr[1]) / 10 ** aggDec;
        navFreshSrc = "onchain_roundData"; navState = (now - navUpdated) > 172800 ? "stale" : "fresh";
      } catch {
        try { navValue = Number(await client.readContract({ address: agg, abi: aggAbi, functionName: "latestAnswer" })) / 10 ** aggDec; navFreshSrc = "onchain_latestAnswer_no_ts"; navState = "value_only"; }
        catch { navState = "unreadable"; }
      }
    }
    // off-chain issuer freshness for value-only feeds
    const iss = await fetchIssuer(addr, now);
    let offNav = null, offAsofTs = null, offAum = null, offSrc = null;
    if (iss) {
      offNav = iss.nav; offAsofTs = iss.asof_ts; offAum = iss.aum; offSrc = iss.source;
      if ((navState === "value_only" || navState === null) && (now - iss.asof_ts) <= 259200) { navState = "fresh"; navFreshSrc = iss.source; navUpdated = iss.asof_ts; }
    }
    const suppliedUsd = price * supplied;
    out.push({ symbol_onchain: symbol, label, issuer, address: addr, decimals: dec, ltv_pct: ltv, liq_threshold_pct: lqt,
      total_supplied: supplied, supplied_usd: suppliedUsd, supply_apy_pct: +supplyApy.toFixed(3), oracle_price_usd: price,
      oracle_source: src, nav_value: navValue, nav_state: navState, nav_freshness_source: navFreshSrc, nav_updated_at: navUpdated,
      offchain_nav: offNav, offchain_nav_asof_ts: offAsofTs, offchain_aum: offAum, offchain_source: offSrc,
      is_stable: STABLE.has(label), known: label !== "?" && !issuer.startsWith("?") });
  }
  const tot = out.reduce((s, r) => s + r.supplied_usd, 0);
  const stab = out.filter(r => r.is_stable).reduce((s, r) => s + r.supplied_usd, 0);
  const major = out.filter(r => !r.is_stable && (!r.known || r.nav_state === "stale" || r.nav_state === "unreadable")).length;
  const minor = out.filter(r => !r.is_stable && r.nav_state === "value_only").length;
  const grade = major === 0 && minor === 0 ? "A" : major === 0 ? "B" : major <= 2 ? "C" : "D";
  return { market_id: "proto_horizon_v3", block: Number(block), fetched_at: now, reserves: out,
    totals: { total_supplied_usd: tot, stablecoin_usd: stab, rwa_usd: tot - stab, reserve_count: out.length,
      rwa_count: out.filter(r => !r.is_stable).length, grade, major_issues: major, minor_issues: minor,
      nav_value_only: minor, nav_stale: out.filter(r => r.nav_state === "stale").length, unknown_count: out.filter(r => !r.known).length } };
}

/** Append the snapshot to Neon history (upserts the spine by contract address). */
async function persist(env: Env, snap: any) {
  const sql = neon(env.DATABASE_URL);
  await sql`INSERT INTO chain (chain_id, name) VALUES (1,'Ethereum') ON CONFLICT (chain_id) DO NOTHING`;
  const ts = new Date(snap.fetched_at * 1000).toISOString();
  for (const r of snap.reserves) {
    const issuerRow = await sql`INSERT INTO issuer (name) VALUES (${r.issuer}) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING issuer_id`;
    const issuerId = issuerRow[0].issuer_id;
    const assetRow = await sql`INSERT INTO asset (name, display_ticker, issuer_id) VALUES (${r.label}, ${r.label}, ${issuerId})
      ON CONFLICT DO NOTHING RETURNING asset_id`;
    let assetId = assetRow[0]?.asset_id;
    if (!assetId) assetId = (await sql`SELECT asset_id FROM asset WHERE name=${r.label} LIMIT 1`)[0]?.asset_id;
    const addr = r.address.toLowerCase();
    const tokRow = await sql`INSERT INTO token (asset_id, chain_id, contract_address, decimals, symbol)
      VALUES (${assetId}, 1, ${addr}, ${r.decimals}, ${r.symbol_onchain})
      ON CONFLICT (chain_id, contract_address) DO UPDATE SET decimals=EXCLUDED.decimals RETURNING token_id`;
    const tokenId = tokRow[0].token_id;
    if (r.nav_value != null)
      await sql`INSERT INTO asset_nav_history (asset_id, ts, nav, source, updated_at_onchain, is_stale)
        VALUES (${assetId}, ${ts}, ${r.nav_value}, ${r.nav_freshness_source ?? "onchain"},
        ${r.nav_updated_at ? new Date(r.nav_updated_at * 1000).toISOString() : null}, ${r.nav_state === "stale"})
        ON CONFLICT DO NOTHING`;
    if (r.supplied_usd != null)
      await sql`INSERT INTO asset_aum_history (asset_id, ts, aum, source) VALUES (${assetId}, ${ts}, ${r.supplied_usd}, 'onchain_derived') ON CONFLICT DO NOTHING`;
    await sql`INSERT INTO token_supply_history (token_id, ts, total_supply) VALUES (${tokenId}, ${ts}, ${r.total_supplied}) ON CONFLICT DO NOTHING`;
  }
}

export default {
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    const snap = await buildSnapshot(env);
    await env.HORIZON_KV.put("latest", JSON.stringify(snap));
    ctx.waitUntil(persist(env, snap).catch(err => console.error("persist failed:", err)));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (url.pathname === "/api/snapshot") {
      const latest = await env.HORIZON_KV.get("latest");
      return new Response(latest ?? JSON.stringify({ error: "no snapshot yet — wait for first cron run" }), { headers: cors });
    }
    if (url.pathname === "/api/refresh") { // manual trigger for testing
      const snap = await buildSnapshot(env);
      await env.HORIZON_KV.put("latest", JSON.stringify(snap));
      return new Response(JSON.stringify({ ok: true, block: snap.block }), { headers: cors });
    }
    return new Response(JSON.stringify({ status: "rwa-terminal-worker", routes: ["/api/snapshot", "/api/refresh"] }), { headers: cors });
  },
};
