import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { GmgnClient, isRateLimit } from "../src/gmgn.js";
import { isCleanGmgnTrendingTrader, trackWallet, validWalletAddress } from "../src/gmgn-wallet-analysis.js";
import { DATA_ROOT, loadConfig } from "../src/config.js";
import { number, wilsonLowerBound } from "../src/scoring.js";
import { detectRunnerMove, enteredBeforeMove } from "../src/runner-timing.js";
import { crossedHistoricalMarketCap, historicalMarketCap } from "../src/market-cap.js";
import type { Chain, Json } from "../src/types.js";
import { connectMongo, TrackedWalletRepository } from "../src/mongo.js";

const envPath=join(process.cwd(),".env");if(existsSync(envPath))loadEnvFile(envPath);
const config=loadConfig(), client=new GmgnClient();
const chains=config.enabled_chains;
const now=new Date(), stamp=now.toISOString().slice(0,10);
const reportDir=join(DATA_ROOT,"reports"); mkdirSync(reportDir,{recursive:true});
const reportPath=join(reportDir,`daily-wallet-scan-${stamp}.json`);
const summaryPath=join(reportDir,`daily-wallet-scan-${stamp}.csv`);
const cachePath=join(reportDir,`daily-wallet-scan-${stamp}.cache.json`);
const walletCachePath=join(reportDir,`daily-wallet-scan-${stamp}.wallet-cache.json`);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

async function gmgn(...args:string[]):Promise<Json>{
  for(let attempt=0;attempt<4;attempt++){
    try{return await client.run(...args);}catch(error){
      if(!isRateLimit(error)||attempt===3)throw error;
      const match=String(error).match(/~(\d+)s remaining/i),seconds=match?Number(match[1]):60;
      console.warn(`Rate cooldown: waiting ${seconds+8}s before one retry…`); await sleep((seconds+8)*1000);
    }
  }
  throw new Error("Unreachable retry state");
}

async function mapLimit<T,R>(items:T[],limit:number,fn:(item:T,index:number)=>Promise<R>):Promise<R[]> {
  const output=new Array<R>(items.length); let next=0;
  async function worker(){while(true){const index=next++;if(index>=items.length)return;output[index]=await fn(items[index]!,index);await sleep(350);}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker)); return output;
}

const walletArgs=(wallets:string[])=>wallets.flatMap(wallet=>["--wallet",wallet]);
const minimumTrendingTraderRoiPercent=Number(process.env.GMGN_MIN_TRENDING_TRADER_ROI_PERCENT??500);
const minimumRunnerAthMarketCap=Number(process.env.GMGN_RUNNER_MIN_ATH_MARKET_CAP_USD??1_000_000);
const minimumKolPushWallets=Number(process.env.GMGN_RUNNER_MIN_RENOWNED_COUNT??2);
const preMoveLeadSeconds=Number(process.env.GMGN_RUNNER_PRE_MOVE_LEAD_SECONDS??21600);
const cleanTrader=(row:Json)=>isCleanGmgnTrendingTrader(row,minimumTrendingTraderRoiPercent);
const validAddress=validWalletAddress;

console.log(`Fetching 24h trending universe and retaining tokens whose ATH market cap crossed $${minimumRunnerAthMarketCap.toLocaleString()} on ${chains.join(", ")}…`);
const trending=await mapLimit(chains,2,async chain=>{
  const data=await gmgn("market","trending","--chain",chain,"--interval","24h","--order-by","volume","--direction","desc","--limit","100");
  const tokens=(data.data?.rank??[]).filter((t:Json)=>t.address&&validAddress(chain,t.address)&&crossedHistoricalMarketCap(t,minimumRunnerAthMarketCap)).map((t:Json)=>({...t,ath_market_cap:historicalMarketCap(t)}));
  console.log(`${chain}: ${tokens.length} qualifying tokens`); return {chain,tokens};
});

type FeedSource="gmgn_smartmoney"|"gmgn_kol"|"gmgn_followed";
const feedResults=await mapLimit(chains,1,async chain=>{
  const feeds:Array<{source:FeedSource;rows:Json[]}>=[];
  const load=async(source:FeedSource,fn:()=>Promise<Json[]>)=>{try{feeds.push({source,rows:await fn()});}catch(error){if(isRateLimit(error))throw error;console.warn(`${chain}: ${source} discovery unavailable: ${String(error)}`);}};
  if(["sol","bsc","base","eth"].includes(chain)){
    await load("gmgn_smartmoney",()=>client.smartMoney(chain,200));
    await load("gmgn_kol",()=>client.kol(chain,200));
  }
  await load("gmgn_followed",()=>client.followedWallets(chain,100));
  console.log(`${chain}: ${feeds.reduce((sum,feed)=>sum+feed.rows.length,0)} GMGN tracking-feed events`);
  return {chain,feeds};
});

const tokenJobs=trending.flatMap(group=>group.tokens.map((token:Json)=>({chain:group.chain,token})));
let completed=0;
const cached:Record<string,Json>=existsSync(cachePath)?JSON.parse(readFileSync(cachePath,"utf8")):{};
const tokenResults=await mapLimit(tokenJobs,1,async ({chain,token})=>{
  const key=`v3:${chain}:${token.address}`; if(cached[key]){completed++;console.log(`[${completed}/${tokenJobs.length}] ${chain}:${token.symbol||token.address} cached`);return cached[key] as any;}
  try {
    const data=await gmgn("token","traders","--chain",chain,"--address",token.address,"--limit","100","--order-by","profit","--direction","desc");
    const traders:Json[]=data.list??[],clean=traders.filter(cleanTrader);
    const kolPushCount=Number(token.renowned_count??token.renowned_wallet_count??token.kol_count??0);
    let runnerMove:Json|undefined,preMoveWallets:string[]=[];
    if(kolPushCount>=minimumKolPushWallets){
      const to=Math.floor(Date.now()/1000),from=to-86400,candles=(await gmgn("market","kline","--chain",chain,"--address",token.address,"--resolution","1m","--from",String(from),"--to",String(to))).list??[];
      runnerMove=detectRunnerMove(candles,Number(process.env.GMGN_RUNNER_PUMP_CANDLE_PERCENT??20),Number(process.env.GMGN_RUNNER_PUMP_VOLUME_RATIO??3),Number(process.env.GMGN_RUNNER_PUMP_5M_PERCENT??35));
      if(runnerMove)preMoveWallets=clean.filter(row=>enteredBeforeMove(row,Number(runnerMove!.started_at),preMoveLeadSeconds)).map(row=>String(row.address));
    }
    completed++; console.log(`[${completed}/${tokenJobs.length}] ${chain}:${token.symbol||token.address} traders=${traders.length} locally_clean=${clean.length} pre_move=${preMoveWallets.length}`);
    const result={chain,token,traders,clean_wallets:clean.map(row=>row.address),kol_push_wallets:kolPushCount,runner_move:runnerMove,pre_move_wallets:preMoveWallets};cached[key]=result;writeFileSync(cachePath,JSON.stringify(cached));return result;
  } catch(error) {
    if(isRateLimit(error))throw error;
    completed++; console.error(`[${completed}/${tokenJobs.length}] ${chain}:${token.symbol||token.address} failed: ${String(error)}`);
    return {chain,token,traders:[] as Json[],clean_wallets:[] as string[],kol_push_wallets:0,runner_move:undefined,pre_move_wallets:[] as string[],error:String(error)};
  }
});

const candidatesByChain=new Map<Chain,Map<string,Json>>();
for(const result of tokenResults){
  const map=candidatesByChain.get(result.chain)??new Map<string,Json>(); candidatesByChain.set(result.chain,map);
  for(const row of result.traders.filter(cleanTrader)){
    const item=map.get(row.address)??{wallet:row.address,tokens:[],pre_move_tokens:[],runner_realized_profit:0,discovery_sources:[],source_events:[]};
    if(!item.discovery_sources.includes("gmgn_trending_500pct"))item.discovery_sources.push("gmgn_trending_500pct");
    const preMove=result.pre_move_wallets.includes(row.address);if(preMove&&!item.pre_move_tokens.includes(result.token.address)){item.pre_move_tokens.push(result.token.address);if(!item.discovery_sources.includes("gmgn_pre_move"))item.discovery_sources.push("gmgn_pre_move");if(item.pre_move_tokens.length>=2&&!item.discovery_sources.includes("gmgn_repeat_pre_move"))item.discovery_sources.push("gmgn_repeat_pre_move");}
    item.tokens.push({address:result.token.address,symbol:result.token.symbol,realized_profit:number(row.realized_profit,0),realized_pnl:number(row.realized_pnl,0),roi_percent:(number(row.realized_pnl,0)??0)*100,pre_move:preMove});
    item.runner_realized_profit+=(number(row.realized_profit,0)??0); map.set(row.address,item);
  }
}

for(const result of feedResults){
  const map=candidatesByChain.get(result.chain)??new Map<string,Json>();candidatesByChain.set(result.chain,map);
  for(const feed of result.feeds)for(const row of feed.rows){
    const wallet=trackWallet(row);if(!validWalletAddress(result.chain,wallet))continue;
    const item=map.get(wallet)??{wallet,tokens:[],pre_move_tokens:[],runner_realized_profit:0,discovery_sources:[],source_events:[]};
    if(!item.discovery_sources.includes(feed.source))item.discovery_sources.push(feed.source);
    item.source_events.push({source:feed.source,token_address:row.base_address,side:row.side,amount_usd:Number(row.amount_usd??0),timestamp:Number(row.timestamp??0),tags:row.maker_info?.tags??[]});
    map.set(wallet,item);
  }
}

const profiles:Json[]=[];
const walletCache:Record<string,Json>=existsSync(walletCachePath)?JSON.parse(readFileSync(walletCachePath,"utf8")):{};
for(const chain of chains){
  const recurrent=[...(candidatesByChain.get(chain)?.values()??[])].filter(c=>c.tokens.length>=2||c.source_events.length>0).sort((a,b)=>(b.tokens.length*3+b.pre_move_tokens.length*5+b.source_events.length)-(a.tokens.length*3+a.pre_move_tokens.length*5+a.source_events.length)||b.runner_realized_profit-a.runner_realized_profit).slice(0,100);
  console.log(`${chain}: ${recurrent.length} GMGN candidates selected for global validation`);
  if(!recurrent.length)continue;
  const wallets=recurrent.map(c=>c.wallet),profitRows:Record<string,Map<string,Json>>={};
  for(const period of ["7d","30d","all"]){
    const data=await gmgn("portfolio","profits","--chain",chain,...walletArgs(wallets),"--period",period);
    profitRows[period]=new Map((data.list??[]).map((row:Json)=>[row.wallet_address,row]));
  }
  const profitPassed:Json[]=[];
  for(const candidate of recurrent){
    const p7=profitRows["7d"]?.get(candidate.wallet)??{},p30=profitRows["30d"]?.get(candidate.wallet)??{},pall=profitRows.all?.get(candidate.wallet)??{};
    const rp7=number(p7.realized_profit,0)??0,rp30=number(p30.realized_profit,0)??0,rpall=number(pall.total_realized_profit??pall.realized_profit,0)??0;
    const roi30=rp30/Math.max(number(p30.realized_profit_cost,0)??0,1),roiall=rpall/Math.max(number(pall.total_realized_profit_cost??pall.realized_profit_cost,0)??0,1);
    const trades30=(number(p30.buy,0)??0)+(number(p30.sell,0)??0);
    if(rp7>=0&&rp30>=1000&&rpall>=5000&&roi30>=.05&&roiall>=.02&&trades30>=30&&trades30<=5000)profitPassed.push({...candidate,rp7,rp30,rpall,roi30,roiall,trades30});
  }
  console.log(`${chain}: ${profitPassed.length} passed batch P&L gates; fetching individual sample stats`);
  const withStats=await mapLimit(profitPassed,1,async candidate=>{
    const key=`${chain}:${candidate.wallet}:stats`;
    const stats=walletCache[key]??await gmgn("portfolio","stats","--chain",chain,"--wallet",candidate.wallet,"--period","30d");
    if(!walletCache[key]){walletCache[key]=stats;writeFileSync(walletCachePath,JSON.stringify(walletCache));}
    return {...candidate,stats};
  });
  const preliminary:Json[]=[];
  for(const candidate of withStats){
    const stats=candidate.stats,tokenCount=number(stats.pnl_stat?.token_num,0)??0,winrate=number(stats.pnl_stat?.winrate,0)??0;
    const wilson=wilsonLowerBound(Math.round(winrate*tokenCount),tokenCount);
    if(tokenCount>=20&&tokenCount<=300&&winrate>=.4&&wilson>=.35)preliminary.push({...candidate,token_count_30d:tokenCount,winrate_30d:winrate,wilson_30d:wilson});
  }
  console.log(`${chain}: ${preliminary.length} passed profitability/sample gates; checking recent behavior`);
  const checked:Json[]=await mapLimit<Json,Json>(preliminary,1,async candidate=>{
    const key=`${chain}:${candidate.wallet}:activity`;
    const data=walletCache[key]??await gmgn("portfolio","activity","--chain",chain,"--wallet",candidate.wallet,"--limit","100","--type","buy","--type","sell");
    if(!walletCache[key]){walletCache[key]=data;writeFileSync(walletCachePath,JSON.stringify(walletCache));}
    const activity:Json[]=data.activities??[],buys=activity.filter(a=>(a.event_type??a.type)==="buy");
    const unique=new Set(activity.map(a=>a.token?.address).filter(Boolean));
    const sizes=buys.map(a=>number(a.cost_usd,0)??0).sort((a,b)=>a-b);
    const median=sizes.length?(sizes.length%2?sizes[(sizes.length-1)/2]!:(sizes[sizes.length/2-1]!+sizes[sizes.length/2]!)/2):0;
    const behavior_pass=activity.length>0&&unique.size<=60&&median>=50;
    const baseScore=Math.min(Math.max(candidate.rp30/10000,0),1)*18+Math.min(Math.max(candidate.rpall/100000,0),1)*9+Math.min(Math.max(candidate.roi30/.25,0),1)*18+Math.min(Math.max(candidate.roiall/.15,0),1)*9+Math.min(Math.max(candidate.wilson_30d/.60,0),1)*23+Math.min(Math.max(candidate.token_count_30d/100,0),1)*9+(candidate.rp7>=0?4:0),preMoveScore=Math.min((candidate.pre_move_tokens?.length??0)/3,1)*10;
    const score=Math.round(10*Math.min(100,baseScore+preMoveScore))/10;
    return {...candidate,chain,unique_tokens_in_sample:unique.size,median_buy_usd:median,behavior_pass,score,funder:candidate.stats.common?.fund_from_address||null};
  });
  const funderSeen=new Set<string>();
  for(const item of checked.filter(x=>x.behavior_pass).sort((a,b)=>b.score-a.score)){
    const identity=item.funder||`wallet:${item.wallet}`; if(funderSeen.has(identity))continue; funderSeen.add(identity); profiles.push(item);
  }
}

const feedCounts=Object.fromEntries((["gmgn_smartmoney","gmgn_kol","gmgn_followed"] as FeedSource[]).map(source=>[source,feedResults.reduce((sum,result)=>sum+result.feeds.filter(feed=>feed.source===source).reduce((n,feed)=>n+feed.rows.length,0),0)]));
const sortedProfiles=profiles.sort((a,b)=>b.score-a.score);
const report={generated_at:now.toISOString(),definition:{window:"24h",minimum_runner_ath_market_cap_usd:minimumRunnerAthMarketCap,current_market_cap_is_not_a_discovery_floor:true,trader_limit_per_token:100,minimum_trending_trader_roi_percent:minimumTrendingTraderRoiPercent,minimum_runner_appearances:2,pre_move_method:{minimum_kol_wallets:minimumKolPushWallets,candle_resolution:"1m",maximum_entry_lead_seconds:preMoveLeadSeconds,pump_candle_percent:Number(process.env.GMGN_RUNNER_PUMP_CANDLE_PERCENT??20),pump_5m_percent:Number(process.env.GMGN_RUNNER_PUMP_5M_PERCENT??35),pump_volume_ratio:Number(process.env.GMGN_RUNNER_PUMP_VOLUME_RATIO??3)},chains,notes:"GMGN candidates come from >=500% realized-position-ROI traders on trending tokens whose historical-high market cap crossed the configured ATH floor; retraced tokens remain eligible regardless of current market cap. Smart Money, KOL, and personally followed-wallet feeds add candidates. One-hit wonders are excluded: a trending-derived wallet needs at least two runner appearances before the global 30-day P&L, ROI, Wilson win-rate, sample-size, recent-behavior, noisy-wallet, and independent-funder gates. For KOL-backed runners, 1-minute candles identify the first volume-confirmed expansion and first-acquisition time is scored as additional evidence only; it never qualifies a wallet by itself."},counts:{tokens:tokenJobs.length,raw_trader_rows:tokenResults.reduce((n,r)=>n+r.traders.length,0),retraced_below_ath_floor:tokenResults.filter(row=>Number(row.token.market_cap)<minimumRunnerAthMarketCap).length,kol_backed_runners:tokenResults.filter(row=>row.kol_push_wallets>=minimumKolPushWallets).length,detected_runner_moves:tokenResults.filter(row=>row.runner_move).length,pre_move_wallet_positions:tokenResults.reduce((sum,row)=>sum+row.pre_move_wallets.length,0),repeat_pre_move_wallets:sortedProfiles.filter(row=>(row.pre_move_tokens?.length??0)>=2).length,...feedCounts,qualified_wallets:sortedProfiles.length},tokens:tokenResults,tracked_wallets:sortedProfiles,qualified_wallets:sortedProfiles};
writeFileSync(reportPath,JSON.stringify(report,null,2));
const columns=["chain","wallet","score","runner_appearances","profit_7d","profit_30d","profit_all","roi_30d","winrate_30d","wilson_30d","tokens_30d","sample_unique_tokens","median_buy_usd"];
const csv=[columns.join(","),...report.qualified_wallets.map((p:Json)=>[p.chain,p.wallet,p.score,p.tokens.length,p.rp7,p.rp30,p.rpall,p.roi30,p.winrate_30d,p.wilson_30d,p.token_count_30d,p.unique_tokens_in_sample,p.median_buy_usd].join(","))].join("\n");
writeFileSync(summaryPath,csv);
const mongo=await connectMongo(false);if(mongo){try{await new TrackedWalletRepository(mongo).replace("gmgn",report.generated_at,report.tracked_wallets);}finally{await mongo.close();}}
console.log(JSON.stringify({reportPath,summaryPath,counts:report.counts,qualified_by_chain:Object.fromEntries(chains.map(chain=>[chain,profiles.filter(p=>p.chain===chain).length]))},null,2));
