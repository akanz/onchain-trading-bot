import assert from "node:assert/strict";
import test from "node:test";
import { gmgnTraderRoiPercent, isCleanGmgnTrendingTrader } from "../src/gmgn-wallet-analysis.js";

const base={address:"0x1111111111111111111111111111111111111111",addr_type:0,history_bought_cost:1000,realized_profit:5000,realized_pnl:5,sell_tx_count_cur:2,buy_tx_count_cur:3,tags:[]};

test("GMGN realized PnL ratio is converted to percent",()=>{
  assert.equal(gmgnTraderRoiPercent({...base,realized_pnl:5}),500);
  assert.equal(gmgnTraderRoiPercent({...base,realized_pnl:.25}),25);
});

test("GMGN trending trader gate requires at least 500 percent ROI",()=>{
  assert.equal(isCleanGmgnTrendingTrader({...base,realized_pnl:4.99},500),false);
  assert.equal(isCleanGmgnTrendingTrader({...base,realized_pnl:5},500),true);
  assert.equal(isCleanGmgnTrendingTrader({...base,tags:["sniper"]},500),false);
});
