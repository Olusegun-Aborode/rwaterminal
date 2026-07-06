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

def gql(q, _tries=4):
    import time
    for i in range(_tries):
        try:
            r = urllib.request.Request(ENVIO, json.dumps({'query': q}).encode(), {'content-type': 'application/json', 'User-Agent': UA})
            return json.load(urllib.request.urlopen(r, timeout=120, context=CTX))['data']
        except Exception:
            if i == _tries - 1: raise
            time.sleep(1.5)

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

# ==== SECTION 13: Morpho RWA-collateral market history for June (backfilled from Morpho API historicalState) ====
def morpho_gql(q):  # via curl (Morpho's CDN 403s python-urllib)
    out = subprocess.run(['curl', '-s', '--max-time', '90', '-X', 'POST', 'https://blue-api.morpho.org/graphql',
                          '-H', 'content-type: application/json', '-d', json.dumps({'query': q})], capture_output=True, text=True, timeout=100)
    return json.loads(out.stdout)
_opt = f'options:{{startTimestamp:{S},endTimestamp:{E},interval:DAY}}'
def _ser(pts): return {dstr(p['x']): p['y'] for p in (pts or []) if p.get('y') is not None}
# Query per market by uniqueKey (a multi-market query exceeds Morpho's complexity cap).
cmk = get(WORKER + '/api/morpho').get('collateral_markets', [])
morpho_per_market = []; magg = {}
for m0 in cmk:
    mid = m0.get('market_id')
    if not mid: continue
    q = (f'{{ markets(first:1, where:{{chainId_in:[1], uniqueKey_in:["{mid}"]}}) {{ items {{ lltv collateralAsset{{symbol}} loanAsset{{symbol}} '
         f'historicalState {{ collateralAssetsUsd({_opt}){{x y}} borrowAssetsUsd({_opt}){{x y}} utilization({_opt}){{x y}} borrowApy({_opt}){{x y}} }} }} }} }}')
    try:
        its = morpho_gql(q)['data']['markets']['items']
    except Exception:
        continue
    if not its: continue
    m = its[0]; hs = m.get('historicalState') or {}
    cs, bs, us, aps = _ser(hs.get('collateralAssetsUsd')), _ser(hs.get('borrowAssetsUsd')), _ser(hs.get('utilization')), _ser(hs.get('borrowApy'))
    jd = sorted(d for d in cs if d.startswith('2026-06'))
    if not jd: continue
    d0, d1 = jd[0], jd[-1]
    morpho_per_market.append({'market': f"{m['collateralAsset']['symbol']}/{m['loanAsset']['symbol']}",
                              'lltv_pct': round(int(m['lltv']) / 1e18 * 100, 1),
                              'collateral_jun_start_usd': c2(cs.get(d0)), 'collateral_jun_end_usd': c2(cs.get(d1)),
                              'borrow_jun_start_usd': c2(bs.get(d0)), 'borrow_jun_end_usd': c2(bs.get(d1)),
                              'avg_utilization': round(sum(us.get(d, 0) for d in jd) / len(jd), 3),
                              'borrow_apy_jun_end_pct': round((aps.get(d1) or 0) * 100, 2)})
    for d in jd:
        a = magg.setdefault(d, {'c': 0.0, 'b': 0.0}); a['c'] += cs.get(d, 0) or 0; a['b'] += bs.get(d, 0) or 0
morpho_daily = [{'date': d, 'total_collateral_usd': c2(v['c']), 'total_borrow_usd': c2(v['b'])} for d, v in sorted(magg.items())]

# ==== SECTION 0: cross-venue reconciliation on ONE consistent lens (RWA deployed as collateral) ====
# This is what makes a "State of RWA composability" claim accurate. NOT fund AUM.
mor_full = get(WORKER + '/api/morpho')
WRAP = {'wjaaa': 'JAAA'}  # Morpho wrapped symbol -> Horizon underlying (the cross-venue asset)
def base_sym(s): return WRAP.get((s or '').lower(), s)
hz_by = {m['symbol']: (m.get('supplied_usd') or 0) for a, m in meta.items() if not m.get('is_stable') and (m.get('supplied_usd') or 0) > 0}
mo_by = {}
for a in mor_full.get('assets', []):
    c = a.get('collateral_usd') or 0
    if c > 1e4:
        k = base_sym(a['label']); mo_by[k] = mo_by.get(k, 0) + c
recon_assets = []
for s in sorted(set(hz_by) | set(mo_by), key=lambda s: -(hz_by.get(s, 0) + mo_by.get(s, 0))):
    h, mo = hz_by.get(s, 0), mo_by.get(s, 0); venues = [v for v, x in [('Aave Horizon', h), ('Morpho', mo)] if x > 0]
    recon_assets.append({'asset': s, 'horizon_collateral_usd': c2(h), 'morpho_collateral_usd': c2(mo),
                         'total_deployed_usd': c2(h + mo), 'venues': venues, 'cross_venue': len(venues) > 1})
hz_tot, mo_tot = sum(hz_by.values()), sum(mo_by.values())
recon_sector = {}
for s, h in hz_by.items(): recon_sector[cls([a for a, m in meta.items() if m['symbol'] == s][0])] = recon_sector.get(cls([a for a, m in meta.items() if m['symbol'] == s][0]), 0) + h
for a in mor_full.get('assets', []):
    c = a.get('collateral_usd') or 0
    if c > 1e4: recon_sector[a['asset_class']] = recon_sector.get(a['asset_class'], 0) + c
section0 = {
    'lens': 'RWA deployed as COLLATERAL in a lending venue (supplied on Horizon / collateral on Morpho). This is the composability metric.',
    'rwa_collateral_deployed_usd': {'aave_horizon': c2(hz_tot), 'morpho': c2(mo_tot), 'both_venues_total': c2(hz_tot + mo_tot)},
    'cross_venue_assets': [r['asset'] for r in recon_assets if r['cross_venue']],
    'by_asset': recon_assets,
    'by_sector_deployed_usd': [{'sector': k, 'usd': c2(v)} for k, v in sorted(recon_sector.items(), key=lambda x: -x[1])],
    'context_not_deployment': {'addressable_universe_fund_aum_usd': c2(snap['totals']['rwa_aum']),
                               'warning': 'Fund AUM (section 3 rwa_aum, ~$5.5B) is the addressable universe of Horizon-listed assets, NOT venue deployment. Do NOT compare it to Morpho collateral or sum it with venue figures.'},
    'notes': ['Only ~$356M of RWA is actually deployed as collateral across both venues, vs a ~$5.5B addressable universe.',
              'JAAA (Horizon) and wJAAA (Morpho) are the SAME underlying asset used across both venues, counted once per venue and flagged cross_venue (not double-summed as distinct value).',
              'The two venues host largely different assets: Horizon skews US Treasuries + JAAA; Morpho skews Private Credit (syrupUSDC/mF-ONE) + Gold.'],
}

# ---- assemble ----
doc = {
    'meta': {
        'report': 'RWA Terminal - June 2026 (Aave Horizon + Morpho)', 'period': {'start': '2026-06-01', 'end': '2026-06-30'},
        'scope': 'Sections 1-11 are Aave Horizon (the event indexer covers Horizon only). Section 12 and 13 are cross-venue: s12 = current-state deployment across Horizon/Morpho/DEX/wallets, s13 = Morpho RWA-collateral market history for June (backfilled from the Morpho API). Morpho flows/holders history is not available for the period (Morpho is not in our event indexer).',
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
    'section0_cross_venue_reconciliation': section0,
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
    'section13_morpho_market_history_june': {
        'note': 'Morpho RWA-collateral markets over June, backfilled from the Morpho API historicalState (daily). LLTV is the current fixed value per market. Makes the report whole-dashboard for market state; Morpho flows/holders history is still unavailable for June.',
        'per_market_june': morpho_per_market,
        'aggregate_daily': morpho_daily,
    },
    'next_report_metrics': {
        'note': 'Genuinely forward-only series (no historical source), recording from 2026-07-04 -> full time-series in the JULY report.',
        'items': [
            {'metric': 'Per-reserve Horizon state deltas (supplied USD, supply APY, LTV, LT) month-over-month', 'source': 'reserve_state_history / api/reserve-history', 'why_not_june': 'Horizon per-reserve supplied/APY/LTV were only kept as a current snapshot; not stored over June.'},
            {'metric': 'Liquidation-risk history (borrower health-factor distribution + min HF over time)', 'source': 'morpho_risk_history / api/morpho-risk-history', 'why_not_june': 'Computed from live positions; the Morpho API exposes historical market state but not a historical health-factor distribution.'},
        ],
        'note2': 'Morpho per-market history (collateral/borrow/utilisation/borrow-APY) is NOT forward-only: it is backfillable from the Morpho API historicalState and is already included for June in section 13.',
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
