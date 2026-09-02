import { addressKey, validTokenAddress } from "../signals.js";
import type { Chain, Json } from "../types.js";

const finite=(value:unknown):number|undefined=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined;};

export function normalizeDexScreenerPairs(chain:Chain,pairs:Json[],now=Math.floor(Date.now()/1000)):Json[]{
  const grouped=new Map<string,Json[]>();
  for(const pair of pairs){const address=String(pair.baseToken?.address??"");if(String(pair.chainId).toLowerCase()!==(chain==="sol"?"solana":chain==="eth"?"ethereum":chain)||!validTokenAddress(chain,address))continue;const key=addressKey(address),items=grouped.get(key)??[];items.push(pair);grouped.set(key,items);}
  const output:Json[]=[];
  for(const items of grouped.values()){
    const primary=[...items].sort((a,b)=>Number(b.liquidity?.usd??0)-Number(a.liquidity?.usd??0)||Number(b.volume?.m5??0)-Number(a.volume?.m5??0))[0]!;
    const createdAt=Math.floor(Number(primary.pairCreatedAt??0)/1000),volume5=items.reduce((sum,row)=>sum+(finite(row.volume?.m5)??0),0),buys5=items.reduce((sum,row)=>sum+(finite(row.txns?.m5?.buys)??0),0),sells5=items.reduce((sum,row)=>sum+(finite(row.txns?.m5?.sells)??0),0),priceChange5=finite(primary.priceChange?.m5)??0,liquidity=items.reduce((sum,row)=>sum+(finite(row.liquidity?.usd)??0),0),marketCap=finite(primary.marketCap??primary.fdv),age=createdAt>0?Math.max(0,now-createdAt):undefined,labels:string[]=[],sources=[...new Set(items.flatMap(row=>(row.dexscreener_discovery_sources??[]).map(String)))];
    const minimumLiquidity=Math.max(0,Number(process.env.DEXSCREENER_MIN_LIQUIDITY_USD??5000)),minimumVolume=Math.max(0,Number(process.env.DEXSCREENER_MIN_VOLUME_5M_USD??10000)),minimumTxns=Math.max(1,Number(process.env.DEXSCREENER_MIN_TXNS_5M??20)),surgePercent=Number(process.env.DEXSCREENER_PRICE_SURGE_5M_PERCENT??15),newPairAge=Math.max(60,Number(process.env.DEXSCREENER_NEW_PAIR_MAX_AGE_SECONDS??1200)),txns=buys5+sells5;
    if(priceChange5>=surgePercent&&volume5>=minimumVolume&&txns>=minimumTxns)labels.push("DEXSCREENER PRICE SURGE");
    if(age!==undefined&&age<=newPairAge&&liquidity>=minimumLiquidity&&volume5>=minimumVolume&&txns>=minimumTxns)labels.push("DEXSCREENER NEW PAIR");
    if(volume5>=minimumVolume*2.5&&txns>=minimumTxns*2)labels.push("DEXSCREENER VOLUME");
    output.push({chain,address:primary.baseToken.address,name:primary.baseToken.name,symbol:primary.baseToken.symbol,price:finite(primary.priceUsd),market_cap:marketCap,fdv:finite(primary.fdv),liquidity,volume:volume5,volume_5m:volume5,buys_5m:buys5,sells_5m:sells5,swaps:txns,price_change_5m:priceChange5,price_change_percent5m:priceChange5,pair_created_at:createdAt||undefined,token_age_seconds:age,pool:primary.pairAddress,dex:primary.dexId,dexscreener_url:primary.url,dexscreener_pair_count:items.length,dexscreener_discovery_sources:sources,is_microcap:marketCap!==undefined&&marketCap>0&&marketCap<=Number(process.env.DEGEN_MAX_MARKET_CAP_USD??100000),degen_sources:[...sources,"DEXSCREENER"],degen_signal_labels:labels,quality_passed:false,quality_reasons:["DexScreener discovery; GMGN contract and holder safety checks pending"]});
  }
  return output.sort((a,b)=>Number(Boolean(b.degen_signal_labels.length))-Number(Boolean(a.degen_signal_labels.length))||Number(b.volume_5m)-Number(a.volume_5m));
}

export function qualifyDexScreenerPairs(chain:Chain,pairs:Json[],now=Math.floor(Date.now()/1000)):Json[]{return normalizeDexScreenerPairs(chain,pairs,now).filter(row=>row.degen_signal_labels.length>0).slice(0,Math.max(1,Number(process.env.DEXSCREENER_MAX_CANDIDATES_PER_SCAN??20)));}
