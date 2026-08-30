import test from "node:test";
import assert from "node:assert/strict";
import { clusterEvents, scoreToken, wilsonLowerBound } from "../src/scoring.js";
import { configForChain, databasePath, loadConfig } from "../src/config.js";
import { TrackerService } from "../src/service.js";

test("Wilson bound shrinks small samples",()=>{
  assert.ok(wilsonLowerBound(1,1)<.3);
  assert.ok(wilsonLowerBound(70,100)>.59);
});

test("cluster requires distinct wallets",()=>{
  const events=["a","a","b","c"].map((maker,i)=>({side:"buy",is_open_or_close:0,base_address:"token",maker,timestamp:100+i,amount_usd:100,price_usd:1}));
  assert.deepEqual(clusterEvents(events,{window_seconds:300,min_qualified_wallets:4}),[]);
});

test("EVM honeypot is rejected",()=>{
  const base=configForChain(loadConfig(),"base");
  const info={price:{price:"0.001",volume_5m:"80000"},circulating_supply:"1000000000",holder_count:2500,stat:{top_10_holder_rate:"0.12",dev_team_hold_rate:"0.01",top_bundler_trader_percentage:"0.02",bot_degen_rate:"0.03",top_rat_trader_percentage:"0.01",top_entrapment_trader_percentage:"0.02"}};
  const security={is_honeypot:true,is_open_source:true,is_renounced:true,buy_tax:"0",sell_tax:"0",top_10_holder_rate:"0.12",lock_summary:{is_locked:true}};
  assert.equal(scoreToken(info,security,{liquidity:"150000"},{median_entry_price_usd:.001,max_price_chase_ratio:.15},base.token).passed,false);
});

test("each chain uses its own database",()=>{
  const cfg=loadConfig();
  assert.match(databasePath(cfg,"sol"),/tracker\.sqlite3$/);
  assert.match(databasePath(cfg,"base"),/tracker\.base\.sqlite3$/);
});

test("contract lookup resolves every exact enabled-chain match",async()=>{
  const address="0x1111111111111111111111111111111111111111";
  const gmgn={tokenInfo:async(chain:string)=>chain==="base"?{symbol:"TEST",standard:"erc20"}:chain==="bsc"?{name:"Test",price:{address}}:{symbol:"",name:"",standard:"",price:{address:""}}};
  const service=new TrackerService(loadConfig(),gmgn as any);
  assert.deepEqual(await service.resolveTokenChains(address),["bsc","base"]);
});

test("Solana address resolves without a cross-chain probe",async()=>{
  const service=new TrackerService(loadConfig(),{tokenInfo:async()=>{throw new Error("should not probe")}} as any);
  assert.deepEqual(await service.resolveTokenChains("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),["sol"]);
});
