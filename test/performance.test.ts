import test from "node:test";
import assert from "node:assert/strict";
import { TrackerService } from "../src/service.js";
import { TrackerStore } from "../src/store.js";
import { ScannerService } from "../src/scanner.service.js";

const address="0x1111111111111111111111111111111111111111";

test("call baselines persist for two hours and are not reset by rediscovery",()=>{
  const store=new TrackerStore(":memory:");
  assert.equal(store.trackCall(address,"TEST","DEGEN",1,100,1_000,7_200,200,86_400),true);
  assert.equal(store.trackCall(address,"TEST","DEGEN",9,900,2_000,7_200,200,86_400),false);
  const [active]=store.activeCallPerformance(2_001);
  assert.equal(active?.baseline_price,1);
  assert.equal(active?.baseline_market_cap,100);
  assert.equal(active?.first_seen,1_000);
  assert.equal(active?.last_seen,2_000);
  assert.equal(store.activeCallPerformance(8_201).length,0);
  assert.equal(store.trackCall(address,"TEST","DEGEN",10,1_000,90_000,7_200,200,86_400),true);
  assert.equal(store.activeCallPerformance(90_001)[0]?.baseline_price,10);
  store.close();
});

test("catastrophic market-cap collapse is suppressed, confirmed, and permanently quarantined",()=>{
  const store=new TrackerStore(":memory:");
  assert.equal(store.trackCall(address,"RUG","DEGEN",1,100_000,1_000,7_200,200,86_400),true);
  assert.equal(store.observeCatastrophicMarketCapCollapse(address,999,.01,1_100,2,15),"suspected");
  assert.equal(store.observeCatastrophicMarketCapCollapse(address,999,.01,1_100,2,15),"suspected");
  assert.equal(store.observeCatastrophicMarketCapCollapse(address,999,.01,1_115,2,15),"dead");
  assert.equal(store.activeCallPerformance(1_116).length,0);
  assert.equal(store.trackCall(address,"RUG","DEGEN",10,10_000,100_000,7_200,200,86_400),false);
  assert.equal(store.callPerformance(address)?.dead_at,1_115);
  store.close();
});

test("GMGN trigger hits cause exact price and safety rescans at each new multiple",async()=>{
  let currentPrice=2.2,currentMc=220,signalCalls=0;
  const gmgn={
    cooldownUntil:0,
    marketSignals:async()=>{signalCalls++;return [{token_address:address,market_cap:currentMc,signal_type:6}];},
    tokenInfo:async()=>({symbol:"TEST",circulating_supply:100,price:{price:currentPrice}}),
  };
  const service=new TrackerService({default_chain:"robinhood",enabled_chains:["robinhood"]} as any,gmgn as any);
  const store=new TrackerStore(":memory:");
  (service as any).stores.set("robinhood",store);
  (service as any).evaluateToken=async()=>({verdict:{passed:true,score:88,warnings:[],reasons:[]}});

  assert.deepEqual(await service.monitorCallMultiples(["robinhood"],[{chain:"robinhood",address,symbol:"TEST",price:1,market_cap:100,degen_sources:["PONS"]}],1_000),[]);
  const [double]=await service.monitorTriggeredCallMultiples(["robinhood"],1_010);
  assert.equal(double?.kind,"MULTIPLE");
  assert.equal(double?.milestone,2);
  assert.equal(double?.multiple,2.2);
  assert.equal(double?.token_score,88);
  service.acknowledgeCallMultiple(double!);

  currentPrice=2.8;currentMc=280;
  assert.deepEqual(await service.monitorTriggeredCallMultiples(["robinhood"],1_020),[]);
  currentPrice=3.05;currentMc=305;
  const [triple]=await service.monitorTriggeredCallMultiples(["robinhood"],1_030);
  assert.equal(triple?.milestone,3);
  assert.equal(triple?.multiple,3.05);
  service.acknowledgeCallMultiple(triple!);
  assert.ok(signalCalls>=3);

  assert.deepEqual(await service.monitorTriggeredCallMultiples(["robinhood"],8_201),[]);
  store.close();
});

test("five-minute fallback reprices every active baseline even without a trigger-feed hit",async()=>{
  let currentPrice=1;
  const gmgn={cooldownUntil:0,tokenInfo:async()=>({symbol:"TEST",circulating_supply:100,price:{price:currentPrice}})};
  const service=new TrackerService({default_chain:"robinhood",enabled_chains:["robinhood"]} as any,gmgn as any),store=new TrackerStore(":memory:");
  (service as any).stores.set("robinhood",store);(service as any).evaluateToken=async()=>({verdict:{passed:true,score:90,warnings:[],reasons:[]}});
  assert.deepEqual(await service.monitorCallMultiples(["robinhood"],[{chain:"robinhood",address,symbol:"TEST",price:1,market_cap:100,degen_sources:["PONS"]}],1_000),[]);
  currentPrice=2.2;const [double]=await service.monitorCallMultiples(["robinhood"],[],1_300);assert.equal(double?.milestone,2);service.acknowledgeCallMultiple(double!);
  currentPrice=3.1;const [triple]=await service.monitorCallMultiples(["robinhood"],[],1_600);assert.equal(triple?.milestone,3);
  assert.deepEqual(store.callPerformanceSummary(1_600),{active_baselines:1,crossed_unannounced:1,max_observed_multiple:3.1,max_alerted_milestone:2,nearest_expiry:8_200});store.close();
});

test("multiplier updates survive ordinary quality failures but explicit rugs remain suppressed",async()=>{
  let currentPrice=1,rug=false;
  const gmgn={cooldownUntil:0,tokenInfo:async()=>({symbol:"TEST",circulating_supply:100,price:{price:currentPrice}})},service=new TrackerService({default_chain:"robinhood",enabled_chains:["robinhood"]} as any,gmgn as any),store=new TrackerStore(":memory:");
  (service as any).stores.set("robinhood",store);(service as any).evaluateToken=async()=>({honeypot:rug,verdict:{passed:false,score:54,warnings:[],reasons:[rug?"FAIL honeypot detected":"FAIL fewer than 300 holders"]}});
  await service.monitorCallMultiples(["robinhood"],[{chain:"robinhood",address,symbol:"TEST",price:1,market_cap:100,degen_sources:["PONS"]}],1_000);
  currentPrice=2.2;const [review]=await service.monitorCallMultiples(["robinhood"],[],1_300);assert.equal(review?.milestone,2);assert.equal(review?.token_passed,false);assert.match(String(review?.token_snapshot?.verdict?.reasons?.[0]),/holders/);service.acknowledgeCallMultiple(review!);
  rug=true;currentPrice=3.2;assert.deepEqual(await service.monitorCallMultiples(["robinhood"],[],1_600),[]);store.close();
});

test("scanner publishes and acknowledges a multiplier only after Telegram delivery",async()=>{
  const alert:any={tier:"RESEARCH",kind:"MULTIPLE",chain:"robinhood",address,milestone:2,first_seen:1_000},published:any[]=[],acknowledged:any[]=[];
  const runtime:any={tracker:{acknowledgeCallMultiple:(row:any)=>acknowledged.push(row)}},telegram:any={alert:async()=>({attempted:1,sent:1,failed:0})},stream:any={publishAlert:(row:any)=>published.push(row)},scanner=new ScannerService(runtime,telegram,stream,{} as any);
  const delivered=await (scanner as any).publishMultipleAlerts([alert]);assert.deepEqual(delivered,{attempted:1,sent:1,failed:0});assert.deepEqual(published,[alert]);assert.deepEqual(acknowledged,[alert]);
  telegram.alert=async()=>({attempted:1,sent:0,failed:1});await (scanner as any).publishMultipleAlerts([{...alert,milestone:3}]);assert.equal(acknowledged.length,1);
});

test("scanner delivers completed trending results when a later GMGN call starts cooldown",async()=>{
  let cooldown=0,trendingDeliveries=0,acknowledged=0;const row:any={chain:"sol",address,symbol:"TREND"},tracker:any={gmgn:{get cooldownUntil(){return cooldown;}},scan:async()=>{cooldown=Date.now()+30_000;return [];},latestTrendingAcross:async()=>[row],diagnostics:()=>({}),acknowledgeTrending:()=>{acknowledged++;}},runtime:any={scheduledChains:["sol"],tracker,botStore:{subscriptionCount:()=>1}},telegram:any={enabled:true,alert:async()=>({attempted:0,sent:0,failed:0}),trending:async()=>{trendingDeliveries++;return {attempted:1,sent:1,failed:0};},degen:async()=>({attempted:0,sent:0,failed:0})},stream:any={publishAlert:()=>{},publishScan:()=>{}},scanner=new ScannerService(runtime,telegram,stream,{} as any);
  (scanner as any).saveScanStatus=()=>{};await scanner.scanAndPublish();assert.equal(trendingDeliveries,1);assert.equal(acknowledged,1);
});

test("multiplier monitoring sends no requests while the shared GMGN cooldown is active",async()=>{
  let requests=0;
  const gmgn={cooldownUntil:Date.now()+30_000,tokenInfo:async()=>{requests++;return {};},marketSignals:async()=>{requests++;return [];}},service=new TrackerService({default_chain:"robinhood",enabled_chains:["robinhood","bsc","sol"]} as any,gmgn as any);
  for(const chain of ["robinhood","bsc","sol"] as const)service.store(chain).trackCall(address,"TEST","DEGEN",1,100,1_000);
  assert.deepEqual(await service.monitorCallMultiples(["robinhood","bsc","sol"],[],1_100),[]);
  assert.deepEqual(await service.monitorTriggeredCallMultiples(["robinhood","bsc","sol"],1_100),[]);
  assert.equal(requests,0);
});

test("scanner shutdown stops scheduling, closes Fomo, and rejects new scan work",async()=>{
  let scans=0,closed=0;
  const deleted:string[]=[],runtime:any={scheduledChains:["robinhood"],tracker:{gmgn:{cooldownUntil:0},scan:async()=>{scans++;return [];}},botStore:{subscriptionCount:()=>0}},telegram:any={},stream:any={},scheduler:any={deleteInterval:(name:string)=>deleted.push(name)},scanner=new ScannerService(runtime,telegram,stream,scheduler);
  (scanner as any).fomoSession={connected:true,close:async()=>{closed++;}};
  await scanner.onApplicationShutdown();
  await scanner.scanAndPublish();
  assert.equal(scans,0);assert.equal(closed,1);assert.ok(deleted.includes("fomo-session-health"));
});
