import assert from "node:assert/strict";
import test from "node:test";
import { crossedHistoricalMarketCap, historicalMarketCap } from "../src/market-cap.js";

test("historical market-cap gate keeps retraced runners", () => {
  const token = { market_cap: 120_000, history_highest_market_cap: 1_400_000 };
  assert.equal(historicalMarketCap(token), 1_400_000);
  assert.equal(crossedHistoricalMarketCap(token, 1_000_000), true);
});
test("derives ATH market cap from ATH price and circulating supply", () => {
  assert.equal(
    historicalMarketCap({
      market_cap: 100_000,
      ath_price: 0.002,
      circulating_supply: 1_000_000_000,
    }),
    2_000_000,
  );
});
test("does not mistake a sub-threshold current cap for a historical runner", () => {
  assert.equal(crossedHistoricalMarketCap({ market_cap: 900_000 }, 1_000_000), false);
});
