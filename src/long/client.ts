import type { Json } from "../types.js";

export interface LongAssetSnapshot {generatedAt:number;assets:Json[];}

type FetchLike=(input:string|URL,init?:RequestInit)=>Promise<Response>;
const sleep=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const transient=(error:unknown)=>/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|SocketError|other side closed/i.test(String(error));

export function longAssetRows(payload:unknown):Json[]{
  if(Array.isArray(payload))return payload.filter((row):row is Json=>Boolean(row)&&typeof row==="object");
  if(!payload||typeof payload!=="object")return [];
  const root=payload as Json,candidates=[root.assets,root.items,root.results,root.tokens,root.data?.assets,root.data?.items,root.data?.results,root.data?.tokens,root.data];
  for(const candidate of candidates)if(Array.isArray(candidate))return candidate.filter((row):row is Json=>Boolean(row)&&typeof row==="object");
  const queue:[unknown,number][]=[[root,0]],seen=new Set<unknown>();while(queue.length){const [value,depth]=queue.shift()!;if(!value||typeof value!=="object"||seen.has(value)||depth>4)continue;seen.add(value);if(Array.isArray(value)){const rows=value.filter((row):row is Json=>Boolean(row)&&typeof row==="object");if(rows.some(row=>row.address||row.tokenAddress||row.token_address||row.contractAddress||row.assetAddress||row.token?.address))return rows;for(const row of rows)queue.push([row,depth+1]);}else for(const child of Object.values(value as Json))queue.push([child,depth+1]);}
  return [];
}

export class LongClient {
  readonly baseUrl=process.env.LONG_API_URL??"https://api.long.xyz/v1/assets";
  constructor(private readonly fetcher:FetchLike=fetch){}
  get enabled(){return process.env.LONG_ENABLED!=="false";}
  private async request():Promise<unknown>{
    const method=String(process.env.LONG_API_METHOD??"GET").toUpperCase(),limit=Math.min(100,Math.max(1,Math.floor(Number(process.env.LONG_PAGE_SIZE??50)))),url=new URL(this.baseUrl);
    if(method==="GET"){
      if(!url.searchParams.has("status"))url.searchParams.set("status",process.env.LONG_STATUS??"all");
      if(!url.searchParams.has("chainId"))url.searchParams.set("chainId",process.env.LONG_CHAIN_ID??"4663");
      if(!url.searchParams.has("limit"))url.searchParams.set("limit",String(limit));
      if(!url.searchParams.has("offset"))url.searchParams.set("offset","0");
    }
    const rawBody=process.env.LONG_API_BODY,body=method==="GET"?undefined:rawBody??JSON.stringify({chainId:Number(process.env.LONG_CHAIN_ID??4663),status:process.env.LONG_STATUS??"all",limit,offset:0});
    for(let attempt=0;attempt<3;attempt++)try{
      const response=await this.fetcher(url,{method,headers:{Accept:"application/json","Content-Type":"application/json",Origin:"https://app.long.xyz",Referer:"https://app.long.xyz/tokens","User-Agent":"gmgn-profitable-wallet-bot/0.1"},...(body?{body}:{}),signal:AbortSignal.timeout(30000)});
      if(!response.ok)throw new Error(`Long ${method} ${url.pathname} failed (${response.status})`);
      const contentType=response.headers.get("content-type")??"";if(!contentType.includes("json"))throw new Error(`Long ${method} ${url.pathname} returned non-JSON content`);
      return response.json();
    }catch(error){if(attempt<2&&transient(error)){await sleep((attempt+1)*1000);continue;}throw error;}
    throw new Error("Long request exhausted transient-network retries");
  }
  async assets():Promise<LongAssetSnapshot>{const payload=await this.request();return {generatedAt:Date.now(),assets:longAssetRows(payload)};}
}
