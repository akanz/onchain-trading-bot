import type { Chain, Json } from "../types.js";
import { join } from "node:path";
import { DATA_ROOT } from "../config.js";
import { selectFomoToken, tokenExpiry } from "./token-store.js";

export interface FomoToken extends Json {
  address:string;
  chain:Chain;
  networkId:number;
  sources:Set<"fomo_most_held"|"fomo_trending">;
  holders:FomoHolder[];
}
export interface FomoHolder extends Json {
  wallet:string;
  roiPercent:number;
  realizedRoiPercent:number;
  unrealizedRoiPercent:number;
}
export type FomoLeaderboardPeriod="24h"|"7d"|"30d";
export interface FomoLeaderboards {byPeriod:Record<FomoLeaderboardPeriod,Json[]>;profiles:Json[];}

const NETWORK_CHAINS:Record<number,Chain|undefined>={1399811149:"sol",56:"bsc",8453:"base",4663:"robinhood",1:"eth"};
export const fomoChain=(networkId:unknown)=>NETWORK_CHAINS[Number(networkId)];
const finite=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)?n:0;};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const transient=(error:unknown)=>/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|SocketError|other side closed|bad record mac/i.test(String(error));

export class FomoClient {
  readonly baseUrl=process.env.FOMO_BASE_URL??"https://prod-api.fomo.family";
  readonly tokenFile=process.env.FOMO_TOKEN_FILE??join(DATA_ROOT,".runtime","fomo-token.json");
  get token(){return selectFomoToken(process.env.FOMO_TOKEN,this.tokenFile);}
  get enabled(){return Boolean(this.token);}
  get expiresAt():number|null {return tokenExpiry(this.token);}

  private headers(){
    if(!this.token)throw new Error("FOMO_TOKEN is not configured");
    return {Authorization:`Bearer ${this.token}`,Origin:"https://fomo.family",Referer:"https://fomo.family/","User-Agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36",Accept:"application/json","Content-Type":"application/json"};
  }
  private async request(path:string,method:"GET"|"POST"="GET",body?:Json):Promise<any>{
    if(this.expiresAt&&this.expiresAt<=Date.now()/1000)throw new Error("FOMO_TOKEN has expired; copy a fresh bearer token from your authenticated Fomo session");
    for(let attempt=0;attempt<3;attempt++){try{const response=await fetch(`${this.baseUrl}${path}`,{method,headers:this.headers(),...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});if(!response.ok){if(attempt<2&&[502,503,504].includes(response.status)){await sleep((attempt+1)*1000);continue;}throw new Error(`Fomo ${method} ${path.split("?")[0]} failed (${response.status})${response.status===401||response.status===430?"; the bearer token may be expired":""}`);}const payload=await response.json();if(payload?.success===false)throw new Error(`Fomo request rejected: ${payload.message??"unknown error"}`);return payload?.responseObject??payload;}catch(error){if(attempt<2&&transient(error)){console.warn(`Fomo transient network failure; retrying in ${attempt+1}s`);await sleep((attempt+1)*1000);continue;}throw error;}}
    throw new Error("Fomo request exhausted transient-network retries");
  }
  mostHeld():Promise<Json[]>{return this.request("/proxy/mostHeld","POST",{});}
  trending():Promise<Json[]>{return this.request("/proxy/trendingTokens","POST",{});}
  async leaderboard(period:FomoLeaderboardPeriod):Promise<Json[]>{const data=await this.request(`/v2/leaderboard/${period}`);return data?.leaderboard??[];}
  async leaderboards(periods:FomoLeaderboardPeriod[]=["24h","7d","30d"]):Promise<FomoLeaderboards>{
    const responses=await Promise.all(periods.map(async period=>[period,await this.leaderboard(period)] as const)),byPeriod={"24h":[],"7d":[],"30d":[]} as Record<FomoLeaderboardPeriod,Json[]>,profiles=new Map<string,Json>();
    for(const [period,rows] of responses){byPeriod[period]=rows;for(const [index,row] of rows.entries()){const id=String(row.id??"");if(!id)continue;const current=profiles.get(id)??{leaderboard_periods:[],leaderboard_ranks:{},leaderboard_pnl:{}};Object.assign(current,row);if(!current.leaderboard_periods.includes(period))current.leaderboard_periods.push(period);current.leaderboard_ranks[period]=index+1;current.leaderboard_pnl[period]=finite(row[`pnl${period}`]);profiles.set(id,current);}}
    return {byPeriod,profiles:[...profiles.values()]};
  }
  userTrades(userId:string):Promise<Json>{return this.request(`/trades?userId=${encodeURIComponent(userId)}`);}
  userSwaps(userId:string):Promise<Json>{return this.request(`/v2/users/${encodeURIComponent(userId)}/swaps?limit=100`);}
  tokenDetails(tokenId:string):Promise<Json>{return this.request("/proxy/tokenDetails","POST",{tokenId});}

  async topHolders(tokens:Array<{address:string;networkId:number}>):Promise<Json[]> {
    const output:Json[]=[];
    for(let offset=0;offset<tokens.length;offset+=10){
      const params=new URLSearchParams();tokens.slice(offset,offset+10).forEach((token,index)=>{params.set(`tokens[${index}][address]`,token.address);params.set(`tokens[${index}][networkId]`,String(token.networkId));});
      output.push(...await this.request(`/hodlers/top?${params}`));
    }
    return output;
  }

  eligibleHolder(row:Json,chain:Chain="sol"):FomoHolder|null {
    const costBasis=finite(row.costBasis),pnl=finite(row.pnl),realizedPnl=finite(row.realizedPnl),unrealizedPnl=finite(row.unrealizedPnl),value=finite(row.value),roiPercent=costBasis>0?pnl/costBasis*100:Infinity,user=row.user??{};
    if(!user.address||row.isDev||user.isRestricted||user.private)return null;
    if(costBasis<Number(process.env.FOMO_MIN_COST_BASIS_USD??100)||value<Number(process.env.FOMO_MIN_POSITION_VALUE_USD??100))return null;
    if(!Number.isFinite(roiPercent)||roiPercent<Number(process.env.FOMO_MIN_POSITION_ROI_PERCENT??500))return null;
    if(finite(user.numTrades)<Number(process.env.FOMO_MIN_USER_TRADES??20)||finite(user.totalVolume)<Number(process.env.FOMO_MIN_USER_VOLUME_USD??1000))return null;
    const wallet=chain==="sol"?user.address:user.evmAddress;if(!wallet)return null;
    return {...row,wallet:String(wallet),roiPercent,realizedRoiPercent:realizedPnl/costBasis*100,unrealizedRoiPercent:unrealizedPnl/costBasis*100};
  }

  async discover():Promise<FomoToken[]> {
    const [mostHeld,trending]=await Promise.all([this.mostHeld(),this.trending()]),tokens=new Map<string,FomoToken>();
    const add=(rows:Json[],source:FomoToken["sources"] extends Set<infer T>?T:never)=>{for(const row of rows){const networkId=Number(row.token?.networkId),chain=fomoChain(networkId),address=String(row.token?.address??"");if(!chain||!address)continue;const key=`${networkId}:${address}`,current=tokens.get(key)??{...row,address,chain,networkId,sources:new Set(),holders:[]};current.sources.add(source);Object.assign(current,row);tokens.set(key,current);}};
    add(mostHeld,"fomo_most_held");add(trending,"fomo_trending");
    const rows=await this.topHolders([...tokens.values()].map(({address,networkId})=>({address,networkId})));
    for(const result of rows){const token=tokens.get(`${result.networkId}:${result.tokenAddress}`);if(token)token.holders=(result.topHolders??[]).map((row:Json)=>this.eligibleHolder(row,token.chain)).filter(Boolean).slice(0,20) as FomoHolder[];}
    return [...tokens.values()];
  }
}
