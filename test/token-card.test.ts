import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAlert,
  formatDegenDigest,
  formatPotentialDigest,
  formatSuppressedTokens,
  formatSurgedDigest,
  formatTokenCard,
  formatTrackingStatus,
  formatTrendingDigest,
} from "../src/format.js";
import { buildTokenSnapshot } from "../src/token-card.js";
import { newcomerGuide, onboarding } from "../src/telegram.js";

const verdict = { passed: true, score: 100, reasons: ["PASS honeypot check passed"], warnings: [] };

test("token card derives market data and renders a tangible potential-call alert", () => {
  const snapshot = buildTokenSnapshot(
    "robinhood",
    "0x56910D4409F3a0C78C64DD8D0545FF0705389870",
    {
      name: "The <Index>",
      symbol: "Index",
      holder_count: 18665,
      circulating_supply: "1000000000",
      max_supply: "1000000000",
      liquidity: "769094",
      price: {
        price: "0.02",
        price_1h: "0.019",
        price_24h: "0.022",
        volume_5m: "12899",
        volume_1h: "139579",
        volume_24h: "3123414",
        buys_1h: 134,
        sells_1h: 86,
      },
      pool: {
        pool_address: "0xpool",
        exchange: "uniswap_v3",
        creation_timestamp: Math.floor(Date.now() / 1000) - 86400,
      },
      stat: { fresh_wallet_rate: "0.05" },
      wallet_tags_stat: { smart_wallets: 7 },
      link: { gmgn: "https://gmgn.ai/token", website: "javascript:alert(1)" },
    },
    {
      is_honeypot: false,
      is_open_source: true,
      is_renounced: true,
      top_10_holder_rate: "0.125",
      buy_tax: "0",
      sell_tax: "0",
      lock_summary: { is_locked: true },
    },
    {
      pool_address: "0xpool",
      exchange: "uniswap_v3",
      liquidity: "769094",
      creation_timestamp: Math.floor(Date.now() / 1000) - 86400,
    },
    [],
    verdict,
  );
  assert.equal(snapshot.marketCap, 20_000_000);
  assert.ok((snapshot.priceChange24h ?? 0) < -9);
  const message = formatAlert({
    tier: "CALL",
    chain: "robinhood",
    address: snapshot.address,
    token_snapshot: snapshot,
    sources: ["smart_money_wallet"],
    signal_strength: 5,
    wallet_count: 3,
    aggregate_buy_usd: 12000,
  });
  assert.match(message, /POTENTIAL CALL/);
  assert.match(message, /MCap: \$20M/);
  assert.match(message, /24h \$3\.1M/);
  assert.match(message, /Top 10: 12\.5%/);
  assert.match(message, /Largest holders: unavailable/);
  assert.match(message, /smart money wallet/);
  assert.match(message, /🚀 <b>POTENTIAL CALL/);
  assert.doesNotMatch(message, /⚠️/);
  assert.doesNotMatch(message, /<Index>/);
  assert.doesNotMatch(message, /javascript:/);
  assert.ok(message.length < 4096);
});

test("degen digest labels rejected microcaps and splits long feeds", () => {
  const rows = Array.from({ length: 13 }, (_, index) => ({
    chain: index % 2 ? "bsc" : "sol",
    symbol: `MICRO${index + 1}`,
    address: `0x${String(index + 1).padStart(40, "0")}`,
    market_cap: 50_000 + index,
    liquidity: 8_000,
    volume: 20_000,
    price_change_percent5m: 35,
    swaps: 90,
    degen_sources: index === 0 ? ["FILTERED TRENDING", "PRICE SURGE"] : ["FILTERED TRENDING"],
    quality_reasons: ["liquidity below $50000", "fewer than 300 holders"],
  }));
  const messages = formatDegenDigest(["sol", "bsc"], rows);
  assert.equal(messages.length, 2);
  assert.match(messages[0]!, /HIGH-RISK DISCOVERY/);
  assert.match(messages[0]!, /highlights ≤ \$100K/);
  assert.match(messages[0]!, /PRICE SURGE/);
  assert.match(messages[0]!, /failed normal filters/);
  assert.doesNotMatch(messages[0]!, /⚠️/);
  assert.match(messages[1]!, /MICRO13/);
  assert.ok(messages.every((message) => message.length < 4096));
});

test("discovery rows reserve the warning emoji for explicit rug evidence", () => {
  const [message] = formatDegenDigest(
    ["base"],
    [
      {
        chain: "base",
        symbol: "TRAP",
        address: "0x3333333333333333333333333333333333333333",
        market_cap: 80_000,
        liquidity: 60_000,
        volume: 20_000,
        price_change_percent5m: 5,
        swaps: 20,
        degen_sources: ["FILTERED TRENDING"],
        quality_reasons: ["honeypot detected", "fewer than 300 holders"],
      },
    ],
  );
  assert.match(message!, /⚠️ Rug-risk evidence: honeypot detected/);
});

test("early discovery cards show confirmed surge-wallet quality", () => {
  const [message] = formatDegenDigest(
    ["sol"],
    [
      {
        chain: "sol",
        symbol: "MOVE",
        address: "9EmtjLFXwWSz828eyLunxmoWZNdoEjpw1nbxsEwGpump",
        market_cap: 70_000,
        liquidity: 19_000,
        volume: 18_000,
        price_change_percent5m: 60,
        swaps: 100,
        is_microcap: true,
        degen_sources: ["PRICE SURGE"],
        quality_reasons: ["market cap outside configured range"],
        surge_attribution: {
          event: { kind: "SIDEWAYS BREAKOUT", price_change_percent: 60, volume_ratio: 5 },
          wallets: [
            {
              wallet: "WAGnxdsjB9zPqi8H84eKTwxuQGxmCVrhFyS4tf1r664",
              position_roi_percent: 345,
              realized_roi_30d_percent: 10,
              realized_roi_all_percent: 9,
              worth_tracking: false,
            },
          ],
        },
      },
    ],
  );
  assert.match(message!, /SIDEWAYS BREAKOUT/);
  assert.match(message!, /≥300% wallets 1/);
  assert.match(message!, /OBSERVE/);
  assert.match(message!, /position \+345\.0%/);
});

test("degen digest renders a rich Pons card with verified trading-bot links", () => {
  const [message] = formatDegenDigest(
    ["robinhood"],
    [
      {
        chain: "robinhood",
        name: "Money <Printer>",
        symbol: "BRRR",
        address: "0x1111111111111111111111111111111111111111",
        price: 0.0000371,
        market_cap: 37_100,
        fdv: 37_100,
        ath_market_cap: 88_400,
        liquidity: 8_100,
        is_microcap: true,
        pons_status: "ACTIVE",
        pons_version: "v2",
        graduation_progress_percent: 72,
        quote_symbol: "USDG",
        launch_age_seconds: 600,
        price_change_1h: -6.4,
        price_change_5m: 35,
        price_change_30m: 110,
        progress_change_30m: 8,
        volume_1h: 159_000,
        volume_24h: 240_000,
        buys_1h: 1300,
        sells_1h: 1000,
        holder_count: 324,
        top_10_holder_rate: 0.23,
        fresh_wallet_rate: 0.1,
        top_holders: [
          { address: "0x2222222222222222222222222222222222222222", amount_percentage: 0.082 },
        ],
        website: "javascript:alert(1)",
        degen_sources: ["PONS ACTIVE", "PONS PRICE SURGE", "NEAR GRADUATION"],
        degen_signal_labels: ["PONS PRICE SURGE", "NEAR GRADUATION"],
        quality_reasons: [
          "Pons launchpad discovery; full contract and liquidity checks have not passed",
        ],
      },
    ],
  );
  assert.match(message!, /Robinhood @ Pons V2/);
  assert.match(message!, /Money &lt;Printer&gt;/);
  assert.match(message!, /\[37\.1K\/-6\.4%\]/);
  assert.match(message!, /curve \+72\.0%/);
  assert.match(message!, /Top holders: .*8\.2/);
  assert.match(message!, /MaestroSniperBot/);
  assert.match(message!, /BananaGunSniper_bot/);
  assert.match(message!, /PONS PRICE SURGE/);
  assert.match(message!, /0x1111111111111111111111111111111111111111/);
  assert.doesNotMatch(message!, /javascript:/);
});

test("failed check includes real rejection reasons", () => {
  const snapshot = buildTokenSnapshot(
    "base",
    "0x1111111111111111111111111111111111111111",
    { name: "Risky", symbol: "RISK", price: { price: "1" }, circulating_supply: "100" },
    { is_honeypot: true },
    {},
    [],
    {
      passed: false,
      score: 25,
      reasons: ["FAIL honeypot detected"],
      warnings: ["Unknown critical field: liquidity"],
    },
  );
  const message = formatTokenCard(snapshot);
  assert.match(message, /REJECTED/);
  assert.match(message, /FAIL honeypot detected/);
  assert.match(message, /Unknown critical field: liquidity/);
  assert.match(message, /Liquidity: n\/a/);
  assert.match(message, /⚠️ <b>REJECTED/);
  assert.match(message, /⚠️ Rug-risk evidence/);
});

test("trending digest returns ten ranked multi-window contracts and cluster alert returns the CA", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    chain: index % 2 ? "bsc" : "sol",
    symbol: `T${index + 1}`,
    address: `0x${String(index + 1).padStart(40, "0")}`,
    market_cap: index === 0 ? 400_000 : 1_000_000 + index,
    liquidity: 100_000,
    volume_5m: 30_000,
    volume_15m: 90_000,
    volume_30m: 180_000,
    volume_1h: 360_000,
    price_change_5m: index,
    price_change_15m: 2,
    price_change_30m: index === 0 ? 120 : 20,
    price_change_1h: 25,
    drawdown_1h_percent: 8,
    multiwindow_grade: "A",
    multiwindow_score: 82,
    pattern: "Bullish consolidation",
  }));
  const digest = formatTrendingDigest(["sol", "bsc"], rows);
  assert.match(digest, /10 FRESH TRENDING SIGNALS/);
  assert.match(digest, /SOL · BSC/);
  assert.match(digest, /Vol 5m \$30K \/ 15m \$90K \/ 30m \$180K \/ 1h \$360K/);
  assert.match(digest, /A 82\/100 · Bullish consolidation/);
  assert.match(digest, /\$T10/);
  assert.doesNotMatch(digest, /\$T11/);
  assert.match(digest, new RegExp(rows[0]!.address));
  const cluster = formatAlert({
    tier: "RESEARCH",
    kind: "WALLET_CLUSTER",
    chain: "sol",
    address: "So11111111111111111111111111111111111111112",
    wallet_count: 2,
    aggregate_buy_usd: 500,
  });
  assert.match(cluster, /OBSERVE · TRACKED-WALLET BUY/);
  assert.match(cluster, /2 tracked wallets<\/b> bought/);
  assert.match(cluster, /So11111111111111111111111111111111111111112/);
  assert.match(cluster, /Observe for a third tracked wallet/);
});

test("tracked-wallet notices name traders, show detection market cap, and scale labels", () => {
  const base = {
    tier: "RESEARCH" as const,
    chain: "robinhood" as const,
    address: "0x1111111111111111111111111111111111111111",
    symbol: "INJOH",
    aggregate_buy_usd: 750,
    sources: ["fomo_tracked_wallet"],
    market_cap_at_detection: 125_000,
    market_cap_observed_at: Math.floor(Date.now() / 1000),
  };
  const observe = formatAlert({
      ...base,
      kind: "TRACKED_WALLET_OBSERVE",
      tracking_label: "OBSERVE",
      wallet_count: 2,
      traders: ["onchainprincess", "traderB"],
    }),
    research = formatAlert({
      ...base,
      kind: "TRACKED_WALLET_POTENTIAL",
      tracking_label: "RESEARCH",
      wallet_count: 4,
      traders: ["traderA", "traderB", "traderC", "traderD"],
    }),
    signal = formatAlert({
      ...base,
      kind: "TRACKED_WALLET_BUY_SIGNAL",
      tracking_label: "BUY SIGNAL",
      wallet_count: 5,
      traders: ["traderA", "traderB", "traderC", "traderD", "traderE"],
    });
  assert.match(observe, /👀 <b>OBSERVE · TRACKED-WALLET BUY · ROBINHOOD/);
  assert.match(observe, /<b>onchainprincess \+ traderB<\/b> bought <b>\$INJOH<\/b>/);
  assert.match(observe, /Market cap at detection: \$125K/);
  assert.match(observe, /Source: Fomo/);
  assert.match(research, /🔎 <b>RESEARCH/);
  assert.match(research, /Research this token now/);
  assert.match(signal, /🔥 <b>BUY SIGNAL/);
  assert.match(signal, /definite buy signal/);
  const message = observe;
  assert.match(message, /👀/u);
  assert.doesNotMatch(message, /⚠️/u);
});

test("sell, surged, and potential feeds are explicit", () => {
  const sell = formatAlert({
    tier: "RESEARCH",
    kind: "TRACKED_WALLET_SELL",
    chain: "robinhood",
    address: "0x1111111111111111111111111111111111111111",
    symbol: "EXIT",
    tracking_label: "OBSERVE",
    wallet_count: 2,
    traders: ["traderA", "traderB"],
    aggregate_sell_usd: 900,
    market_cap_at_detection: 200_000,
  });
  assert.match(sell, /OBSERVE · TRACKED-WALLET SELL · ROBINHOOD/);
  assert.match(sell, /traderA \+ traderB<\/b> sold/);
  const row = {
    chain: "robinhood",
    address: "0x1111111111111111111111111111111111111111",
    symbol: "EARLY",
    market_cap: 80_000,
    liquidity: 20_000,
    volume: 50_000,
    price_change_5m: 12,
    degen_signal_labels: ["NEAR GRADUATION"],
    potential_runner_score: 70,
  };
  assert.match(formatSurgedDigest(["robinhood", "bsc", "sol"], [row])[0]!, /SURGED TOKENS/);
  assert.match(
    formatPotentialDigest(["robinhood", "bsc", "sol"], [row])[0]!,
    /SERIOUS POTENTIAL RUNNERS/,
  );
  assert.match(
    formatPotentialDigest(["robinhood", "bsc", "sol"], [row])[0]!,
    /ROBINHOOD · BSC · SOL/,
  );
});

test("tracking status exposes GMGN roster, multiplier baselines, surge attribution, polling health, and safety suppressions", () => {
  const message = formatTrackingStatus(["sol"], {
    sol: {
      gmgn_tracked_wallets: 4,
      tracked_wallet_poll: {
        attempted_wallets: 2,
        events: 1,
        refreshed_at: "2026-09-02T12:00:00.000Z",
      },
      multiplier_monitor: {
        active_baselines: 9,
        crossed_unannounced: 1,
        max_observed_multiple: 2.76,
      },
      surge_wallet_attribution: {
        tokens_checked: 1,
        surge_events: 1,
        confirmed_profitable_wallets: 2,
        track_worthy_wallets: 0,
      },
      tracked_buy_safety: { checked: 2, passed: 1, suppressed: 1, unavailable: 0 },
    },
  });
  assert.match(message, /Monitored GMGN wallets: 4/);
  assert.match(message, /Wallet poll: 2 addresses · 1 recent events/);
  assert.match(message, /9 active · 1 crossed but unannounced · max 2\.76×/);
  assert.match(message, /1 checked · 1 moves · 2 confirmed ≥300% · 0 track-worthy/);
  assert.doesNotMatch(message, /Fomo/i);
  assert.match(message, /Safety checks: 2 · passed: 1 · suppressed: 1 · unavailable: 0/);
});

test("suppressed-token view shows tracked buyers and full safety context", () => {
  const [message] = formatSuppressedTokens(["robinhood"], {
    robinhood: {
      tracked_buy_safety: {
        recent_suppressed: [
          {
            address: "0x1111111111111111111111111111111111111111",
            symbol: "THIN",
            traders: ["traderA"],
            wallet_count: 1,
            aggregate_buy_usd: 250,
            bought_at: Math.floor(Date.now() / 1000) - 60,
            price: 0.001,
            market_cap: 100_000,
            liquidity: 3_000,
            liquidity_to_market_cap_ratio: 0.03,
            holder_count: 120,
            top_10_holder_rate: 0.25,
            smart_wallets: 1,
            renowned_wallets: 0,
            fresh_wallet_rate: 0.2,
            volume_1h: 50_000,
            volume_24h: 200_000,
            buys_1h: 30,
            sells_1h: 20,
            honeypot: false,
            blacklist: false,
            cannot_sell: false,
            open_source: true,
            renounced: true,
            liquidity_locked: true,
            buy_tax: 0,
            sell_tax: 0,
            dex: "uniswap_v4",
            creator: "0x2222222222222222222222222222222222222222",
            reasons: ["FAIL liquidity-to-market-cap ratio 3.00% >= 5.00%"],
          },
        ],
      },
    },
  });
  assert.match(message!, /SUPPRESSED TRACKED BUY · ROBINHOOD/);
  assert.match(message!, /traderA/);
  assert.match(message!, /liquidity \$3K \(3\.0% of MC\)/);
  assert.match(message!, /Honeypot no/);
  assert.match(message!, /Blocked because: liquidity-to-market-cap ratio/);
});

test("suppressed discovery view proves a DexScreener token was found without promoting it", () => {
  const [message] = formatSuppressedTokens(["robinhood"], {
    robinhood: {
      discovery_audit: {
        recent_suppressed: [
          {
            address: "0x1111111111111111111111111111111111111111",
            symbol: "JINQIAN",
            sources: ["DEXSCREENER"],
            signals: ["DEXSCREENER PRICE SURGE"],
            market_cap: 60_000_000,
            liquidity: 400_000,
            volume_5m: 750_000,
            price_change_5m: 30,
            honeypot: true,
            open_source: false,
            reasons: ["FAIL honeypot detected"],
          },
        ],
      },
    },
  });
  assert.match(message!, /SUPPRESSED DISCOVERY · ROBINHOOD/);
  assert.match(message!, /Found via DEXSCREENER/);
  assert.match(message!, /JINQIAN/);
  assert.match(message!, /Rug-risk evidence: honeypot detected/);
  assert.match(message!, /⚠️/);
});

test("new-user onboarding explains feeds, safety levels, and subscriptions", () => {
  assert.match(onboarding, /subscribed to all enabled chains/i);
  assert.match(onboarding, /tracked-wallet buy notice/i);
  assert.match(onboarding, /five or more are BUY SIGNAL/i);
  assert.match(onboarding, /CALL and RESEARCH cards have passed/i);
  assert.match(onboarding, /never places trades/i);
  assert.doesNotMatch(onboarding, /\p{Extended_Pictographic}/u);
  assert.match(newcomerGuide, /Welcome to the on-chain signal chat/);
  assert.match(newcomerGuide, /tracked-wallet buy notice/i);
  assert.doesNotMatch(newcomerGuide, /\p{Extended_Pictographic}/u);
});

test("multiple alert shows the initial baseline and fresh safety rescan", () => {
  const message = formatAlert({
    tier: "RESEARCH",
    kind: "MULTIPLE",
    chain: "robinhood",
    address: "0x1111111111111111111111111111111111111111",
    symbol: "BRRR",
    milestone: 2,
    multiple: 2.14,
    baseline_price: 0.00001,
    current_price: 0.0000214,
    baseline_market_cap: 40_000,
    current_market_cap: 85_600,
    first_seen: Math.floor(Date.now() / 1000) - 900,
    expires_at: Math.floor(Date.now() / 1000) + 6_300,
    age_seconds: 900,
    source: "PONS DEGEN",
    token_snapshot: {},
    token_passed: true,
    token_score: 88,
    token_warnings: [],
  });
  assert.match(message, /2X MOMENTUM UPDATE/);
  assert.match(message, /2\.14x/);
  assert.match(message, /PONS degen baseline/i);
  assert.match(message, /<b>Market move<\/b>/);
  assert.match(message, /<b>Safety check<\/b>/);
  assert.match(message, /✅ <b>PASSED · 88\/100<\/b>/);
  assert.match(message, /<b>Contract<\/b>/);
  assert.match(message, /0x1111111111111111111111111111111111111111/);
});

test("failed multiplier scans use a calm review state unless rug evidence is explicit", () => {
  const base = {
    tier: "RESEARCH" as const,
    kind: "MULTIPLE",
    chain: "bsc" as const,
    address: "0x761b4ee3cb3f7327c1cc07030ec6ec9465897777",
    symbol: "佛猫",
    milestone: 2,
    multiple: 2.56,
    baseline_price: 0.00001582,
    current_price: 0.00004041,
    baseline_market_cap: 15_800,
    current_market_cap: 40_400,
    age_seconds: 60,
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    source: "DEGEN",
    token_snapshot: { verdict: { reasons: [] } },
    token_passed: false,
    token_score: 64.7,
    token_warnings: [],
  };
  const review = formatAlert(base);
  assert.match(review, /🔎 <b>NEEDS REVIEW · 64\.7\/100<\/b>/);
  assert.doesNotMatch(review, /⚠️/);
  const rug = formatAlert({
    ...base,
    token_snapshot: { honeypot: true, verdict: { reasons: ["FAIL honeypot detected"] } },
  });
  assert.match(rug, /⚠️ <b>RUG RISK · 64\.7\/100<\/b>/);
  assert.match(rug, /Rug-risk evidence: FAIL honeypot detected/);
});

test("token cards explain profitable surge-wallet attribution and wallet-wide quality", () => {
  const snapshot = buildTokenSnapshot(
      "sol",
      "9EmtjLFXwWSz828eyLunxmoWZNdoEjpw1nbxsEwGpump",
      {
        name: "HyperGrok",
        symbol: "HYPERGROK",
        price: { price: ".0001" },
        circulating_supply: "1000000000",
      },
      { renounced_mint: true, renounced_freeze_account: true },
      { liquidity: 50000 },
      [],
      verdict,
    ),
    message = formatTokenCard(snapshot, {
      tier: "RESEARCH",
      sources: ["profitable_surge_wallet"],
      surgeAttribution: {
        event: {
          kind: "SIDEWAYS BREAKOUT",
          price_change_percent: 60,
          volume_usd: 18000,
          volume_ratio: 5,
        },
        track_worthy_wallets: 1,
        wallets: [
          {
            wallet: "WAGnxdsjB9zPqi8H84eKTwxuQGxmCVrhFyS4tf1r664",
            position_roi_percent: 345,
            realized_roi_30d_percent: 230,
            realized_roi_all_percent: 410,
            worth_tracking: true,
          },
        ],
      },
    });
  assert.match(message, /SIDEWAYS BREAKOUT ATTRIBUTION/);
  assert.match(message, /Profitable pre-move wallets: 1/);
  assert.match(message, /TRACK/);
  assert.match(message, /position ROI \+345\.0%/);
});
