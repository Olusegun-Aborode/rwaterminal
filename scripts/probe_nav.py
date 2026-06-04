import time
from web3 import Web3
RPCS=["https://eth.llamarpc.com","https://ethereum-rpc.publicnode.com","https://cloudflare-eth.com","https://rpc.ankr.com/eth"]
w3=None
for u in RPCS:
    try:
        c=Web3(Web3.HTTPProvider(u,request_kwargs={"timeout":20}))
        if c.is_connected(): w3=c; break
    except: pass
A=Web3.to_checksum_address
SRC={"USTB":"0x5Ae4D93B9b9626Dc3289e1Afb14b821FD3C95F44",
     "USCC":"0x14CB2E810Eb93b79363f489D45a972b609E47230",
     "JTRSY":"0xfAB6790E399f0481e1303167c655b3c39ee6e7A0",
     "JAAA":"0xF77f2537dba4ffD60f77fACdfB2c1706364fA03d",
     "USYC(works)":"0xE8E65Fb9116875012F5990Ecaab290B3531DbeB9"}
def mk(sig,outs):
    name=sig.split("(")[0]; ins=[]
    return {"name":name,"type":"function","stateMutability":"view","inputs":ins,"outputs":[{"type":t} for t in outs]}
PROBES=[("latestRoundData",["uint80","int256","uint256","uint256","uint80"]),
        ("latestAnswer",["int256"]),("latestTimestamp",["uint256"]),
        ("latestRound",["uint256"]),("decimals",["uint8"]),
        ("description",["string"]),("aggregator",["address"]),
        ("version",["uint256"])]
now=int(time.time())
for lbl,src in SRC.items():
    print(f"\n=== {lbl}  {src} ===")
    code=len(w3.eth.get_code(A(src)))
    print(f"  bytecode: {code} bytes")
    for name,outs in PROBES:
        try:
            ct=w3.eth.contract(A(src),abi=[mk(name,outs)])
            v=getattr(ct.functions,name)().call()
            if name=="latestRoundData":
                age=round((now-v[3])/3600,1)
                print(f"  ✓ latestRoundData -> answer={v[1]} updatedAt={v[3]} (age {age}h)")
            elif name=="latestTimestamp":
                print(f"  ✓ latestTimestamp -> {v} (age {round((now-v)/3600,1)}h)")
            else:
                print(f"  ✓ {name} -> {v}")
        except Exception as e:
            print(f"  ✗ {name}")
