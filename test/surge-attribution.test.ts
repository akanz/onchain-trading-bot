import assert from "node:assert/strict";
import test from "node:test";
import {
  assessWalletPerformance,
  detectSurgeEvents,
  profitablePreMoveTrader,
} from "../src/surge-attribution.js";
import { TrackerService } from "../src/service.js";
import { hasCapitalConfirmation, signalStrength, type SignalCandidate } from "../src/signals.js";

test("detects and merges a volume-confirmed expansion after sideways trading", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
      time: 1_000 + index * 60,
      open: index === 7 ? 1 : index === 8 ? 1.2 : 1,
      high: index === 7 ? 1.2 : index === 8 ? 1.5 : 1.02,
      low: 0.99,
      close: index === 7 ? 1.2 : index === 8 ? 1.5 : 1,
      volume: index >= 7 ? 600 : 100,
    })),
    [event] = detectSurgeEvents(rows);
  assert.equal(event?.kind, "SIDEWAYS BREAKOUT");
  assert.equal(event?.started_at, 1_420);
  assert.equal(event?.ended_at, 1_540);
  assert.ok(Number(event?.price_change_percent) > 45);
});

test("detects a volume-confirmed reversal after a sharp drawdown", () => {
  const rows = [1, 1, 0.95, 0.8, 0.65, 0.6, 0.6, 0.78].map((close, index) => ({
      time: 2_000 + index * 60,
      open: index === 7 ? 0.6 : close,
      high: index === 0 ? 1.05 : Math.max(close, index === 7 ? 0.78 : close),
      low: Math.min(close, index === 7 ? 0.59 : close),
      close,
      volume: index === 7 ? 700 : 100,
    })),
    [event] = detectSurgeEvents(rows);
  assert.equal(event?.kind, "DIP REVERSAL");
  assert.equal(event?.started_at, 2_420);
});

test("attributes only clean wallets with explicit realized or unrealized ROI above 300 percent", () => {
  const event = {
      started_at: 10_000,
      ended_at: 10_060,
      kind: "SIDEWAYS BREAKOUT" as const,
      price_change_percent: 30,
      volume_usd: 1000,
      volume_ratio: 5,
      prior_range_percent: 4,
      prior_drawdown_percent: 0,
    },
    base = {
      address: "wallet",
      addr_type: 0,
      is_suspicious: false,
      transfer_in: false,
      is_new: false,
      history_bought_cost: 200,
      realized_profit: 800,
      unrealized_profit: 0,
      realized_pnl: 4,
      unrealized_pnl: 0,
      profit_change: 4,
      buy_tx_count_cur: 1,
      sell_tx_count_cur: 1,
      start_holding_at: 9_500,
      tags: [],
      maker_token_tags: [],
    };
  assert.equal(profitablePreMoveTrader(base, event)?.position_roi_percent, 400);
  assert.equal(
    profitablePreMoveTrader(
      { ...base, realized_pnl: 2.9, unrealized_pnl: 2.8, profit_change: 8 },
      event,
    ),
    undefined,
  );
  assert.equal(
    profitablePreMoveTrader({ ...base, maker_token_tags: ["bundler"] }, event),
    undefined,
  );
});

test("wallet-wide quality requires 200 percent ROI in both windows and enough trades", () => {
  const pass = assessWalletPerformance(
    { realized_profit: 3000, realized_profit_cost: 1000, buy: 12, sell: 10 },
    { total_realized_profit: 9000, total_realized_profit_cost: 3000 },
  );
  assert.equal(pass.worth_tracking, true);
  const fail = assessWalletPerformance(
    { realized_profit: 1000, realized_profit_cost: 1000, buy: 12, sell: 10 },
    { total_realized_profit: 9000, total_realized_profit_cost: 3000 },
  );
  assert.equal(fail.worth_tracking, false);
  assert.match(fail.reasons.join(" "), /30d/);
});

test("live surge enrichment requires a confirmed buy near the move before global checks", async () => {
  const now = Math.floor(Date.now() / 1000),
    candles = Array.from({ length: 8 }, (_, index) => ({
      time: now - 420 + index * 60,
      open: index === 7 ? 1 : 1,
      high: index === 7 ? 1.4 : 1.01,
      low: 0.99,
      close: index === 7 ? 1.4 : 1,
      volume: index === 7 ? 1000 : 100,
    })),
    wallet = "WAGnxdsjB9zPqi8H84eKTwxuQGxmCVrhFyS4tf1r664",
    gmgn = {
      cooldownUntil: 0,
      kline: async () => candles,
      tokenTraders: async () => [
        {
          address: wallet,
          addr_type: 0,
          is_suspicious: false,
          transfer_in: false,
          is_new: false,
          history_bought_cost: 200,
          realized_profit: 800,
          unrealized_profit: 0,
          realized_pnl: 4,
          unrealized_pnl: 0,
          profit_change: 4,
          buy_tx_count_cur: 1,
          sell_tx_count_cur: 1,
          start_holding_at: now - 600,
          tags: [],
          maker_token_tags: [],
        },
      ],
      walletTokenActivity: async () => [{ event_type: "buy", timestamp: now - 60, cost_usd: 250 }],
      walletProfits: async (_chain: string, _wallets: string[], period: string) =>
        period === "30d"
          ? [
              {
                wallet_address: wallet,
                realized_profit: 3000,
                realized_profit_cost: 1000,
                buy: 12,
                sell: 10,
              },
            ]
          : [
              {
                wallet_address: wallet,
                total_realized_profit: 9000,
                total_realized_profit_cost: 3000,
              },
            ],
    },
    service = new TrackerService(
      { default_chain: "sol", enabled_chains: ["sol"] } as any,
      gmgn as any,
    ),
    candidate: SignalCandidate = {
      chain: "sol",
      address: "9EmtjLFXwWSz828eyLunxmoWZNdoEjpw1nbxsEwGpump",
      sources: new Set(["price_surge"]),
      sourceIds: new Set(),
      wallets: new Set(),
      buyWallets: new Set(),
      twitterAccounts: new Set(),
      firstTimestamp: now,
      aggregateBuyUsd: 0,
      market: { volume_1m: 1000 },
    };
  await (service as any).enrichSurgeAttributions("sol", new Map([[candidate.address, candidate]]));
  assert.equal(candidate.surgeAttribution?.track_worthy_wallets, 1);
  assert.equal(candidate.surgeAttribution?.wallets?.[0]?.confirmed_buy_usd, 250);
  assert.ok(candidate.sources.has("profitable_surge_wallet"));
  assert.equal(hasCapitalConfirmation(candidate), true);
  assert.equal(signalStrength(candidate), 4);
});
