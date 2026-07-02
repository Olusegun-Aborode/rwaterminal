import json, time, os
from web3 import Web3

RPCS = ["https://eth.llamarpc.com","https://ethereum-rpc.publicnode.com",
        "https://cloudflare-eth.com","https://rpc.ankr.com/eth","https://eth.drpc.org"]
w3 = None
for url in RPCS:
    try:
        c = Web3(Web3.HTTPProvider(url, request_kwargs={"timeout": 20}))
        if c.is_connected() and c.eth.block_number > 0:
            w3 = c; print(f"connected via {url} (block {c.eth.block_number})"); break
    except Exception as e:
        print(f"  {url} failed: {e}")
assert w3, "no RPC reachable"

A = Web3.to_checksum_address
POOL          = A("0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8")
ORACLE        = A("0x985BcfAB7e0f4EF2606CC5b64FC1A16311880442")
DATA_PROVIDER = A("0x53519c32f73fE1797d10210c4950fFeBa3b21504")
UI_NEW        = A("0x2dAd8162A989cd99D673dE4425Bb2298Db1E1aA2")
UI_OLD        = A("0x56b7A1012765C285afAC8b8F25C69Bf10ccfE978")

KNOWN = {
 "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e": ("USTB","Superstate"),
 "0x14d60e7fdc0d71d8611742720e4c50e7a974020c": ("USCC","Superstate"),
 "0x8c213ee79581ff4984583c6a801e5263418c4b86": ("JTRSY","Janus Henderson / Anemoy / Centrifuge"),
 "0x5a0f93d040de44e78f251b03c43be9cf317dcf64": ("JAAA","Janus Henderson / Anemoy / Centrifuge"),
 "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b": ("USYC","Circle (Hashnote)"),
 "0x2255718832bc9fd3be1caf75084f4803da14ff01": ("VBILL","VanEck (Securitize)"),
 "0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f": ("GHO","Aave"),
 "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ("USDC","Circle"),
 "0x8292bb45bf1ee4d140127049757c2e0ff06317ed": ("RLUSD","Ripple"),
 "0x17418038ecf73ba4026c4f428547bf099706f27b": ("ACRED","Apollo / Securitize"),
}
DP_ABI = [
 {"name":"getAllReservesTokens","stateMutability":"view","inputs":[],"outputs":[{"type":"tuple[]","components":[{"name":"symbol","type":"string"},{"name":"tokenAddress","type":"address"}]}]},
 {"name":"getReserveTokensAddresses","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"address"},{"type":"address"},{"type":"address"}]},
 {"name":"getReserveConfigurationData","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"},{"type":"uint256"},{"type":"uint256"},{"type":"uint256"},{"type":"uint256"},{"type":"bool"},{"type":"bool"},{"type":"bool"},{"type":"bool"},{"type":"bool"}]},
 {"name":"getReserveData","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]*11+[{"type":"uint40"}]},
]
ORACLE_ABI=[
 {"name":"getSourceOfAsset","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"address"}]},
 {"name":"getAssetPrice","stateMutability":"view","inputs":[{"type":"address"}],"outputs":[{"type":"uint256"}]},
]
AGG_ABI=[
 {"name":"decimals","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
 {"name":"description","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
 {"name":"latestAnswer","stateMutability":"view","inputs":[],"outputs":[{"type":"int256"}]},
 {"name":"latestRoundData","stateMutability":"view","inputs":[],"outputs":[{"type":"uint80"},{"type":"int256"},{"type":"uint256"},{"type":"uint256"},{"type":"uint80"}]},
]
ERC20=[
 {"name":"decimals","stateMutability":"view","inputs":[],"outputs":[{"type":"uint8"}]},
 {"name":"symbol","stateMutability":"view","inputs":[],"outputs":[{"type":"string"}]},
 {"name":"totalSupply","stateMutability":"view","inputs":[],"outputs":[{"type":"uint256"}]},
]
for _abi in (DP_ABI, ORACLE_ABI, AGG_ABI, ERC20):
    for _i in _abi: _i["type"] = "function"
import datetime, requests
_HDR={"User-Agent":"rwa-terminal/1.0"}
ISSUER_FEEDS = {  # off-chain timestamped NAV for the "value-only" on-chain feeds
 "0x43415eb6ff9db7e26a15b704e7a3edce97d31c4e": ("superstate", 1),  # USTB
 "0x14d60e7fdc0d71d8611742720e4c50e7a974020c": ("superstate", 2),  # USCC
 "0x136471a34f6ef19fe571effc1ca711fdb8e49f2b": ("usyc", None),     # USYC (cross-check)
}
def fetch_issuer(addr):
    cfg = ISSUER_FEEDS.get(addr.lower())
    if not cfg: return None
    try:
        if cfg[0] == "superstate":
            d = requests.get(f"https://api.superstate.com/v1/funds/{cfg[1]}/nav-daily", headers=_HDR, timeout=15).json()
            r = d[0] if isinstance(d, list) else (d.get("data") or [d])[0]
            ts = int(datetime.datetime.strptime(r["net_asset_value_date"], "%m/%d/%Y").replace(tzinfo=datetime.timezone.utc).timestamp())
            return dict(source="superstate_api", nav=float(r["net_asset_value"]), asof=r["net_asset_value_date"],
                        asof_ts=ts, aum=float(r.get("assets_under_management") or 0))
        if cfg[0] == "usyc":
            d = requests.get("https://usyc.hashnote.com/api/price-reports", headers=_HDR, timeout=15).json()
            r = (d.get("data") if isinstance(d, dict) else d)
            r = r[0] if isinstance(r, list) else r
            return dict(source="hashnote_api", nav=float(r["price"]), asof_ts=int(r["timestamp"]),
                        asof=datetime.datetime.utcfromtimestamp(int(r["timestamp"])).strftime("%m/%d/%Y"), aum=None)
    except Exception as e:
        return None

dp = w3.eth.contract(DATA_PROVIDER, abi=DP_ABI)
oracle = w3.eth.contract(ORACLE, abi=ORACLE_ABI)

# UiPoolDataProvider check: new vs old address — confirm which actually has code
code_new = len(w3.eth.get_code(UI_NEW)); code_old = len(w3.eth.get_code(UI_OLD))
print(f"UiPoolDataProvider — new {UI_NEW}: {code_new} bytes | old {UI_OLD}: {code_old} bytes")

now = int(time.time())
reserves = dp.functions.getAllReservesTokens().call()
print(f"\nHorizon live reserves: {len(reserves)}\n" + "="*70)
out=[]
for sym_onchain, addr in reserves:
    addr_l = addr.lower()
    label, issuer = KNOWN.get(addr_l, ("?","? UNKNOWN — investigate"))
    try: aT, sD, vD = dp.functions.getReserveTokensAddresses(addr).call()
    except Exception: aT=sD=vD=None
    try:
        cfg = dp.functions.getReserveConfigurationData(addr).call()
        dec, ltv, lqt = cfg[0], cfg[1]/100.0, cfg[2]/100.0
        usable_collat, borrow_en, _, active, frozen = cfg[5], cfg[6], cfg[7], cfg[8], cfg[9]
    except Exception as e:
        dec=ltv=lqt=None; usable_collat=borrow_en=active=frozen=None
    try:
        rd = dp.functions.getReserveData(addr).call()
        total_atoken = rd[2]/(10**dec) if dec else rd[2]
        liq_rate = rd[5]/1e27*100; var_borrow = rd[6]/1e27*100
    except Exception:
        total_atoken=liq_rate=var_borrow=None
    try: price = oracle.functions.getAssetPrice(addr).call()/1e8
    except Exception: price=None
    try: src = oracle.functions.getSourceOfAsset(addr).call()
    except Exception: src=None
    agg_desc=None; nav_updated=None; nav_age_h=None; agg_dec=None
    nav_value=None; nav_state=None; nav_fresh_src=None
    if src and int(src,16)!=0:
        agg = w3.eth.contract(A(src), abi=AGG_ABI)
        try: agg_dec = agg.functions.decimals().call()
        except Exception: agg_dec=None
        try: agg_desc = agg.functions.description().call()
        except Exception: agg_desc=None
        try:  # full AggregatorV3 feed -> has a timestamp -> fresh/stale
            lr = agg.functions.latestRoundData().call()
            nav_updated = lr[3]; nav_age_h = round((now-lr[3])/3600,1)
            nav_value = lr[1]/(10**agg_dec) if agg_dec else lr[1]
            nav_fresh_src = "onchain_roundData"
            nav_state = "stale" if nav_age_h>48 else "fresh"
        except Exception:  # LlamaGuard "USD Scaled" adapter: latestAnswer only, NO on-chain ts
            try:
                ans = agg.functions.latestAnswer().call()
                nav_value = ans/(10**agg_dec) if agg_dec else ans
                nav_fresh_src = "onchain_latestAnswer_no_ts"
                nav_state = "value_only"   # value OK; freshness must come from issuer feed
            except Exception:
                nav_state = "unreadable"
    iss = fetch_issuer(addr)
    off_nav=off_asof=off_asof_ts=off_aum=off_src=None
    if iss:
        off_nav, off_asof, off_asof_ts, off_aum, off_src = iss["nav"], iss["asof"], iss["asof_ts"], iss.get("aum"), iss["source"]
        off_age_h = round((now-off_asof_ts)/3600,1)
        # value-only on-chain feed now has an off-chain timestamp -> treat as fresh
        if nav_state in ("value_only", None) and off_age_h <= 72:
            nav_state = "fresh"; nav_fresh_src = off_src; nav_age_h = off_age_h
    rec = dict(symbol_onchain=sym_onchain, label=label, issuer=issuer, address=addr,
               aToken=aT, variableDebt=vD, decimals=dec, ltv_pct=ltv, liq_threshold_pct=lqt,
               collateral=usable_collat, borrowable=borrow_en, active=active, frozen=frozen,
               total_supplied=total_atoken, supply_apy_pct=round(liq_rate,3) if liq_rate is not None else None,
               borrow_apy_pct=round(var_borrow,3) if var_borrow is not None else None,
               oracle_price_usd=price, oracle_source=src, oracle_desc=agg_desc,
               nav_updated_at=nav_updated, nav_age_hours=nav_age_h,
               nav_value=nav_value, nav_state=nav_state, nav_freshness_source=nav_fresh_src,
               offchain_nav=off_nav, offchain_nav_asof=off_asof, offchain_nav_asof_ts=off_asof_ts,
               offchain_aum=off_aum, offchain_source=off_src)
    out.append(rec)
    fr = "FROZEN" if frozen else ("stale!" if (nav_age_h and nav_age_h>48) else "")
    print(f"{label:6} {sym_onchain:8} | px ${price if price else '—'} | supplied {total_atoken:,.2f} | "
          f"LTV {ltv}% | NAV age {nav_age_h}h {fr}" if price else f"{label:6} {sym_onchain:8} | (partial)")

res = dict(market_id="proto_horizon_v3", pool=POOL, oracle=ORACLE, data_provider=DATA_PROVIDER,
           ui_pool_data_provider_new=UI_NEW, ui_pool_new_code_bytes=code_new,
           ui_pool_old_code_bytes=code_old, block=w3.eth.block_number, fetched_at=now, reserves=out)
open(os.path.join(os.path.dirname(__file__), "..", "horizon.reserves.json"),"w").write(json.dumps(res, indent=2, default=str))
print("="*70)
print(f"wrote horizon.reserves.json — {len(out)} reserves @ block {w3.eth.block_number}")
