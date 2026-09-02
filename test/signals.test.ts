import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractContractAddresses,
  hasTrackedBuyCluster,
  isCatastrophicMarketCapCollapse,
  passesMarketGate,
  passesSurgeDiscoveryGate,
  shouldInvestigate,
  type SignalCandidate,
} from "../src/signals.js";
import { TrackerStore } from "../src/store.js";
import {
  isSurgedToken,
  passesHighMarketCapPolicy,
  potentialRunnerScore,
  priorityChainSlice,
  TrackerService,
  rotatingSlice,
} from "../src/service.js";
import { loadConfig } from "../src/config.js";
import { GmgnRateLimitError } from "../src/gmgn.js";

const cfg = {
  min_liquidity_usd: 50000,
  min_market_cap_usd: 100000,
  max_market_cap_usd: 20000000,
  min_holders: 300,
  max_top_10_holder_rate: 0.3,
  max_dev_team_hold_rate: 0.1,
  max_bundler_rate: 0.15,
  max_rat_trader_rate: 0.05,
  max_entrapment_rate: 0.15,
};
const safe = {
  address: "0x1111111111111111111111111111111111111111",
  liquidity: 100000,
  market_cap: 1000000,
  holder_count: 1000,
  rug_ratio: 0,
  top_10_holder_rate: 0.2,
  bundler_rate: 0.02,
  rat_trader_amount_rate: 0.01,
  entrapment_ratio: 0.02,
  is_wash_trading: false,
  is_honeypot: false,
};

test("market nomination rejects rugs and accepts complete safe data", () => {
  assert.equal(passesMarketGate(safe, cfg).passed, true);
  assert.equal(passesMarketGate({ ...safe, rug_ratio: 1 }, cfg).passed, false);
});
test("market nomination rejects a 0% top-holder reading and thin relative liquidity", () => {
  assert.equal(passesMarketGate({ ...safe, top_10_holder_rate: 0 }, cfg).passed, false);
  assert.equal(passesMarketGate({ ...safe, liquidity: 10_000 }, cfg).passed, false);
});
test("early surge discovery admits a complete liquid microcap but rejects absurd market data", () => {
  const earlyCfg = {
      ...cfg,
      min_liquidity_to_market_cap_ratio: 0.05,
      tracked_alert_min_liquidity_usd: 500,
      tracked_alert_min_liquidity_to_market_cap_ratio: 0.01,
      tracked_alert_max_liquidity_to_market_cap_ratio: 10,
      tracked_alert_min_market_cap_usd: 5000,
      tracked_alert_min_holders: 10,
      tracked_alert_max_top_10_holder_rate: 0.3,
    },
    row = {
      market_cap: 70_000,
      liquidity: 19_000,
      holder_count: 722,
      top_10_holder_rate: 0.17,
      rug_ratio: 0.1,
      is_wash_trading: false,
    };
  assert.equal(passesMarketGate(row, earlyCfg).passed, false);
  assert.equal(passesSurgeDiscoveryGate(row, earlyCfg).passed, true);
  assert.equal(passesSurgeDiscoveryGate({ ...row, top_10_holder_rate: 0 }, earlyCfg).passed, false);
  assert.equal(
    passesSurgeDiscoveryGate({ ...row, top_10_holder_rate: 0.4 }, earlyCfg).passed,
    false,
  );
  assert.equal(passesSurgeDiscoveryGate({ ...row, market_cap: 1 }, earlyCfg).passed, false);
  assert.equal(
    passesSurgeDiscoveryGate({ ...row, market_cap: 5000, liquidity: 100_000 }, earlyCfg).passed,
    false,
  );
});
test("catastrophic market-cap collapse means more than a 99% loss", () => {
  assert.equal(isCatastrophicMarketCapCollapse(100_000, 1_000), false);
  assert.equal(isCatastrophicMarketCapCollapse(100_000, 999), true);
  assert.equal(isCatastrophicMarketCapCollapse(undefined, 1), false);
});
test("Twitter cannot trigger a candidate without capital confirmation", () => {
  const c: SignalCandidate = {
    chain: "base",
    address: safe.address,
    sources: new Set(["twitter", "price_surge"]),
    sourceIds: new Set(),
    wallets: new Set(),
    buyWallets: new Set(),
    twitterAccounts: new Set(["elonmusk"]),
    firstTimestamp: 1,
    aggregateBuyUsd: 0,
    market: safe,
  };
  assert.equal(shouldInvestigate(c, 3), false);
  c.sources.add("smart_money_signal");
  assert.equal(shouldInvestigate(c, 3), true);
});
test("tracked-wallet trigger requires three distinct buyers", () => {
  const candidate = { buyWallets: new Set(["wallet-a"]) } as SignalCandidate;
  assert.equal(hasTrackedBuyCluster(candidate), false);
  candidate.buyWallets.add("wallet-b");
  assert.equal(hasTrackedBuyCluster(candidate), false);
  candidate.buyWallets.add("wallet-c");
  assert.equal(hasTrackedBuyCluster(candidate), true);
  candidate.buyWallets.add("wallet-c");
  assert.equal(candidate.buyWallets.size, 3);
});
test("qualified KOL activity is capital confirmation", () => {
  const c: SignalCandidate = {
    chain: "base",
    address: safe.address,
    sources: new Set(["kol_wallet", "trending_momentum"]),
    sourceIds: new Set(),
    wallets: new Set(["wallet-a"]),
    buyWallets: new Set(["wallet-a"]),
    twitterAccounts: new Set(),
    firstTimestamp: 1,
    aggregateBuyUsd: 100,
    market: safe,
  };
  assert.equal(shouldInvestigate(c, 2), true);
});
test("extracts EVM and Solana contract addresses", () => {
  const sol = "So11111111111111111111111111111111111111112",
    evm = "0x1111111111111111111111111111111111111111";
  assert.deepEqual(extractContractAddresses(`CA ${sol} and ${evm}`), [evm, sol]);
});
test("30-minute trending momentum survives scan cycles", () => {
  const dir = mkdtempSync(join(tmpdir(), "trending-price-test-")),
    store = new TrackerStore(join(dir, "test.sqlite3")),
    now = 2_000_000;
  try {
    store.recordTrendingPrice(safe.address, 1, now - 1800);
    assert.equal(Math.round(store.trendingPriceChange(safe.address, 2, 1800, now) ?? 0), 100);
    assert.equal(store.trendingPriceChange("missing", 2, 1800, now), undefined);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracked-wallet fallback batches rotate through the full roster", () => {
  const wallets = ["a", "b", "c", "d", "e"];
  assert.deepEqual(rotatingSlice(wallets, 0, 2), ["a", "b"]);
  assert.deepEqual(rotatingSlice(wallets, 2, 2), ["c", "d"]);
  assert.deepEqual(rotatingSlice(wallets, 4, 2), ["e", "a"]);
  assert.deepEqual(rotatingSlice(wallets, 1, 20), ["b", "c", "d", "e", "a"]);
});

test("cross-chain feeds reserve and display Robinhood, BSC, then Solana", () => {
  const rows = [
    ...Array.from({ length: 8 }, (_, i) => ({ chain: "sol", address: `sol-${i}` })),
    ...Array.from({ length: 8 }, (_, i) => ({ chain: "bsc", address: `bsc-${i}` })),
    ...Array.from({ length: 8 }, (_, i) => ({ chain: "robinhood", address: `rh-${i}` })),
  ] as any[];
  const selected = priorityChainSlice(rows, 10);
  assert.equal(selected.filter((row) => row.chain === "robinhood").length, 5);
  assert.equal(selected.filter((row) => row.chain === "bsc").length, 3);
  assert.equal(selected.filter((row) => row.chain === "sol").length, 2);
  assert.deepEqual([...new Set(selected.map((row) => row.chain))], ["robinhood", "bsc", "sol"]);
});
test("surges are separated from scored pre-run candidates", () => {
  const surge = { degen_signal_labels: ["PRICE SURGE"], price_change_5m: 40, is_microcap: true },
    potential = {
      degen_signal_labels: ["NEAR GRADUATION"],
      is_microcap: true,
      volume: 50_000,
      holder_count: 100,
      top_10_holder_rate: 0.2,
    };
  assert.equal(isSurgedToken(surge), true);
  assert.equal(potentialRunnerScore(surge), 0);
  assert.equal(isSurgedToken(potential), false);
  assert.ok(potentialRunnerScore(potential) >= 45);
});
test("routine feeds suppress mature tokens unless they surge or have two tracked buyers", () => {
  const mature = {
    market_cap: 36_400_000,
    price_change_5m: 1.5,
    degen_signal_labels: [],
    signal_sources: [],
  };
  assert.equal(passesHighMarketCapPolicy(mature), false);
  assert.equal(passesHighMarketCapPolicy({ ...mature, price_change_5m: 20 }), true);
  assert.equal(passesHighMarketCapPolicy({ ...mature, tracked_buy_wallet_count: 2 }), true);
});

test("tracked-wallet fallback stops on rate limit without discarding core scan state", async () => {
  let calls = 0;
  const gmgn = {
      followedWallets: async () => [],
      walletActivity: async () => {
        calls++;
        throw new GmgnRateLimitError("limited", Date.now() + 30_000);
      },
    },
    service = new TrackerService(
      { ...loadConfig(), default_chain: "sol", enabled_chains: ["sol"] } as any,
      gmgn as any,
    );
  (service as any).mongoTrackedWalletRows = [
    { source: "gmgn", chain: "sol", wallet: "wallet-a", tracking_tier: "qualified" },
    { source: "gmgn", chain: "sol", wallet: "wallet-b", tracking_tier: "qualified" },
  ];
  await (service as any).collectWalletSignals("sol", new Map());
  assert.equal(calls, 1);
  await service.close();
});

test("dedicated wallet monitor suppresses a single-wallet buy", async () => {
  const token = "0x9999999999999999999999999999999999999999",
    wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    now = Math.floor(Date.now() / 1000),
    info = {
      symbol: "EARLY",
      circulating_supply: 1_000_000,
      holder_count: 100,
      price: { price: 0.02 },
      stat: { top_10_holder_rate: 0.2 },
    },
    security = {
      is_honeypot: false,
      is_blacklist: false,
      can_not_sell: 0,
      is_open_source: true,
      is_renounced: true,
      buy_tax: 0,
      sell_tax: 0,
      top_10_holder_rate: 0.2,
      lock_summary: { is_locked: true },
    },
    gmgn = {
      followedWallets: async () => [],
      walletActivity: async (_chain: string, scanned: string) =>
        scanned === wallet
          ? [{ event_type: "buy", token_address: token, timestamp: now - 5, cost_usd: 200 }]
          : [],
      tokenInfo: async () => info,
      tokenSecurity: async () => security,
      tokenPool: async () => ({ liquidity: 5_000 }),
    },
    service = new TrackerService(
      { ...loadConfig(), default_chain: "robinhood", enabled_chains: ["robinhood"] } as any,
      gmgn as any,
    );
  (service as any).mongoTrackedWalletRows = [
    {
      source: "gmgn",
      chain: "robinhood",
      wallet,
      name: "alphaTrader",
      tracking_tier: "qualified",
      score: 1_000_000_000,
    },
  ];
  service.invalidateTrackedWalletCache();
  const alerts = await service.scanTrackedWallets("robinhood");
  assert.deepEqual(alerts, []);
  await service.close();
});

test("tracked-wallet alerts require two buyers and upgrade through research", async () => {
  const info = {
      symbol: "BUY",
      circulating_supply: 1_000_000,
      holder_count: 1000,
      price: { price: 0.2 },
      stat: { top_10_holder_rate: 0.2, fresh_wallet_rate: 0.1 },
    },
    security = {
      is_honeypot: false,
      is_blacklist: false,
      can_not_sell: 0,
      is_open_source: true,
      is_renounced: true,
      buy_tax: 0,
      sell_tax: 0,
      top_10_holder_rate: 0.2,
      lock_summary: { is_locked: true },
    },
    gmgn = {
      tokenInfo: async () => info,
      tokenSecurity: async () => security,
      tokenPool: async () => ({ liquidity: 100_000 }),
      tokenHolders: async () => [],
    },
    config = { ...loadConfig(), default_chain: "robinhood", enabled_chains: ["robinhood"] } as any,
    service = new TrackerService(config, gmgn as any);
  let count = 1;
  (service as any).refreshTwitter = async () => {};
  (service as any).collectCandidates = async () => {
    const wallets = Array.from({ length: count }, (_, index) => `wallet-${index + 1}`),
      candidate: SignalCandidate = {
        chain: "robinhood",
        address: "0x2222222222222222222222222222222222222222",
        sources: new Set(["fomo_tracked_wallet"]),
        sourceIds: new Set(["tx"]),
        wallets: new Set(wallets),
        buyWallets: new Set(wallets),
        traderLabels: new Set(wallets.map((_, index) => `trader${index + 1}`)),
        twitterAccounts: new Set(),
        firstTimestamp: Math.floor(Date.now() / 1000) - 10,
        aggregateBuyUsd: 500 * count,
      };
    return new Map([[candidate.address, candidate]]);
  };
  const suppressed = await service.scan("robinhood");
  count = 2;
  const [observe] = await service.scan("robinhood");
  count = 3;
  const [research] = await service.scan("robinhood");
  count = 5;
  const [signal] = await service.scan("robinhood");
  assert.equal(
    suppressed.some((row) => String(row.kind ?? "").startsWith("TRACKED_WALLET_")),
    false,
  );
  assert.deepEqual(
    [observe?.kind, research?.kind, signal?.kind],
    ["TRACKED_WALLET_OBSERVE", "TRACKED_WALLET_POTENTIAL", "TRACKED_WALLET_BUY_SIGNAL"],
  );
  assert.deepEqual(
    [observe?.tracking_label, research?.tracking_label, signal?.tracking_label],
    ["OBSERVE", "RESEARCH", "BUY SIGNAL"],
  );
  assert.equal(observe?.traders[0], "trader1");
  assert.equal(observe?.market_cap_at_detection, 200_000);
  assert.equal(observe?.liquidity_to_market_cap_ratio, 0.5);
  await service.close();
});

test("tracked-wallet sells produce an exit observation without becoming a buy signal", async () => {
  const address = "0x8888888888888888888888888888888888888888",
    info = {
      symbol: "EXIT",
      circulating_supply: 1_000_000,
      holder_count: 1000,
      price: { price: 0.2 },
      stat: { top_10_holder_rate: 0.2 },
    },
    security = {
      is_honeypot: false,
      is_blacklist: false,
      can_not_sell: 0,
      is_open_source: true,
      is_renounced: true,
      buy_tax: 0,
      sell_tax: 0,
      top_10_holder_rate: 0.2,
      lock_summary: { is_locked: true },
    },
    gmgn = {
      tokenInfo: async () => info,
      tokenSecurity: async () => security,
      tokenPool: async () => ({ liquidity: 20_000 }),
      tokenHolders: async () => [],
    },
    service = new TrackerService(
      { ...loadConfig(), default_chain: "robinhood", enabled_chains: ["robinhood"] } as any,
      gmgn as any,
    ),
    now = Math.floor(Date.now() / 1000);
  (service as any).refreshTwitter = async () => {};
  let sellCount = 1;
  (service as any).collectCandidates = async () => {
    const candidate: any = {
      chain: "robinhood",
      address,
      sources: new Set(),
      sellSources: new Set(["fomo_tracked_wallet"]),
      sourceIds: new Set(),
      wallets: new Set(),
      buyWallets: new Set(),
      sellWallets: new Set(["wallet-a", "wallet-b"].slice(0, sellCount)),
      traderLabels: new Set(),
      sellTraderLabels: new Set(["traderA", "traderB"].slice(0, sellCount)),
      twitterAccounts: new Set(),
      firstTimestamp: now - 5,
      aggregateBuyUsd: 0,
      aggregateSellUsd: 900,
    };
    return new Map([[address, candidate]]);
  };
  const suppressed = await service.scan("robinhood");
  assert.deepEqual(suppressed, []);
  sellCount = 2;
  const [alert] = await service.scan("robinhood");
  assert.equal(alert?.kind, "TRACKED_WALLET_SELL");
  assert.equal(alert?.tracking_label, "OBSERVE");
  assert.deepEqual(alert?.traders, ["traderA", "traderB"]);
  assert.equal(alert?.aggregate_sell_usd, 900);
  assert.equal(alert?.tracked_buy_wallet_count, undefined);
  await service.close();
});

test("trending delivery emits fresh and strengthened events without repeating stale rows", async () => {
  const service = new TrackerService({
      ...loadConfig(),
      default_chain: "base",
      enabled_chains: ["base"],
    } as any),
    address = "0x7777777777777777777777777777777777777777",
    row: any = {
      chain: "base",
      address,
      symbol: "MOVE",
      price: 1,
      quality_passed: true,
      multiwindow_passed: true,
      multiwindow_score: 80,
      price_change_5m: 2,
      price_change_30m: 5,
      signal_sources: [],
    };
  (service as any).trendingRows.set("base", [row]);
  const first = await service.latestTrendingAcross(["base"], 10);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0]?.trending_signal_tags, ["NEW", "PRICE UP"]);
  service.acknowledgeTrending(first);
  assert.deepEqual(await service.latestTrendingAcross(["base"], 10), []);
  row.signal_sources = ["smart_money_signal"];
  const smart = await service.latestTrendingAcross(["base"], 10);
  assert.equal(smart.length, 1);
  assert.ok(smart[0]?.trending_signal_tags.includes("SMART MONEY BUY"));
  service.acknowledgeTrending(smart);
  assert.deepEqual(await service.latestTrendingAcross(["base"], 10), []);
  await service.close();
});
