import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractContractAddresses, hasTrackedBuyCluster, passesMarketGate, shouldInvestigate, type SignalCandidate } from "../src/signals.js";
import { TrackerStore } from "../src/store.js";

const cfg={min_liquidity_usd:50000,min_market_cap_usd:100000,max_market_cap_usd:20000000,min_holders:300,max_top_10_holder_rate:.3,max_dev_team_hold_rate:.1,max_bundler_rate:.15,max_rat_trader_rate:.05,max_entrapment_rate:.15};
const safe={address:"0x1111111111111111111111111111111111111111",liquidity:100000,market_cap:1000000,holder_count:1000,rug_ratio:0,top_10_holder_rate:.2,bundler_rate:.02,rat_trader_amount_rate:.01,entrapment_ratio:.02,is_wash_trading:false,is_honeypot:false};

test("market nomination rejects rugs and accepts complete safe data",()=>{assert.equal(passesMarketGate(safe,cfg).passed,true);assert.equal(passesMarketGate({...safe,rug_ratio:1},cfg).passed,false);});
test("Twitter cannot trigger a candidate without capital confirmation",()=>{const c:SignalCandidate={chain:"base",address:safe.address,sources:new Set(["twitter","price_surge"]),sourceIds:new Set(),wallets:new Set(),buyWallets:new Set(),twitterAccounts:new Set(["elonmusk"]),firstTimestamp:1,aggregateBuyUsd:0,market:safe};assert.equal(shouldInvestigate(c,3),false);c.sources.add("smart_money_signal");assert.equal(shouldInvestigate(c,3),true);});
test("tracked-wallet trigger requires three distinct buyers",()=>{const candidate={buyWallets:new Set(["wallet-a"])} as SignalCandidate;assert.equal(hasTrackedBuyCluster(candidate),false);candidate.buyWallets.add("wallet-b");assert.equal(hasTrackedBuyCluster(candidate),false);candidate.buyWallets.add("wallet-c");assert.equal(hasTrackedBuyCluster(candidate),true);candidate.buyWallets.add("wallet-c");assert.equal(candidate.buyWallets.size,3);});
test("qualified KOL activity is capital confirmation",()=>{const c:SignalCandidate={chain:"base",address:safe.address,sources:new Set(["kol_wallet","trending_momentum"]),sourceIds:new Set(),wallets:new Set(["wallet-a"]),buyWallets:new Set(["wallet-a"]),twitterAccounts:new Set(),firstTimestamp:1,aggregateBuyUsd:100,market:safe};assert.equal(shouldInvestigate(c,2),true);});
test("extracts EVM and Solana contract addresses",()=>{const sol="So11111111111111111111111111111111111111112",evm="0x1111111111111111111111111111111111111111";assert.deepEqual(extractContractAddresses(`CA ${sol} and ${evm}`),[evm,sol]);});
test("30-minute trending momentum survives scan cycles",()=>{const dir=mkdtempSync(join(tmpdir(),"trending-price-test-")),store=new TrackerStore(join(dir,"test.sqlite3")),now=2_000_000;try{store.recordTrendingPrice(safe.address,1,now-1800);assert.equal(Math.round(store.trendingPriceChange(safe.address,2,1800,now)??0),100);assert.equal(store.trendingPriceChange("missing",2,1800,now),undefined);}finally{store.close();rmSync(dir,{recursive:true,force:true});}});
