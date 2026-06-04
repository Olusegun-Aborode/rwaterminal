import json
d=json.load(open("horizon.reserves.json"))
STABLE={"GHO","USDC","RLUSD"}
fresh=stale=value_only=unreadable=unknown=0
for r in d["reserves"]:
    p=r.get("oracle_price_usd") or 0; s=r.get("total_supplied") or 0
    r["supplied_usd"]=p*s; r["is_stable"]=r["label"] in STABLE; r["known"]=r["label"]!="?"
    if not r["known"]: unknown+=1
    if not r["is_stable"]:
        st=r.get("nav_state")
        if st=="fresh": fresh+=1
        elif st=="stale": stale+=1
        elif st=="value_only": value_only+=1
        else: unreadable+=1
tot=sum(r["supplied_usd"] for r in d["reserves"]); stab=sum(r["supplied_usd"] for r in d["reserves"] if r["is_stable"]); rwa=tot-stab
major=unknown+stale+unreadable          # hard data-quality failures
minor=value_only                         # known follow-up (off-chain freshness)
grade = "A" if (major==0 and minor==0) else "B" if major==0 else "C" if major<=2 else "D"
d["totals"]=dict(total_supplied_usd=tot,stablecoin_usd=stab,rwa_usd=rwa,
    reserve_count=len(d["reserves"]),rwa_count=sum(1 for r in d["reserves"] if not r["is_stable"]),
    unknown_count=unknown,nav_fresh=fresh,nav_stale=stale,nav_value_only=value_only,nav_unreadable=unreadable,
    grade=grade,major_issues=major,minor_issues=minor)
open("horizon.data.js","w").write("window.HORIZON_DATA = "+json.dumps(d,default=str)+";")
print(f"GRADE {grade}  (major issues={major}, minor={minor})")
print(f"  mapped: {len(d['reserves'])-unknown}/{len(d['reserves'])} (ACRED now mapped, unknown={unknown})")
print(f"  NAV: fresh={fresh} stale={stale} value_only={value_only} unreadable={unreadable}")
print(f"  totals: ${tot:,.0f}  stable ${stab:,.0f}  rwa ${rwa:,.0f}")
