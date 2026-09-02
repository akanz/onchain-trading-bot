import { validTokenAddress } from "../signals.js";
import type { Json } from "../types.js";

const finite = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const unix = (value: unknown): number => {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
};

export function normalizePonsLaunch(
  row: Json,
  now = Math.floor(Date.now() / 1000),
): Json | undefined {
  const address = String(row.token ?? "");
  if (!validTokenAddress("robinhood", address)) return undefined;
  const launchedAt = unix(row.launchedAt),
    graduatedAt = unix(row.graduatedAt),
    latestBuyAt = unix(row.latestBuyAt),
    marketCap = finite(row.marketCapUsd),
    price = finite(row.priceUsd),
    progress = finite(row.graduationProgressPct) ?? 0,
    graduated = row.graduated === true;
  return {
    chain: "robinhood",
    address,
    name: row.name,
    symbol: row.symbol,
    price,
    market_cap: marketCap,
    liquidity: finite(row.liquidityUsd),
    deployer: row.deployer,
    pool: row.pool,
    pair_token: row.pairToken,
    quote_symbol: row.quoteAsset?.symbol,
    quote_name: row.quoteAsset?.name,
    quote_asset_class: row.quoteAsset?.assetClass,
    pons_version: row.version ?? "v1",
    pons_venue: row.venue ?? (graduated ? "pool" : "curve"),
    pons_status: graduated ? "GRADUATED" : "ACTIVE",
    graduated,
    graduation_progress_percent: progress,
    launched_at: launchedAt,
    graduated_at: graduatedAt,
    latest_buy_at: latestBuyAt,
    launch_age_seconds: launchedAt ? Math.max(0, now - launchedAt) : undefined,
    graduated_age_seconds: graduatedAt ? Math.max(0, now - graduatedAt) : undefined,
    latest_buy_age_seconds: latestBuyAt ? Math.max(0, now - latestBuyAt) : undefined,
    is_microcap:
      marketCap !== undefined &&
      marketCap > 0 &&
      marketCap <= Number(process.env.DEGEN_MAX_MARKET_CAP_USD ?? 100000),
    pons_url: `https://www.ponsfamily.com/launchpad`,
    degen_sources: [graduated ? "PONS GRADUATED" : "PONS ACTIVE"],
    degen_signal_labels: [],
    quality_passed: false,
    quality_reasons: [
      "Pons launchpad discovery; full contract and liquidity checks have not passed",
    ],
  };
}

export function selectPonsProbeRows(
  active: Json[],
  graduated: Json[],
  limit = 20,
  now = Math.floor(Date.now() / 1000),
): Json[] {
  const rows = [...active, ...graduated]
    .map((row) => normalizePonsLaunch(row, now))
    .filter((row): row is Json => Boolean(row));
  const seedScore = (row: Json) => {
    const buyRecency =
        (Math.max(0, 1800 - Number(row.latest_buy_age_seconds ?? Infinity)) / 1800) * 30,
      newness = (Math.max(0, 21600 - Number(row.launch_age_seconds ?? Infinity)) / 21600) * 20,
      graduationNew =
        (Math.max(0, 21600 - Number(row.graduated_age_seconds ?? Infinity)) / 21600) * 35,
      progress = (Math.min(Number(row.graduation_progress_percent ?? 0), 100) / 100) * 25,
      mcap = Math.min(Number(row.market_cap ?? 0) / 100000, 1) * 10;
    return buyRecency + newness + graduationNew + progress + mcap;
  };
  return rows
    .sort(
      (a, b) =>
        seedScore(b) - seedScore(a) ||
        Number(b.latest_buy_at ?? b.graduated_at ?? 0) -
          Number(a.latest_buy_at ?? a.graduated_at ?? 0),
    )
    .slice(0, Math.max(0, limit));
}

export function ponsKlineChanges(rows: Json[]): {
  price_change_5m?: number | undefined;
  price_change_30m?: number | undefined;
} {
  const candles = rows
      .map((row) => ({ time: Number(row.time), open: Number(row.open), close: Number(row.close) }))
      .filter((row) => Number.isFinite(row.time) && row.open > 0 && row.close > 0)
      .sort((a, b) => a.time - b.time),
    last = candles.at(-1);
  if (!last) return {};
  const change = (seconds: number) => {
    const target = last.time - seconds * 1000,
      baseline = [...candles].reverse().find((row) => row.time <= target) ?? candles[0];
    return baseline && baseline.open > 0 ? (last.close / baseline.open - 1) * 100 : undefined;
  };
  return { price_change_5m: change(300), price_change_30m: change(1800) };
}

export function qualifyPonsDegen(
  row: Json,
  changes: {
    price_change_5m?: number | undefined;
    price_change_30m?: number | undefined;
    progress_change_30m?: number | undefined;
  },
): Json | undefined {
  const labels: string[] = [],
    change5 = changes.price_change_5m,
    change30 = changes.price_change_30m,
    progressChange = changes.progress_change_30m,
    recentBuy =
      Number(row.latest_buy_age_seconds ?? Infinity) <=
      Number(process.env.PONS_RECENT_BUY_SECONDS ?? 900);
  if (
    (change5 ?? -Infinity) >= Number(process.env.PONS_SURGE_5M_PERCENT ?? 30) ||
    (change30 ?? -Infinity) >= Number(process.env.PONS_SURGE_30M_PERCENT ?? 100)
  )
    labels.push("PONS PRICE SURGE");
  if ((progressChange ?? -Infinity) >= Number(process.env.PONS_PROGRESS_SURGE_30M_POINTS ?? 5))
    labels.push("PONS PROGRESS SURGE");
  if (
    !row.graduated &&
    Number(row.graduation_progress_percent ?? 0) >=
      Number(process.env.PONS_NEAR_GRADUATION_PERCENT ?? 50) &&
    recentBuy
  )
    labels.push("NEAR GRADUATION");
  if (
    row.graduated &&
    Number(row.graduated_age_seconds ?? Infinity) <=
      Number(process.env.PONS_JUST_GRADUATED_SECONDS ?? 21600)
  )
    labels.push("JUST GRADUATED");
  if (
    !row.graduated &&
    Number(row.launch_age_seconds ?? Infinity) <=
      Number(process.env.PONS_NEW_LAUNCH_SECONDS ?? 1800) &&
    recentBuy &&
    Number(row.market_cap ?? 0) >= Number(process.env.PONS_NEW_LAUNCH_MIN_MC_USD ?? 3000)
  )
    labels.push("NEW ACTIVE LAUNCH");
  if (!labels.length) return undefined;
  return {
    ...row,
    ...changes,
    price_change_percent5m: changes.price_change_5m,
    degen_signal_labels: labels,
    degen_sources: [...new Set([...(row.degen_sources ?? []), ...labels])],
    pons_signal_score:
      (labels.includes("PONS PRICE SURGE") ? 50 : 0) +
      (labels.includes("PONS PROGRESS SURGE") ? 35 : 0) +
      (labels.includes("JUST GRADUATED") ? 25 : 0) +
      (labels.includes("NEAR GRADUATION") ? 20 : 0) +
      (labels.includes("NEW ACTIVE LAUNCH") ? 10 : 0),
  };
}
