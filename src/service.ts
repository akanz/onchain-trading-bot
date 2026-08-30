import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { configForChain, DATA_ROOT, ROOT } from "./config.js";
import { GmgnClient, isRateLimit } from "./gmgn.js";
import { buildEliteGmgnWalletsFromTokenResults } from "./gmgn-wallet-analysis.js";
import { number, scoreToken, screenTrackedBuyToken } from "./scoring.js";
import { OpenTwitterClient } from "./opentwitter.js";
import { FomoClient, fomoChain, type FomoToken } from "./fomo/client.js";
import { buildEliteFomoWalletsFromInsights } from "./fomo/tracking.js";
import { addressKey, extractContractAddresses, marketSnapshot, passesMarketGate, shouldInvestigate, signalStrength, validTokenAddress, type SignalCandidate, type SignalSource } from "./signals.js";
import { TrackerStore } from "./store.js";
import { buildTokenSnapshot } from "./token-card.js";
import { analyzeTrendingCandles } from "./trending-analysis.js";
import { buildDegenRows } from "./degen.js";
import { PonsClient } from "./pons/client.js";
import { normalizePonsLaunch, ponsKlineChanges, qualifyPonsDegen, selectPonsProbeRows } from "./pons/analysis.js";
import type { Alert, Chain, Json, TokenSnapshot, TrackerConfig } from "./types.js";
import { TrackedWalletRepository, type MongoState } from "./mongo.js";
import { loadTrackedWalletSeeds } from "./tracked-wallet-seeds.js";

const envNumber=(name:string,fallback:number)=>{const value=Number(process.env[name]);return Number.isFinite(value)?value:fallback;};
const finiteNumber=(value:unknown):number|undefined=>{const parsed=Number(value);return Number.isFinite(parsed)?parsed:undefined;};
const timestamp=(row:Json)=>Number(row.timestamp??row.trigger_at??row.created_at??0);
const recent=(row:Json,seconds:number)=>timestamp(row)>0&&timestamp(row)>=Math.floor(Date.now()/1000)-seconds;
const explicitRugEvidence=(snapshot:TokenSnapshot):boolean=>snapshot.honeypot===true||[...(snapshot.verdict?.reasons??[]),...(snapshot.verdict?.warnings??[])].some(value=>{const text=String(value);return !/\b(?:unavailable|unknown)\b/i.test(text)&&/\b(?:honeypot detected|rug(?: pull)? (?:detected|flagged)|scam(?: token)?|cannot sell|can't sell|unsellable|malicious contract)\b/i.test(text);});
async function mapLimit<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>):Promise<R[]>{const output=new Array<R>(items.length);let next=0;async function worker(){while(true){const index=next++;if(index>=items.length)return;output[index]=await fn(items[index]!);}}await Promise.all(Array.from({length:Math.min(Math.max(1,limit),items.length)},worker));return output;}
const mergeDegenRows=(...groups:Json[][]):Json[]=>{const merged=new Map<string,Json>();for(const row of groups.flat()){const key=`${row.chain}:${addressKey(String(row.address??""))}`;if(!row.address||key.endsWith(":"))continue;const current=merged.get(key)??{},sources=[...(current.degen_sources??[])],labels=[...(current.degen_signal_labels??[])],reasons=[...(current.quality_reasons??[])];for(const [field,value] of Object.entries(row))if(value!==undefined&&value!==null&&value!=="")current[field]=value;current.degen_sources=[...new Set([...sources,...(row.degen_sources??[])])];current.degen_signal_labels=[...new Set([...labels,...(row.degen_signal_labels??[])])];current.quality_reasons=[...new Set([...reasons,...(row.quality_reasons??[])])];merged.set(key,current);}return [...merged.values()];};
const trackedWalletSeedPath=join(ROOT,"tracked-wallet-seeds.json");
const trackedWalletSeeds=():Json[]=>{try{return loadTrackedWalletSeeds(trackedWalletSeedPath);}catch(error){console.warn("Could not load tracked-wallet-seeds.json",String(error));return [];}};

export class TrackerService {
  private stores=new Map<Chain,TrackerStore>();
  private running=new Set<Chain>();
  private walletScanAt=new Map<Chain,number>();
  private walletScanCursor=new Map<Chain,number>();
  private twitterScanAt=0;
  private twitterMentions=new Map<string,{accounts:Set<string>;seenAt:number}>();
  private trackedWalletCache:Map<Chain,string[]>|undefined;
  private trackedWalletRowCache:Json[]|undefined;
  private trackedWalletSignature="";
  private mongoTrackedWalletRows:Json[]=[];
  private fomoScanAt=0;
  private fomoTokens=new Map<Chain,FomoToken[]>();
  private fomoActivity=new Map<Chain,Json[]>();
  private fomoActivityRefreshedAt=0;
  private fomoTrackedProfiles=0;
  private fomoProfileErrors=0;
  private trackedBuySafetyStats=new Map<Chain,Json>();
  private ponsScanAt=0;
  private ponsRows:Json[]=[];
  private ponsStats:Json={active:0,graduated:0,qualified:0,refreshed_at:null};
  private trendingRows=new Map<Chain,Json[]>();
  private trendingSeen=new Map<string,{firstSeen:number;lastSeen:number}>();
  private trendingDispatch=new Map<string,{sentAt:number;price?:number;tags:Set<string>}>();
  private degenRows=new Map<Chain,Json[]>();
  constructor(readonly config:TrackerConfig,readonly gmgn=new GmgnClient(),readonly twitter=new OpenTwitterClient(),readonly fomo=new FomoClient(),readonly pons=new PonsClient(),readonly mongo?:MongoState){}
  store(chain:Chain):TrackerStore {let s=this.stores.get(chain);if(!s){s=new TrackerStore(chain,this.mongo);this.stores.set(chain,s);}return s;}
  async init():Promise<void>{await Promise.all(this.config.enabled_chains.map(chain=>this.store(chain).init()));await this.refreshTrackedWalletsFromMongo();}
  async close():Promise<void>{await Promise.all([...this.stores.values()].map(store=>store.close()));}
  roster(chain:Chain){const stored=this.store(chain).roster(),fallback=this.loadTrackedWalletRows().filter(row=>row.chain===chain),combined=new Map<string,Json>();for(const row of [...stored,...fallback])combined.set(`${row.source??"stored"}:${String(row.wallet).toLowerCase()}`,row);return [...combined.values()].sort((a,b)=>Number(b.score??b.fomo_leaderboard_pnl??b.max_position_roi_percent??b.wilson_closed_sample??b.wilson_30d??0)-Number(a.score??a.fomo_leaderboard_pnl??a.max_position_roi_percent??a.wilson_closed_sample??a.wilson_30d??0)).map(row=>({wallet:row.wallet,score:row.score??row.wilson_closed_sample??row.wilson_30d??0,assessed_at:row.generated_at??row.updated_at,source:row.source,tracking_tier:row.tracking_tier??"qualified",fomo_handle:row.fomo_handle,qualifying_positions:row.qualifying_positions??[],max_position_roi_percent:row.max_position_roi_percent,max_realized_position_roi_percent:row.max_realized_position_roi_percent,max_unrealized_position_roi_percent:row.max_unrealized_position_roi_percent,fomo_leaderboard_pnl:row.fomo_leaderboard_pnl}));}
  alerts(chain:Chain,limit=50){return this.store(chain).alerts(limit);}
  latestTrending(chain:Chain,limit=10):Json[]{return (this.trendingRows.get(chain)??[]).slice(0,limit);}
  diagnostics(chains:Chain[]):Json {
    const tracked=this.loadTrackedWallets();
    return Object.fromEntries(chains.map(chain=>{
      const fomoActivity=this.fomoActivity.get(chain)??[],recentFomo=fomoActivity.filter(row=>recent(row,envNumber("SIGNAL_LOOKBACK_SECONDS",1800))),clusters=new Map<string,Set<string>>();
      for(const row of recentFomo){const address=addressKey(String(row.tokenAddress??"")),wallet=addressKey(String(row.wallet??""));if(!address||!wallet)continue;const wallets=clusters.get(address)??new Set<string>();wallets.add(wallet);clusters.set(address,wallets);}
      const trending=this.trendingRows.get(chain)??[],fomoTokens=this.fomoTokens.get(chain)??[];
      const degen=this.degenRows.get(chain)??[];
      return [chain,{gmgn_tracked_wallets:(tracked.get(chain)??[]).length,multiplier_monitor:this.store(chain).callPerformanceSummary(),gmgn_trending_rows:trending.length,gmgn_trending_quality_passed:trending.filter(row=>row.quality_passed===true).length,gmgn_trending_multiwindow_passed:trending.filter(row=>row.multiwindow_passed===true).length,degen_filtered_trending:degen.filter(row=>row.degen_sources?.includes("FILTERED TRENDING")).length,degen_microcaps:degen.filter(row=>row.is_microcap===true).length,degen_surge_events:degen.filter(row=>row.degen_signal_labels?.length).length,...(chain==="robinhood"?{pons_active_launches:this.ponsStats.active,pons_recent_graduated:this.ponsStats.graduated,pons_degen_candidates:this.ponsStats.qualified,pons_refreshed_at:this.ponsStats.refreshed_at}:{}),fomo_discovery_tokens:fomoTokens.length,fomo_trending_tokens:fomoTokens.filter(token=>token.sources.has("fomo_trending")).length,fomo_most_held_tokens:fomoTokens.filter(token=>token.sources.has("fomo_most_held")).length,fomo_eligible_holder_positions:fomoTokens.reduce((sum,token)=>sum+token.holders.length,0),fomo_tracked_profiles:this.fomoTrackedProfiles,fomo_profile_scan_errors:this.fomoProfileErrors,fomo_activity_refreshed_at:this.fomoActivityRefreshedAt?new Date(this.fomoActivityRefreshedAt).toISOString():null,fomo_recent_buy_swaps:recentFomo.length,fomo_recent_buy_wallets:new Set(recentFomo.map(row=>row.wallet).filter(Boolean)).size,fomo_recent_buys:recentFomo.slice(0,10).map(row=>({trader:row.fomo_handle??row.wallet,token:row.tokenAddress,amount_usd:row.amount_usd,bought_at:row.timestamp?new Date(Number(row.timestamp)*1000).toISOString():null})),fomo_tracked_buy_clusters:[...clusters.values()].filter(wallets=>wallets.size>=envNumber("MIN_TRACKED_BUY_WALLETS",3)).length,tracked_buy_safety:this.trackedBuySafetyStats.get(chain)??{checked:0,passed:0,suppressed:0,unavailable:0,recent_suppressed:[]}}];
    }));
  }
  async latestTrendingAcross(chains:Chain[],limit=10):Promise<Json[]> {
    const requireStability=process.env.TRENDING_REQUIRE_MULTIWINDOW_STABILITY!=="false",now=Math.floor(Date.now()/1000),reentry=Math.max(300,envNumber("TRENDING_REENTRY_SECONDS",21600)),cooldown=Math.max(300,envNumber("TRENDING_SIGNAL_COOLDOWN_SECONDS",1800)),minPositive=envNumber("TRENDING_MIN_POSITIVE_CHANGE_PERCENT",0),minGain=Math.max(0,envNumber("TRENDING_REEMIT_MIN_PRICE_GAIN_PERCENT",5))/100,rows:Json[]=chains.flatMap(chain=>(this.trendingRows.get(chain)??[]).map(row=>({...row,chain} as Json))).filter(row=>row.quality_passed===true&&(!requireStability||row.multiwindow_passed===true));
    const selected:Json[]=[];
    for(const row of rows){
      const address=String(row.address??"");if(!address)continue;const key=`${row.chain}:${addressKey(address)}`,seen=this.trendingSeen.get(key),isNew=!seen||now-seen.lastSeen>=reentry,firstSeen=isNew?now:seen.firstSeen;this.trendingSeen.set(key,{firstSeen,lastSeen:now});
      const changes=[row.price_change_5m,row.price_change_percent5m,row.price_change_15m,row.price_change_30m,row.price_change_1h].map(finiteNumber).filter((value):value is number=>value!==undefined),sources=new Set<string>(Array.isArray(row.signal_sources)?row.signal_sources.map(String):[]),tags:string[]=[];
      if(isNew)tags.push("NEW");if(changes.some(change=>change>minPositive))tags.push("PRICE UP");if(Number(row.price_change_5m??row.price_change_percent5m)>=envNumber("MIN_PRICE_SURGE_5M_PERCENT",10)||Number(row.price_change_30m)>=envNumber("TRENDING_30M_PRICE_INCREASE_PERCENT",100)||sources.has("price_surge")||sources.has("trending_momentum"))tags.push("PRICE SURGE");if(sources.has("smart_money_signal")||sources.has("smart_money_wallet")||sources.has("trending_smart_money")||Number(row.smart_degen_count??row.smart_money_count)>0)tags.push("SMART MONEY BUY");
      if(!tags.length)continue;const prior=this.trendingDispatch.get(key),price=finiteNumber(row.price),hasNewTag=isNew||!prior||tags.some(tag=>!prior.tags.has(tag)),meaningfullyHigher=price!==undefined&&prior?.price!==undefined&&price>=prior.price*(1+minGain),reemit=Boolean(prior&&now-prior.sentAt>=cooldown&&meaningfullyHigher&&tags.some(tag=>tag!=="NEW"));if(prior&&!hasNewTag&&!reemit)continue;
      selected.push({...row,trending_signal_tags:tags,trending_first_seen_at:firstSeen,trending_is_new:isNew,trending_dispatch_key:key});
    }
    return selected.sort((a,b)=>Number(b.trending_signal_tags?.includes("SMART MONEY BUY"))-Number(a.trending_signal_tags?.includes("SMART MONEY BUY"))||Number(b.trending_signal_tags?.includes("PRICE SURGE"))-Number(a.trending_signal_tags?.includes("PRICE SURGE"))||Number(b.multiwindow_score??0)-Number(a.multiwindow_score??0)||Number(b.volume_15m??0)-Number(a.volume_15m??0)).slice(0,limit);
  }
  acknowledgeTrending(rows:Json[],sentAt=Math.floor(Date.now()/1000)):void {for(const row of rows){const key=String(row.trending_dispatch_key??`${row.chain}:${addressKey(String(row.address??""))}`),price=finiteNumber(row.price);if(!key||key.endsWith(":"))continue;this.trendingDispatch.set(key,{sentAt,...(price===undefined?{}:{price}),tags:new Set((row.trending_signal_tags??[]).map(String))});}}
  latestDegenAcross(chains:Chain[],limit=20):Json[] {
    const all=chains.flatMap(chain=>this.degenRows.get(chain)??[]),rejected=all.filter(row=>row.degen_sources?.includes("FILTERED TRENDING")),signalOnly=all.filter(row=>!row.degen_sources?.includes("FILTERED TRENDING"));
    const priority=(row:Json)=>row.degen_signal_labels?.includes("PONS PRICE SURGE")||row.degen_signal_labels?.includes("PRICE SURGE")?6:row.degen_signal_labels?.includes("PONS PROGRESS SURGE")?5:row.degen_signal_labels?.includes("NEW ATH")||row.degen_signal_labels?.includes("JUST GRADUATED")?4:row.degen_signal_labels?.includes("NEAR GRADUATION")?3:row.degen_signal_labels?.includes("SMART MONEY")?2:1;
    const rank=(a:Json,b:Json)=>Number(b.is_microcap===true)-Number(a.is_microcap===true)||priority(b)-priority(a)||Number(b.pons_signal_score??0)-Number(a.pons_signal_score??0)||Number(b.price_change_percent5m??b.price_change_percent??-Infinity)-Number(a.price_change_percent5m??a.price_change_percent??-Infinity)||Number(b.volume??0)-Number(a.volume??0);
    const ranked=[...rejected,...signalOnly].sort(rank),capped=Math.max(0,limit),robinhood=ranked.filter(row=>row.chain==="robinhood"),target=Math.min(robinhood.length,Math.ceil(capped*Math.min(1,Math.max(0,envNumber("DEGEN_ROBINHOOD_MIN_SHARE",0.75))))),selected=robinhood.slice(0,target),rowKey=(row:Json)=>`${row.chain}:${addressKey(String(row.address))}`,keys=new Set(selected.map(rowKey));
    for(const row of ranked)if(selected.length<capped&&!keys.has(rowKey(row))){selected.push(row);keys.add(rowKey(row));}
    return selected.sort(rank).slice(0,capped);
  }
  async enrichDegenRows(rows:Json[]):Promise<Json[]> {
    const limit=envNumber("PONS_CARD_ENRICH_LIMIT",20),holderLimit=envNumber("PONS_CARD_HOLDER_LIMIT",5),output=rows.map(row=>({...row})),targets=output.filter(row=>this.config.enabled_chains.includes(row.chain)&&validTokenAddress(row.chain,String(row.address))).slice(0,Math.max(0,limit));
    for(const row of targets){
      try {
        const chain=row.chain as Chain,address=String(row.address),[info,security,pool,holders]=await Promise.all([this.gmgn.tokenInfo(chain,address),this.gmgn.tokenSecurity(chain,address),this.gmgn.tokenPool(chain,address),this.gmgn.tokenHolders(chain,address,holderLimit)]),safety=screenTrackedBuyToken(info,security,pool,configForChain(this.config,chain).token),current=finiteNumber(info.price?.price),circulating=finiteNumber(info.circulating_supply),total=finiteNumber(info.max_supply??info.total_supply),athPrice=finiteNumber(info.ath_price),createdAt=finiteNumber(info.pool?.creation_timestamp??info.open_timestamp??info.creation_timestamp),price1h=finiteNumber(info.price?.price_1h);
        const marketCap=current!==undefined&&circulating!==undefined?current*circulating:finiteNumber(row.market_cap),fdv=current!==undefined&&total!==undefined?current*total:finiteNumber(row.market_cap),athMarketCap=athPrice!==undefined&&circulating!==undefined?athPrice*circulating:undefined;
        Object.assign(row,{safety_passed:safety.passed,safety_reasons:safety.reasons,name:info.name??row.name,symbol:info.symbol??row.symbol,price:current??row.price,market_cap:marketCap,fdv,ath_market_cap:athMarketCap,liquidity:finiteNumber(pool.liquidity??info.liquidity??info.pool?.liquidity)??row.liquidity,price_change_1h:current!==undefined&&price1h!==undefined&&price1h>0?(current/price1h-1)*100:undefined,volume_1h:finiteNumber(info.price?.volume_1h),volume_24h:finiteNumber(info.price?.volume_24h),buys_1h:finiteNumber(info.price?.buys_1h),sells_1h:finiteNumber(info.price?.sells_1h),holder_count:finiteNumber(info.holder_count??info.stat?.holder_count),top_10_holder_rate:finiteNumber(info.stat?.top_10_holder_rate??info.dev?.top_10_holder_rate),fresh_wallet_rate:finiteNumber(info.stat?.fresh_wallet_rate),smart_wallets:finiteNumber(info.wallet_tags_stat?.smart_wallets),pool_address:info.biggest_pool_address??info.pool?.pool_address??row.pool,exchange:info.pool?.exchange,token_age_seconds:createdAt?Math.max(0,Math.floor(Date.now()/1000-createdAt)):row.launch_age_seconds,logo:info.logo,website:info.link?.website,twitter_username:info.link?.twitter_username,telegram:info.link?.telegram,gmgn_url:info.link?.gmgn,top_holders:holders.map(holder=>({address:holder.address,amount_percentage:finiteNumber(holder.amount_percentage),usd_value:finiteNumber(holder.usd_value),tags:Array.isArray(holder.tags)?holder.tags.slice(0,3):[]})).filter(holder=>validTokenAddress(chain,String(holder.address))).slice(0,holderLimit)});
      } catch(error) {
        row.safety_passed=false;row.safety_reasons=[`GMGN safety checks unavailable: ${String(error)}`];
        if(isRateLimit(error)){console.warn("Degen safety enrichment stopped because GMGN entered cooldown",String(error));break;}
        console.warn(`Degen safety enrichment unavailable for ${row.address}`,String(error));
      }
    }
    return output.filter(row=>row.safety_passed===true);
  }
  async monitorCallMultiples(chains:Chain[],displayedRows:Json[],now=Math.floor(Date.now()/1000),triggered?:Map<Chain,Set<string>>):Promise<Alert[]> {
    if(process.env.MULTIPLE_MONITOR_ENABLED==="false")return [];
    const windowSeconds=envNumber("MULTIPLE_MONITOR_WINDOW_SECONDS",7200),maxActive=envNumber("MULTIPLE_MONITOR_MAX_ACTIVE_PER_CHAIN",200),rearmSeconds=envNumber("MULTIPLE_MONITOR_REARM_SECONDS",86400),minMilestone=Math.max(2,Math.floor(envNumber("MULTIPLE_MONITOR_MIN_MILESTONE",2))),visible=new Map<string,Json>();
    for(const row of displayedRows){const chain=row.chain as Chain,address=String(row.address??"");if(!chains.includes(chain)||!validTokenAddress(chain,address))continue;const key=`${chain}:${addressKey(address)}`,current=visible.get(key);if(!current||(!finiteNumber(current.price)&&finiteNumber(row.price)))visible.set(key,row);}
    const output:Alert[]=[];
    for(const chain of chains){
      const store=this.store(chain),active=store.activeCallPerformance(now,maxActive).filter(row=>!triggered||triggered.get(chain)?.has(addressKey(String(row.token))));
      for(const baseline of active){
        const address=String(baseline.token),key=`${chain}:${addressKey(address)}`,row=visible.get(key);let currentPrice=finiteNumber(row?.price),currentMarketCap=finiteNumber(row?.market_cap),symbol=String(row?.symbol??baseline.symbol??"")||undefined,knownInfo:Json|undefined;
        if(currentPrice===undefined||triggered)try{const info=await this.gmgn.tokenInfo(chain,address);knownInfo=info;const price=finiteNumber(info.price?.price),supply=finiteNumber(info.circulating_supply);currentPrice=price;if(price!==undefined&&supply!==undefined)currentMarketCap=price*supply;if(!symbol)symbol=String(info.symbol??"")||undefined;}catch(error){if(isRateLimit(error)){console.warn("2h multiplier monitoring stopped because GMGN entered cooldown",String(error));break;}console.warn(`${chain}: multiplier price unavailable for ${address}`,String(error));continue;}
        if(currentPrice===undefined||currentPrice<=0)continue;
        const multiple=currentPrice/Number(baseline.baseline_price);store.updateCallPerformance(address,currentPrice,multiple);const milestone=Math.floor(multiple),lastAlerted=Number(baseline.last_alerted_multiple??1);
        if(milestone<minMilestone||milestone<=lastAlerted)continue;
        const alert:Alert={tier:"RESEARCH",kind:"MULTIPLE",chain,address,...(symbol?{symbol}:{}),milestone,multiple,baseline_price:Number(baseline.baseline_price),current_price:currentPrice,baseline_market_cap:finiteNumber(baseline.baseline_market_cap),current_market_cap:currentMarketCap,first_seen:Number(baseline.first_seen),expires_at:Number(baseline.expires_at),age_seconds:Math.max(0,now-Number(baseline.first_seen)),source:baseline.source};
        try{const snapshot=await this.evaluateToken(chain,address,knownInfo);if(explicitRugEvidence(snapshot))continue;alert.token_snapshot=snapshot;alert.token_score=snapshot.verdict.score;alert.token_passed=snapshot.verdict.passed;alert.token_warnings=snapshot.verdict.warnings;}catch(error){if(isRateLimit(error))console.warn("Milestone safety re-scan stopped because GMGN entered cooldown",String(error));else console.warn(`${chain}: milestone safety re-scan unavailable for ${address}`,String(error));continue;}
        output.push(alert);
      }
      const candidates=[...visible.values()].filter(row=>row.chain===chain).sort((a,b)=>Number(b.pons_signal_score??b.multiwindow_score??0)-Number(a.pons_signal_score??a.multiwindow_score??0));
      for(const row of candidates){const price=finiteNumber(row.price);if(price===undefined||price<=0)continue;const source=row.pons_status?"PONS DEGEN":row.degen_sources?"DEGEN":"TRENDING";store.trackCall(String(row.address),String(row.symbol??"")||undefined,source,price,finiteNumber(row.market_cap),now,windowSeconds,maxActive,rearmSeconds);}
    }
    return output;
  }
  async monitorTriggeredCallMultiples(chains:Chain[],now=Math.floor(Date.now()/1000)):Promise<Alert[]> {
    if(process.env.MULTIPLE_MONITOR_ENABLED==="false")return [];
    const triggered=new Map<Chain,Set<string>>();
    for(const chain of chains){const active=this.store(chain).activeCallPerformance(now,envNumber("MULTIPLE_MONITOR_MAX_ACTIVE_PER_CHAIN",200));if(!active.length)continue;const activeByKey=new Map(active.map(row=>[addressKey(String(row.token)),row]));try{for(const signal of await this.gmgn.marketSignals(chain)){const address=String(signal.token_address??signal.address??signal.data?.address??""),key=addressKey(address),baseline=activeByKey.get(key);if(!baseline||!validTokenAddress(chain,address))continue;const currentMc=finiteNumber(signal.market_cap),baselineMc=finiteNumber(baseline.baseline_market_cap),nextMilestone=Math.max(2,Number(baseline.last_alerted_multiple??1)+1);if(currentMc!==undefined&&baselineMc!==undefined&&baselineMc>0&&currentMc<baselineMc*nextMilestone*.98)continue;const set=triggered.get(chain)??new Set<string>();set.add(key);triggered.set(chain,set);}}catch(error){if(isRateLimit(error))throw error;console.warn(`${chain}: real-time multiplier trigger feed unavailable`,String(error));}}
    if(!triggered.size)return [];
    return this.monitorCallMultiples(chains,[],now,triggered);
  }
  acknowledgeCallMultiple(alert:Alert):void {if(alert.kind!=="MULTIPLE")return;const milestone=Number(alert.milestone);this.store(alert.chain).acknowledgeCallMultiple(alert.address,milestone);this.store(alert.chain).saveAlert(alert,Number(alert.first_seen)*100+milestone);}

  private async resolveTokenLocations(address:string):Promise<Array<{chain:Chain;info?:Json}>> {
    if(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)){if(!this.config.enabled_chains.includes("sol"))throw new Error("This looks like a Solana address, but Solana is disabled");return [{chain:"sol"}];}
    if(!/^0x[0-9a-fA-F]{40}$/.test(address))throw new Error("Invalid contract address format");
    const evm=this.config.enabled_chains.filter(chain=>chain!=="sol");
    const probes=await Promise.allSettled(evm.map(async chain=>({chain,info:await this.gmgn.tokenInfo(chain,address)})));
    const limited=probes.find(result=>result.status==="rejected"&&isRateLimit(result.reason));
    if(limited?.status==="rejected")throw limited.reason;
    const found=probes.flatMap(result=>{if(result.status!=="fulfilled")return [];const {chain,info}=result.value;const exists=Boolean(info.symbol||info.name||info.standard||info.biggest_pool_address||info.pool?.pool_address||info.price?.address);return exists?[{chain,info}]:[];});
    if(!found.length)throw new Error("GMGN could not find that contract on any enabled chain");return found;
  }
  async resolveTokenChains(address:string):Promise<Chain[]>{return (await this.resolveTokenLocations(address)).map(item=>item.chain);}
  async evaluateAddress(address:string){const locations=await this.resolveTokenLocations(address);return Promise.all(locations.map(({chain,info})=>this.evaluateToken(chain,address,info)));}
  private async tokenHolders(chain:Chain,address:string):Promise<Json[]>{try{return await this.gmgn.tokenHolders(chain,address,5);}catch(error){if(isRateLimit(error))throw error;console.warn(`${chain}: GMGN top holders unavailable for ${address}`,String(error));return [];}}
  async evaluateToken(chain:Chain,address:string,knownInfo?:Json):Promise<TokenSnapshot>{const cfg=configForChain(this.config,chain);const [info,security,pool,holders]=await Promise.all([knownInfo??this.gmgn.tokenInfo(chain,address),this.gmgn.tokenSecurity(chain,address),this.gmgn.tokenPool(chain,address),this.tokenHolders(chain,address)]);const verdict=scoreToken(info,security,pool,{median_entry_price_usd:number(info.price?.price,null),max_price_chase_ratio:cfg.cluster.max_price_chase_ratio},cfg.token);return buildTokenSnapshot(chain,address,info,security,pool,holders,verdict);}

  private catalysts(cfg:Json):Json {const path=join(ROOT,cfg.catalysts_file??"catalysts.json");if(!existsSync(path))return {};const now=Date.now()/1000,data=JSON.parse(readFileSync(path,"utf8"));return Object.fromEntries(Object.entries(data).filter(([,v]:any)=>!v.expires_at||v.expires_at>now));}
  private candidate(map:Map<string,SignalCandidate>,chain:Chain,address:string,symbol?:string):SignalCandidate {const key=addressKey(address);let item=map.get(key);if(!item){item={chain,address,...(symbol?{symbol}:{}),sources:new Set(),sourceIds:new Set(),wallets:new Set(),buyWallets:new Set(),traderLabels:new Set(),twitterAccounts:new Set(),firstTimestamp:Math.floor(Date.now()/1000),aggregateBuyUsd:0};map.set(key,item);}if(symbol&&!item.symbol)item.symbol=symbol;return item;}
  private addEvent(map:Map<string,SignalCandidate>,chain:Chain,row:Json,source:SignalSource):void {const address=String(row.base_address??row.token_address??row.token?.address??row.address??"");if(!validTokenAddress(chain,address)||!recent(row,envNumber("SIGNAL_LOOKBACK_SECONDS",1800)))return;const item=this.candidate(map,chain,address,row.base_token?.symbol??row.token?.symbol??row.symbol);item.sources.add(source);const wallet=addressKey(String(row.maker??row.wallet??row.wallet_address??""));if(wallet){item.wallets.add(wallet);item.buyWallets.add(wallet);item.traderLabels?.add(String(row.fomo_handle??row.trader_label??wallet));}const observedMarketCap=finiteNumber(row.market_cap??row.marketCap??row.token?.market_cap??row.token?.marketCap);if(observedMarketCap!==undefined&&observedMarketCap>0){item.observedMarketCap??=observedMarketCap;item.marketCapObservedAt??=timestamp(row)||Math.floor(Date.now()/1000);}const id=String(row.transaction_hash??row.tx_hash??row.id??"");if(id)item.sourceIds.add(id);item.aggregateBuyUsd+=Number(row.amount_usd??row.cost_usd??0)||0;const ts=timestamp(row);if(ts)item.firstTimestamp=Math.min(item.firstTimestamp,ts);}

  private loadTrackedWalletRows():Json[] {
    const dir=join(DATA_ROOT,"reports"),fomoPath=join(DATA_ROOT,"fomo","data","qualified-wallets.json"),files=existsSync(dir)?readdirSync(dir):[];
    const gmgnFile=files.filter(name=>/^daily-wallet-scan-.*\.json$/.test(name)&&!name.includes("cache")).sort().reverse().at(0),fomoFile=files.filter(name=>/^fomo-wallet-scan-.*\.json$/.test(name)).sort().reverse().at(0),gmgnPath=gmgnFile?join(dir,gmgnFile):undefined,fomoReportPath=fomoFile?join(dir,fomoFile):undefined;
    const paths=[gmgnPath,fomoReportPath,fomoPath,trackedWalletSeedPath].filter((path):path is string=>path!==undefined&&existsSync(path));
    const signature=`mongo:${this.mongoTrackedWalletRows.length}:${this.mongoTrackedWalletRows.map(row=>String(row.updated_at??row.generated_at??"")).sort().at(-1)??""}:`+paths.map(path=>`${path}:${statSync(path).mtimeMs}`).join("|");
    if(this.trackedWalletRowCache&&signature===this.trackedWalletSignature)return this.trackedWalletRowCache;
    const rows:Json[]=[];
    const addReport=(path:string|undefined,source:"gmgn"|"fomo")=>{if(!path)return;try{const report=JSON.parse(readFileSync(path,"utf8")),tracked:Json[]|undefined=report.tracked_wallets,selected:Json[]=tracked??report.qualified_wallets??[];for(const row of selected)rows.push({...row,source:row.source??source,tracking_tier:row.tracking_tier??(source==="gmgn"||!tracked?"qualified":undefined)});if(source==="fomo"&&report.profile_insights)rows.push(...buildEliteFomoWalletsFromInsights(report.profile_insights,this.config.enabled_chains));if(source==="gmgn"&&report.tokens)rows.push(...buildEliteGmgnWalletsFromTokenResults(report.tokens));}catch(error){console.warn(`Could not load ${source.toUpperCase()} tracked-wallet report`,String(error));}};
    addReport(gmgnPath,"gmgn");addReport(fomoReportPath,"fomo");addReport(fomoPath,"fomo");rows.push(...trackedWalletSeeds(),...this.mongoTrackedWalletRows);
    const normalizeTier=(input:Json):Json=>{const inferred=input.tracking_tier??(input.verification_source||input.roi30!==undefined||input.roi_closed_sample!==undefined?"qualified":undefined),row=inferred===input.tracking_tier?input:{...input,tracking_tier:inferred};if(row.tracking_tier!=="qualified")return row;const roi30=finiteNumber(row.roi30??row.roi_closed_sample),roiAll=finiteNumber(row.roiall??row.roi_all),minimum30=Number(this.config.wallet.min_roi_30d??2),minimumAll=Number(this.config.wallet.min_roi_all??2),verified=row.verification_source;if(verified==="fomo_native"&&roi30!==undefined&&roi30<minimum30)return {...row,tracking_tier:"observed"};if(verified!=="fomo_native"&&roi30!==undefined&&roiAll!==undefined&&(roi30<minimum30||roiAll<minimumAll))return {...row,tracking_tier:"observed"};return row;},eligible=(row:Json)=>row.tracking_tier===undefined||row.tracking_tier==="qualified"||row.tracking_tier==="elite_observed",priority=(row:Json)=>row.tracking_tier==="qualified"?3:row.tracking_tier==="elite_observed"?2:1,deduped=new Map<string,Json>();
    for(const original of rows){const row=normalizeTier(original),chain=row.chain as Chain,wallet=String(row.wallet??"");if(!this.config.enabled_chains.includes(chain)||!wallet||!eligible(row))continue;const key=`${row.source??"generated"}:${chain}:${wallet.toLowerCase()}`,current=deduped.get(key);if(!current||priority(row)>priority(current))deduped.set(key,row);}
    this.trackedWalletSignature=signature;this.trackedWalletCache=undefined;return this.trackedWalletRowCache=[...deduped.values()].sort((a,b)=>priority(b)-priority(a)||Number(b.score??b.fomo_leaderboard_pnl??b.max_position_roi_percent??0)-Number(a.score??a.fomo_leaderboard_pnl??a.max_position_roi_percent??0));
  }
  private loadTrackedWallets():Map<Chain,string[]> {
    const rows=this.loadTrackedWalletRows();
    if(this.trackedWalletCache)return this.trackedWalletCache;
    const output=new Map<Chain,string[]>();for(const row of rows){const chain=row.chain as Chain,wallet=String(row.wallet);if(!output.get(chain)?.some(value=>addressKey(value)===addressKey(wallet)))output.set(chain,[...(output.get(chain)??[]),wallet]);}
    return this.trackedWalletCache=output;
  }
  invalidateTrackedWalletCache():void {this.trackedWalletCache=undefined;this.trackedWalletRowCache=undefined;this.trackedWalletSignature="";}
  async refreshTrackedWalletsFromMongo():Promise<void>{if(this.mongo)this.mongoTrackedWalletRows=await new TrackedWalletRepository(this.mongo).loadAll();this.invalidateTrackedWalletCache();}
  private async collectWalletSignals(chain:Chain,map:Map<string,SignalCandidate>):Promise<void> {
    const every=envNumber("TRACKED_WALLET_SCAN_EVERY_MS",300000),now=Date.now();if(now-(this.walletScanAt.get(chain)??0)<every)return;this.walletScanAt.set(chain,now);
    const qualifiedWallets=this.loadTrackedWallets().get(chain)??[],qualified=new Set(qualifiedWallets.map(addressKey));
    try {for(const row of await this.gmgn.followedWallets(chain,100))if(qualified.has(addressKey(String(row.maker??""))))this.addEvent(map,chain,row,"followed_wallet");}catch(error){if(isRateLimit(error))throw error;console.warn(`${chain}: GMGN followed-wallet feed unavailable`,String(error));}
    if(process.env.DISABLE_TRACKED_WALLET_FALLBACK==="true")return;
    const limit=Math.max(0,Math.floor(envNumber("TRACKED_WALLET_FALLBACK_LIMIT",25))),start=qualifiedWallets.length?(this.walletScanCursor.get(chain)??0)%qualifiedWallets.length:0,batch=rotatingSlice(qualifiedWallets,start,limit);
    if(qualifiedWallets.length)this.walletScanCursor.set(chain,(start+batch.length)%qualifiedWallets.length);
    for(const wallet of batch){try{for(const row of await this.gmgn.walletActivity(chain,wallet,20))if(row.event_type==="buy")this.addEvent(map,chain,{...row,wallet},"tracked_wallet");}catch(error){if(isRateLimit(error))throw error;console.warn(`${chain}: could not scan tracked wallet ${wallet}`,String(error));}}
  }
  private async refreshTwitter():Promise<void> {
    if(!this.twitter.enabled)return;const every=envNumber("TWITTER_SCAN_EVERY_MS",120000),now=Date.now();if(now-this.twitterScanAt<every)return;this.twitterScanAt=now;
    const accounts=(process.env.TWITTER_ACCOUNTS??"elonmusk,WhiteHouse,realDonaldTrump,cz_binance").split(",").map(x=>x.trim().replace(/^@/,"")).filter(Boolean);const cutoff=Math.floor(now/1000)-envNumber("TWITTER_LOOKBACK_SECONDS",3600);
    for(const [address,mention] of this.twitterMentions)if(mention.seenAt<cutoff)this.twitterMentions.delete(address);
    for(const account of accounts){try{for(const tweet of await this.twitter.userTweets(account,10)){const ts=Number(tweet.timestamp??tweet.created_at_timestamp??Date.parse(tweet.created_at??"")/1000)||Math.floor(now/1000);if(ts<cutoff)continue;const text=String(tweet.text??tweet.full_text??tweet.content??"");for(const address of extractContractAddresses(text)){const key=addressKey(address),mention=this.twitterMentions.get(key)??{accounts:new Set<string>(),seenAt:ts};mention.accounts.add(account);mention.seenAt=Math.max(mention.seenAt,ts);this.twitterMentions.set(key,mention);}}}catch(error){console.warn(`OpenTwitter scan failed for @${account}`,String(error));}}
  }
  private attachTwitter(map:Map<string,SignalCandidate>):void {for(const [key,item] of map){const mention=this.twitterMentions.get(key);if(!mention)continue;item.sources.add("twitter");for(const account of mention.accounts)item.twitterAccounts.add(account);}}
  private async refreshFomo():Promise<void>{
    if(!this.fomo.enabled)return;const every=envNumber("FOMO_SCAN_EVERY_MS",300000),now=Date.now();if(now-this.fomoScanAt<every)return;this.fomoScanAt=now;
    try {const tokens=await this.fomo.discover();this.fomoTokens.clear();for(const token of tokens)this.fomoTokens.set(token.chain,[...(this.fomoTokens.get(token.chain)??[]),token]);}catch(error){console.warn("Fomo discovery scan failed",String(error));}
    try {const rows=this.loadTrackedWalletRows().filter(row=>row.source==="fomo"&&row.fomo_user_id),walletByProfileChain=new Map(rows.map(row=>[`${row.fomo_user_id}:${row.chain}`,row.wallet])),profiles=[...new Map(rows.map(row=>[String(row.fomo_user_id),row])).values()].slice(0,envNumber("FOMO_TRACKED_PROFILES",1000)),activity:Json[]=[];if(!profiles.length)return;this.fomoTrackedProfiles=profiles.length;let successful=0,failed=0;await mapLimit(profiles,envNumber("FOMO_ACTIVITY_CONCURRENCY",4),async profile=>{try{const data=await this.fomo.userSwaps(String(profile.fomo_user_id));successful++;for(const swap of data.swaps??[]){if(!swap.outTradeId)continue;const chain=fomoChain(swap.outNetworkId??swap.networkId),wallet=walletByProfileChain.get(`${profile.fomo_user_id}:${chain}`),created=Math.floor(Date.parse(swap.createdAt??0)/1000),tokenAddress=String(swap.outTokenAddress??"");if(chain&&wallet&&validTokenAddress(chain,tokenAddress)&&created>=Math.floor(now/1000)-envNumber("SIGNAL_LOOKBACK_SECONDS",1800))activity.push({...swap,chain,wallet,tokenAddress,timestamp:created,amount_usd:Number(swap.humanUsdAmountIn??swap.humanUsdAmountOut??0),fomo_handle:profile.fomo_handle??profile.userHandle,discovery_sources:profile.discovery_sources??[]});}}catch(error){failed++;console.warn(`Fomo activity unavailable for ${profile.fomo_handle??profile.fomo_user_id}`,String(error));}});this.fomoProfileErrors=failed;if(successful){this.fomoActivity.clear();for(const row of activity)this.fomoActivity.set(row.chain,[...(this.fomoActivity.get(row.chain)??[]),row]);this.fomoActivityRefreshedAt=Date.now();}}catch(error){console.warn("Fomo tracked-wallet activity scan failed",String(error));}
  }
  private attachFomo(chain:Chain,map:Map<string,SignalCandidate>):void{
    const cfg=configForChain(this.config,chain);
    for(const token of this.fomoTokens.get(chain)??[]){const liquidity=Number(token.liquidity??0),marketCap=Number(token.marketCap??0),volume24=Number(token.volume24??0);if(!token.holders.length||liquidity<cfg.token.min_liquidity_usd||marketCap<cfg.token.min_market_cap_usd||marketCap>cfg.token.max_market_cap_usd||volume24<envNumber("FOMO_MIN_VOLUME_24H_USD",50000))continue;const item=this.candidate(map,chain,token.address,token.token?.symbol);for(const source of token.sources)item.sources.add(source);item.sources.add("fomo_holder");for(const holder of token.holders)item.wallets.add(holder.wallet);if(!item.market)item.market={address:token.address,symbol:token.token?.symbol,market_cap:marketCap,liquidity,volume_24h:volume24,price_change_24h:Number(token.change24??0)*100};}
    for(const trade of this.fomoActivity.get(chain)??[]){if(!recent(trade,envNumber("SIGNAL_LOOKBACK_SECONDS",1800)))continue;const item=this.candidate(map,chain,String(trade.tokenAddress)),wallet=addressKey(String(trade.wallet));item.sources.add("fomo_tracked_wallet");for(const source of trade.discovery_sources??[]){if(String(source).startsWith("fomo_leaderboard"))item.sources.add("fomo_leaderboard");if(String(source).startsWith("fomo_most_held"))item.sources.add("fomo_most_held");if(String(source).startsWith("fomo_trending"))item.sources.add("fomo_trending");}item.wallets.add(wallet);item.buyWallets.add(wallet);item.traderLabels?.add(String(trade.fomo_handle??wallet));item.aggregateBuyUsd+=Number(trade.amount_usd??0);item.firstTimestamp=Math.min(item.firstTimestamp,Number(trade.timestamp));}
  }

  private async enrichTrackedBuyCandidates(chain:Chain,candidates:Map<string,SignalCandidate>):Promise<void>{
    const tracked=[...candidates.values()].filter(candidate=>candidate.buyWallets.size),concurrency=Math.max(1,Math.floor(envNumber("TRACKED_BUY_ENRICH_CONCURRENCY",3))),stats:Json={checked:0,passed:0,suppressed:0,unavailable:0,recent_suppressed:[]};let cooling=false;
    await mapLimit(tracked,concurrency,async candidate=>{
      const fromMarket=finiteNumber(candidate.market?.market_cap);if(candidate.observedMarketCap===undefined&&fromMarket!==undefined&&fromMarket>0){candidate.observedMarketCap=fromMarket;candidate.marketCapObservedAt=Math.floor(Date.now()/1000);}
      if(cooling){candidate.trackedBuySafety={passed:false,reasons:["FAIL GMGN safety checks unavailable during cooldown"],warnings:[]};stats.unavailable++;stats.suppressed++;return;}
      try {
        const [info,security,pool]=await Promise.all([this.gmgn.tokenInfo(chain,candidate.address),this.gmgn.tokenSecurity(chain,candidate.address),this.gmgn.tokenPool(chain,candidate.address)]),price=finiteNumber(info.price?.price),circulating=finiteNumber(info.circulating_supply??info.total_supply),marketCap=price!==undefined&&circulating!==undefined?price*circulating:finiteNumber(info.market_cap??info.price?.market_cap),liquidity=finiteNumber(pool.liquidity??info.liquidity??info.pool?.liquidity),safety=screenTrackedBuyToken(info,security,pool,configForChain(this.config,chain).token);
        candidate.tokenInfo=info;candidate.tokenSecurity=security;candidate.tokenPool=pool;candidate.trackedBuySafety=safety;if(!candidate.symbol&&info.symbol)candidate.symbol=String(info.symbol);if(candidate.observedMarketCap===undefined&&marketCap!==undefined&&marketCap>0){candidate.observedMarketCap=marketCap;candidate.marketCapObservedAt=Math.floor(Date.now()/1000);}candidate.market={...(candidate.market??{}),address:candidate.address,symbol:candidate.symbol,market_cap:candidate.observedMarketCap,liquidity,holder_count:finiteNumber(info.holder_count??info.stat?.holder_count),top_10_holder_rate:finiteNumber(info.stat?.top_10_holder_rate??info.dev?.top_10_holder_rate)};
        stats.checked++;if(safety.passed)stats.passed++;else{const top10=finiteNumber(security.top_10_holder_rate??info.stat?.top_10_holder_rate??info.dev?.top_10_holder_rate);stats.suppressed++;stats.recent_suppressed.push({address:candidate.address,symbol:candidate.symbol,name:info.name,traders:[...(candidate.traderLabels??[])],wallets:[...candidate.buyWallets],wallet_count:candidate.buyWallets.size,aggregate_buy_usd:Math.round(candidate.aggregateBuyUsd*100)/100,bought_at:candidate.firstTimestamp,price,market_cap:marketCap,liquidity,liquidity_to_market_cap_ratio:liquidity!==undefined&&marketCap!==undefined&&marketCap>0?liquidity/marketCap:undefined,holder_count:finiteNumber(info.holder_count??info.stat?.holder_count),top_10_holder_rate:top10,smart_wallets:finiteNumber(info.wallet_tags_stat?.smart_wallets),renowned_wallets:finiteNumber(info.wallet_tags_stat?.renowned_wallets),fresh_wallet_rate:finiteNumber(info.stat?.fresh_wallet_rate),volume_1h:finiteNumber(info.price?.volume_1h),volume_24h:finiteNumber(info.price?.volume_24h),buys_1h:finiteNumber(info.price?.buys_1h),sells_1h:finiteNumber(info.price?.sells_1h),honeypot:security.is_honeypot??security.honeypot,blacklist:security.is_blacklist??security.blacklist,cannot_sell:security.can_not_sell,open_source:security.is_open_source??security.open_source,renounced:security.is_renounced??security.owner_renounced??security.renounced,liquidity_locked:security.lock_summary?.is_locked,buy_tax:finiteNumber(security.buy_tax),sell_tax:finiteNumber(security.sell_tax),dex:pool.exchange??info.pool?.exchange,pool_address:pool.address??pool.pool_address??info.biggest_pool_address??info.pool?.pool_address,creator:info.dev?.creator_address,gmgn_url:info.link?.gmgn,reasons:safety.reasons.filter((reason:string)=>reason.startsWith("FAIL ")).slice(0,8)});}
      } catch(error) {
        if(isRateLimit(error))cooling=true;else console.warn(`${chain}: tracked-buy safety lookup unavailable for ${candidate.address}`,String(error));
        candidate.trackedBuySafety={passed:false,reasons:[`FAIL GMGN safety checks unavailable: ${String(error)}`],warnings:[]};stats.unavailable++;stats.suppressed++;stats.recent_suppressed.push({address:candidate.address,symbol:candidate.symbol,traders:[...(candidate.traderLabels??[])],wallets:[...candidate.buyWallets],wallet_count:candidate.buyWallets.size,aggregate_buy_usd:Math.round(candidate.aggregateBuyUsd*100)/100,bought_at:candidate.firstTimestamp,reasons:["GMGN safety checks unavailable"]});
      }
    });
    stats.recent_suppressed=stats.recent_suppressed.slice(0,10);this.trackedBuySafetyStats.set(chain,stats);
  }

  private async refreshPons():Promise<void> {
    if(!this.pons.enabled)return;
    const every=envNumber("PONS_SCAN_EVERY_MS",300000),now=Date.now();
    if(now-this.ponsScanAt<every)return;
    this.ponsScanAt=now;
    try {
      const snapshot=await this.pons.launches(),nowSeconds=Math.floor(now/1000),store=this.store("robinhood"),normalized=[...snapshot.active,...snapshot.graduated].map(row=>normalizePonsLaunch(row,nowSeconds)).filter((row):row is Json=>Boolean(row));
      const probes=selectPonsProbeRows(snapshot.active,snapshot.graduated,envNumber("PONS_GMGN_PROBE_LIMIT",12),nowSeconds),probeKeys=new Set(probes.map(row=>addressKey(String(row.address)))),qualified:Json[]=[];
      for(const row of normalized){
        const key=addressKey(String(row.address)),price=Number(row.price),progress=Number(row.graduation_progress_percent),changes:{price_change_5m?:number|undefined;price_change_30m?:number|undefined;progress_change_30m?:number|undefined}={};
        if(Number.isFinite(price)&&price>0){changes.price_change_5m=store.trendingPriceChange(`pons:${key}`,price,300,nowSeconds);changes.price_change_30m=store.trendingPriceChange(`pons:${key}`,price,1800,nowSeconds);}
        if(Number.isFinite(progress))changes.progress_change_30m=store.metricDelta(key,"pons_graduation_progress",progress,1800,nowSeconds);
        if(probeKeys.has(key)&&(changes.price_change_5m===undefined||changes.price_change_30m===undefined))try{const kline=ponsKlineChanges(await this.gmgn.kline("robinhood",String(row.address),1900,"5m"));changes.price_change_5m??=kline.price_change_5m;changes.price_change_30m??=kline.price_change_30m;}catch(error){if(isRateLimit(error))throw error;console.warn(`Pons: GMGN price confirmation unavailable for ${row.address}`,String(error));}
        const signal=qualifyPonsDegen(row,changes);if(signal)qualified.push(signal);
        if(Number.isFinite(price)&&price>0)store.recordTrendingPrice(`pons:${key}`,price,nowSeconds);
        if(Number.isFinite(progress))store.recordMetric(key,"pons_graduation_progress",progress,nowSeconds);
      }
      this.ponsRows=qualified;
      this.ponsStats={active:snapshot.active.length,graduated:snapshot.graduated.length,qualified:qualified.length,refreshed_at:new Date(now).toISOString()};
    } catch(error) {
      if(isRateLimit(error))throw error;
      console.warn("Pons Robinhood discovery scan failed",String(error));
    }
  }

  private async collectCandidates(chain:Chain,limit:number):Promise<Map<string,SignalCandidate>> {
    const cfg=configForChain(this.config,chain),map=new Map<string,SignalCandidate>(),store=this.store(chain);
    const supportsPublicFeeds=["sol","bsc","base","eth"].includes(chain),qualified=new Set((this.loadTrackedWallets().get(chain)??[]).map(addressKey));
    const [trending,signals,smartMoney,kols]=await Promise.all([this.gmgn.trending(chain,cfg.market_filters??[],Math.min(limit,envNumber("TRENDING_LIMIT",30))),this.gmgn.marketSignals(chain),supportsPublicFeeds?this.gmgn.smartMoney(chain,Math.min(limit,100)):Promise.resolve([]),supportsPublicFeeds?this.gmgn.kol(chain,Math.min(limit,100)):Promise.resolve([])]);
    const normalizedTrending:Json[]=trending.map(row=>{const market:Json={...marketSnapshot(row),chain},address=String(market.address??""),price=Number(market.price),gate=passesMarketGate(market,cfg.token),valid=validTokenAddress(chain,address);if(valid&&Number.isFinite(price)&&price>0){const key=addressKey(address),change30=store.trendingPriceChange(key,price,envNumber("TRENDING_PRICE_LOOKBACK_SECONDS",1800));if(change30!==undefined)market.price_change_30m=change30;store.recordTrendingPrice(key,price);}market.quality_passed=gate.passed&&valid;market.quality_reasons=valid?gate.reasons:[...gate.reasons,"invalid token address"];return market;});
    let degen=buildDegenRows(chain,normalizedTrending,signals,cfg.token,envNumber("DEGEN_MAX_MARKET_CAP_USD",100000));
    if(chain==="robinhood"){await this.refreshPons();degen=mergeDegenRows(degen,this.ponsRows);}
    this.degenRows.set(chain,degen);
    const probeLimit=envNumber("TRENDING_MULTIWINDOW_CHECK_LIMIT_PER_CHAIN",10),probeOrder=normalizedTrending.filter(row=>row.quality_passed===true).sort((a,b)=>Number(b.volume??0)-Number(a.volume??0));
    for(const [index,market] of probeOrder.entries()){
      if(index>=probeLimit){market.multiwindow_passed=false;market.multiwindow_grade="NOT_CHECKED";continue;}
      try{Object.assign(market,analyzeTrendingCandles(await this.gmgn.kline(chain,String(market.address),3900,"5m"),market,cfg.token.min_volume_5m_usd));}
      catch(error){if(isRateLimit(error))throw error;market.multiwindow_passed=false;market.multiwindow_grade="UNAVAILABLE";market.multiwindow_reasons=[String(error)];console.warn(`${chain}: multi-window trend unavailable for ${market.address}`,String(error));}
    }
    const surgeThreshold=envNumber("TRENDING_30M_PRICE_INCREASE_PERCENT",100),smallCapMax=envNumber("TRENDING_MAX_MARKET_CAP_USD",500000);
    for(const market of normalizedTrending){market.momentum_30m_signal=Number(market.price_change_30m)>=surgeThreshold;market.small_cap_signal=Number(market.market_cap)>0&&Number(market.market_cap)<=smallCapMax;market.momentum_30m_threshold=surgeThreshold;market.small_cap_threshold=smallCapMax;}
    this.trendingRows.set(chain,normalizedTrending);
    for(const market of normalizedTrending){const address=String(market.address??"");if(!validTokenAddress(chain,address)||market.quality_passed!==true)continue;const item=this.candidate(map,chain,address,market.symbol);item.market=market;const change5m=Number(market.price_change_percent5m??market.price_change_5m??0),change30m=Number(market.price_change_30m),volume=Number(market.volume_5m??market.volume??0);if(market.multiwindow_passed===true){item.sources.add("trending_early_volume");item.sources.add("trending_multiwindow_stability");}if((change5m>=envNumber("MIN_PRICE_SURGE_5M_PERCENT",10)&&volume>=cfg.token.min_volume_5m_usd)||change30m>=envNumber("TRENDING_30M_PRICE_INCREASE_PERCENT",100))item.sources.add("trending_momentum");if(Number(market.market_cap)>0&&Number(market.market_cap)<=envNumber("TRENDING_MAX_MARKET_CAP_USD",500000))item.sources.add("trending_small_cap");if(Number(market.smart_degen_count??market.smart_money_count??0)>=3)item.sources.add("trending_smart_money");if(!item.sources.size)map.delete(addressKey(address));}
    for(const row of signals){const market=marketSnapshot(row),address=String(market.address??"");if(!validTokenAddress(chain,address)||!passesMarketGate(market,cfg.token).passed)continue;const item=this.candidate(map,chain,address,market.symbol);item.market=market;const type=Number(row.signal_type);item.sources.add(type===12?"smart_money_signal":"price_surge");if(row.id)item.sourceIds.add(String(row.id));}
    for(const row of smartMoney)if(qualified.has(addressKey(String(row.maker??""))))this.addEvent(map,chain,row,"smart_money_wallet");
    for(const row of kols)if(qualified.has(addressKey(String(row.maker??""))))this.addEvent(map,chain,row,"kol_wallet");
    await this.collectWalletSignals(chain,map);this.attachFomo(chain,map);this.attachTwitter(map);for(const market of normalizedTrending){const candidate=map.get(addressKey(String(market.address??"")));market.signal_sources=candidate?[...candidate.sources]:[];}return map;
  }

  async scan(chain:Chain,limit=200):Promise<Alert[]> {
    if(this.running.has(chain))throw new Error(`A ${chain} scan is already running`);this.running.add(chain);
    try {
      await Promise.all([this.refreshTwitter(),this.refreshFomo()]);
      const cfg=configForChain(this.config,chain),store=this.store(chain),output:Alert[]=[];
      let candidates:Map<string,SignalCandidate>;
      try {candidates=await this.collectCandidates(chain,limit);}
      catch(error){candidates=new Map();this.attachFomo(chain,candidates);this.attachTwitter(candidates);if(!candidates.size)throw error;console.warn(`${chain}: market feeds unavailable; continuing with ${candidates.size} direct Fomo tracked-buy candidate(s)`,String(error));}

      await this.enrichTrackedBuyCandidates(chain,candidates);
      for(const candidate of candidates.values()){
        const count=candidate.buyWallets.size;if(!count||candidate.trackedBuySafety?.passed!==true)continue;
        const trackingLabel=count>=3?"BUY SIGNAL":count===2?"POTENTIAL":"OBSERVE",kind=count>=3?"TRACKED_WALLET_BUY_SIGNAL":count===2?"TRACKED_WALLET_POTENTIAL":"TRACKED_WALLET_OBSERVE",cooldown=count>=3?envNumber("WALLET_CLUSTER_ALERT_COOLDOWN_MS",1800000):envNumber("TRACKED_WALLET_BUY_ALERT_COOLDOWN_MS",1800000);
        if(Date.now()/1000-store.lastAlertAt(candidate.address,kind)<cooldown/1000)continue;
        const marketCap=candidate.observedMarketCap,liquidity=finiteNumber(candidate.tokenPool?.liquidity??candidate.tokenInfo?.liquidity??candidate.tokenInfo?.pool?.liquidity),alert:Alert={tier:"RESEARCH",kind,tracking_label:trackingLabel,chain,address:candidate.address,...(candidate.symbol?{symbol:candidate.symbol}:{}),wallet_count:count,wallets:[...candidate.buyWallets],traders:[...(candidate.traderLabels??[])],sources:[...candidate.sources],aggregate_buy_usd:Math.round(candidate.aggregateBuyUsd*100)/100,market_cap_at_detection:marketCap,market_cap_observed_at:candidate.marketCapObservedAt,liquidity_at_detection:liquidity,liquidity_to_market_cap_ratio:liquidity!==undefined&&marketCap!==undefined&&marketCap>0?liquidity/marketCap:undefined,holder_count_at_detection:finiteNumber(candidate.tokenInfo?.holder_count??candidate.tokenInfo?.stat?.holder_count),top_10_holder_rate_at_detection:finiteNumber(candidate.tokenInfo?.stat?.top_10_holder_rate??candidate.tokenInfo?.dev?.top_10_holder_rate),safety_reasons:candidate.trackedBuySafety.reasons,first_timestamp:candidate.firstTimestamp};
        if(store.saveAlert(alert,candidate.firstTimestamp))output.push(alert);
      }

      const selected=[...candidates.values()].filter(candidate=>shouldInvestigate(candidate,envNumber("MIN_SIGNAL_STRENGTH",3))).sort((a,b)=>signalStrength(b)-signalStrength(a)).slice(0,envNumber("MAX_CANDIDATES_PER_CHAIN",5));
      for(const candidate of selected){
        const cooldown=envNumber("SIGNAL_ALERT_COOLDOWN_MS",21600000);if(Date.now()/1000-store.lastAlertAt(candidate.address)<cooldown/1000)continue;
        try {const [info,security,pool]=candidate.tokenInfo&&candidate.tokenSecurity&&candidate.tokenPool?[candidate.tokenInfo,candidate.tokenSecurity,candidate.tokenPool]:await Promise.all([this.gmgn.tokenInfo(chain,candidate.address),this.gmgn.tokenSecurity(chain,candidate.address),this.gmgn.tokenPool(chain,candidate.address)]),currentPrice=number(info.price?.price,null),verdict=scoreToken(info,security,pool,{median_entry_price_usd:currentPrice,max_price_chase_ratio:cfg.cluster.max_price_chase_ratio},cfg.token),failures=[...verdict.reasons.filter(r=>r.startsWith("FAIL ")),...verdict.warnings],catalysts=this.catalysts(cfg),catalyst=catalysts[`${chain}:${candidate.address}`]??catalysts[candidate.address],tier:Alert["tier"]=failures.length||!verdict.passed?"REJECT":(catalyst||!cfg.require_catalyst_for_call?"CALL":"RESEARCH"),holders=tier==="REJECT"?[]:await this.tokenHolders(chain,candidate.address),snapshot=buildTokenSnapshot(chain,candidate.address,info,security,pool,holders,verdict),market=candidate.market??{},alert:Alert={tier,chain,address:candidate.address,...(snapshot.symbol?{symbol:snapshot.symbol}:candidate.symbol?{symbol:candidate.symbol}:{}),name:snapshot.name,wallet_count:candidate.wallets.size,tracked_buy_wallet_count:candidate.buyWallets.size,independent_funders:candidate.wallets.size,aggregate_buy_usd:Math.round(candidate.aggregateBuyUsd*100)/100,median_buy_usd:0,window_seconds:Math.max(0,Math.floor(Date.now()/1000)-candidate.firstTimestamp),wallets:[...candidate.wallets],traders:[...(candidate.traderLabels??[])],sources:[...candidate.sources],signal_strength:signalStrength(candidate),twitter_accounts:[...candidate.twitterAccounts],market_cap:snapshot.marketCap??market.market_cap,liquidity:snapshot.liquidity??market.liquidity,price_change_5m:market.price_change_percent5m??market.price_change_5m,token_score:verdict.score,token_reasons:verdict.reasons,warnings:verdict.warnings,failures,catalyst,token_snapshot:snapshot,invalidation:"Downgrade if tracked wallets distribute, liquidity falls below threshold, momentum reverses, or contract safety changes."};if(store.saveAlert(alert,candidate.firstTimestamp))output.push(alert);}
        catch(error){if(isRateLimit(error)){console.warn(`${chain}: full token checks paused after direct tracked-buy alerts were preserved`,String(error));break;}console.warn(`${chain}: full token check unavailable for ${candidate.address}`,String(error));}
      }
      return output;
    }finally{this.running.delete(chain);}
  }
  async scanAll(limit=200):Promise<Alert[]>{const output:Alert[]=[];for(const chain of this.config.enabled_chains){try{output.push(...await this.scan(chain,limit));}catch(error){if(isRateLimit(error))throw error;console.error(`${chain} scan failed`,String(error));}}return output;}
}

export function rotatingSlice<T>(items:T[],start:number,limit:number):T[]{
  if(!items.length||limit<=0)return [];
  const count=Math.min(items.length,Math.floor(limit)),offset=((Math.floor(start)%items.length)+items.length)%items.length;
  return Array.from({length:count},(_,index)=>items[(offset+index)%items.length]!);
}
