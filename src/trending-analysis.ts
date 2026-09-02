import type { Json } from "./types.js";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
const finite = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const change = (candles: Candle[]) =>
  candles.length && candles[0]!.open > 0
    ? (candles.at(-1)!.close / candles[0]!.open - 1) * 100
    : undefined;
const volume = (candles: Candle[]) => sum(candles.map((candle) => candle.volume));
const slice = (candles: Candle[], bars: number) => candles.slice(-Math.min(bars, candles.length));

export function normalizeTrendingCandles(rows: Json[]): Candle[] {
  return rows
    .map((row) => ({
      time: Number(row.time),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Math.max(Number(row.volume) || 0, 0),
    }))
    .filter(
      (row) =>
        Number.isFinite(row.time) && row.open > 0 && row.high > 0 && row.low > 0 && row.close > 0,
    )
    .sort((a, b) => a.time - b.time);
}

interface TrendMetrics {
  pattern: string;
  trendUp: "up" | "down" | "flat";
  slope: number;
  volatility: number;
  drawdown: number;
  upFromLow: number;
  volumeRatio: number | undefined;
  volumeCv30: number | undefined;
  turnover15: number | undefined;
  volume5: number;
  volume15: number;
  volume30: number;
  volume60: number;
  return5: number | undefined;
  return15: number | undefined;
  return30: number | undefined;
  return60: number | undefined;
  buySellRatio: number | undefined;
}

class TrendScore {
  value = 0;
  readonly reasons: string[] = [];

  add(points: number, reason: string): void {
    this.value += points;
    this.reasons.push(`${points >= 0 ? "+" : ""}${points} ${reason}`);
  }

  bounded(): number {
    return Math.max(0, Math.min(100, this.value));
  }
}

function classifyPattern(
  slope: number,
  drawdown: number,
  volatility: number,
  upFromLow: number,
  trend: "up" | "down" | "flat",
): string {
  if (slope > 0.25 && drawdown < 0.12) return "Vertical run-up";
  if (slope > 0.08 && drawdown < 0.25) return "Uptrend channel";
  if (drawdown > 0.55 && slope < -0.1) return "Breakdown";
  if (drawdown > 0.55 && slope > 0.02) return "Bounce off the lows";
  if (drawdown > 0.35 && Math.abs(slope) < 0.08) return "Distribution at highs";
  if (slope < -0.2) return "Slow bleed";
  if (Math.abs(slope) < 0.05 && volatility < 0.05 && upFromLow < 0.2) return "Basing at lows";
  if (Math.abs(slope) < 0.08 && volatility > 0.08) return "Wide chop";
  if (trend === "up") return "Bullish consolidation";
  if (trend === "down") return "Bearish consolidation";
  return "Sideways consolidation";
}

function calculateMetrics(candles: Candle[], market: Json): TrendMetrics {
  const last = candles.at(-1)!;
  const last5 = slice(candles, 1);
  const last15 = slice(candles, 3);
  const last30 = slice(candles, 6);
  const last60 = slice(candles, 12);
  const closes = candles.map((row) => row.close);
  const shortMean = mean(closes.slice(-9))!;
  const longMean = mean(closes.slice(-Math.min(21, closes.length)))!;
  const trendUp = shortMean > longMean ? "up" : shortMean < longMean ? "down" : "flat";
  const slope = last.close / last60[0]!.open - 1;
  const volatility = mean(last60.map((row) => (row.high - row.low) / row.close))!;
  const rangeHigh = Math.max(...last60.map((row) => row.high));
  const rangeLow = Math.min(...last60.map((row) => row.low));
  const drawdown = (rangeHigh - last.close) / rangeHigh;
  const upFromLow = (last.close - rangeLow) / rangeLow;
  const previousMean = mean(
    candles
      .slice(0, -1)
      .slice(-11)
      .map((row) => row.volume),
  );
  const volumeRatio = previousMean && previousMean > 0 ? last.volume / previousMean : undefined;
  const volumes30 = last30.map((row) => row.volume);
  const volumeMean30 = mean(volumes30)!;
  const variance30 = mean(volumes30.map((value) => (value - volumeMean30) ** 2))!;
  const volumeCv30 = volumeMean30 > 0 ? Math.sqrt(variance30) / volumeMean30 : undefined;
  const volume15 = volume(last15);
  const liquidity = finite(market.liquidity) ?? 0;
  const buys = finite(market.buys) ?? 0;
  const sells = finite(market.sells) ?? 0;

  return {
    pattern: classifyPattern(slope, drawdown, volatility, upFromLow, trendUp),
    trendUp,
    slope,
    volatility,
    drawdown,
    upFromLow,
    volumeRatio,
    volumeCv30,
    turnover15: liquidity > 0 ? volume15 / liquidity : undefined,
    volume5: finite(market.volume) ?? volume(last5),
    volume15,
    volume30: volume(last30),
    volume60: volume(last60),
    return5: change(last5),
    return15: change(last15),
    return30: change(last30),
    return60: change(last60),
    buySellRatio: sells > 0 ? buys / sells : buys > 0 ? Infinity : undefined,
  };
}

function scoreVolume(score: TrendScore, metrics: TrendMetrics, minimumVolume: number): void {
  score.add(
    Math.min(15, Math.round((15 * metrics.volume5) / Math.max(minimumVolume, 1))),
    `5m volume $${Math.round(metrics.volume5).toLocaleString()}`,
  );
  score.add(
    metrics.volume15 >= minimumVolume * 2
      ? 10
      : Math.round((10 * metrics.volume15) / Math.max(minimumVolume * 2, 1)),
    metrics.volume15 >= minimumVolume * 2 ? "15m volume persisted" : "15m volume developing",
  );
  if (metrics.volume30 >= minimumVolume * 3) score.add(5, "30m participation persisted");

  if (metrics.volumeRatio !== undefined) {
    if (metrics.volumeRatio >= 0.7 && metrics.volumeRatio <= 4)
      score.add(8, `latest volume ${metrics.volumeRatio.toFixed(1)}x baseline`);
    else if (metrics.volumeRatio > 0.3)
      score.add(3, `latest volume ${metrics.volumeRatio.toFixed(1)}x baseline`);
    else score.add(-5, "latest volume is fading");
  }
  if (metrics.volumeCv30 !== undefined) {
    if (metrics.volumeCv30 <= 1) score.add(7, "30m volume is distributed across candles");
    else if (metrics.volumeCv30 <= 1.75) score.add(3, "30m volume is moderately uneven");
    else score.add(-4, "30m volume is concentrated in a spike");
  }
  if (metrics.turnover15 !== undefined) {
    if (metrics.turnover15 >= 0.05 && metrics.turnover15 <= 3)
      score.add(5, "healthy 15m volume/liquidity turnover");
    else if (metrics.turnover15 > 3) score.add(1, "very high turnover; watch churn");
  }
}

function scorePriceStructure(score: TrendScore, metrics: TrendMetrics): void {
  if (metrics.drawdown <= 0.15) score.add(10, "holding near the 1h range high");
  else if (metrics.drawdown <= 0.3) score.add(6, "contained 1h drawdown");
  else if (metrics.drawdown <= 0.45) score.add(2, "recoverable but material drawdown");
  else score.add(-10, "deep drawdown from the 1h high");

  if (metrics.volatility <= 0.08) score.add(10, "stable intrabar ranges");
  else if (metrics.volatility <= 0.15) score.add(6, "manageable volatility");
  else if (metrics.volatility <= 0.25) score.add(2, "high but bounded volatility");
  else score.add(-8, "extreme candle volatility");

  if (metrics.return30 !== undefined) {
    if (metrics.return30 >= -15) score.add(5, "30m structure is intact");
    else if (metrics.return30 < -30) score.add(-8, "30m structure is breaking down");
  }
  if (metrics.return60 !== undefined) {
    score.add(
      metrics.return60 >= -25 ? 5 : -5,
      metrics.return60 >= -25 ? "1h structure is intact" : "1h structure remains weak",
    );
  }
}

function scorePattern(score: TrendScore, pattern: string): void {
  if (["Basing at lows", "Bullish consolidation", "Sideways consolidation"].includes(pattern))
    score.add(8, pattern.toLowerCase());
  else if (pattern === "Uptrend channel") score.add(6, "controlled uptrend");
  else if (pattern === "Vertical run-up") score.add(-8, "vertical move creates chase risk");
  else if (["Breakdown", "Slow bleed"].includes(pattern)) score.add(-15, pattern.toLowerCase());
  else if (pattern === "Distribution at highs") score.add(-8, "possible distribution at highs");
}

function scoreMarketEvidence(score: TrendScore, metrics: TrendMetrics, market: Json): void {
  const smartWallets = finite(market.smart_degen_count ?? market.smart_money_count) ?? 0;
  const renownedWallets = finite(market.renowned_count) ?? 0;
  if (smartWallets >= 3) score.add(8, `${smartWallets} smart-money wallets`);
  else if (smartWallets > 0)
    score.add(3, `${smartWallets} smart-money wallet${smartWallets === 1 ? "" : "s"}`);
  if (renownedWallets > 0)
    score.add(2, `${renownedWallets} renowned wallet${renownedWallets === 1 ? "" : "s"}`);
  if (metrics.buySellRatio !== undefined) {
    if (metrics.buySellRatio >= 0.8) score.add(3, "5m buyers are not overwhelmed by sellers");
    else if (metrics.buySellRatio < 0.5) score.add(-3, "5m sells materially exceed buys");
  }
  if ((finite(market.market_cap) ?? Infinity) <= 500_000) score.add(3, "early market-cap range");
}

function passedStabilityGate(score: number, metrics: TrendMetrics, minimumVolume: number): boolean {
  const checks = [
    score >= Number(process.env.TRENDING_MIN_STABILITY_SCORE ?? 60),
    metrics.volume15 >= Number(process.env.TRENDING_MIN_VOLUME_15M_USD ?? minimumVolume * 2),
    metrics.drawdown <= Number(process.env.TRENDING_MAX_DRAWDOWN_1H_PERCENT ?? 45) / 100,
    metrics.volatility <= Number(process.env.TRENDING_MAX_VOLATILITY_1H_RATIO ?? 0.3),
    (metrics.return30 ?? -Infinity) >= Number(process.env.TRENDING_MIN_RETURN_30M_PERCENT ?? -30),
    !["Breakdown", "Slow bleed"].includes(metrics.pattern),
  ];
  return checks.every(Boolean);
}

export function analyzeTrendingCandles(rows: Json[], market: Json, minVolume5m = 25000): Json {
  const candles = normalizeTrendingCandles(rows);
  if (candles.length < 8)
    return {
      multiwindow_passed: false,
      multiwindow_score: 0,
      multiwindow_grade: "INSUFFICIENT",
      pattern: "not enough candles",
      candle_count: candles.length,
      multiwindow_reasons: ["fewer than 8 usable 5m candles"],
    };
  const metrics = calculateMetrics(candles, market);
  const score = new TrendScore();
  scoreVolume(score, metrics, minVolume5m);
  scorePriceStructure(score, metrics);
  scorePattern(score, metrics.pattern);
  scoreMarketEvidence(score, metrics, market);
  const finalScore = score.bounded();
  return {
    multiwindow_passed: passedStabilityGate(finalScore, metrics, minVolume5m),
    multiwindow_score: finalScore,
    multiwindow_grade:
      finalScore >= 80 ? "A" : finalScore >= 65 ? "B" : finalScore >= 50 ? "C" : "D",
    pattern: metrics.pattern,
    candle_count: candles.length,
    trend_up: metrics.trendUp,
    slope_percent: metrics.slope * 100,
    volatility_1h_ratio: metrics.volatility,
    drawdown_1h_percent: metrics.drawdown * 100,
    up_from_low_1h_percent: metrics.upFromLow * 100,
    volume_ratio_5m: metrics.volumeRatio,
    volume_cv_30m: metrics.volumeCv30,
    volume_turnover_15m: metrics.turnover15,
    volume_5m: metrics.volume5,
    volume_15m: metrics.volume15,
    volume_30m: metrics.volume30,
    volume_1h: metrics.volume60,
    price_change_5m: metrics.return5,
    price_change_15m: metrics.return15,
    price_change_30m: metrics.return30,
    price_change_1h: metrics.return60,
    buy_sell_ratio_5m: metrics.buySellRatio,
    multiwindow_reasons: score.reasons,
  };
}
