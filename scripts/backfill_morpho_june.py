#!/usr/bin/env python3
"""Backfill Morpho RWA-collateral market state for June 2026 into Neon
(morpho_market_history + morpho_risk_history aggregate). Source: Morpho API historicalState.
HF buckets are NOT backfillable (no historical position data) -> left NULL for June.
Idempotent: ON CONFLICT DO NOTHING."""
import json, subprocess, os
from datetime import datetime, timezone

WORKER = 'https://rwa-terminal-worker.aborodeolusegun.workers.dev'
CONN = os.environ.get('DATABASE_URL', '')
PSQL = '/opt/homebrew/opt/libpq/bin/psql'
UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'
S = int(datetime(2026, 6, 1, tzinfo=timezone.utc).timestamp())
E = int(datetime(2026, 7, 4, tzinfo=timezone.utc).timestamp())  # through Jul 3 to close the gap before the cron (Jul 4)

def get(url):
    o = subprocess.run(['/usr/bin/curl', '-s', '--max-time', '60', '-H', 'User-Agent: ' + UA, url], capture_output=True, text=True)
    return json.loads(o.stdout)

def mgql(q, tries=6):
    import time
    last = ''
    for k in range(tries):
        o = subprocess.run(['/usr/bin/curl', '-s', '--max-time', '90', '-X', 'POST', 'https://blue-api.morpho.org/graphql',
                            '-H', 'content-type: application/json', '-d', json.dumps({'query': q})], capture_output=True, text=True)
        last = o.stdout[:200]
        try:
            d = json.loads(o.stdout)
            if d.get('data') is not None: return d['data']
            if d.get('errors'): last = str(d['errors'])[:200]
        except Exception:
            pass
        time.sleep(1.5 + k)
    raise RuntimeError('mgql failed: ' + last)

def daykey(ts):  # canonical midnight-UTC timestamp for a daily point
    dt = datetime.fromtimestamp(int(ts), timezone.utc)
    return datetime(dt.year, dt.month, dt.day, tzinfo=timezone.utc)

cm = get(WORKER + '/api/morpho')['collateral_markets']
print(f"markets to backfill: {len(cm)}")
_opt = 'options:{startTimestamp:%d,endTimestamp:%d,interval:DAY}' % (S, E)

mkt_rows = []                # (ts, market_id, coll, loan, class, lltv, coll_usd, borrow_usd, util, apy)
agg = {}                     # ts -> {coll, borrow, lltv_sum, n}
for m in cm:
    mid = m.get('market_id')
    if not mid: continue
    coll, loan, cls = m['collateral_symbol'], m['loan_symbol'], m.get('asset_class')
    q = ('{ markets(first:1, where:{chainId_in:[1], uniqueKey_in:["%s"]}) { items { lltv '
         'historicalState { collateralAssetsUsd(%s){x y} borrowAssetsUsd(%s){x y} utilization(%s){x y} borrowApy(%s){x y} } } } }'
         % (mid, _opt, _opt, _opt, _opt))
    its = mgql(q)['markets']['items']
    if not its: continue
    it = its[0]; lltv = int(it['lltv']) / 1e18
    hs = it.get('historicalState') or {}
    def ser(key): return {int(p['x']): p['y'] for p in (hs.get(key) or []) if p.get('y') is not None}
    cs, bs, us, aps = ser('collateralAssetsUsd'), ser('borrowAssetsUsd'), ser('utilization'), ser('borrowApy')
    june_xs = sorted(x for x in cs if S <= x < E)
    n = 0
    for x in june_xs:
        ts = daykey(x)
        cu, bu = cs.get(x), bs.get(x, 0.0)
        mkt_rows.append((ts, mid, coll, loan, cls, lltv, cu, bu, us.get(x), aps.get(x)))
        a = agg.setdefault(ts, {'coll': 0.0, 'borrow': 0.0, 'lltv': 0.0, 'n': 0})
        a['coll'] += cu or 0; a['borrow'] += bu or 0; a['lltv'] += lltv; a['n'] += 1
        n += 1
    print(f"  {coll}/{loan}: {n} June days")

# ---- emit SQL ----
def q(v):
    if v is None: return 'NULL'
    if isinstance(v, str): return "'" + v.replace("'", "''") + "'"
    if isinstance(v, datetime): return "'" + v.isoformat() + "'"
    return repr(float(v))

lines = ["BEGIN;"]
for (ts, mid, coll, loan, cls, lltv, cu, bu, util, apy) in mkt_rows:
    lines.append(
        "INSERT INTO morpho_market_history (ts,market_id,collateral_symbol,loan_symbol,asset_class,lltv,collateral_usd,borrow_usd,utilization,borrow_apy) VALUES ("
        + ",".join(q(x) for x in [ts, mid, coll, loan, cls, lltv, cu, bu, util, apy]) + ") ON CONFLICT DO NOTHING;")
for ts, a in sorted(agg.items()):
    avg_lltv = a['lltv'] / a['n'] if a['n'] else None
    lines.append(
        "INSERT INTO morpho_risk_history (ts,total_collateral_usd,total_borrow_usd,avg_lltv,market_count,borrowers,min_health_factor,hf_at_risk,hf_tight,hf_moderate,hf_safe) VALUES ("
        + ",".join(q(x) for x in [ts, a['coll'], a['borrow'], avg_lltv, a['n']]) + ",NULL,NULL,NULL,NULL,NULL,NULL) ON CONFLICT DO NOTHING;")
lines.append("COMMIT;")
sqlfile = os.path.join(os.path.dirname(__file__), 'backfill_morpho_june.sql')
open(sqlfile, 'w').write("\n".join(lines))
print(f"market rows: {len(mkt_rows)} | risk-agg days: {len(agg)} | SQL -> {sqlfile}")

if CONN:
    out = subprocess.run([PSQL, CONN, '-X', '-f', sqlfile], capture_output=True, text=True)
    print("psql:", (out.stdout or out.stderr).strip()[-400:])
else:
    print("DATABASE_URL not set; SQL written but not executed.")
