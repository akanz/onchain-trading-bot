import type { Chain, Json } from "../types.js";

type FetchLike=(input:string|URL,init?:RequestInit)=>Promise<Response>;
const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const transient=(error:unknown)=>/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|SocketError|other side closed|HTTP 5\d\d/i.test(String(error));
const chainId=(chain:Chain)=>chain==="sol"?"solana":chain==="eth"?"ethereum":chain;
const rows=(payload:unknown):Json[]=>Array.isArray(payload)?payload.filter((row):row is Json=>Boolean(row)&&typeof row==="object"):[];

export interface DexScreenerSnapshot {generatedAt:number;pairs:Json[];discovered:number;}

/** Uses only DexScreener's documented public REST endpoints. */
export class DexScreenerClient {
  readonly baseUrl=String(process.env.DEXSCREENER_API_URL??"https://api.dexscreener.com").replace(/\/$/,"");
  constructor(private readonly fetcher:FetchLike=fetch){}
  get enabled(){return process.env.DEXSCREENER_ENABLED!=="false";}

  private async get(path:string):Promise<unknown>{
    for(let attempt=0;attempt<3;attempt++)try{
      const response=await this.fetcher(`${this.baseUrl}${path}`,{headers:{Accept:"application/json","User-Agent":"gmgn-profitable-wallet-bot/0.1"},signal:AbortSignal.timeout(15000)});
      if(!response.ok)throw new Error(`DexScreener GET ${path.split("?")[0]} failed (HTTP ${response.status})`);
      const contentType=response.headers.get("content-type")??"";if(!contentType.includes("json"))throw new Error(`DexScreener GET ${path.split("?")[0]} returned non-JSON content`);
      return response.json();
    }catch(error){if(attempt<2&&transient(error)){await sleep((attempt+1)*500);continue;}throw error;}
    return [];
  }

  async discover(chain:Chain):Promise<DexScreenerSnapshot>{
    if(!this.enabled)return {generatedAt:Date.now(),pairs:[],discovered:0};
    const wanted=chainId(chain),sources=new Map<string,Set<string>>(),searchPairs:Json[]=[],queries=String(process.env.DEXSCREENER_SEARCH_QUERIES??"robinhood,ETH,WETH,USDG,FAMI,DJT,SPY,QQQ,AAPL,TSLA,NVDA").split(",").map(value=>value.trim()).filter(Boolean).slice(0,20),requests=[this.get("/token-profiles/latest/v1"),this.get("/token-boosts/latest/v1"),...queries.map(query=>this.get(`/latest/dex/search?q=${encodeURIComponent(query)}`))],results=await Promise.allSettled(requests);if(results.every(result=>result.status==="rejected"))throw (results[0] as PromiseRejectedResult).reason;
    for(const [index,result] of results.entries())if(result.status==="fulfilled")for(const row of index<2?rows(result.value):rows((result.value as Json)?.pairs)){
      if(String(row.chainId).toLowerCase()!==wanted)continue;const address=String(index<2?row.tokenAddress??"":row.baseToken?.address??"");if(!address)continue;const labels=sources.get(address.toLowerCase())??new Set<string>();labels.add(index===0?"DEXSCREENER PROFILE":index===1?"DEXSCREENER BOOST":`DEXSCREENER SEARCH ${queries[index-2]}`);sources.set(address.toLowerCase(),labels);if(index>=2)searchPairs.push(row);
    }
    const addresses=[...sources.keys()].slice(0,Math.max(1,Math.min(90,Number(process.env.DEXSCREENER_MAX_DISCOVERED_TOKENS??60)))),allowed=new Set(addresses),pairs=new Map<string,Json>();
    const add=(pair:Json)=>{const address=String(pair.baseToken?.address??"").toLowerCase(),labels=sources.get(address);if(!allowed.has(address)||!labels)return;const key=String(pair.pairAddress??`${address}:${pair.dexId??""}:${pair.quoteToken?.address??""}`).toLowerCase(),existing=pairs.get(key);pairs.set(key,{...existing,...pair,dexscreener_discovery_sources:[...labels]});};for(const pair of searchPairs)add(pair);
    for(let offset=0;offset<addresses.length;offset+=30){const chunk=addresses.slice(offset,offset+30),payload=await this.get(`/tokens/v1/${encodeURIComponent(wanted)}/${chunk.map(encodeURIComponent).join(",")}`);for(const pair of rows(payload))add(pair);}
    return {generatedAt:Date.now(),pairs:[...pairs.values()],discovered:addresses.length};
  }
}
