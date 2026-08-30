import test from "node:test";
import assert from "node:assert/strict";
import { TrackerService } from "../src/service.js";
import { TrackerStore } from "../src/store.js";

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
