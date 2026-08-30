import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractContractAddresses, hasTrackedBuyCluster, passesMarketGate, shouldInvestigate, type SignalCandidate } from "../src/signals.js";
import { TrackerStore } from "../src/store.js";
import { TrackerService, rotatingSlice } from "../src/service.js";
import { loadConfig } from "../src/config.js";

const cfg={min_liquidity_usd:50000,min_market_cap_usd:100000,max_market_cap_usd:20000000,min_holders:300,max_top_10_holder_rate:.3,max_dev_team_hold_rate:.1,max_bundler_rate:.15,max_rat_trader_rate:.05,max_entrapment_rate:.15};
const safe={address:"0x1111111111111111111111111111111111111111",liquidity:100000,market_cap:1000000,holder_count:1000,rug_ratio:0,top_10_holder_rate:.2,bundler_rate:.02,rat_trader_amount_rate:.01,entrapment_ratio:.02,is_wash_trading:false,is_honeypot:false};

test("market nomination rejects rugs and accepts complete safe data",()=>{assert.equal(passesMarketGate(safe,cfg).passed,true);assert.equal(passesMarketGate({...safe,rug_ratio:1},cfg).passed,false);});
test("market nomination rejects a 0% top-holder reading and thin relative liquidity",()=>{assert.equal(passesMarketGate({...safe,top_10_holder_rate:0},cfg).passed,false);assert.equal(passesMarketGate({...safe,liquidity:10_000},cfg).passed,false);});
test("Twitter cannot trigger a candidate without capital confirmation",()=>{const c:SignalCandidate={chain:"base",address:safe.address,sources:new Set(["twitter","price_surge"]),sourceIds:new Set(),wallets:new Set(),buyWallets:new Set(),twitterAccounts:new Set(["elonmusk"]),firstTimestamp:1,aggregateBuyUsd:0,market:safe};assert.equal(shouldInvestigate(c,3),false);c.sources.add("smart_money_signal");assert.equal(shouldInvestigate(c,3),true);});
test("tracked-wallet trigger requires three distinct buyers",()=>{const candidate={buyWallets:new Set(["wallet-a"])} as SignalCandidate;assert.equal(hasTrackedBuyCluster(candidate),false);candidate.buyWallets.add("wallet-b");assert.equal(hasTrackedBuyCluster(candidate),false);candidate.buyWallets.add("wallet-c");assert.equal(hasTrackedBuyCluster(candidate),true);candidate.buyWallets.add("wallet-c");assert.equal(candidate.buyWallets.size,3);});
test("qualified KOL activity is capital confirmation",()=>{const c:SignalCandidate={chain:"base",address:safe.address,sources:new Set(["kol_wallet","trending_momentum"]),sourceIds:new Set(),wallets:new Set(["wallet-a"]),buyWallets:new Set(["wallet-a"]),twitterAccounts:new Set(),firstTimestamp:1,aggregateBuyUsd:100,market:safe};assert.equal(shouldInvestigate(c,2),true);});
test("extracts EVM and Solana contract addresses",()=>{const sol="So11111111111111111111111111111111111111112",evm="0x1111111111111111111111111111111111111111";assert.deepEqual(extractContractAddresses(`CA ${sol} and ${evm}`),[evm,sol]);});
test("30-minute trending momentum survives scan cycles",()=>{const dir=mkdtempSync(join(tmpdir(),"trending-price-test-")),store=new TrackerStore(join(dir,"test.sqlite3")),now=2_000_000;try{store.recordTrendingPrice(safe.address,1,now-1800);assert.equal(Math.round(store.trendingPriceChange(safe.address,2,1800,now)??0),100);assert.equal(store.trendingPriceChange("missing",2,1800,now),undefined);}finally{store.close();rmSync(dir,{recursive:true,force:true});}});

test("tracked-wallet fallback batches rotate through the full roster",()=>{
  const wallets=["a","b","c","d","e"];
  assert.deepEqual(rotatingSlice(wallets,0,2),["a","b"]);
  assert.deepEqual(rotatingSlice(wallets,2,2),["c","d"]);
  assert.deepEqual(rotatingSlice(wallets,4,2),["e","a"]);
  assert.deepEqual(rotatingSlice(wallets,1,20),["b","c","d","e","a"]);
});

test("tracked-wallet alerts upgrade from observe to potential to buy signal",async()=>{
  const info={symbol:"BUY",circulating_supply:1_000_000,holder_count:1000,price:{price:.2},stat:{top_10_holder_rate:.2,fresh_wallet_rate:.1}},security={is_honeypot:false,is_blacklist:false,can_not_sell:0,is_open_source:true,is_renounced:true,buy_tax:0,sell_tax:0,top_10_holder_rate:.2,lock_summary:{is_locked:true}},gmgn={tokenInfo:async()=>info,tokenSecurity:async()=>security,tokenPool:async()=>({liquidity:100_000}),tokenHolders:async()=>[]},config={...loadConfig(),default_chain:"robinhood",enabled_chains:["robinhood"]} as any,service=new TrackerService(config,gmgn as any);let count=1;
  (service as any).refreshTwitter=async()=>{};(service as any).refreshFomo=async()=>{};(service as any).collectCandidates=async()=>{const wallets=Array.from({length:count},(_,index)=>`wallet-${index+1}`),candidate:SignalCandidate={chain:"robinhood",address:"0x2222222222222222222222222222222222222222",sources:new Set(["fomo_tracked_wallet"]),sourceIds:new Set(["tx"]),wallets:new Set(wallets),buyWallets:new Set(wallets),traderLabels:new Set(wallets.map((_,index)=>`trader${index+1}`)),twitterAccounts:new Set(),firstTimestamp:Math.floor(Date.now()/1000)-10,aggregateBuyUsd:500*count};return new Map([[candidate.address,candidate]]);};
  const [observe]=await service.scan("robinhood");count=2;const [potential]=await service.scan("robinhood");count=3;const [signal]=await service.scan("robinhood");
  assert.deepEqual([observe?.kind,potential?.kind,signal?.kind],["TRACKED_WALLET_OBSERVE","TRACKED_WALLET_POTENTIAL","TRACKED_WALLET_BUY_SIGNAL"]);
  assert.deepEqual([observe?.tracking_label,potential?.tracking_label,signal?.tracking_label],["OBSERVE","POTENTIAL","BUY SIGNAL"]);
  assert.equal(observe?.traders[0],"trader1");
  assert.equal(observe?.market_cap_at_detection,200_000);
  assert.equal(observe?.liquidity_to_market_cap_ratio,.5);
  await service.close();
});

test("direct Fomo buy alerts survive an unavailable GMGN market feed",async()=>{
  const address="0x3333333333333333333333333333333333333333",info={symbol:"BUY",circulating_supply:1_000_000,holder_count:1000,price:{price:.2},stat:{top_10_holder_rate:.2,fresh_wallet_rate:.1}},security={is_honeypot:false,is_blacklist:false,can_not_sell:0,is_open_source:true,is_renounced:true,buy_tax:0,sell_tax:0,top_10_holder_rate:.2,lock_summary:{is_locked:true}},gmgn={tokenInfo:async()=>info,tokenSecurity:async()=>security,tokenPool:async()=>({liquidity:100_000}),tokenHolders:async()=>[]},service=new TrackerService({...loadConfig(),default_chain:"robinhood",enabled_chains:["robinhood"]} as any,gmgn as any),now=Math.floor(Date.now()/1000);
  (service as any).refreshTwitter=async()=>{};(service as any).refreshFomo=async()=>{};(service as any).collectCandidates=async()=>{throw new Error("market feed unavailable");};(service as any).fomoActivity.set("robinhood",[{chain:"robinhood",wallet:"0x4444444444444444444444444444444444444444",tokenAddress:address,timestamp:now-5,amount_usd:250,fomo_handle:"traderA",discovery_sources:[]}]);
  const [alert]=await service.scan("robinhood");
  assert.equal(alert?.kind,"TRACKED_WALLET_OBSERVE");
  assert.deepEqual(alert?.traders,["traderA"]);
  assert.equal(alert?.market_cap_at_detection,200_000);
  await service.close();
});

test("direct Fomo buy alerts fail closed when safety data is unavailable",async()=>{
  const address="0x5555555555555555555555555555555555555555",unavailable=async()=>{throw new Error("GMGN unavailable");},gmgn={tokenInfo:unavailable,tokenSecurity:unavailable,tokenPool:unavailable},service=new TrackerService({...loadConfig(),default_chain:"robinhood",enabled_chains:["robinhood"]} as any,gmgn as any),now=Math.floor(Date.now()/1000);
  (service as any).refreshTwitter=async()=>{};(service as any).refreshFomo=async()=>{};(service as any).collectCandidates=async()=>{throw new Error("market feed unavailable");};(service as any).fomoActivity.set("robinhood",[{chain:"robinhood",wallet:"0x6666666666666666666666666666666666666666",tokenAddress:address,timestamp:now-5,amount_usd:250,fomo_handle:"traderA",discovery_sources:[]}]);
  assert.deepEqual(await service.scan("robinhood"),[]);
  const stats=service.diagnostics(["robinhood"]).robinhood.tracked_buy_safety;
  assert.equal(stats.suppressed,1);assert.equal(stats.unavailable,1);
  await service.close();
});

test("trending delivery emits fresh and strengthened events without repeating stale rows",async()=>{
  const service=new TrackerService({...loadConfig(),default_chain:"base",enabled_chains:["base"]} as any),address="0x7777777777777777777777777777777777777777",row:any={chain:"base",address,symbol:"MOVE",price:1,quality_passed:true,multiwindow_passed:true,multiwindow_score:80,price_change_5m:2,price_change_30m:5,signal_sources:[]};
  (service as any).trendingRows.set("base",[row]);
  const first=await service.latestTrendingAcross(["base"],10);assert.equal(first.length,1);assert.deepEqual(first[0]?.trending_signal_tags,["NEW","PRICE UP"]);service.acknowledgeTrending(first);
  assert.deepEqual(await service.latestTrendingAcross(["base"],10),[]);
  row.signal_sources=["smart_money_signal"];const smart=await service.latestTrendingAcross(["base"],10);assert.equal(smart.length,1);assert.ok(smart[0]?.trending_signal_tags.includes("SMART MONEY BUY"));service.acknowledgeTrending(smart);
  assert.deepEqual(await service.latestTrendingAcross(["base"],10),[]);
  await service.close();
});
