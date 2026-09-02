import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEliteGmgnWalletsFromTokenResults,
  gmgnTraderRoiPercent,
  isCleanGmgnTrendingTrader,
} from "../src/gmgn-wallet-analysis.js";

const base = {
  address: "0x1111111111111111111111111111111111111111",
  addr_type: 0,
  history_bought_cost: 1000,
  realized_profit: 5000,
  realized_pnl: 5,
  sell_tx_count_cur: 2,
  buy_tx_count_cur: 3,
  tags: [],
};

test("GMGN strongest realized, unrealized, or total PnL ratio is converted to percent", () => {
  assert.equal(gmgnTraderRoiPercent({ ...base, realized_pnl: 5 }), 500);
  assert.equal(gmgnTraderRoiPercent({ ...base, realized_pnl: 0.25 }), 25);
  assert.equal(gmgnTraderRoiPercent({ ...base, realized_pnl: 0.25, unrealized_pnl: 8 }), 800);
});

test("GMGN trending trader gate requires at least 500 percent ROI", () => {
  assert.equal(isCleanGmgnTrendingTrader({ ...base, realized_pnl: 4.99 }, 500), false);
  assert.equal(isCleanGmgnTrendingTrader({ ...base, realized_pnl: 5 }, 500), true);
  assert.equal(
    isCleanGmgnTrendingTrader(
      { ...base, realized_profit: 0, realized_pnl: 0.1, unrealized_profit: 600, unrealized_pnl: 6 },
      500,
    ),
    true,
  );
  assert.equal(isCleanGmgnTrendingTrader({ ...base, tags: ["sniper"] }, 500), false);
});

test("GMGN elite roster retains every clean high-return trader before repeatability qualification", () => {
  const second = {
      ...base,
      address: "0x2222222222222222222222222222222222222222",
      realized_profit: 0,
      realized_pnl: 0.1,
      unrealized_profit: 1000,
      unrealized_pnl: 7,
    },
    rows = buildEliteGmgnWalletsFromTokenResults([
      {
        chain: "base",
        token: { address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", symbol: "RUN" },
        traders: [
          base,
          second,
          { ...base, address: "0x3333333333333333333333333333333333333333", realized_pnl: 1 },
        ],
      },
    ]);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.every((row) => row.tracking_tier === "elite_observed"),
    true,
  );
  assert.equal(
    rows.find((row) => row.wallet === second.address)?.max_unrealized_position_roi_percent,
    700,
  );
});
