import type { Json } from "./types.js";

const positive = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/** Best evidenced all-time-high market cap. Current market cap is a valid lower bound. */
export function historicalMarketCap(row: Json): number | undefined {
  const price = row.price ?? {},
    athPrice = positive(row.ath_price ?? price.ath_price),
    supply = positive(row.circulating_supply ?? row.total_supply),
    derived = athPrice && supply ? athPrice * supply : undefined;
  const values = [
    row.history_highest_market_cap,
    row.ath_market_cap,
    row.athMarketCap,
    row.all_time_high_market_cap,
    row.market_cap,
    derived,
  ]
    .map(positive)
    .filter((value): value is number => value !== undefined);
  return values.length ? Math.max(...values) : undefined;
}

export function crossedHistoricalMarketCap(row: Json, minimum: number): boolean {
  const ath = historicalMarketCap(row);
  return ath !== undefined && ath >= minimum;
}
