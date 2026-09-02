import type { DeliveryResult } from "../telegram.service.js";
import type { Alert, Chain, Json } from "../types.js";

export interface DiscoveryBatch {
  trending: Json[];
  surged: Json[];
  potential: Json[];
}

export interface DiscoveryDeliveries {
  trendingDelivery: DeliveryResult;
  surgedDelivery: DeliveryResult;
  potentialDelivery: DeliveryResult;
}

interface ScanStatusInput extends DiscoveryBatch, DiscoveryDeliveries {
  completedChains: Chain[];
  cooldownUntil?: number;
  diagnostics: Json;
  suppressedDiscoveries: Json[];
  multipleAlerts: Alert[];
  deliverableAlerts: Alert[];
  multipleDelivery: DeliveryResult;
  alertDelivery: DeliveryResult;
  telegramEnabled: boolean;
  subscriptionCount: number;
}

interface TrackedWalletStatusInput {
  completedChains: Chain[];
  alerts: Alert[];
  diagnostics: Json;
  delivery: DeliveryResult;
}

interface DexScreenerStatusInput {
  safe: Json[];
  surged: Json[];
  potential: Json[];
  suppressed: Json[];
  diagnostics: Json;
  surgedDelivery: DeliveryResult;
  potentialDelivery: DeliveryResult;
}

export function emptyDelivery(): DeliveryResult {
  return { attempted: 0, sent: 0, failed: 0 };
}

export function serializeTrending(row: Json): Json {
  return {
    chain: row.chain,
    address: row.address,
    symbol: row.symbol,
    quality_passed: row.quality_passed,
    multiwindow_passed: row.multiwindow_passed,
    multiwindow_grade: row.multiwindow_grade,
    multiwindow_score: row.multiwindow_score,
    pattern: row.pattern,
    market_cap: row.market_cap,
    liquidity: row.liquidity,
    volume_5m: row.volume_5m ?? row.volume,
    volume_15m: row.volume_15m,
    volume_30m: row.volume_30m,
    volume_1h: row.volume_1h,
    price_change_5m: row.price_change_5m,
    price_change_15m: row.price_change_15m,
    price_change_30m: row.price_change_30m,
    price_change_1h: row.price_change_1h,
    drawdown_1h_percent: row.drawdown_1h_percent,
  };
}

export function serializeDiscovery(row: Json): Json {
  return {
    chain: row.chain,
    address: row.address,
    symbol: row.symbol,
    market_cap: row.market_cap,
    liquidity: row.liquidity,
    volume_5m: row.volume,
    price_change_5m: row.price_change_5m ?? row.price_change_percent5m ?? row.price_change_percent,
    price_change_30m: row.price_change_30m,
    pons_status: row.pons_status,
    graduation_progress_percent: row.graduation_progress_percent,
    progress_change_30m: row.progress_change_30m,
    sources: row.degen_sources,
    surge_attribution: row.surge_attribution
      ? {
          event: row.surge_attribution.event,
          confirmed_profitable_wallets: row.surge_attribution.wallets?.length ?? 0,
          track_worthy_wallets: row.surge_attribution.track_worthy_wallets ?? 0,
        }
      : undefined,
    failed_gates: row.quality_reasons,
  };
}

function serializeSuppressedDiscovery(row: Json, chain?: Chain): Json {
  return {
    chain: chain ?? row.scope,
    address: row.address,
    symbol: row.symbol,
    status: row.status,
    sources: row.sources,
    signals: row.signals,
    reasons: row.reasons,
    market_cap: row.market_cap,
    liquidity: row.liquidity,
    volume_5m: row.volume_5m,
    price_change_5m: row.price_change_5m,
    last_detected_at: row.last_detected_at,
  };
}

function serializeMultiple(alert: Alert): Json {
  return {
    chain: alert.chain,
    address: alert.address,
    symbol: alert.symbol,
    milestone: alert.milestone,
    multiple: alert.multiple,
    age_seconds: alert.age_seconds,
  };
}

function serializeAlert(alert: Alert): Json {
  return {
    chain: alert.chain,
    address: alert.address,
    symbol: alert.symbol,
    tier: alert.tier,
    kind: alert.kind,
    tracking_label: alert.tracking_label,
    traders: alert.traders,
    market_cap_at_detection: alert.market_cap_at_detection,
  };
}

export function buildScanStatus(input: ScanStatusInput): Json {
  return {
    scanned_at: new Date().toISOString(),
    completed_chains: input.completedChains,
    gmgn_cooldown_until: input.cooldownUntil ? new Date(input.cooldownUntil).toISOString() : null,
    diagnostics: input.diagnostics,
    trending_contracts: input.trending.map(serializeTrending),
    surged_contracts: input.surged.map(serializeDiscovery),
    potential_contracts: input.potential.map((row) => ({
      ...serializeDiscovery(row),
      potential_runner_score: row.potential_runner_score,
    })),
    suppressed_discoveries: input.suppressedDiscoveries,
    multiple_alerts: input.multipleAlerts.map(serializeMultiple),
    alerts: input.deliverableAlerts.map(serializeAlert),
    subscribed_chats: input.subscriptionCount,
    telegram: {
      enabled: input.telegramEnabled,
      trending: input.trendingDelivery,
      surged: input.surgedDelivery,
      potential: input.potentialDelivery,
      multiples: input.multipleDelivery,
      alerts: input.alertDelivery,
    },
  };
}

export function buildTrackedWalletStatus(input: TrackedWalletStatusInput): Json {
  return {
    scanned_at: new Date().toISOString(),
    completed_chains: input.completedChains,
    alerts: input.alerts.map(serializeAlert),
    diagnostics: input.diagnostics,
    telegram: input.delivery,
  };
}

export function buildDexScreenerStatus(input: DexScreenerStatusInput): Json {
  return {
    scanned_at: new Date().toISOString(),
    safe_candidates: input.safe.length,
    surged: input.surged.map(serializeDiscovery),
    potential: input.potential.map((row) => ({
      ...serializeDiscovery(row),
      potential_runner_score: row.potential_runner_score,
    })),
    suppressed: input.suppressed.map((row) => serializeSuppressedDiscovery(row)),
    diagnostics: input.diagnostics,
    telegram: {
      surged: input.surgedDelivery,
      potential: input.potentialDelivery,
    },
  };
}

export function serializeSuppressed(rows: Array<{ chain: Chain; row: Json }>): Json[] {
  return rows.map(({ chain, row }) => serializeSuppressedDiscovery(row, chain));
}
