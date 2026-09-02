import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDexTrader, parseDexMoney } from "../src/dexscreener/traders.js";

test("DexScreener money parser handles abbreviated values", () => {
  assert.equal(parseDexMoney("$32.8K"), 32_800);
  assert.equal(parseDexMoney("$1.25M"), 1_250_000);
  assert.equal(parseDexMoney("-"), undefined);
});

test("DexScreener trader rows derive realized and total return from cash flows", () => {
  const row = normalizeDexTrader("robinhood", {
    wallet: "0x1111111111111111111111111111111111111111",
    cells: ["#1", "0x1…111", "$1,000\n1M/2 txns", "$6,000\n5M/3 txns", "$5,000", "$1,000"],
  });
  assert.equal(row?.realized_pnl, 5);
  assert.equal(row?.profit_change, 6);
  assert.equal(row?.buy_tx_count_cur, 2);
  assert.equal(row?.sell_tx_count_cur, 3);
});

test("DexScreener trader rows do not merge the USD value with token quantity", () => {
  const row = normalizeDexTrader("robinhood", {
    wallet: "0x1111111111111111111111111111111111111111",
    cells: ["#1", "0x1…111", "$744 426.7K / 3 txns", "$8,539 4.9M / 6 txns", "$7,795", "-"],
  });
  assert.equal(row?.history_bought_cost, 744);
  assert.equal(row?.history_sold_income, 8_539);
  assert.equal(row?.realized_profit, 7_795);
});

test("DexScreener trader rows reject zero-cost and malformed wallets", () => {
  assert.equal(
    normalizeDexTrader("robinhood", {
      wallet: "0x1111111111111111111111111111111111111111",
      cells: ["#1", "wallet", "-", "$5,000", "$5,000", "-"],
    }),
    undefined,
  );
  assert.equal(normalizeDexTrader("sol", { wallet: "bad", cells: [] }), undefined);
});
