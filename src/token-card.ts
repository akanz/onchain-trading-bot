import { number } from "./scoring.js";
import type { Chain, Json, TokenHolderSnapshot, TokenSnapshot, Verdict } from "./types.js";

const bool=(value:unknown):boolean|undefined=>value===true||[1,"1","true","yes"].includes(value as any)?true:value===false||[0,"0","false","no"].includes(value as any)?false:undefined;
const definedNumber=(value:unknown):number|undefined=>number(value,null)??undefined;
const firstNumber=(...values:unknown[]):number|undefined=>{for(const value of values){const parsed=definedNumber(value);if(parsed!==undefined)return parsed;}return undefined;};
const ratioChange=(current?:number,previous?:number):number|undefined=>current!==undefined&&previous!==undefined&&previous>0?(current/previous-1)*100:undefined;
const positiveTimestamp=(...values:unknown[]):number|undefined=>{for(const value of values){const parsed=definedNumber(value);if(parsed&&parsed>0)return parsed;}return undefined;};
const httpUrl=(value:unknown):string|undefined=>{if(typeof value!=="string"||!value.trim())return undefined;try{const url=new URL(value.trim());return url.protocol==="https:"||url.protocol==="http:"?url.toString():undefined;}catch{return undefined;}};

function holderSnapshot(row:Json):TokenHolderSnapshot|undefined {
  const address=String(row.address??row.wallet_address??row.wallet??"");
  if(!address)return undefined;
  const rawTags=row.tags??row.tag??[];
  const tags=(Array.isArray(rawTags)?rawTags:[rawTags]).map(String).filter(Boolean).slice(0,3);
  return {
    address,
    percentage:firstNumber(row.amount_percentage,row.percentage,row.hold_rate),
    usdValue:firstNumber(row.usd_value,row.value_usd),
    profit:firstNumber(row.profit,row.realized_profit),
    tags,
  };
}

export function buildTokenSnapshot(chain:Chain,address:string,info:Json,security:Json,pool:Json,holders:Json[],verdict:Verdict):TokenSnapshot {
  const price=definedNumber(info.price?.price);
  const circulating=definedNumber(info.circulating_supply);
  const total=firstNumber(info.max_supply,info.total_supply);
  const marketCap=price!==undefined&&circulating!==undefined?price*circulating:undefined;
  const fdv=price!==undefined&&total!==undefined?price*total:undefined;
  const createdAt=positiveTimestamp(pool.creation_timestamp,info.pool?.creation_timestamp,info.open_timestamp,info.creation_timestamp);
  const twitterUsername=String(info.link?.twitter_username??"").trim().replace(/^@/,"");
  const twitter=httpUrl(info.link?.twitter)??(twitterUsername?`https://x.com/${encodeURIComponent(twitterUsername)}`:undefined);
  return {
    chain,address,
    name:String(info.name??"")||undefined,
    symbol:String(info.symbol??"")||undefined,
    price,marketCap,fdv,
    liquidity:firstNumber(pool.liquidity,info.pool?.liquidity,info.liquidity),
    priceChange1h:ratioChange(price,definedNumber(info.price?.price_1h)),
    priceChange24h:ratioChange(price,definedNumber(info.price?.price_24h)),
    volume5m:definedNumber(info.price?.volume_5m),
    volume1h:definedNumber(info.price?.volume_1h),
    volume24h:definedNumber(info.price?.volume_24h),
    buys1h:definedNumber(info.price?.buys_1h),
    sells1h:definedNumber(info.price?.sells_1h),
    ageSeconds:createdAt?Math.max(0,Math.floor(Date.now()/1000-createdAt)):undefined,
    holderCount:firstNumber(info.holder_count,info.stat?.holder_count),
    top10HolderRate:firstNumber(security.top_10_holder_rate,info.dev?.top_10_holder_rate,info.stat?.top_10_holder_rate),
    smartWallets:definedNumber(info.wallet_tags_stat?.smart_wallets),
    freshWalletRate:definedNumber(info.stat?.fresh_wallet_rate),
    dex:String(pool.exchange??info.pool?.exchange??"")||undefined,
    poolAddress:String(pool.pool_address??info.biggest_pool_address??info.pool?.pool_address??"")||undefined,
    website:httpUrl(info.link?.website),twitter,
    telegram:httpUrl(info.link?.telegram),gmgn:httpUrl(info.link?.gmgn),
    honeypot:bool(security.is_honeypot??security.honeypot),
    openSource:bool(security.is_open_source??security.open_source),
    renounced:bool(security.is_renounced??security.owner_renounced??security.renounced),
    liquidityLocked:bool(security.lock_summary?.is_locked),
    buyTax:definedNumber(security.buy_tax),sellTax:definedNumber(security.sell_tax),
    topHolders:holders.map(holderSnapshot).filter((holder):holder is TokenHolderSnapshot=>Boolean(holder)).slice(0,5),
    verdict,
  };
}
