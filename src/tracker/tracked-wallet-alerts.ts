import type { TrackerStore } from "../store.js";
import type { Alert, Chain } from "../types.js";
import type { SignalCandidate } from "../signals.js";

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const finiteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

function candidateLiquidity(candidate: SignalCandidate): number | undefined {
  return finiteNumber(
    candidate.tokenPool?.liquidity ??
      candidate.tokenInfo?.liquidity ??
      candidate.tokenInfo?.pool?.liquidity,
  );
}

function cooldownElapsed(
  store: TrackerStore,
  candidate: SignalCandidate,
  kind: string,
  cooldownMilliseconds: number,
  nowSeconds: number,
): boolean {
  return nowSeconds - store.lastAlertAt(candidate.address, kind) >= cooldownMilliseconds / 1000;
}

function buildSellAlert(
  chain: Chain,
  candidate: SignalCandidate,
  store: TrackerStore,
  nowSeconds: number,
): Alert | undefined {
  const walletCount = candidate.sellWallets?.size ?? 0;
  if (walletCount < 2 || candidate.trackedBuySafety?.passed !== true) return undefined;

  const kind = "TRACKED_WALLET_SELL";
  const cooldown = envNumber("TRACKED_WALLET_SELL_ALERT_COOLDOWN_MS", 900_000);
  if (!cooldownElapsed(store, candidate, kind, cooldown, nowSeconds)) return undefined;

  return {
    tier: "RESEARCH",
    kind,
    tracking_label: walletCount === 2 ? "OBSERVE" : "SELL WATCH",
    chain,
    address: candidate.address,
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
    wallet_count: walletCount,
    wallets: [...(candidate.sellWallets ?? [])],
    traders: [...(candidate.sellTraderLabels ?? [])],
    sources: [...(candidate.sellSources ?? [])],
    aggregate_sell_usd: Math.round((candidate.aggregateSellUsd ?? 0) * 100) / 100,
    market_cap_at_detection: candidate.observedMarketCap,
    market_cap_observed_at: candidate.marketCapObservedAt,
    liquidity_at_detection: candidateLiquidity(candidate),
    first_timestamp: candidate.firstTimestamp,
  };
}

function buyAlertIdentity(walletCount: number): Pick<Alert, "kind" | "tracking_label"> {
  if (walletCount >= 5) {
    return { kind: "TRACKED_WALLET_BUY_SIGNAL", tracking_label: "BUY SIGNAL" };
  }
  if (walletCount >= 3) {
    return { kind: "TRACKED_WALLET_POTENTIAL", tracking_label: "RESEARCH" };
  }
  return { kind: "TRACKED_WALLET_OBSERVE", tracking_label: "OBSERVE" };
}

function buildBuyAlert(
  chain: Chain,
  candidate: SignalCandidate,
  store: TrackerStore,
  nowSeconds: number,
): Alert | undefined {
  const walletCount = candidate.buyWallets.size;
  if (walletCount < 2 || candidate.trackedBuySafety?.passed !== true) return undefined;

  const identity = buyAlertIdentity(walletCount);
  const cooldown =
    walletCount >= 5
      ? envNumber("WALLET_CLUSTER_ALERT_COOLDOWN_MS", 1_800_000)
      : envNumber("TRACKED_WALLET_BUY_ALERT_COOLDOWN_MS", 1_800_000);
  if (!cooldownElapsed(store, candidate, String(identity.kind), cooldown, nowSeconds)) {
    return undefined;
  }

  const marketCap = candidate.observedMarketCap;
  const liquidity = candidateLiquidity(candidate);
  return {
    tier: "RESEARCH",
    ...identity,
    chain,
    address: candidate.address,
    ...(candidate.symbol ? { symbol: candidate.symbol } : {}),
    wallet_count: walletCount,
    wallets: [...candidate.buyWallets],
    traders: [...(candidate.traderLabels ?? [])],
    sources: [...candidate.sources],
    aggregate_buy_usd: Math.round(candidate.aggregateBuyUsd * 100) / 100,
    market_cap_at_detection: marketCap,
    market_cap_observed_at: candidate.marketCapObservedAt,
    liquidity_at_detection: liquidity,
    liquidity_to_market_cap_ratio:
      liquidity !== undefined && marketCap !== undefined && marketCap > 0
        ? liquidity / marketCap
        : undefined,
    holder_count_at_detection: finiteNumber(
      candidate.tokenInfo?.holder_count ?? candidate.tokenInfo?.stat?.holder_count,
    ),
    top_10_holder_rate_at_detection: finiteNumber(
      candidate.tokenInfo?.stat?.top_10_holder_rate ?? candidate.tokenInfo?.dev?.top_10_holder_rate,
    ),
    safety_reasons: candidate.trackedBuySafety.reasons,
    first_timestamp: candidate.firstTimestamp,
  };
}

function persistAlert(store: TrackerStore, alert: Alert | undefined, timestamp: number): Alert[] {
  if (!alert || !store.saveAlert(alert, timestamp)) return [];
  return [alert];
}

export function buildTrackedWalletAlerts(
  chain: Chain,
  candidates: Map<string, SignalCandidate>,
  store: TrackerStore,
  nowSeconds = Date.now() / 1000,
): Alert[] {
  const alerts: Alert[] = [];

  for (const candidate of candidates.values()) {
    alerts.push(
      ...persistAlert(
        store,
        buildSellAlert(chain, candidate, store, nowSeconds),
        candidate.firstTimestamp,
      ),
      ...persistAlert(
        store,
        buildBuyAlert(chain, candidate, store, nowSeconds),
        candidate.firstTimestamp,
      ),
    );
  }

  return alerts;
}
