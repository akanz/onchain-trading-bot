import type { Json, Verdict } from "./types.js";

export function number(value: unknown, fallback: number | null = 0): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
const flag = (v: unknown): boolean | null =>
  v === true || [1, "1", "yes", "true"].includes(v as any)
    ? true
    : v === false || [0, "0", "no", "false"].includes(v as any)
      ? false
      : null;
const firstNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const parsed = number(value, null);
    if (parsed !== null) return parsed;
  }
  return null;
};
const firstPositiveNumber = (...values: unknown[]): number | null => {
  let zero: number | null = null;
  for (const value of values) {
    const parsed = number(value, null);
    if (parsed === null) continue;
    if (parsed > 0) return parsed;
    if (parsed === 0) zero = 0;
  }
  return zero;
};

const holderAnalysisFields = (info: Json): unknown[] => {
  const stat = info.stat ?? {};
  return [
    stat.top_rat_trader_percentage,
    stat.top_bundler_trader_percentage,
    stat.top_entrapment_trader_percentage,
    stat.top_bot_degen_percentage,
    stat.bot_degen_rate,
    stat.fresh_wallet_rate,
    stat.top_10_holder_rate,
    stat.dev_team_hold_rate,
    stat.creator_hold_rate,
    stat.private_vault_hold_rate,
  ];
};

export function hasPopulatedHolderAnalysis(info: Json): boolean {
  return holderAnalysisFields(info).some((value) => {
    const parsed = number(value, null);
    return parsed !== null && parsed !== 0;
  });
}

export function screenTrackedBuyToken(info: Json, security: Json, pool: Json, cfg: Json): Verdict {
  const reasons: string[] = [],
    warnings: string[] = [];
  let failures = 0;
  const required = (ok: boolean, label: string) => {
    reasons.push(`${ok ? "PASS" : "FAIL"} ${label}`);
    if (!ok) failures++;
  };
  const maxRate = (value: number | null, limit: number, label: string) =>
    required(
      value !== null && value <= limit,
      value === null
        ? `${label} unavailable`
        : `${label} ${(value * 100).toFixed(1)}% <= ${(limit * 100).toFixed(1)}%`,
    );
  const price = number(info.price?.price, null),
    supply = firstNumber(info.circulating_supply, info.total_supply),
    marketCap =
      firstNumber(info.market_cap, info.price?.market_cap) ??
      (price !== null && supply !== null ? price * supply : null),
    liquidity = firstNumber(pool.liquidity, info.liquidity, info.pool?.liquidity),
    holderCount = firstNumber(info.holder_count, info.stat?.holder_count),
    top10 = firstPositiveNumber(
      security.top_10_holder_rate,
      info.stat?.top_10_holder_rate,
      info.dev?.top_10_holder_rate,
    ),
    minLiquidity = number(cfg.tracked_alert_min_liquidity_usd, 500) ?? 500,
    minRatio = number(cfg.tracked_alert_min_liquidity_to_market_cap_ratio, 0.01) ?? 0.01,
    maxRatio = number(cfg.tracked_alert_max_liquidity_to_market_cap_ratio, 10) ?? 10,
    minMarketCap = number(cfg.tracked_alert_min_market_cap_usd, 5000) ?? 5000,
    minHolders = number(cfg.tracked_alert_min_holders, 10) ?? 10;
  const honeypot = flag(security.is_honeypot ?? security.honeypot),
    blacklist = flag(security.is_blacklist ?? security.blacklist),
    openSource = flag(security.is_open_source ?? security.open_source),
    renounced = flag(security.is_renounced ?? security.owner_renounced ?? security.renounced),
    locked = flag(security.lock_summary?.is_locked),
    cannotSell = flag(security.can_not_sell);

  required(Boolean(String(info.symbol ?? "").trim()), "GMGN token record exists");
  if (cfg.require_honeypot_false) {
    required(honeypot === false, "honeypot check passed");
    required(blacklist === false, "blacklist check passed");
    required(cannotSell !== true, "sellability check passed");
  } else if (honeypot === true) required(false, "honeypot detected");
  if (cfg.require_open_source) required(openSource === true, "contract source verified");
  if (cfg.require_owner_renounced) required(renounced === true, "contract ownership renounced");
  if (cfg.require_liquidity_locked) required(locked === true, "liquidity lock confirmed");
  if (cfg.require_renounced_mint)
    required(flag(security.renounced_mint) === true, "mint authority renounced");
  if (cfg.require_renounced_freeze)
    required(flag(security.renounced_freeze_account) === true, "freeze authority renounced");
  required(
    liquidity !== null && liquidity >= minLiquidity,
    `tracked-alert liquidity $${Math.round(liquidity ?? 0).toLocaleString()} >= $${minLiquidity.toLocaleString()}`,
  );
  const liquidityRatio =
    liquidity !== null && marketCap !== null && marketCap > 0 ? liquidity / marketCap : null;
  required(
    liquidityRatio !== null && liquidityRatio >= minRatio,
    liquidityRatio === null
      ? "liquidity-to-market-cap ratio unavailable"
      : `liquidity-to-market-cap ratio ${(liquidityRatio * 100).toFixed(2)}% >= ${(minRatio * 100).toFixed(2)}%`,
  );
  required(
    liquidityRatio !== null && liquidityRatio <= maxRatio,
    liquidityRatio === null
      ? "liquidity-to-market-cap ratio unavailable"
      : `liquidity-to-market-cap ratio ${(liquidityRatio * 100).toFixed(2)}% <= ${(maxRatio * 100).toFixed(2)}%`,
  );
  required(
    marketCap !== null && marketCap >= minMarketCap,
    `tracked-alert market cap $${Math.round(marketCap ?? 0).toLocaleString()} >= $${minMarketCap.toLocaleString()}`,
  );
  required(
    holderCount !== null && holderCount >= minHolders,
    `tracked-alert holders ${Math.round(holderCount ?? 0)} >= ${minHolders}`,
  );
  required(
    hasPopulatedHolderAnalysis(info),
    "GMGN holder analysis is populated; an all-zero block is not accepted as safe",
  );
  required(top10 !== null && top10 > 0, "top-10 concentration is populated and above 0%");
  maxRate(
    top10,
    number(cfg.tracked_alert_max_top_10_holder_rate, cfg.max_top_10_holder_rate) ??
      cfg.max_top_10_holder_rate,
    "top-10 concentration",
  );
  if (cfg.require_honeypot_false) {
    maxRate(number(security.buy_tax, null), cfg.max_buy_tax ?? 0.05, "buy tax");
    maxRate(number(security.sell_tax, null), cfg.max_sell_tax ?? 0.05, "sell tax");
  }
  const passed = reasons.filter((reason) => reason.startsWith("PASS ")).length;
  return {
    passed: failures === 0,
    score: Math.round((1000 * passed) / Math.max(reasons.length + warnings.length, 1)) / 10,
    reasons,
    warnings,
  };
}

export function wilsonLowerBound(wins: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = wins / total;
  return (
    (p + (z * z) / (2 * total) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) /
    (1 + (z * z) / total)
  );
}

export function scoreToken(
  info: Json,
  security: Json,
  pool: Json,
  cluster: Json,
  cfg: Json,
): Verdict {
  const reasons: string[] = [],
    warnings: string[] = [];
  let failures = 0;
  const required = (ok: boolean, label: string) => {
    reasons.push(`${ok ? "PASS" : "FAIL"} ${label}`);
    if (!ok) failures++;
  };
  const knownMax = (value: number | null, limit: number, label: string) => {
    if (value === null) {
      warnings.push(`Unknown critical field: ${label}`);
      failures++;
    } else
      required(
        value <= limit,
        `${label} ${(value * 100).toFixed(1)}% <= ${(limit * 100).toFixed(1)}%`,
      );
  };
  const price = number(info.price?.price, null),
    supply = number(info.circulating_supply, null);
  const marketCap = price !== null && supply !== null ? price * supply : null;
  const liquidity = number(pool.liquidity ?? info.liquidity, null);
  const stat = info.stat ?? {};
  const honeypot = flag(security.is_honeypot),
    blacklist = flag(security.is_blacklist ?? security.blacklist),
    openSource = flag(security.is_open_source ?? security.open_source);
  const renounced = flag(security.is_renounced ?? security.owner_renounced ?? security.renounced);
  const locked = flag(security.lock_summary?.is_locked);
  if (cfg.require_honeypot_false) {
    required(honeypot === false, "honeypot check passed");
    required(blacklist === false, "blacklist check passed");
    required(flag(security.can_not_sell) !== true, "sellability check passed");
  } else if (honeypot === true) required(false, "honeypot detected");
  if (cfg.require_open_source) required(openSource === true, "contract source verified");
  if (cfg.require_owner_renounced) required(renounced === true, "contract ownership renounced");
  if (cfg.require_liquidity_locked) required(locked === true, "liquidity lock confirmed");
  if (cfg.require_renounced_mint)
    required(flag(security.renounced_mint) === true, "mint authority renounced");
  if (cfg.require_renounced_freeze)
    required(flag(security.renounced_freeze_account) === true, "freeze authority renounced");
  required(
    liquidity !== null && liquidity >= cfg.min_liquidity_usd,
    `liquidity $${Math.round(liquidity ?? 0).toLocaleString()}`,
  );
  const liquidityRatio =
      liquidity !== null && marketCap !== null && marketCap > 0 ? liquidity / marketCap : null,
    minRatio = number(cfg.min_liquidity_to_market_cap_ratio, 0.05) ?? 0.05;
  required(
    liquidityRatio !== null && liquidityRatio >= minRatio,
    liquidityRatio === null
      ? "liquidity-to-market-cap ratio unavailable"
      : `liquidity-to-market-cap ratio ${(liquidityRatio * 100).toFixed(2)}% >= ${(minRatio * 100).toFixed(2)}%`,
  );
  required(
    marketCap !== null &&
      marketCap >= cfg.min_market_cap_usd &&
      marketCap <= cfg.max_market_cap_usd,
    `market cap $${Math.round(marketCap ?? 0).toLocaleString()}`,
  );
  required(
    (number(info.holder_count, 0) ?? 0) >= cfg.min_holders,
    `holders ${number(info.holder_count, 0)}`,
  );
  required(
    (number(info.price?.volume_5m, 0) ?? 0) >= cfg.min_volume_5m_usd,
    `5m volume $${Math.round(number(info.price?.volume_5m, 0) ?? 0).toLocaleString()}`,
  );
  required(
    hasPopulatedHolderAnalysis(info),
    "GMGN holder analysis is populated; an all-zero block is not accepted as safe",
  );
  const top10 = firstPositiveNumber(
    security.top_10_holder_rate,
    stat.top_10_holder_rate,
    info.dev?.top_10_holder_rate,
  );
  required(top10 !== null && top10 > 0, "top-10 concentration is populated and above 0%");
  knownMax(top10, cfg.max_top_10_holder_rate, "top-10 concentration");
  knownMax(
    number(security.dev_team_hold_rate ?? stat.dev_team_hold_rate, null),
    cfg.max_dev_team_hold_rate,
    "dev-team holding",
  );
  knownMax(
    number(security.bundler_trader_amount_rate ?? stat.top_bundler_trader_percentage, null),
    cfg.max_bundler_rate,
    "bundler activity",
  );
  knownMax(number(stat.bot_degen_rate, null), cfg.max_bot_rate, "bot activity");
  knownMax(
    number(security.rat_trader_amount_rate ?? stat.top_rat_trader_percentage, null),
    cfg.max_rat_trader_rate,
    "insider/rat activity",
  );
  knownMax(
    number(stat.top_entrapment_trader_percentage, null),
    cfg.max_entrapment_rate ?? 1,
    "entrapment activity",
  );
  if (cfg.require_honeypot_false) {
    knownMax(number(security.buy_tax, null), cfg.max_buy_tax ?? 0.05, "buy tax");
    knownMax(number(security.sell_tax, null), cfg.max_sell_tax ?? 0.05, "sell tax");
  }
  const entry = number(cluster.median_entry_price_usd, null);
  if (price === null || entry === null || entry <= 0) {
    warnings.push("Cannot measure price chase from cluster entry");
    failures++;
  } else
    required(
      price / entry - 1 <= (cluster.max_price_chase_ratio ?? 0.15),
      `price moved ${((price / entry - 1) * 100).toFixed(1)}% since median tracked entry`,
    );
  const passed = reasons.filter((r) => r.startsWith("PASS ")).length;
  return {
    passed: failures === 0,
    score: Math.round((1000 * passed) / Math.max(reasons.length + warnings.length, 1)) / 10,
    reasons,
    warnings,
  };
}

export function clusterEvents(events: Json[], cfg: Json): Json[] {
  const grouped = new Map<string, Json[]>();
  for (const event of events)
    if (event.side === "buy" && event.is_open_or_close === 0 && event.base_address)
      grouped.set(event.base_address, [...(grouped.get(event.base_address) ?? []), event]);
  const clusters: Json[] = [];
  for (const [address, rows] of grouped) {
    rows.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
    for (let start = 0; start < rows.length; start++) {
      const window = rows
        .slice(start)
        .filter((r) => Number(r.timestamp) - Number(rows[start]!.timestamp) <= cfg.window_seconds);
      const unique = new Map<string, Json>();
      for (const row of window) if (row.maker && !unique.has(row.maker)) unique.set(row.maker, row);
      const selected = [...unique.values()];
      if (selected.length < cfg.min_qualified_wallets) continue;
      const amounts = selected.map((r) => number(r.amount_usd, 0) ?? 0).sort((a, b) => a - b);
      const prices = selected
        .map((r) => number(r.price_usd, 0) ?? 0)
        .filter(Boolean)
        .sort((a, b) => a - b);
      const median = (a: number[]) =>
        a.length % 2 ? a[(a.length - 1) / 2]! : (a[a.length / 2 - 1]! + a[a.length / 2]!) / 2;
      clusters.push({
        address,
        symbol: selected[0]?.base_token?.symbol,
        wallets: [...unique.keys()].sort(),
        events: selected,
        wallet_count: selected.length,
        aggregate_buy_usd: amounts.reduce((a, b) => a + b, 0),
        median_buy_usd: median(amounts),
        median_entry_price_usd: prices.length ? median(prices) : null,
        first_timestamp: Math.min(...selected.map((r) => Number(r.timestamp))),
        last_timestamp: Math.max(...selected.map((r) => Number(r.timestamp))),
      });
      break;
    }
  }
  return clusters;
}
