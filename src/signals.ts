import type { Chain, Json } from "./types.js";

export type SignalSource =
  | "trending_momentum"
  | "trending_small_cap"
  | "trending_smart_money"
  | "trending_early_volume"
  | "trending_multiwindow_stability"
  | "price_surge"
  | "profitable_surge_wallet"
  | "smart_money_signal"
  | "smart_money_wallet"
  | "kol_wallet"
  | "followed_wallet"
  | "tracked_wallet"
  | "fomo_most_held"
  | "fomo_trending"
  | "fomo_holder"
  | "fomo_leaderboard"
  | "fomo_tracked_wallet"
  | "long_launchpad"
  | "dexscreener_market"
  | "twitter";

export interface SignalCandidate {
  chain: Chain;
  address: string;
  symbol?: string;
  sources: Set<SignalSource>;
  sourceIds: Set<string>;
  wallets: Set<string>;
  buyWallets: Set<string>;
  sellWallets?: Set<string>;
  traderLabels?: Set<string>;
  sellTraderLabels?: Set<string>;
  sellSources?: Set<SignalSource>;
  twitterAccounts: Set<string>;
  firstTimestamp: number;
  aggregateBuyUsd: number;
  aggregateSellUsd?: number;
  observedMarketCap?: number;
  marketCapObservedAt?: number;
  market?: Json;
  tokenInfo?: Json;
  tokenSecurity?: Json;
  tokenPool?: Json;
  trackedBuySafety?: Json;
  surgeAttribution?: Json;
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const truthyFlag = (value: unknown) =>
  value === true || value === 1 || value === "1" || value === "yes" || value === "true";

type GateRule = readonly [passes: boolean, failureReason: string];

function gateResult(rules: GateRule[]): { passed: boolean; reasons: string[] } {
  const reasons = rules.filter(([passes]) => !passes).map(([, reason]) => reason);
  return { passed: reasons.length === 0, reasons };
}

export function addressKey(address: string): string {
  return address.startsWith("0x") ? address.toLowerCase() : address;
}

export function validTokenAddress(chain: Chain, address: string): boolean {
  return chain === "sol"
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
    : /^0x[0-9a-fA-F]{40}$/.test(address);
}

export function marketSnapshot(row: Json): Json {
  const data = row.data ?? row,
    cur = row.cur_data ?? {};
  return {
    ...data,
    address: row.token_address ?? data.address,
    symbol: data.symbol ?? row.symbol,
    market_cap: finite(row.market_cap ?? data.market_cap ?? data.usd_market_cap),
    liquidity: finite(cur.liquidity ?? data.liquidity),
    holder_count: finite(cur.holder_count ?? data.holder_count),
    top_10_holder_rate: finite(cur.top_10_holder_rate ?? data.top_10_holder_rate),
    rug_ratio: finite(data.rug_ratio),
  };
}

export function passesMarketGate(row: Json, cfg: Json): { passed: boolean; reasons: string[] } {
  const market = marketSnapshot(row);
  const liquidity = finite(market.liquidity);
  const marketCap = finite(market.market_cap);
  const holders = finite(market.holder_count);
  const topTenRate = finite(market.top_10_holder_rate);
  const rugRatio = finite(market.rug_ratio);
  const bundlerRate = finite(market.bundler_rate ?? market.bundler_trader_amount_rate);
  const insiderRate = finite(market.rat_trader_amount_rate ?? market.suspected_insider_hold_rate);
  const entrapmentRate = finite(market.entrapment_ratio);
  const developerRate = finite(market.dev_team_hold_rate);
  const liquidityRatio =
    liquidity !== null && marketCap !== null && marketCap > 0 ? liquidity / marketCap : null;
  const minimumLiquidityRatio = finite(cfg.min_liquidity_to_market_cap_ratio) ?? 0.05;

  return gateResult([
    [
      liquidity !== null && liquidity >= cfg.min_liquidity_usd,
      `liquidity below $${cfg.min_liquidity_usd}`,
    ],
    [
      liquidityRatio !== null && liquidityRatio >= minimumLiquidityRatio,
      liquidityRatio === null
        ? "liquidity-to-market-cap ratio unavailable"
        : `liquidity-to-market-cap ratio below ${(minimumLiquidityRatio * 100).toFixed(1)}%`,
    ],
    [
      marketCap !== null &&
        marketCap >= cfg.min_market_cap_usd &&
        marketCap <= cfg.max_market_cap_usd,
      "market cap outside configured range",
    ],
    [holders !== null && holders >= cfg.min_holders, `fewer than ${cfg.min_holders} holders`],
    [rugRatio !== null && rugRatio <= 0.3, "rug ratio unavailable or above 0.30"],
    [!truthyFlag(market.is_wash_trading), "wash trading detected"],
    [!truthyFlag(market.is_honeypot), "honeypot detected"],
    [
      topTenRate !== null && topTenRate > 0 && topTenRate <= cfg.max_top_10_holder_rate,
      "top-10 concentration is 0%, too high, or unavailable",
    ],
    [
      bundlerRate !== null && bundlerRate <= cfg.max_bundler_rate,
      "bundler activity too high or unavailable",
    ],
    [
      insiderRate !== null && insiderRate <= cfg.max_rat_trader_rate,
      "insider/rat activity too high or unavailable",
    ],
    [
      entrapmentRate !== null && entrapmentRate <= (cfg.max_entrapment_rate ?? 1),
      "entrapment activity too high or unavailable",
    ],
    [
      developerRate === null || developerRate <= cfg.max_dev_team_hold_rate,
      "dev-team holding too high",
    ],
  ]);
}

export function passesSurgeDiscoveryGate(
  row: Json,
  cfg: Json,
): { passed: boolean; reasons: string[] } {
  const market = marketSnapshot(row),
    liquidity = finite(market.liquidity),
    marketCap = finite(market.market_cap),
    holders = finite(market.holder_count),
    topTenRate = finite(market.top_10_holder_rate),
    rugRatio = finite(market.rug_ratio),
    minLiquidity = finite(cfg.tracked_alert_min_liquidity_usd) ?? 500,
    minRatio = finite(cfg.tracked_alert_min_liquidity_to_market_cap_ratio) ?? 0.01,
    maxRatio = finite(cfg.tracked_alert_max_liquidity_to_market_cap_ratio) ?? 10,
    minMarketCap = finite(cfg.tracked_alert_min_market_cap_usd) ?? 5000,
    minHolders = finite(cfg.tracked_alert_min_holders) ?? 10,
    maxTop10 =
      finite(cfg.tracked_alert_max_top_10_holder_rate) ?? finite(cfg.max_top_10_holder_rate) ?? 0.3,
    ratio =
      liquidity !== null && marketCap !== null && marketCap > 0 ? liquidity / marketCap : null;
  return gateResult([
    [
      liquidity !== null && liquidity >= minLiquidity,
      `liquidity below early-token floor $${minLiquidity}`,
    ],
    [
      marketCap !== null && marketCap >= minMarketCap && marketCap <= cfg.max_market_cap_usd,
      `market cap unavailable or outside early-token range $${minMarketCap}-$${cfg.max_market_cap_usd}`,
    ],
    [
      ratio !== null && ratio >= minRatio,
      `liquidity-to-market-cap ratio below ${(minRatio * 100).toFixed(1)}%`,
    ],
    [
      ratio !== null && ratio <= maxRatio,
      `liquidity-to-market-cap ratio above ${(maxRatio * 100).toFixed(1)}%; market data is contradictory`,
    ],
    [holders !== null && holders >= minHolders, `fewer than ${minHolders} holders`],
    [
      topTenRate !== null && topTenRate > 0 && topTenRate <= maxTop10,
      "top-10 concentration is 0%, too high, or unavailable",
    ],
    [rugRatio === null || rugRatio <= 0.3, "rug ratio above 0.30"],
    [!truthyFlag(market.is_wash_trading), "wash trading detected"],
    [!truthyFlag(market.is_honeypot), "honeypot detected"],
  ]);
}

export function isCatastrophicMarketCapCollapse(
  baseline: unknown,
  current: unknown,
  ratio = 0.01,
): boolean {
  const baselineMarketCap = finite(baseline),
    currentMarketCap = finite(current),
    threshold = finite(ratio);
  const validInputs = [
    baselineMarketCap !== null,
    baselineMarketCap !== null && baselineMarketCap > 0,
    currentMarketCap !== null,
    currentMarketCap !== null && currentMarketCap >= 0,
    threshold !== null,
    threshold !== null && threshold > 0,
  ];
  if (!validInputs.every(Boolean)) return false;
  return currentMarketCap! < baselineMarketCap! * threshold!;
}

export function signalStrength(candidate: SignalCandidate): number {
  const weights: Partial<Record<SignalSource, number>> = {
    trending_smart_money: 2,
    trending_early_volume: 1,
    trending_multiwindow_stability: 2,
    smart_money_signal: 2,
    price_surge: 1,
    profitable_surge_wallet: 3,
    trending_momentum: 1,
    trending_small_cap: 1,
    twitter: 1,
    followed_wallet: 2,
    tracked_wallet: 2,
    fomo_most_held: 1,
    fomo_trending: 1,
    fomo_holder: 2,
    fomo_leaderboard: 3,
    fomo_tracked_wallet: 3,
    long_launchpad: 1,
    dexscreener_market: 1,
  };
  const weightedSources = [...candidate.sources].reduce(
    (score, source) => score + (weights[source] ?? 0),
    0,
  );
  const smartMoneyWeight = candidate.wallets.size >= 3 ? 3 : candidate.wallets.size >= 2 ? 2 : 1;
  const smartMoneyScore = candidate.sources.has("smart_money_wallet") ? smartMoneyWeight : 0;
  const kolScore = candidate.sources.has("kol_wallet") ? (candidate.wallets.size >= 3 ? 2 : 1) : 0;

  return weightedSources + smartMoneyScore + kolScore;
}

export function hasCapitalConfirmation(candidate: SignalCandidate): boolean {
  return [
    "trending_multiwindow_stability",
    "trending_smart_money",
    "smart_money_signal",
    "profitable_surge_wallet",
    "smart_money_wallet",
    "kol_wallet",
    "followed_wallet",
    "tracked_wallet",
    "fomo_holder",
    "fomo_leaderboard",
    "fomo_tracked_wallet",
  ].some((source) => candidate.sources.has(source as SignalSource));
}

export function shouldInvestigate(candidate: SignalCandidate, minStrength = 3): boolean {
  return (
    Boolean(candidate.market) &&
    hasCapitalConfirmation(candidate) &&
    signalStrength(candidate) >= minStrength
  );
}

export function hasTrackedBuyCluster(candidate: SignalCandidate, minWallets = 3): boolean {
  return candidate.buyWallets.size >= minWallets;
}

export function extractContractAddresses(text: string): string[] {
  const evm = text.match(/\b0x[0-9a-fA-F]{40}\b/g) ?? [];
  const sol = text.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) ?? [];
  return [...new Set([...evm, ...sol])];
}
