import { createHash, randomBytes } from "node:crypto";
import type { Alert, Json } from "./types.js";
import type { MongoState } from "./mongo.js";

export type AdminInviteClaim="claimed"|"invalid"|"expired"|"used";
const inviteHash=(token:string)=>createHash("sha256").update(token).digest("hex");

abstract class MongoCachedStore {
  private pending:Promise<unknown>=Promise.resolve();
  private acceptingWrites=true;
  constructor(protected readonly mongo?:MongoState) {}
  protected write(task:()=>Promise<unknown>):void {if(this.mongo&&this.acceptingWrites)this.pending=this.pending.then(task).catch(error=>console.error("MongoDB state write failed",error));}
  async flush():Promise<void>{await this.pending;}
  async close():Promise<void>{this.acceptingWrites=false;await this.flush();}
}

export class TrackerStore extends MongoCachedStore {
  private readonly profiles=new Map<string,Json>();
  private readonly alertRows=new Map<string,Json>();
  private readonly trendingPrices=new Map<string,Json[]>();
  private readonly metricSamples=new Map<string,Json[]>();
  private readonly calls=new Map<string,Json>();
  private readonly discoveryRows=new Map<string,Json>();

  constructor(readonly scope:string,mongo?:MongoState){super(mongo);}

  async init():Promise<void>{
    if(!this.mongo)return;
    const [profiles,alerts,prices,metrics,calls,discoveries]=await Promise.all([
      this.mongo.db.collection<Json>("tracker_profiles").find({scope:this.scope}).toArray(),
      this.mongo.db.collection<Json>("tracker_alerts").find({scope:this.scope}).sort({created_at:-1}).limit(1000).toArray(),
      this.mongo.db.collection<Json>("trending_prices").find({scope:this.scope}).toArray(),
      this.mongo.db.collection<Json>("metric_samples").find({scope:this.scope}).toArray(),
      this.mongo.db.collection<Json>("call_performance").find({scope:this.scope}).toArray(),
      this.mongo.db.collection<Json>("discovery_decisions").find({scope:this.scope}).sort({last_detected_at:-1}).limit(500).toArray(),
    ]);
    for(const row of profiles)this.profiles.set(String(row.wallet),row);
    for(const row of alerts)this.alertRows.set(`${row.token}:${row.window_start}`,row);
    for(const row of prices)this.trendingPrices.set(String(row.token),[...(this.trendingPrices.get(String(row.token))??[]),row]);
    for(const row of metrics){const key=`${row.token}:${row.metric}`;this.metricSamples.set(key,[...(this.metricSamples.get(key)??[]),row]);}
    for(const row of calls)this.calls.set(String(row.token),row);
    for(const row of discoveries)this.discoveryRows.set(String(row.token),row);
  }

  roster():Json[]{return [...this.profiles.values()].filter(row=>row.passed===true||Number(row.passed)===1).sort((a,b)=>Number(b.score)-Number(a.score)).map(row=>({wallet:row.wallet,score:row.score,assessed_at:row.assessed_at}));}
  remember(events:Json[]):void {
    const now=Math.floor(Date.now()/1000),valid=events.filter(row=>row.maker);if(!this.mongo||!valid.length)return;
    this.write(async()=>{
      const eventOps=valid.filter(row=>row.transaction_hash&&row.base_address).map(row=>({
        updateOne:{
          filter:{scope:this.scope,tx_hash:row.transaction_hash,maker:row.maker,token:row.base_address},
          update:{$setOnInsert:{scope:this.scope,tx_hash:row.transaction_hash,maker:row.maker,token:row.base_address,timestamp:Number(row.timestamp)||0,payload:row}},
          upsert:true,
        },
      }));
      const candidateOps=valid.map(row=>({
        updateOne:{
          filter:{scope:this.scope,wallet:row.maker},
          update:{$set:{source:"smartmoney-feed",last_seen:now},$setOnInsert:{first_seen:now}},
          upsert:true,
        },
      }));
      if(eventOps.length)await this.mongo!.db.collection("tracker_events").bulkWrite(eventOps);
      if(candidateOps.length)await this.mongo!.db.collection("tracker_candidates").bulkWrite(candidateOps);
    });
  }
  qualified(events:Json[]):Json[]{const wallets=new Set(this.roster().map(row=>row.wallet));return events.filter(row=>wallets.has(row.maker));}
  independentFunders(wallets:string[]):number{return new Set(wallets.map(wallet=>this.profiles.get(wallet)?.funder||`wallet:${wallet}`)).size;}
  saveAlert(alert:Alert,windowStart:number):boolean {const token=alert.kind?`${alert.kind}:${alert.address}`:alert.address,key=`${token}:${windowStart}`;if(this.alertRows.has(key))return false;const row={scope:this.scope,token,window_start:windowStart,tier:alert.tier,payload:structuredClone(alert),created_at:Math.floor(Date.now()/1000)};this.alertRows.set(key,row);this.write(()=>this.mongo!.db.collection("tracker_alerts").updateOne({scope:this.scope,token,window_start:windowStart},{$setOnInsert:row},{upsert:true}));return true;}
  alerts(limit=50):Alert[]{return [...this.alertRows.values()].sort((a,b)=>Number(b.created_at)-Number(a.created_at)).slice(0,limit).map(row=>structuredClone(row.payload));}
  recordDiscoveryDecision(input:Json,detectedAt=Math.floor(Date.now()/1000)):void {
    const token=String(input.address??input.token??"");if(!token)return;const existing=this.discoveryRows.get(token),newObservation=Number(existing?.last_detected_at)!==detectedAt,row={...existing,...structuredClone(input),scope:this.scope,token,address:token,first_detected_at:Number(existing?.first_detected_at??detectedAt),last_detected_at:detectedAt,detection_count:Number(existing?.detection_count??0)+(newObservation?1:0)};this.discoveryRows.set(token,row);
    this.write(()=>this.mongo!.db.collection("discovery_decisions").updateOne({scope:this.scope,token},{$set:row},{upsert:true}));
  }
  discoveryDecisions(limit=50,status?:string):Json[]{return [...this.discoveryRows.values()].filter(row=>!status||row.status===status).sort((a,b)=>Number(b.last_detected_at)-Number(a.last_detected_at)).slice(0,Math.max(0,limit)).map(row=>structuredClone(row));}
  lastAlertAt(token:string,kind?:string):number {const key=kind?`${kind}:${token}`:token;return Math.max(0,...[...this.alertRows.values()].filter(row=>row.token===key).map(row=>Number(row.created_at)||0));}
  recordTrendingPrice(token:string,price:number,sampledAt=Math.floor(Date.now()/1000)):void {if(!Number.isFinite(price)||price<=0)return;const rows=(this.trendingPrices.get(token)??[]).filter(row=>Number(row.sampled_at)>=sampledAt-7200&&Number(row.sampled_at)!==sampledAt),entry={scope:this.scope,token,sampled_at:sampledAt,price};rows.push(entry);this.trendingPrices.set(token,rows);this.write(async()=>{await this.mongo!.db.collection("trending_prices").updateOne({scope:this.scope,token,sampled_at:sampledAt},{$set:entry},{upsert:true});await this.mongo!.db.collection("trending_prices").deleteMany({scope:this.scope,sampled_at:{$lt:sampledAt-7200}});});}
  trendingPriceChange(token:string,currentPrice:number,lookbackSeconds=1800,now=Math.floor(Date.now()/1000)):number|undefined {if(!Number.isFinite(currentPrice)||currentPrice<=0)return;const target=now-lookbackSeconds,row=(this.trendingPrices.get(token)??[]).filter(item=>Number(item.sampled_at)<=target).sort((a,b)=>Number(b.sampled_at)-Number(a.sampled_at))[0];if(!row||target-Number(row.sampled_at)>600||Number(row.price)<=0)return;return (currentPrice/Number(row.price)-1)*100;}
  recordMetric(token:string,metric:string,value:number,sampledAt=Math.floor(Date.now()/1000)):void {if(!token||!metric||!Number.isFinite(value))return;const key=`${token}:${metric}`,rows=(this.metricSamples.get(key)??[]).filter(row=>Number(row.sampled_at)>=sampledAt-86400&&Number(row.sampled_at)!==sampledAt),entry={scope:this.scope,token,metric,sampled_at:sampledAt,value};rows.push(entry);this.metricSamples.set(key,rows);this.write(async()=>{await this.mongo!.db.collection("metric_samples").updateOne({scope:this.scope,token,metric,sampled_at:sampledAt},{$set:entry},{upsert:true});await this.mongo!.db.collection("metric_samples").deleteMany({scope:this.scope,sampled_at:{$lt:sampledAt-86400}});});}
  metricDelta(token:string,metric:string,currentValue:number,lookbackSeconds=1800,now=Math.floor(Date.now()/1000)):number|undefined {if(!token||!metric||!Number.isFinite(currentValue))return;const target=now-lookbackSeconds,row=(this.metricSamples.get(`${token}:${metric}`)??[]).filter(item=>Number(item.sampled_at)<=target).sort((a,b)=>Number(b.sampled_at)-Number(a.sampled_at))[0];if(!row||target-Number(row.sampled_at)>600||!Number.isFinite(Number(row.value)))return;return currentValue-Number(row.value);}
  trackCall(token:string,symbol:string|undefined,source:string,price:number,marketCap:number|undefined,firstSeen=Math.floor(Date.now()/1000),windowSeconds=7200,maxActive=200,rearmSeconds=86400):boolean {if(!token||!Number.isFinite(price)||price<=0||windowSeconds<=0)return false;this.pruneCallPerformance(firstSeen,rearmSeconds);const existing=this.calls.get(token);if(existing){if(existing.dead_at)return false;existing.last_seen=firstSeen;if(symbol)existing.symbol=symbol;this.write(()=>this.mongo!.db.collection("call_performance").updateOne({scope:this.scope,token},{$set:{last_seen:firstSeen,...(symbol?{symbol}:{})}}));return false;}if([...this.calls.values()].filter(row=>!row.dead_at&&Number(row.expires_at)>firstSeen).length>=Math.max(1,maxActive))return false;const row={scope:this.scope,token,symbol:symbol??null,source,baseline_price:price,baseline_market_cap:marketCap!==undefined&&Number.isFinite(marketCap)?marketCap:null,first_seen:firstSeen,last_seen:firstSeen,expires_at:firstSeen+windowSeconds,last_price:price,max_multiple:1,last_alerted_multiple:1};this.calls.set(token,row);this.write(()=>this.mongo!.db.collection("call_performance").updateOne({scope:this.scope,token},{$setOnInsert:row},{upsert:true}));return true;}
  activeCallPerformance(now=Math.floor(Date.now()/1000),limit=200):Json[]{this.pruneCallPerformance(now);return [...this.calls.values()].filter(row=>!row.dead_at&&Number(row.expires_at)>now).sort((a,b)=>Number(a.first_seen)-Number(b.first_seen)).slice(0,Math.max(0,limit)).map(row=>structuredClone(row));}
  callPerformance(token:string):Json|undefined {const row=this.calls.get(token);return row?structuredClone(row):undefined;}
  observeCatastrophicMarketCapCollapse(token:string,currentMarketCap:number,collapseRatio=.01,observedAt=Math.floor(Date.now()/1000),confirmations=2,minimumIntervalSeconds=15):"clear"|"suspected"|"dead"|"unknown" {const row=this.calls.get(token),baseline=Number(row?.baseline_market_cap);if(!row||!Number.isFinite(baseline)||baseline<=0||!Number.isFinite(currentMarketCap)||currentMarketCap<0)return "unknown";if(row.dead_at)return "dead";if(currentMarketCap>=baseline*collapseRatio){if(row.collapse_observations){delete row.collapse_observations;delete row.collapse_last_observed_at;delete row.collapse_market_cap;this.write(()=>this.mongo!.db.collection("call_performance").updateOne({scope:this.scope,token},{$unset:{collapse_observations:"",collapse_last_observed_at:"",collapse_market_cap:""}}));}return "clear";}const last=Number(row.collapse_last_observed_at??0);if(last&&observedAt-last<Math.max(0,minimumIntervalSeconds))return "suspected";row.collapse_observations=Number(row.collapse_observations??0)+1;row.collapse_last_observed_at=observedAt;row.collapse_market_cap=currentMarketCap;if(Number(row.collapse_observations)>=Math.max(1,confirmations))row.dead_at=observedAt;this.write(()=>this.mongo!.db.collection("call_performance").updateOne({scope:this.scope,token},{$set:{collapse_observations:row.collapse_observations,collapse_last_observed_at:observedAt,collapse_market_cap:currentMarketCap,...(row.dead_at?{dead_at:row.dead_at}:{})}}));return row.dead_at?"dead":"suspected";}
  callPerformanceSummary(now=Math.floor(Date.now()/1000)):Json {const active=this.activeCallPerformance(now,Number.MAX_SAFE_INTEGER),crossed=active.filter(row=>Math.floor(Number(row.max_multiple??1))>=Math.max(2,Number(row.last_alerted_multiple??1)+1));return {active_baselines:active.length,crossed_unannounced:crossed.length,max_observed_multiple:active.length?Math.max(...active.map(row=>Number(row.max_multiple??1))):1,max_alerted_milestone:active.length?Math.max(...active.map(row=>Number(row.last_alerted_multiple??1))):1,nearest_expiry:active.length?Math.min(...active.map(row=>Number(row.expires_at))):null};}
  updateCallPerformance(token:string,currentPrice:number,multiple:number):void {if(!Number.isFinite(currentPrice)||currentPrice<=0||!Number.isFinite(multiple)||multiple<=0)return;const row=this.calls.get(token);if(!row)return;row.last_price=currentPrice;row.max_multiple=Math.max(Number(row.max_multiple),multiple);this.write(()=>this.mongo!.db.collection("call_performance").updateOne({scope:this.scope,token},{$set:{last_price:currentPrice},$max:{max_multiple:multiple}}));}
  acknowledgeCallMultiple(token:string,milestone:number):void {if(!Number.isInteger(milestone)||milestone<2)return;const row=this.calls.get(token);if(!row)return;row.last_alerted_multiple=Math.max(Number(row.last_alerted_multiple),milestone);this.write(()=>this.mongo!.db.collection("call_performance").updateOne({scope:this.scope,token},{$max:{last_alerted_multiple:milestone}}));}
  pruneCallPerformance(now=Math.floor(Date.now()/1000),rearmSeconds=86400):void {const tokens=[...this.calls.values()].filter(row=>!row.dead_at&&Number(row.expires_at)<=now&&Number(row.last_seen)<=now-Math.max(0,rearmSeconds)).map(row=>String(row.token));for(const token of tokens)this.calls.delete(token);if(tokens.length)this.write(()=>this.mongo!.db.collection("call_performance").deleteMany({scope:this.scope,token:{$in:tokens}}));}
}

export class BotStore extends MongoCachedStore {
  private readonly subscriptions=new Set<string>();
  private readonly admins=new Map<string,Json>();
  private readonly invites=new Map<string,Json>();
  private readonly chatMessages=new Map<string,Json[]>();
  constructor(mongo?:MongoState){super(mongo);}
  async init():Promise<void>{if(!this.mongo)return;const [subscriptions,admins,invites]=await Promise.all([this.mongo.db.collection<Json>("subscriptions").find({}).toArray(),this.mongo.db.collection<Json>("bot_admins").find({}).toArray(),this.mongo.db.collection<Json>("admin_invites").find({}).toArray()]);for(const row of subscriptions)this.subscriptions.add(`${row.chat_id}:${row.chain}`);for(const row of admins)this.admins.set(String(row.user_id),row);for(const row of invites)this.invites.set(String(row.token_hash),row);}
  subscribe(chatId:string,chain:string):void {const key=`${chatId}:${chain}`;if(this.subscriptions.has(key))return;this.subscriptions.add(key);this.write(()=>this.mongo!.db.collection("subscriptions").updateOne({chat_id:chatId,chain},{$setOnInsert:{chat_id:chatId,chain}},{upsert:true}));}
  unsubscribe(chatId:string,chain:string):void {this.subscriptions.delete(`${chatId}:${chain}`);this.write(()=>this.mongo!.db.collection("subscriptions").deleteOne({chat_id:chatId,chain}));}
  chats(chain:string):string[]{return [...new Set([...this.subscriptions].map(key=>{const split=key.lastIndexOf(":");return {chat:key.slice(0,split),chain:key.slice(split+1)};}).filter(row=>row.chain===chain||row.chain==="all").map(row=>row.chat))];}
  chatsForChains(chains:string[]):string[]{return [...new Set(chains.flatMap(chain=>this.chats(chain)))];}
  subscriptionCount():number{return new Set([...this.subscriptions].map(key=>key.slice(0,key.lastIndexOf(":")))).size;}
  isAdmin(userId:string):boolean{return /^\d+$/.test(userId)&&this.admins.has(userId);}
  createAdminInvite(createdBy:string,ttlSeconds=3600,now=Math.floor(Date.now()/1000)):string {if(!/^\d+$/.test(createdBy))throw new Error("Invalid Telegram owner ID");const ttl=Math.min(86400,Math.max(300,Math.floor(ttlSeconds))),token=randomBytes(24).toString("base64url"),token_hash=inviteHash(token);for(const [hash,row] of this.invites)if(Number(row.expires_at)<now-86400||row.claimed_at&&Number(row.claimed_at)<now-86400)this.invites.delete(hash);const row={token_hash,created_by:createdBy,created_at:now,expires_at:now+ttl,claimed_by:null,claimed_at:null};this.invites.set(token_hash,row);this.write(()=>this.mongo!.db.collection("admin_invites").updateOne({token_hash},{$setOnInsert:row},{upsert:true}));return token;}
  claimAdminInvite(token:string,userId:string,username?:string,now=Math.floor(Date.now()/1000)):AdminInviteClaim {if(!/^[A-Za-z0-9_-]{20,64}$/.test(token)||!/^\d+$/.test(userId))return "invalid";const hash=inviteHash(token),invite=this.invites.get(hash);if(!invite)return "invalid";if(invite.claimed_at!==null&&invite.claimed_at!==undefined)return "used";if(Number(invite.expires_at)<now)return "expired";invite.claimed_by=userId;invite.claimed_at=now;const row={user_id:userId,username:username?.slice(0,64)??null,granted_by:invite.created_by,granted_at:now};this.admins.set(userId,row);this.write(async()=>{const claimed=await this.mongo!.db.collection("admin_invites").updateOne({token_hash:hash,claimed_at:null,expires_at:{$gte:now}},{$set:{claimed_by:userId,claimed_at:now}});if(claimed.modifiedCount!==1)throw new Error("Admin invite was claimed concurrently");await this.mongo!.db.collection("bot_admins").updateOne({user_id:userId},{$set:row},{upsert:true});});return "claimed";}
  adminRows():Json[]{return [...this.admins.values()].sort((a,b)=>Number(a.granted_at)-Number(b.granted_at)).map(row=>structuredClone(row));}
  revokeAdmin(userId:string):boolean {const found=this.admins.delete(userId);if(found)this.write(()=>this.mongo!.db.collection("bot_admins").deleteOne({user_id:userId}));return found;}
  recordChatMessage(message:Json):void {
    const chatId=String(message.chat_id??""),messageId=Number(message.message_id),createdAt=Number(message.created_at);if(!chatId||!Number.isInteger(messageId)||messageId<=0||!Number.isFinite(createdAt)||createdAt<=0)return;
    const retention=Math.max(86400,Number(process.env.CHAT_HISTORY_RETENTION_SECONDS??604800)),cutoff=Math.floor(Date.now()/1000)-retention,rows=(this.chatMessages.get(chatId)??[]).filter(row=>Number(row.created_at)>=cutoff&&!(Number(row.message_id)===messageId&&row.direction===message.direction)),stored=structuredClone(message);rows.push(stored);this.chatMessages.set(chatId,rows.sort((a,b)=>Number(a.created_at)-Number(b.created_at)||Number(a.message_id)-Number(b.message_id)));
    this.write(async()=>{await this.mongo!.db.collection("telegram_chat_messages").updateOne({chat_id:chatId,message_id:messageId,direction:message.direction},{$set:stored},{upsert:true});await this.mongo!.db.collection("telegram_chat_messages").deleteMany({created_at:{$lt:cutoff}});});
  }
  async chatHistory(chatId:string,since:number):Promise<Json[]> {
    const normalized=String(chatId),cutoff=Math.max(0,Math.floor(since));await this.flush();
    if(this.mongo)return this.mongo.db.collection<Json>("telegram_chat_messages").find({chat_id:normalized,created_at:{$gte:cutoff}}).sort({created_at:1,message_id:1}).toArray();
    return (this.chatMessages.get(normalized)??[]).filter(row=>Number(row.created_at)>=cutoff).map(row=>structuredClone(row));
  }
  inviteHashForTest(token:string):string{return inviteHash(token);}
}
