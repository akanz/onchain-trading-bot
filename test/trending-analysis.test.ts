import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTrendingCandles } from "../src/trending-analysis.js";

const candles=(closes:number[],volumes:number[])=>closes.map((close,index)=>({
  time:1_000+index*300,
  open:index?closes[index-1]:close*1.002,
  high:close*1.025,
  low:close*.975,
  close,
  volume:volumes[index]!,
}));

test("persistent volume and stable structure can qualify while price is mildly red",()=>{
  const rows=candles([1,.998,.996,.994,.992,.99,.989,.988,.987,.986,.985,.984,.983],[18000,19000,21000,22000,24000,26000,23000,25000,27000,26000,28000,29000,30000]);
  const result=analyzeTrendingCandles(rows,{volume:30000,liquidity:250000,market_cap:450000,buys:42,sells:38,smart_degen_count:3},25000);
  assert.equal(result.multiwindow_passed,true);
  assert.ok(Number(result.price_change_30m)<0);
  assert.ok(Number(result.volume_15m)>=87000);
});

test("a vertical pump with one concentrated volume spike does not pass as stable",()=>{
  const rows=candles([1,1,1.01,1.01,1.02,1.02,1.03,1.04,1.04,1.05,1.06,1.07,1.8],[5000,5000,5500,5000,5200,5100,5000,5500,5200,5100,5300,5000,300000]);
  const result=analyzeTrendingCandles(rows,{volume:300000,liquidity:100000,market_cap:300000,buys:100,sells:12},25000);
  assert.equal(result.pattern,"Vertical run-up");
  assert.equal(result.multiwindow_passed,false);
});

test("a breakdown remains a hard rejection even with sufficient volume",()=>{
  const rows=candles([1,.98,.95,.92,.88,.8,.72,.65,.58,.52,.48,.44,.4],Array(13).fill(30000));
  const result=analyzeTrendingCandles(rows,{volume:30000,liquidity:300000,market_cap:400000,buys:20,sells:50},25000);
  assert.equal(result.pattern,"Breakdown");
  assert.equal(result.multiwindow_passed,false);
});
