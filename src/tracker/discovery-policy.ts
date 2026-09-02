import { compareChainPriority, priorityChains } from "../chain-priority.js";
import { addressKey } from "../signals.js";
import type { Chain, Json } from "../types.js";

const DEFAULT_CHAIN_SHARES: Partial<Record<Chain, number>> = {
  robinhood: 0.5,
  bsc: 0.3,
  sol: 0.2,
};

const SURGE_LABELS = new Set([
  "PRICE SURGE",
  "PONS PRICE SURGE",
  "DEXSCREENER PRICE SURGE",
  "NEW ATH",
]);

const envNumber = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const finiteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const discoveryRowKey = (row: Json): string =>
  `${row.chain}:${addressKey(String(row.address ?? row.token_address ?? ""))}`;

function uniqueValues(current: unknown, incoming: unknown): unknown[] {
  const left = Array.isArray(current) ? current : [];
  const right = Array.isArray(incoming) ? incoming : [];
  return [...new Set([...left, ...right])];
}

function mergeDiscoveryRow(target: Json, incoming: Json): void {
  for (const [field, value] of Object.entries(incoming)) {
    if (value !== undefined && value !== null && value !== "") target[field] = value;
  }

  target.degen_sources = uniqueValues(target.degen_sources, incoming.degen_sources);
  target.degen_signal_labels = uniqueValues(
    target.degen_signal_labels,
    incoming.degen_signal_labels,
  );
  target.quality_reasons = uniqueValues(target.quality_reasons, incoming.quality_reasons);
}

export function mergeDiscoveryRows(...groups: Json[][]): Json[] {
  const merged = new Map<string, Json>();

  for (const row of groups.flat()) {
    const key = discoveryRowKey(row);
    if (!row.address || key.endsWith(":")) continue;

    const target = merged.get(key) ?? {};
    mergeDiscoveryRow(target, row);
    merged.set(key, target);
  }

  return [...merged.values()];
}

function boundedShare(value: unknown): number {
  return Math.max(0, Math.min(1, Number(value ?? 0)));
}

function appendRows<T extends Json>(
  rows: T[],
  selected: T[],
  selectedKeys: Set<string>,
  limit: number,
  predicate: (row: T) => boolean,
): void {
  for (const row of rows) {
    if (selected.length >= limit) return;
    const key = discoveryRowKey(row);
    if (predicate(row) && !selectedKeys.has(key)) {
      selected.push(row);
      selectedKeys.add(key);
    }
  }
}

export function priorityChainSlice<T extends Json>(
  rows: T[],
  limit: number,
  minimumShares: Partial<Record<Chain, number>> = DEFAULT_CHAIN_SHARES,
): T[] {
  const cappedLimit = Math.max(0, Math.floor(limit));
  const selected: T[] = [];
  const selectedKeys = new Set<string>();

  for (const chain of priorityChains(Object.keys(minimumShares) as Chain[])) {
    const quota = Math.min(
      cappedLimit - selected.length,
      Math.ceil(cappedLimit * boundedShare(minimumShares[chain])),
    );
    let selectedForChain = 0;

    appendRows(rows, selected, selectedKeys, cappedLimit, (row) => {
      if (row.chain !== chain || selectedForChain >= quota) return false;
      selectedForChain += 1;
      return true;
    });
  }

  appendRows(rows, selected, selectedKeys, cappedLimit, () => true);

  const originalRank = new Map(rows.map((row, index) => [discoveryRowKey(row), index]));
  return selected.sort(
    (left, right) =>
      compareChainPriority(left.chain, right.chain) ||
      Number(originalRank.get(discoveryRowKey(left))) -
        Number(originalRank.get(discoveryRowKey(right))),
  );
}

export function isSurgedToken(row: Json): boolean {
  const labels = new Set<string>((row.degen_signal_labels ?? []).map(String));
  const sources = new Set<string>((row.signal_sources ?? []).map(String));
  const change = finiteNumber(
    row.price_change_5m ?? row.price_change_percent5m ?? row.price_change_percent,
  );
  const threshold = envNumber("MIN_PRICE_SURGE_5M_PERCENT", 10);

  const hasSurgeLabel = [...SURGE_LABELS].some((label) => labels.has(label));
  const hasSurgeSource = sources.has("price_surge") || sources.has("trending_momentum");
  const hasPriceSurge = change !== undefined && change >= threshold;

  return Boolean(row.surge_attribution?.event) || hasSurgeLabel || hasSurgeSource || hasPriceSurge;
}

export function passesHighMarketCapPolicy(
  row: Json,
  maximum = envNumber("ROUTINE_FEED_MAX_MARKET_CAP_USD", 1_000_000),
  minimumTrackedWallets = envNumber("HIGH_CAP_MIN_TRACKED_BUY_WALLETS", 2),
): boolean {
  const marketCap = finiteNumber(row.market_cap ?? row.marketCap);
  const trackedWallets = finiteNumber(row.tracked_buy_wallet_count) ?? 0;

  if (marketCap === undefined || marketCap <= maximum) return true;
  return isSurgedToken(row) || trackedWallets >= minimumTrackedWallets;
}

function smartMoneyScore(labels: Set<string>, smartWallets: number): number {
  if (labels.has("SMART MONEY") || smartWallets >= 3) return 25;
  return smartWallets > 0 ? 10 : 0;
}

export function potentialRunnerScore(row: Json): number {
  if (isSurgedToken(row)) return 0;

  const labels = new Set<string>((row.degen_signal_labels ?? []).map(String));
  const smartWallets =
    finiteNumber(row.smart_degen_count ?? row.smart_money_count ?? row.smart_wallets) ?? 0;
  const volume = finiteNumber(row.volume_5m ?? row.volume ?? row.volume_1h) ?? 0;
  const change =
    finiteNumber(row.price_change_5m ?? row.price_change_percent5m ?? row.price_change_percent) ??
    0;
  const holders = finiteNumber(row.holder_count);
  const topTenRate = finiteNumber(row.top_10_holder_rate);

  const hasGraduationSignal = ["NEAR GRADUATION", "JUST GRADUATED", "PONS PROGRESS SURGE"].some(
    (label) => labels.has(label),
  );

  const contributions = [
    hasGraduationSignal ? 35 : 0,
    labels.has("NEW ACTIVE LAUNCH") ? 20 : 0,
    labels.has("LONG NEW LAUNCH") ? 30 : 0,
    labels.has("DEXSCREENER NEW PAIR") ? 30 : 0,
    labels.has("DEXSCREENER VOLUME") ? 20 : 0,
    smartMoneyScore(labels, smartWallets),
    row.is_microcap === true ? 20 : 0,
    volume >= envNumber("POTENTIAL_RUNNER_MIN_VOLUME_USD", 25_000) ? 15 : 0,
    change > 0 ? 10 : 0,
    holders !== undefined && holders >= 50 ? 10 : 0,
    topTenRate !== undefined && topTenRate > 0 && topTenRate <= 0.3 ? 10 : 0,
  ];

  return Math.min(
    100,
    contributions.reduce((total, points) => total + points, 0),
  );
}
