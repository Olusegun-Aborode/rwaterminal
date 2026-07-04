#!/usr/bin/env python3
"""Build docs/rwa-june-2026-data.json (June 1-30, 2026)."""
import json, ssl, os, urllib.request, subprocess
from datetime import datetime, timezone

CONN = os.environ.get('DATABASE_URL', '')  # export DATABASE_URL before running
ENVIO = 'https://indexer.dev.hyperindex.xyz/3609531/v1/graphql'
WORKER = 'https://rwa-terminal-worker.aborodeolusegun.workers.dev'
OUT = os.path.join(os.path.dirname(__file__), '..', 'docs', 'rwa-june-2026-data.json')
CTX = ssl._create_unverified_context()

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'

def gql(q):
    r = urllib.request.Request(ENVIO, json.dumps({'query': q}).encode(), {'content-type': 'application/json', 'User-Agent': UA})
    return json.load(urllib.request.urlopen(r, timeout=120, context=CTX))['data']

def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=120, context=CTX))

def psql_json(q):
    out = subprocess.run(['psql', CONN, '-X', '-tA', '-c', q], capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        raise RuntimeError(out.stderr[:400])
    s = out.stdout.strip()
    return json.loads(s) if s else None

def dstr(ts): return datetime.fromtimestamp(ts, timezone.utc).strftime('%Y-%m-%d')
def c2(x): return round(float(x), 2) if x is not None else None

S = int(datetime(2026, 6, 1, tzinfo=timezone.utc).timestamp())
E = int(datetime(2026, 7, 1, tzinfo=timezone.utc).timestamp())

# ---- reserve metadata from current snapshot ----
snap = get(WORKER + '/api/snapshot')
meta = {}
for r in snap['reserves']:
    a = r['address'].lower()
    meta[a] = {
        'symbol': r.get('label') if r.get('label') and r.get('label') != '?' else r.get('symbol_onchain'),
        'decimals': r.get('decimals'), 'price': r.get('oracle_price_usd') or 0,
        'asset_class': r.get('asset_class'), 'is_stable': r.get('is_stable'), 'issuer': r.get('issuer'),
        'ltv_pct': r.get('ltv_pct'), 'lt_pct': r.get('liq_threshold_pct'),
        'supplied_usd': r.get('supplied_usd'), 'supply_apy_pct': r.get('supply_apy_pct'), 'nav': r.get('nav_value'),
    }
def sym(a): return meta.get(a.lower(), {}).get('symbol', a[:10])
def cls(a): return meta.get(a.lower(), {}).get('asset_class', 'Other')
def to_usd(a, amt):
    m = meta.get(a.lower())
    if not m or m.get('decimals') is None: return 0.0
    return int(amt) / 10 ** m['decimals'] * (m['price'] or 0)

# aToken -> underlying symbol (from the indexer config; mGLOBAL not indexed yet)
ATOKEN = {
    '0x946281a2d0dd6e650d08f74833323d66ae4c8b12': 'GHO', '0x68215b6533c47ff9f7125ac95adf00fe4a62f79e': 'USDC',
    '0xe3190143eb552456f88464662f0c0c4ac67a77eb': 'RLUSD', '0x4e58a2e433a739726134c83d2f07b2562e8dfdb3': 'USTB',
    '0x08b798c40b9ab931356d9ab4235f548325c4cb80': 'USCC', '0xc167932ac4eec2b65844ef00d31b4550250536a5': 'USYC',
    '0x844f07ab09aa5dbdce6a9b1206ce150e1eadaccb': 'JTRSY', '0xb0ec6c4482ac1ef77be239c0ac833cf37a27c876': 'JAAA',
    '0xe1cfd16b8e4b1c86bb5b7a104cfefbc7b09326dd': 'VBILL', '0xc293744ffbcf46696d589f5c415e71bc491519cd': 'ACRED',
}

# ---- fetch all June ReserveActions (paginate) ----
actions = []; skip = 0
while True:
    q = f'{{ ReserveAction(limit:1000, offset:{skip}, where:{{timestamp:{{_gte:{S},_lt:{E}}}}}, order_by:{{timestamp:asc}}) {{ kind reserve user amount timestamp txHash }} }}'
    batch = gql(q)['ReserveAction']
    actions += batch
    if len(batch) < 1000: break
    skip += 1000
print(f"June actions fetched: {len(actions)}")

# ---- SECTION 1: daily flows per reserve + net + sector ----
KINDS = ['supply', 'withdraw', 'borrow', 'repay']
LABEL = {'supply': 'deposit', 'withdraw': 'withdraw', 'borrow': 'borrow', 'repay': 'repay'}
daily = {}   # (date, reserve) -> {kind:{count,usd}}
res_net = {}  # reserve -> {deposit_usd, withdraw_usd, borrow_usd, repay_usd}
for a in actions:
    day = dstr(a['timestamp']); res = a['reserve'].lower(); k = a['kind']; u = to_usd(res, a['amount'])
    d = daily.setdefault((day, res), {kk: {'count': 0, 'usd': 0.0} for kk in KINDS})
    d[k]['count'] += 1; d[k]['usd'] += u
    rn = res_net.setdefault(res, {kk: 0.0 for kk in KINDS}); rn[k] += u

sec1_daily = []
for (day, res), d in sorted(daily.items()):
    sec1_daily.append({'date': day, 'reserve': sym(res), 'asset_class': cls(res), 'reserve_address': res,
                       **{LABEL[k]: {'count': d[k]['count'], 'usd': c2(d[k]['usd'])} for k in KINDS}})
sec1_reserve_net = []
for res, rn in sorted(res_net.items(), key=lambda x: -(x[1]['supply'] - x[1]['withdraw'])):
    net = rn['supply'] - rn['withdraw']
    sec1_reserve_net.append({'reserve': sym(res), 'asset_class': cls(res),
                             'deposit_usd': c2(rn['supply']), 'withdraw_usd': c2(rn['withdraw']),
                             'borrow_usd': c2(rn['borrow']), 'repay_usd': c2(rn['repay']),
                             'net_flow_usd': c2(net)})
sector = {}
for res, rn in res_net.items():
    sc = cls(res); s = sector.setdefault(sc, 0.0); sector[sc] = s + (rn['supply'] - rn['withdraw'])
sec1_sector = [{'sector': k, 'net_flow_usd': c2(v)} for k, v in sorted(sector.items(), key=lambda x: -x[1])]

# ---- SECTION 2: top 10 single flow events by USD ----
ev = sorted(actions, key=lambda a: to_usd(a['reserve'], a['amount']), reverse=True)[:10]
sec2 = [{'date': dstr(a['timestamp']), 'reserve': sym(a['reserve']), 'direction': LABEL[a['kind']],
         'usd': c2(to_usd(a['reserve'], a['amount'])), 'tx_hash': a['txHash']} for a in ev]

# ---- SECTION 6: June daily active addresses (distinct users acting that day) ----
day_users = {}
for a in actions:
    day_users.setdefault(dstr(a['timestamp']), set()).add(a['user'].lower())
sec6 = [{'date': d, 'active_addresses': len(u)} for d, u in sorted(day_users.items())]

# ---- SECTION 3: daily market history (June) ----
sec3 = psql_json("""
SELECT COALESCE(json_agg(r ORDER BY r.date), '[]') FROM (
  SELECT to_char(date_trunc('day',ts),'YYYY-MM-DD') AS date,
    round(((array_agg(rwa_aum ORDER BY ts DESC))[1])::numeric,2) AS rwa_aum,
    round(((array_agg(stablecoin_aum ORDER BY ts DESC))[1])::numeric,2) AS stablecoin_aum,
    round(((array_agg(horizon_supplied_usd ORDER BY ts DESC))[1])::numeric,2) AS horizon_supplied_usd,
    (array_agg(holders ORDER BY ts DESC))[1] AS holders,
    (array_agg(active_addresses ORDER BY ts DESC))[1] AS active_addresses
  FROM market_history WHERE ts>='2026-06-01' AND ts<'2026-07-01'
  GROUP BY date_trunc('day',ts)) r;""")

# ---- SECTION 4: per-reserve state at June 7 and June 30 ----
hist = psql_json("""
SELECT COALESCE(json_agg(row_to_json(x)), '[]') FROM (
  SELECT lower(t.contract_address) AS addr, t.symbol,
    (SELECT round(nav::numeric,4) FROM asset_nav_history WHERE asset_id=t.asset_id AND ts<'2026-06-08' ORDER BY ts DESC LIMIT 1) AS nav_jun07,
    (SELECT round(nav::numeric,4) FROM asset_nav_history WHERE asset_id=t.asset_id AND ts<'2026-07-01' ORDER BY ts DESC LIMIT 1) AS nav_jun30,
    (SELECT round(aum::numeric,2) FROM asset_aum_history WHERE asset_id=t.asset_id AND ts<'2026-06-08' ORDER BY ts DESC LIMIT 1) AS aum_jun07,
    (SELECT round(aum::numeric,2) FROM asset_aum_history WHERE asset_id=t.asset_id AND ts<'2026-07-01' ORDER BY ts DESC LIMIT 1) AS aum_jun30,
    (SELECT round(total_supply::numeric,2) FROM token_supply_history WHERE token_id=t.token_id AND ts<'2026-06-08' ORDER BY ts DESC LIMIT 1) AS supply_jun07,
    (SELECT round(total_supply::numeric,2) FROM token_supply_history WHERE token_id=t.token_id AND ts<'2026-07-01' ORDER BY ts DESC LIMIT 1) AS supply_jun30
  FROM token t) x;""")
histm = {h['addr']: h for h in (hist or [])}
sec4 = []
for a, m in meta.items():
    h = histm.get(a, {})
    sec4.append({
        'reserve': m['symbol'], 'asset_class': m['asset_class'], 'issuer': m['issuer'], 'address': a,
        'jun07': {'nav': h.get('nav_jun07'), 'aum_usd': h.get('aum_jun07'), 'token_supply': h.get('supply_jun07')},
        'jun30': {'nav': h.get('nav_jun30'), 'aum_usd': h.get('aum_jun30'), 'token_supply': h.get('supply_jun30')},
        'current': {'supplied_usd': c2(m['supplied_usd']), 'supply_apy_pct': m['supply_apy_pct'],
                    'ltv_pct': m['ltv_pct'], 'liq_threshold_pct': m['lt_pct'], 'nav': m['nav']},
    })

# ---- SECTION 5: holders per token, June 1 vs June 30 (Envio HolderPoint) ----
def holders_at(ts):
    q = f'{{ HolderPoint(distinct_on: token, where:{{timestamp:{{_lte:{ts}}}}}, order_by:[{{token:asc}},{{timestamp:desc}}]) {{ token holderCount }} }}'
    return {h['token'].lower(): h['holderCount'] for h in gql(q)['HolderPoint']}
h_start = holders_at(S)          # <= June 1 00:00 (i.e. end of May / June-open)
h_end = holders_at(E - 1)        # <= June 30 23:59
sec5 = []
for atok, symn in ATOKEN.items():
    sec5.append({'token': symn, 'holders_jun01': h_start.get(atok), 'holders_jun30': h_end.get(atok),
                 'change': (h_end.get(atok, 0) - h_start.get(atok, 0)) if (atok in h_start and atok in h_end) else None})

# ==== SUPPLEMENTARY METRICS (the "available now" set) ====
# S7 - per-user flows
uf = {}; ur = {}
for a in actions:
    u = a['user'].lower(); res = a['reserve'].lower(); v = abs(to_usd(res, a['amount']))
    uf[u] = uf.get(u, 0) + v; ur.setdefault(res, set()).add(u)
tot_uf = sum(uf.values()) or 1
top_users = sorted(uf.items(), key=lambda x: -x[1])[:10]
supp_users = {'total_unique_users': len(uf),
              'top5_concentration_pct': round(sum(x[1] for x in top_users[:5]) / tot_uf * 100, 2),
              'top10_users': [{'address': ad, 'total_flow_usd': c2(v)} for ad, v in top_users],
              'unique_users_per_reserve': {sym(r): len(u) for r, u in sorted(ur.items(), key=lambda x: -len(x[1]))}}

# S8 - borrow demand & utilisation (net borrow = borrow - repay per reserve, from June flows)
supp_borrow = [{'reserve': sym(r), 'asset_class': cls(r), 'borrowed_usd': c2(rn['borrow']), 'repaid_usd': c2(rn['repay']),
                'net_borrow_usd': c2(rn['borrow'] - rn['repay'])}
               for r, rn in sorted(res_net.items(), key=lambda x: -(x[1]['borrow'] - x[1]['repay'])) if rn['borrow'] or rn['repay']]

# S9 - NAV yield & data-quality (NAV drift Jun07->Jun30 + stale-NAV incident count).
# NAV/supply history began 2026-06-04; using Jun07 start for consistency with section 4.
navq = psql_json("""SELECT COALESCE(json_agg(row_to_json(x)),'[]') FROM (
  SELECT t.symbol,
    (SELECT nav FROM asset_nav_history WHERE asset_id=t.asset_id AND ts<'2026-06-08' ORDER BY ts DESC LIMIT 1) AS nav_start,
    (SELECT nav FROM asset_nav_history WHERE asset_id=t.asset_id AND ts<'2026-07-01' ORDER BY ts DESC LIMIT 1) AS nav_end,
    (SELECT count(*) FROM asset_nav_history WHERE asset_id=t.asset_id AND ts>='2026-06-01' AND ts<'2026-07-01' AND is_stale) AS stale_snapshots
  FROM token t) x;""")
supp_nav = []
for r in (navq or []):
    ns, ne = r.get('nav_start'), r.get('nav_end'); ay = round(((ne / ns) - 1) * (365 / 23) * 100, 2) if (ns and ne and ns > 0) else None
    supp_nav.append({'token': r['symbol'], 'nav_jun07': round(ns, 4) if ns else None, 'nav_jun30': round(ne, 4) if ne else None,
                     'annualized_yield_pct': ay, 'stale_snapshots_june': r.get('stale_snapshots')})

# S11 - issuance vs redemption (token supply change Jun07->Jun30)
iss = psql_json("""SELECT COALESCE(json_agg(row_to_json(x)),'[]') FROM (
  SELECT t.symbol, lower(t.contract_address) AS addr,
    (SELECT total_supply FROM token_supply_history WHERE token_id=t.token_id AND ts<'2026-06-08' ORDER BY ts DESC LIMIT 1) AS s_start,
    (SELECT total_supply FROM token_supply_history WHERE token_id=t.token_id AND ts<'2026-07-01' ORDER BY ts DESC LIMIT 1) AS s_end
  FROM token t) x;""")
supp_iss = []
for r in (iss or []):
    ss, se = r.get('s_start'), r.get('s_end'); m = meta.get(r['addr'], {}); pr = m.get('price') or 0
    chg = (se - ss) if (ss is not None and se is not None) else None
    supp_iss.append({'token': r['symbol'], 'supply_jun07': round(ss, 2) if ss is not None else None, 'supply_jun30': round(se, 2) if se is not None else None,
                     'net_change_tokens': round(chg, 2) if chg is not None else None, 'net_change_usd': c2(chg * pr) if chg is not None else None,
                     'direction': ('issuance' if chg > 0 else 'redemption' if chg < 0 else 'flat') if chg is not None else None})

# S10 - holder concentration (current, Envio Holding balances per aToken; no _aggregate, so sum in Python)
supp_conc = []
for atok, symn in ATOKEN.items():
    try:
        hs = gql(f'{{ Holding(where:{{token:{{_eq:"{atok}"}}, balance:{{_gt:"0"}}}}, order_by:{{balance:desc}}, limit:1000) {{ balance }} }}')['Holding']
        bals = [float(h['balance']) for h in hs]; tsum = sum(bals)
        if bals and tsum > 0:
            supp_conc.append({'token': symn, 'holders': len(bals), 'top1_share_pct': round(bals[0] / tsum * 100, 2),
                              'top5_share_pct': round(sum(bals[:5]) / tsum * 100, 2)})
    except Exception:
        pass

# S12 - cross-venue deployment (current state)
usage = get(WORKER + '/api/usage'); mor = get(WORKER + '/api/morpho'); mh = (mor.get('health') or {})
supp_cross = {'as_of': 'current (report generation)',
              'by_kind_usd': {k: c2(v) for k, v in (usage.get('by_kind') or {}).items()},
              'deployed_pct_of_tracked': round((usage.get('deployed_usd') or 0) / (usage.get('total_usd') or 1) * 100, 2),
              'morpho': {'total_collateral_usd': c2(mor.get('total_collateral')), 'total_borrow_usd': c2(mor.get('total_borrow')),
                         'avg_lltv_pct': round((mor.get('avg_lltv') or 0) * 100, 1), 'borrowers': mh.get('borrowers'),
                         'min_health_factor': round(mh.get('min_hf'), 3) if mh.get('min_hf') is not None else None, 'at_risk_positions': mh.get('at_risk')}}

# ---- assemble ----
doc = {
    'meta': {
        'report': 'RWA Terminal - Aave Horizon - June 2026', 'period': {'start': '2026-06-01', 'end': '2026-06-30'},
        'generated_utc': dstr(int(datetime.now(timezone.utc).timestamp())),
        'sources': {'flows_and_holders': 'Envio HyperIndex (Horizon pool events)',
                    'market_and_asset_history': 'Neon Postgres (5-min cron snapshots)',
                    'reserve_metadata': 'on-chain snapshot'},
        'notes': [
            'USD amounts rounded to cents. Dates YYYY-MM-DD (UTC).',
            'Flow USD priced at current oracle/NAV per reserve (NAV-stable assets; treat as approximate for the month).',
            'The 2026-06-29 rwa_aum spike (issuer-API AUM misread on USTB/USCC) has been corrected in both market and asset history.',
            'Section 4 supplied_usd / supply_apy / LTV are current-snapshot values (per-reserve Horizon-supplied/APY/LTV are not stored historically); NAV/AUM/supply are as-of June 7 and June 30.',
            'mGLOBAL (Midas Fasanara Global) was listed on Horizon in June and is not yet in the event indexer, so it has no per-token holder history (section 5); its pool flows ARE captured (sections 1,2).',
            'Section 3 (daily market history) begins 2026-06-07: the market_history table was created mid-period, so June 1-6 have no aggregate snapshot. Flows (1,2,6) and holders (5) cover the full month from the event indexer.',
            "Two different active-address metrics: section 3 active_addresses is cumulative distinct users since genesis (the terminal's headline); section 6 active_addresses is distinct users who acted on that specific day.",
        ],
    },
    'section1_daily_flows_per_reserve': {'daily': sec1_daily, 'reserve_net_june': sec1_reserve_net, 'sector_net_june': sec1_sector},
    'section2_top10_flow_events': sec2,
    'section3_daily_market_history': sec3,
    'section4_reserve_state_jun07_jun30': sec4,
    'section5_holders_start_vs_end': sec5,
    'section6_daily_active_addresses': sec6,
    'supplementary_metrics': {
        'note': 'Beyond the 6-section spec, computed from the same existing data. Flow-derived (s7,s8) cover June; NAV/supply (s9,s11) are June-bounded; holder concentration (s10) and cross-venue (s12) are current-state, labeled as such.',
        's7_per_user_flows': supp_users,
        's8_borrow_demand': supp_borrow,
        's9_nav_yield_and_data_quality': supp_nav,
        's10_holder_concentration_current': supp_conc,
        's11_issuance_vs_redemption': supp_iss,
        's12_cross_venue_current': supp_cross,
    },
    'next_report_metrics': {
        'note': 'These series began recording 2026-07-04 (forward-only, no backfill), so the JULY report will include them as true time-series; they could not be produced for June.',
        'items': [
            {'metric': 'Per-reserve month-over-month deltas (supplied USD, supply APY, LTV, LT)', 'source': 'reserve_state_history / api/reserve-history'},
            {'metric': 'Morpho market trends (per-market LLTV, utilisation, borrow APY, collateral, borrowed)', 'source': 'morpho_market_history / api/morpho-history'},
            {'metric': 'Liquidation-risk history (borrower health-factor distribution + min HF over time)', 'source': 'morpho_risk_history / api/morpho-risk-history'},
        ],
    },
}
import os
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as f:
    json.dump(doc, f, indent=2)
print("WROTE", OUT)
print("sizes: s1_daily=%d s1_net=%d s2=%d s3=%d s4=%d s5=%d s6=%d" % (
    len(sec1_daily), len(sec1_reserve_net), len(sec2), len(sec3 or []), len(sec4), len(sec5), len(sec6)))
print("sample sector net:", sec1_sector)
print("sample top event:", sec2[0] if sec2 else None)
print("sample s3[-1]:", (sec3 or [])[-1] if sec3 else None)
print("sample s5:", [s for s in sec5 if s['holders_jun30']][:3])
