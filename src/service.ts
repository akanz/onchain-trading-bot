import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configForChain, ROOT } from "./config.js";
import { GmgnClient, isRateLimit } from "./gmgn.js";
import { number, scoreToken, screenTrackedBuyToken } from "./scoring.js";
import { OpenTwitterClient } from "./opentwitter.js";
import {
  addressKey,
  extractContractAddresses,
  isCatastrophicMarketCapCollapse,
  marketSnapshot,
  passesMarketGate,
  passesSurgeDiscoveryGate,
  shouldInvestigate,
  signalStrength,
  validTokenAddress,
  type SignalCandidate,
  type SignalSource,
} from "./signals.js";
import { TrackerStore } from "./store.js";
import { buildTokenSnapshot } from "./token-card.js";
import { analyzeTrendingCandles } from "./trending-analysis.js";
import { buildDegenRows } from "./degen.js";
import { PonsClient } from "./pons/client.js";
import {
  normalizePonsLaunch,
  ponsKlineChanges,
  qualifyPonsDegen,
  selectPonsProbeRows,
} from "./pons/analysis.js";
import type { Alert, Chain, Json, TokenSnapshot, TrackerConfig } from "./types.js";
import type { MongoState } from "./mongo.js";
import {
  assessWalletPerformance,
  detectSurgeEvents,
  profitablePreMoveTrader,
} from "./surge-attribution.js";
import { priorityChains } from "./chain-priority.js";
import { LongClient } from "./long/client.js";
import { qualifyLongAssets } from "./long/analysis.js";
import { DexScreenerClient } from "./dexscreener/client.js";
import { normalizeDexScreenerPairs, qualifyDexScreenerPairs } from "./dexscreener/analysis.js";
import {
  discoveryRowKey as rowKey,
  isSurgedToken,
  mergeDiscoveryRows as mergeDegenRows,
  passesHighMarketCapPolicy,
  potentialRunnerScore,
  priorityChainSlice,
} from "./tracker/discovery-policy.js";
import { TrackedWalletRoster } from "./tracker/tracked-wallet-roster.js";
import { buildTrackedWalletAlerts } from "./tracker/tracked-wallet-alerts.js";
import { alertTier, buildCandidateAlert } from "./tracker/candidate-alert.js";

export {
  isSurgedToken,
  passesHighMarketCapPolicy,
  potentialRunnerScore,
  priorityChainSlice,
} from "./tracker/discovery-policy.js";

const envNumber = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const finiteNumber = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const timestamp = (row: Json) => Number(row.timestamp ?? row.trigger_at ?? row.created_at ?? 0);
const recent = (row: Json, seconds: number) =>
  timestamp(row) > 0 && timestamp(row) >= Math.floor(Date.now() / 1000) - seconds;
const explicitRugEvidence = (snapshot: TokenSnapshot): boolean =>
  snapshot.honeypot === true ||
  [...(snapshot.verdict?.reasons ?? []), ...(snapshot.verdict?.warnings ?? [])].some((value) => {
    const text = String(value);
    return (
      !/\b(?:unavailable|unknown)\b/i.test(text) &&
      /\b(?:honeypot detected|rug(?: pull)? (?:detected|flagged)|scam(?: token)?|cannot sell|can't sell|unsellable|malicious contract)\b/i.test(
        text,
      )
    );
  });
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return output;
}
export class TrackerService {
  private stores = new Map<Chain, TrackerStore>();
  private running = new Set<Chain>();
  private walletScanAt = new Map<Chain, number>();
  private walletScanCursor = new Map<Chain, number>();
  private twitterScanAt = 0;
  private twitterMentions = new Map<string, { accounts: Set<string>; seenAt: number }>();
  private readonly walletRoster: TrackedWalletRoster;
  private set mongoTrackedWalletRows(rows: Json[]) {
    this.walletRoster.replaceMongoRows(rows);
  }
  private trackedBuySafetyStats = new Map<Chain, Json>();
  private trackedWalletPollStats = new Map<Chain, Json>();
  private ponsScanAt = 0;
  private ponsRows: Json[] = [];
  private ponsStats: Json = { active: 0, graduated: 0, qualified: 0, refreshed_at: null };
  private longScanAt = 0;
  private longInitialized = false;
  private longRows: Json[] = [];
  private longStats: Json = { assets: 0, qualified: 0, refreshed_at: null, error: null };
  private dexScreenerScanAt = new Map<Chain, number>();
  private dexScreenerRows = new Map<Chain, Json[]>();
  private dexScreenerStats = new Map<Chain, Json>();
  private trendingRows = new Map<Chain, Json[]>();
  private trendingSeen = new Map<string, { firstSeen: number; lastSeen: number }>();
  private trendingDispatch = new Map<
    string,
    { sentAt: number; price?: number; tags: Set<string> }
  >();
  private potentialDispatch = new Map<
    string,
    { sentAt: number; metric?: number; wallets: number; labels: Set<string> }
  >();
  private surgedDispatch = new Map<
    string,
    { sentAt: number; metric?: number; wallets: number; labels: Set<string> }
  >();
  private degenRows = new Map<Chain, Json[]>();
  private surgeAttributionCache = new Map<string, { checkedAt: number; attribution?: Json }>();
  private surgeAttributionStats = new Map<Chain, Json>();
  constructor(
    readonly config: TrackerConfig,
    readonly gmgn = new GmgnClient(),
    readonly twitter = new OpenTwitterClient(),
    readonly pons = new PonsClient(),
    readonly mongo?: MongoState,
    readonly long = new LongClient(),
    readonly dexScreener = new DexScreenerClient(),
  ) {
    this.walletRoster = new TrackedWalletRoster(config, mongo);
  }
  store(chain: Chain): TrackerStore {
    let s = this.stores.get(chain);
    if (!s) {
      s = new TrackerStore(chain, this.mongo);
      this.stores.set(chain, s);
    }
    return s;
  }
  async init(): Promise<void> {
    await Promise.all(this.config.enabled_chains.map((chain) => this.store(chain).init()));
    await this.refreshTrackedWalletsFromMongo();
  }
  async close(): Promise<void> {
    this.gmgn.close?.();
    await Promise.all([...this.stores.values()].map((store) => store.close()));
  }
  roster(chain: Chain) {
    const stored = this.store(chain).roster(),
      fallback = this.loadTrackedWalletRows().filter((row) => row.chain === chain),
      combined = new Map<string, Json>();
    for (const row of [...stored, ...fallback])
      combined.set(`${row.source ?? "stored"}:${String(row.wallet).toLowerCase()}`, row);
    return [...combined.values()]
      .sort(
        (a, b) =>
          Number(
            b.score ??
              b.fomo_leaderboard_pnl ??
              b.max_position_roi_percent ??
              b.wilson_closed_sample ??
              b.wilson_30d ??
              0,
          ) -
          Number(
            a.score ??
              a.fomo_leaderboard_pnl ??
              a.max_position_roi_percent ??
              a.wilson_closed_sample ??
              a.wilson_30d ??
              0,
          ),
      )
      .map((row) => ({
        wallet: row.wallet,
        score: row.score ?? row.wilson_closed_sample ?? row.wilson_30d ?? 0,
        assessed_at: row.generated_at ?? row.updated_at,
        source: row.source,
        tracking_tier: row.tracking_tier ?? "qualified",
        fomo_handle: row.fomo_handle,
        qualifying_positions: row.qualifying_positions ?? [],
        max_position_roi_percent: row.max_position_roi_percent,
        max_realized_position_roi_percent: row.max_realized_position_roi_percent,
        max_unrealized_position_roi_percent: row.max_unrealized_position_roi_percent,
        fomo_leaderboard_pnl: row.fomo_leaderboard_pnl,
      }));
  }
  alerts(chain: Chain, limit = 50) {
    return this.store(chain).alerts(limit);
  }
  discoveryDecisions(chain: Chain, limit = 50, status?: string) {
    return this.store(chain).discoveryDecisions(limit, status);
  }
  latestTrending(chain: Chain, limit = 10): Json[] {
    return (this.trendingRows.get(chain) ?? []).slice(0, limit);
  }
  diagnostics(chains: Chain[]): Json {
    const tracked = this.loadTrackedWallets();
    return Object.fromEntries(
      chains.map((chain) => {
        const trending = this.trendingRows.get(chain) ?? [],
          degen = this.degenRows.get(chain) ?? [];
        const decisions = this.store(chain).discoveryDecisions(500),
          dex = this.dexScreenerStats.get(chain) ?? {
            discovered: 0,
            qualified: 0,
            refreshed_at: null,
            error: null,
          };
        return [
          chain,
          {
            gmgn_tracked_wallets: (tracked.get(chain) ?? []).length,
            tracked_wallet_poll: this.trackedWalletPollStats.get(chain) ?? {
              attempted_wallets: 0,
              events: 0,
              refreshed_at: null,
              rate_limited: false,
            },
            multiplier_monitor: this.store(chain).callPerformanceSummary(),
            surge_wallet_attribution: this.surgeAttributionStats.get(chain) ?? {
              tokens_checked: 0,
              surge_events: 0,
              confirmed_profitable_wallets: 0,
              track_worthy_wallets: 0,
              rate_limited: false,
            },
            gmgn_trending_rows: trending.length,
            gmgn_trending_quality_passed: trending.filter((row) => row.quality_passed === true)
              .length,
            gmgn_trending_multiwindow_passed: trending.filter(
              (row) => row.multiwindow_passed === true,
            ).length,
            dexscreener_discovered: dex.discovered,
            dexscreener_candidates: dex.qualified,
            dexscreener_refreshed_at: dex.refreshed_at,
            dexscreener_error: dex.error,
            discovery_audit: {
              total: decisions.length,
              passed: decisions.filter((row) => row.status === "passed").length,
              suppressed: decisions.filter((row) => row.status === "suppressed").length,
              pending: decisions.filter((row) => row.status === "pending").length,
              recent_suppressed: decisions
                .filter((row) => row.status === "suppressed")
                .slice(0, 10),
            },
            degen_filtered_trending: degen.filter((row) =>
              row.degen_sources?.includes("FILTERED TRENDING"),
            ).length,
            degen_microcaps: degen.filter((row) => row.is_microcap === true).length,
            degen_surge_events: degen.filter((row) => row.degen_signal_labels?.length).length,
            ...(chain === "robinhood"
              ? {
                  pons_active_launches: this.ponsStats.active,
                  pons_recent_graduated: this.ponsStats.graduated,
                  pons_degen_candidates: this.ponsStats.qualified,
                  pons_refreshed_at: this.ponsStats.refreshed_at,
                  long_assets: this.longStats.assets,
                  long_candidates: this.longStats.qualified,
                  long_refreshed_at: this.longStats.refreshed_at,
                  long_error: this.longStats.error,
                }
              : {}),
            tracked_buy_safety: this.trackedBuySafetyStats.get(chain) ?? {
              checked: 0,
              passed: 0,
              suppressed: 0,
              unavailable: 0,
              recent_suppressed: [],
            },
          },
        ];
      }),
    );
  }
  private collapseSuppressed(row: Json, now = Math.floor(Date.now() / 1000)): boolean {
    const chain = row.chain as Chain,
      address = String(row.address ?? row.token_address ?? ""),
      currentMarketCap = finiteNumber(row.market_cap);
    if (!this.config.enabled_chains.includes(chain) || !address || currentMarketCap === undefined)
      return false;
    const tokenConfig = configForChain(this.config, chain).token,
      collapseRatio = finiteNumber(tokenConfig.catastrophic_market_cap_ratio) ?? 0.01,
      baseline = this.store(chain).callPerformance(address)?.baseline_market_cap;
    if (
      !isCatastrophicMarketCapCollapse(baseline, currentMarketCap, collapseRatio) &&
      !this.store(chain).callPerformance(address)?.dead_at
    ) {
      this.store(chain).observeCatastrophicMarketCapCollapse(
        address,
        currentMarketCap,
        collapseRatio,
        now,
      );
      return false;
    }
    const state = this.store(chain).observeCatastrophicMarketCapCollapse(
      address,
      currentMarketCap,
      collapseRatio,
      now,
      Math.max(1, Math.floor(finiteNumber(tokenConfig.catastrophic_market_cap_confirmations) ?? 2)),
      Math.max(
        0,
        Math.floor(
          finiteNumber(tokenConfig.catastrophic_market_cap_confirmation_interval_seconds) ?? 15,
        ),
      ),
    );
    return state === "suspected" || state === "dead";
  }
  async latestTrendingAcross(chains: Chain[], limit = 10): Promise<Json[]> {
    const requireStability = process.env.TRENDING_REQUIRE_MULTIWINDOW_STABILITY !== "false",
      now = Math.floor(Date.now() / 1000),
      reentry = Math.max(300, envNumber("TRENDING_REENTRY_SECONDS", 21600)),
      cooldown = Math.max(300, envNumber("TRENDING_SIGNAL_COOLDOWN_SECONDS", 1800)),
      minPositive = envNumber("TRENDING_MIN_POSITIVE_CHANGE_PERCENT", 0),
      minGain = Math.max(0, envNumber("TRENDING_REEMIT_MIN_PRICE_GAIN_PERCENT", 5)) / 100,
      rows: Json[] = chains
        .flatMap((chain) =>
          (this.trendingRows.get(chain) ?? []).map((row) => ({ ...row, chain }) as Json),
        )
        .filter(
          (row) =>
            row.quality_passed === true &&
            (!requireStability || row.multiwindow_passed === true) &&
            passesHighMarketCapPolicy(
              row,
              envNumber(
                "TRENDING_ROUTINE_MAX_MARKET_CAP_USD",
                envNumber("ROUTINE_FEED_MAX_MARKET_CAP_USD", 1_000_000),
              ),
              envNumber("HIGH_CAP_MIN_TRACKED_BUY_WALLETS", 2),
            ) &&
            !this.collapseSuppressed(row, now),
        );
    const selected: Json[] = [];
    for (const row of rows) {
      const address = String(row.address ?? "");
      if (!address) continue;
      const key = `${row.chain}:${addressKey(address)}`,
        seen = this.trendingSeen.get(key),
        isNew = !seen || now - seen.lastSeen >= reentry,
        firstSeen = isNew ? now : seen.firstSeen;
      this.trendingSeen.set(key, { firstSeen, lastSeen: now });
      const changes = [
          row.price_change_5m,
          row.price_change_percent5m,
          row.price_change_15m,
          row.price_change_30m,
          row.price_change_1h,
        ]
          .map(finiteNumber)
          .filter((value): value is number => value !== undefined),
        sources = new Set<string>(
          Array.isArray(row.signal_sources) ? row.signal_sources.map(String) : [],
        ),
        tags: string[] = [];
      if (isNew) tags.push("NEW");
      if (changes.some((change) => change > minPositive)) tags.push("PRICE UP");
      if (
        Number(row.price_change_5m ?? row.price_change_percent5m) >=
          envNumber("MIN_PRICE_SURGE_5M_PERCENT", 10) ||
        Number(row.price_change_30m) >= envNumber("TRENDING_30M_PRICE_INCREASE_PERCENT", 100) ||
        sources.has("price_surge") ||
        sources.has("trending_momentum")
      )
        tags.push("PRICE SURGE");
      if (
        sources.has("smart_money_signal") ||
        sources.has("smart_money_wallet") ||
        sources.has("trending_smart_money") ||
        Number(row.smart_degen_count ?? row.smart_money_count) > 0
      )
        tags.push("SMART MONEY BUY");
      if (!tags.length) continue;
      const prior = this.trendingDispatch.get(key),
        price = finiteNumber(row.price),
        hasNewTag = isNew || !prior || tags.some((tag) => !prior.tags.has(tag)),
        meaningfullyHigher =
          price !== undefined && prior?.price !== undefined && price >= prior.price * (1 + minGain),
        reemit = Boolean(
          prior &&
            now - prior.sentAt >= cooldown &&
            meaningfullyHigher &&
            tags.some((tag) => tag !== "NEW"),
        );
      if (prior && !hasNewTag && !reemit) continue;
      selected.push({
        ...row,
        trending_signal_tags: tags,
        trending_first_seen_at: firstSeen,
        trending_is_new: isNew,
        trending_dispatch_key: key,
      });
    }
    const ranked = selected.sort(
      (a, b) =>
        Number(b.trending_signal_tags?.includes("SMART MONEY BUY")) -
          Number(a.trending_signal_tags?.includes("SMART MONEY BUY")) ||
        Number(b.trending_signal_tags?.includes("PRICE SURGE")) -
          Number(a.trending_signal_tags?.includes("PRICE SURGE")) ||
        Number(b.multiwindow_score ?? 0) - Number(a.multiwindow_score ?? 0) ||
        Number(b.volume_15m ?? 0) - Number(a.volume_15m ?? 0),
    );
    return priorityChainSlice(ranked, limit, {
      robinhood: envNumber("TRENDING_ROBINHOOD_MIN_SHARE", 0.5),
      bsc: envNumber("TRENDING_BSC_MIN_SHARE", 0.3),
      sol: envNumber("TRENDING_SOL_MIN_SHARE", 0.2),
    });
  }
  acknowledgeTrending(rows: Json[], sentAt = Math.floor(Date.now() / 1000)): void {
    for (const row of rows) {
      const key = String(
          row.trending_dispatch_key ?? `${row.chain}:${addressKey(String(row.address ?? ""))}`,
        ),
        price = finiteNumber(row.price);
      if (!key || key.endsWith(":")) continue;
      this.trendingDispatch.set(key, {
        sentAt,
        ...(price === undefined ? {} : { price }),
        tags: new Set((row.trending_signal_tags ?? []).map(String)),
      });
    }
  }
  latestDegenAcross(chains: Chain[], limit = 20): Json[] {
    const now = Math.floor(Date.now() / 1000),
      all: Json[] = chains
        .flatMap((chain) =>
          (this.degenRows.get(chain) ?? []).map((row) => ({ ...row, chain }) as Json),
        )
        .filter((row) => !this.collapseSuppressed(row, now)),
      rejected = all.filter((row) => row.degen_sources?.includes("FILTERED TRENDING")),
      signalOnly = all.filter((row) => !row.degen_sources?.includes("FILTERED TRENDING"));
    const priority = (row: Json) =>
      row.degen_signal_labels?.includes("PONS PRICE SURGE") ||
      row.degen_signal_labels?.includes("PRICE SURGE")
        ? 6
        : row.degen_signal_labels?.includes("PONS PROGRESS SURGE")
          ? 5
          : row.degen_signal_labels?.includes("NEW ATH") ||
              row.degen_signal_labels?.includes("JUST GRADUATED")
            ? 4
            : row.degen_signal_labels?.includes("NEAR GRADUATION")
              ? 3
              : row.degen_signal_labels?.includes("SMART MONEY")
                ? 2
                : 1;
    const rank = (a: Json, b: Json) =>
      Number(b.is_microcap === true) - Number(a.is_microcap === true) ||
      priority(b) - priority(a) ||
      Number(b.pons_signal_score ?? 0) - Number(a.pons_signal_score ?? 0) ||
      Number(b.price_change_percent5m ?? b.price_change_percent ?? -Infinity) -
        Number(a.price_change_percent5m ?? a.price_change_percent ?? -Infinity) ||
      Number(b.volume ?? 0) - Number(a.volume ?? 0);
    const ranked = [...rejected, ...signalOnly].sort(rank),
      capped = Math.max(0, limit),
      robinhood = ranked.filter((row) => row.chain === "robinhood"),
      target = Math.min(
        robinhood.length,
        Math.ceil(capped * Math.min(1, Math.max(0, envNumber("DEGEN_ROBINHOOD_MIN_SHARE", 0.75)))),
      ),
      selected = robinhood.slice(0, target),
      rowKey = (row: Json) => `${row.chain}:${addressKey(String(row.address))}`,
      keys = new Set(selected.map(rowKey));
    for (const row of ranked)
      if (selected.length < capped && !keys.has(rowKey(row))) {
        selected.push(row);
        keys.add(rowKey(row));
      }
    return selected.sort(rank).slice(0, capped);
  }
  latestSurgedAcross(chains: Chain[], limit = 10): Json[] {
    const rows = mergeDegenRows(
        chains.flatMap((chain) => this.degenRows.get(chain) ?? []),
        chains.flatMap((chain) => (this.trendingRows.get(chain) ?? []).filter(isSurgedToken)),
      ).filter((row) => isSurgedToken(row) && this.discoveryDispatchAllowed("surged", row)),
      rank = (a: Json, b: Json) =>
        Number(b.surge_attribution?.wallets?.length ?? 0) -
          Number(a.surge_attribution?.wallets?.length ?? 0) ||
        Number(b.smart_degen_count ?? b.smart_wallets ?? 0) -
          Number(a.smart_degen_count ?? a.smart_wallets ?? 0) ||
        Number(b.price_change_5m ?? b.price_change_percent5m ?? b.price_change_percent ?? 0) -
          Number(a.price_change_5m ?? a.price_change_percent5m ?? a.price_change_percent ?? 0) ||
        Number(b.volume_5m ?? b.volume ?? 0) - Number(a.volume_5m ?? a.volume ?? 0);
    return priorityChainSlice(rows.sort(rank), limit, {
      robinhood: envNumber("SURGED_ROBINHOOD_MIN_SHARE", 0.5),
      bsc: envNumber("SURGED_BSC_MIN_SHARE", 0.3),
      sol: envNumber("SURGED_SOL_MIN_SHARE", 0.2),
    });
  }
  latestPotentialAcross(chains: Chain[], limit = 10): Json[] {
    const minimum = envNumber("POTENTIAL_RUNNER_MIN_SCORE", 45),
      rows = chains
        .flatMap((chain) => this.degenRows.get(chain) ?? [])
        .map((row) => ({ ...row, potential_runner_score: potentialRunnerScore(row) }))
        .filter(
          (row) =>
            row.potential_runner_score >= minimum &&
            passesHighMarketCapPolicy(
              row,
              envNumber(
                "POTENTIAL_RUNNER_MAX_MARKET_CAP_USD",
                envNumber("ROUTINE_FEED_MAX_MARKET_CAP_USD", 1_000_000),
              ),
              envNumber("HIGH_CAP_MIN_TRACKED_BUY_WALLETS", 2),
            ) &&
            this.discoveryDispatchAllowed("potential", row),
        ),
      rank = (a: Json, b: Json) =>
        Number(b.potential_runner_score) - Number(a.potential_runner_score) ||
        Number(b.long_signal_score ?? b.pons_signal_score ?? 0) -
          Number(a.long_signal_score ?? a.pons_signal_score ?? 0) ||
        Number(b.volume_5m ?? b.volume ?? b.volume_1h ?? 0) -
          Number(a.volume_5m ?? a.volume ?? a.volume_1h ?? 0);
    return priorityChainSlice(rows.sort(rank), limit, {
      robinhood: envNumber("POTENTIAL_ROBINHOOD_MIN_SHARE", 0.5),
      bsc: envNumber("POTENTIAL_BSC_MIN_SHARE", 0.3),
      sol: envNumber("POTENTIAL_SOL_MIN_SHARE", 0.2),
    });
  }
  private discoveryDispatchAllowed(
    kind: "surged" | "potential",
    row: Json,
    now = Math.floor(Date.now() / 1000),
  ): boolean {
    const map = kind === "surged" ? this.surgedDispatch : this.potentialDispatch,
      key = `${row.chain}:${addressKey(String(row.address ?? ""))}`,
      prior = map.get(key);
    if (!prior) return true;
    const cooldown = Math.max(
        300,
        envNumber(
          kind === "surged"
            ? "SURGED_SIGNAL_COOLDOWN_SECONDS"
            : "POTENTIAL_SIGNAL_COOLDOWN_SECONDS",
          kind === "surged" ? 1800 : 21600,
        ),
      ),
      wallets = Number(row.tracked_buy_wallet_count ?? 0),
      labels = new Set<string>((row.degen_signal_labels ?? []).map(String)),
      newEvidence =
        wallets > prior.wallets || [...labels].some((label) => !prior.labels.has(label));
    if (newEvidence) return true;
    const metric = finiteNumber(row.price ?? row.market_cap),
      minimumGain =
        Math.max(
          0,
          envNumber(
            kind === "surged"
              ? "SURGED_REEMIT_MIN_GAIN_PERCENT"
              : "POTENTIAL_REEMIT_MIN_GAIN_PERCENT",
            25,
          ),
        ) / 100;
    return (
      now - prior.sentAt >= cooldown &&
      metric !== undefined &&
      prior.metric !== undefined &&
      metric >= prior.metric * (1 + minimumGain)
    );
  }
  acknowledgeDiscovery(
    kind: "surged" | "potential",
    rows: Json[],
    sentAt = Math.floor(Date.now() / 1000),
  ): void {
    const map = kind === "surged" ? this.surgedDispatch : this.potentialDispatch;
    for (const row of rows) {
      const key = `${row.chain}:${addressKey(String(row.address ?? ""))}`;
      if (key.endsWith(":")) continue;
      const metric = finiteNumber(row.price ?? row.market_cap);
      map.set(key, {
        sentAt,
        ...(metric === undefined ? {} : { metric }),
        wallets: Number(row.tracked_buy_wallet_count ?? 0),
        labels: new Set((row.degen_signal_labels ?? []).map(String)),
      });
    }
  }
  private recordDiscoveryAudit(
    row: Json,
    status: "passed" | "suppressed" | "pending",
    reasons: string[],
    detectedAt: number,
  ): void {
    const chain = row.chain as Chain,
      address = String(row.address ?? "");
    if (!this.config.enabled_chains.includes(chain) || !validTokenAddress(chain, address)) return;
    this.store(chain).recordDiscoveryDecision(
      {
        address,
        symbol: row.symbol,
        name: row.name,
        status,
        reasons: reasons.slice(0, 10),
        sources: [
          ...new Set(
            [...(row.degen_sources ?? []), ...(row.dexscreener_discovery_sources ?? [])].map(
              String,
            ),
          ),
        ],
        signals: [...new Set((row.degen_signal_labels ?? []).map(String))],
        price: finiteNumber(row.price),
        market_cap: finiteNumber(row.market_cap),
        liquidity: finiteNumber(row.liquidity),
        volume_5m: finiteNumber(row.volume_5m ?? row.volume),
        price_change_5m: finiteNumber(
          row.price_change_5m ?? row.price_change_percent5m ?? row.price_change_percent,
        ),
        holder_count: finiteNumber(row.holder_count),
        top_10_holder_rate: finiteNumber(row.top_10_holder_rate),
        honeypot: row.honeypot,
        open_source: row.open_source,
        renounced: row.renounced,
        liquidity_locked: row.liquidity_locked,
        dexscreener_url: row.dexscreener_url,
        safety_checked_at: status === "pending" ? null : detectedAt,
      },
      detectedAt,
    );
  }
  async enrichDegenRows(rows: Json[]): Promise<Json[]> {
    const detectedAt = Math.floor(Date.now() / 1000),
      limit = envNumber(
        "DISCOVERY_SAFETY_EVALUATION_LIMIT",
        envNumber("PONS_CARD_ENRICH_LIMIT", 20),
      ),
      holderLimit = envNumber("PONS_CARD_HOLDER_LIMIT", 5),
      output: Json[] = rows.map((row) => ({ ...row, safety_status: "pending" })),
      targets = output
        .filter(
          (row) =>
            this.config.enabled_chains.includes(row.chain) &&
            validTokenAddress(row.chain, String(row.address)),
        )
        .slice(0, Math.max(0, limit)),
      processed = new Set<Json>();
    for (const row of targets) {
      processed.add(row);
      try {
        const chain = row.chain as Chain,
          address = String(row.address),
          [info, security, pool, holders] = await Promise.all([
            this.gmgn.tokenInfo(chain, address),
            this.gmgn.tokenSecurity(chain, address),
            this.gmgn.tokenPool(chain, address),
            this.gmgn.tokenHolders(chain, address, holderLimit),
          ]),
          safety = screenTrackedBuyToken(
            info,
            security,
            pool,
            configForChain(this.config, chain).token,
          ),
          current = finiteNumber(info.price?.price),
          circulating = finiteNumber(info.circulating_supply),
          total = finiteNumber(info.max_supply ?? info.total_supply),
          athPrice = finiteNumber(info.ath_price),
          createdAt = finiteNumber(
            info.pool?.creation_timestamp ?? info.open_timestamp ?? info.creation_timestamp,
          ),
          price1h = finiteNumber(info.price?.price_1h);
        const marketCap =
            current !== undefined && circulating !== undefined
              ? current * circulating
              : finiteNumber(row.market_cap),
          fdv =
            current !== undefined && total !== undefined
              ? current * total
              : finiteNumber(row.market_cap),
          athMarketCap =
            athPrice !== undefined && circulating !== undefined
              ? athPrice * circulating
              : undefined;
        Object.assign(row, {
          safety_status: safety.passed ? "passed" : "suppressed",
          safety_passed: safety.passed,
          safety_reasons: safety.reasons,
          name: info.name ?? row.name,
          symbol: info.symbol ?? row.symbol,
          price: current ?? row.price,
          market_cap: marketCap,
          fdv,
          ath_market_cap: athMarketCap,
          liquidity:
            finiteNumber(pool.liquidity ?? info.liquidity ?? info.pool?.liquidity) ?? row.liquidity,
          price_change_1h:
            current !== undefined && price1h !== undefined && price1h > 0
              ? (current / price1h - 1) * 100
              : undefined,
          volume_1h: finiteNumber(info.price?.volume_1h),
          volume_24h: finiteNumber(info.price?.volume_24h),
          buys_1h: finiteNumber(info.price?.buys_1h),
          sells_1h: finiteNumber(info.price?.sells_1h),
          holder_count: finiteNumber(info.holder_count ?? info.stat?.holder_count),
          top_10_holder_rate: finiteNumber(
            info.stat?.top_10_holder_rate ?? info.dev?.top_10_holder_rate,
          ),
          fresh_wallet_rate: finiteNumber(info.stat?.fresh_wallet_rate),
          smart_wallets: finiteNumber(info.wallet_tags_stat?.smart_wallets),
          pool_address: info.biggest_pool_address ?? info.pool?.pool_address ?? row.pool,
          exchange: info.pool?.exchange,
          token_age_seconds: createdAt
            ? Math.max(0, detectedAt - createdAt)
            : row.launch_age_seconds,
          logo: info.logo,
          website: info.link?.website,
          twitter_username: info.link?.twitter_username,
          telegram: info.link?.telegram,
          gmgn_url: info.link?.gmgn,
          honeypot: security.is_honeypot ?? security.honeypot,
          open_source: security.is_open_source ?? security.open_source,
          renounced: security.is_renounced ?? security.owner_renounced ?? security.renounced,
          liquidity_locked: security.lock_summary?.is_locked,
          top_holders: holders
            .map((holder) => ({
              address: holder.address,
              amount_percentage: finiteNumber(holder.amount_percentage),
              usd_value: finiteNumber(holder.usd_value),
              tags: Array.isArray(holder.tags) ? holder.tags.slice(0, 3) : [],
            }))
            .filter((holder) => validTokenAddress(chain, String(holder.address)))
            .slice(0, holderLimit),
        });
        this.recordDiscoveryAudit(
          row,
          safety.passed ? "passed" : "suppressed",
          safety.reasons.filter((reason) => reason.startsWith("FAIL ")),
          detectedAt,
        );
      } catch (error) {
        row.safety_status = "pending";
        row.safety_passed = false;
        row.safety_reasons = [`GMGN safety checks unavailable: ${String(error)}`];
        this.recordDiscoveryAudit(row, "pending", row.safety_reasons, detectedAt);
        if (isRateLimit(error)) {
          console.warn(
            "Degen safety enrichment stopped because GMGN entered cooldown",
            String(error),
          );
          break;
        }
        console.warn(`Degen safety enrichment unavailable for ${row.address}`, String(error));
      }
    }
    for (const row of output)
      if (!processed.has(row))
        this.recordDiscoveryAudit(
          row,
          "pending",
          ["Safety evaluation deferred by per-cycle limit"],
          detectedAt,
        );
    return output.filter((row) => row.safety_status === "passed");
  }
  async monitorCallMultiples(
    chains: Chain[],
    displayedRows: Json[],
    now = Math.floor(Date.now() / 1000),
    triggered?: Map<Chain, Set<string>>,
  ): Promise<Alert[]> {
    if (process.env.MULTIPLE_MONITOR_ENABLED === "false" || this.gmgn.cooldownUntil) return [];
    const windowSeconds = envNumber("MULTIPLE_MONITOR_WINDOW_SECONDS", 7200),
      maxActive = envNumber("MULTIPLE_MONITOR_MAX_ACTIVE_PER_CHAIN", 200),
      rearmSeconds = envNumber("MULTIPLE_MONITOR_REARM_SECONDS", 86400),
      minMilestone = Math.max(2, Math.floor(envNumber("MULTIPLE_MONITOR_MIN_MILESTONE", 2))),
      visible = new Map<string, Json>();
    for (const row of displayedRows) {
      const chain = row.chain as Chain,
        address = String(row.address ?? "");
      if (!chains.includes(chain) || !validTokenAddress(chain, address)) continue;
      const key = `${chain}:${addressKey(address)}`,
        current = visible.get(key);
      if (!current || (!finiteNumber(current.price) && finiteNumber(row.price)))
        visible.set(key, row);
    }
    const output: Alert[] = [];
    for (const chain of chains) {
      const store = this.store(chain),
        active = store
          .activeCallPerformance(now, maxActive)
          .filter((row) => !triggered || triggered.get(chain)?.has(addressKey(String(row.token))));
      for (const baseline of active) {
        const address = String(baseline.token),
          key = `${chain}:${addressKey(address)}`,
          row = visible.get(key);
        let currentPrice = finiteNumber(row?.price),
          currentMarketCap = finiteNumber(row?.market_cap),
          symbol = String(row?.symbol ?? baseline.symbol ?? "") || undefined,
          knownInfo: Json | undefined;
        if (currentPrice === undefined || triggered)
          try {
            const info = await this.gmgn.tokenInfo(chain, address);
            knownInfo = info;
            const price = finiteNumber(info.price?.price),
              supply = finiteNumber(info.circulating_supply);
            currentPrice = price;
            if (price !== undefined && supply !== undefined) currentMarketCap = price * supply;
            if (!symbol) symbol = String(info.symbol ?? "") || undefined;
          } catch (error) {
            if (isRateLimit(error)) {
              console.warn(
                "2h multiplier monitoring stopped because GMGN entered cooldown",
                String(error),
              );
              return output;
            }
            console.warn(`${chain}: multiplier price unavailable for ${address}`, String(error));
            continue;
          }
        if (
          currentPrice === undefined ||
          currentPrice <= 0 ||
          (currentMarketCap !== undefined &&
            this.collapseSuppressed({ chain, address, market_cap: currentMarketCap }, now))
        )
          continue;
        const multiple = currentPrice / Number(baseline.baseline_price);
        store.updateCallPerformance(address, currentPrice, multiple);
        const milestone = Math.floor(multiple),
          lastAlerted = Number(baseline.last_alerted_multiple ?? 1);
        if (milestone < minMilestone || milestone <= lastAlerted) continue;
        const alert: Alert = {
          tier: "RESEARCH",
          kind: "MULTIPLE",
          chain,
          address,
          ...(symbol ? { symbol } : {}),
          milestone,
          multiple,
          baseline_price: Number(baseline.baseline_price),
          current_price: currentPrice,
          baseline_market_cap: finiteNumber(baseline.baseline_market_cap),
          current_market_cap: currentMarketCap,
          first_seen: Number(baseline.first_seen),
          expires_at: Number(baseline.expires_at),
          age_seconds: Math.max(0, now - Number(baseline.first_seen)),
          source: baseline.source,
        };
        try {
          const snapshot = await this.evaluateToken(chain, address, knownInfo);
          if (explicitRugEvidence(snapshot)) continue;
          alert.token_snapshot = snapshot;
          alert.token_score = snapshot.verdict.score;
          alert.token_passed = snapshot.verdict.passed;
          alert.token_warnings = snapshot.verdict.warnings;
        } catch (error) {
          if (isRateLimit(error))
            console.warn(
              "Milestone safety re-scan stopped because GMGN entered cooldown",
              String(error),
            );
          else
            console.warn(
              `${chain}: milestone safety re-scan unavailable for ${address}`,
              String(error),
            );
          continue;
        }
        output.push(alert);
      }
      const candidates = [...visible.values()]
        .filter((row) => row.chain === chain)
        .sort(
          (a, b) =>
            Number(b.pons_signal_score ?? b.multiwindow_score ?? 0) -
            Number(a.pons_signal_score ?? a.multiwindow_score ?? 0),
        );
      for (const row of candidates) {
        const price = finiteNumber(row.price);
        if (price === undefined || price <= 0) continue;
        const source = row.pons_status ? "PONS DEGEN" : row.degen_sources ? "DEGEN" : "TRENDING";
        store.trackCall(
          String(row.address),
          String(row.symbol ?? "") || undefined,
          source,
          price,
          finiteNumber(row.market_cap),
          now,
          windowSeconds,
          maxActive,
          rearmSeconds,
        );
      }
    }
    return output;
  }
  async monitorTriggeredCallMultiples(
    chains: Chain[],
    now = Math.floor(Date.now() / 1000),
  ): Promise<Alert[]> {
    if (process.env.MULTIPLE_MONITOR_ENABLED === "false" || this.gmgn.cooldownUntil) return [];
    const triggered = new Map<Chain, Set<string>>();
    for (const chain of chains) {
      const active = this.store(chain).activeCallPerformance(
        now,
        envNumber("MULTIPLE_MONITOR_MAX_ACTIVE_PER_CHAIN", 200),
      );
      if (!active.length) continue;
      const activeByKey = new Map(active.map((row) => [addressKey(String(row.token)), row]));
      try {
        for (const signal of await this.gmgn.marketSignals(chain)) {
          const address = String(
              signal.token_address ?? signal.address ?? signal.data?.address ?? "",
            ),
            key = addressKey(address),
            baseline = activeByKey.get(key);
          if (!baseline || !validTokenAddress(chain, address)) continue;
          const currentMc = finiteNumber(signal.market_cap),
            baselineMc = finiteNumber(baseline.baseline_market_cap),
            nextMilestone = Math.max(2, Number(baseline.last_alerted_multiple ?? 1) + 1);
          if (
            currentMc !== undefined &&
            this.collapseSuppressed({ chain, address, market_cap: currentMc }, now)
          )
            continue;
          if (
            currentMc !== undefined &&
            baselineMc !== undefined &&
            baselineMc > 0 &&
            currentMc < baselineMc * nextMilestone * 0.98
          )
            continue;
          const set = triggered.get(chain) ?? new Set<string>();
          set.add(key);
          triggered.set(chain, set);
        }
      } catch (error) {
        if (isRateLimit(error)) throw error;
        console.warn(`${chain}: real-time multiplier trigger feed unavailable`, String(error));
      }
    }
    if (!triggered.size) return [];
    return this.monitorCallMultiples(chains, [], now, triggered);
  }
  acknowledgeCallMultiple(alert: Alert): void {
    if (alert.kind !== "MULTIPLE") return;
    const milestone = Number(alert.milestone);
    this.store(alert.chain).acknowledgeCallMultiple(alert.address, milestone);
    this.store(alert.chain).saveAlert(alert, Number(alert.first_seen) * 100 + milestone);
  }

  private async resolveTokenLocations(
    address: string,
  ): Promise<Array<{ chain: Chain; info?: Json }>> {
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
      if (!this.config.enabled_chains.includes("sol"))
        throw new Error("This looks like a Solana address, but Solana is disabled");
      return [{ chain: "sol" }];
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Invalid contract address format");
    const evm = this.config.enabled_chains.filter((chain) => chain !== "sol");
    const probes = await Promise.allSettled(
      evm.map(async (chain) => ({ chain, info: await this.gmgn.tokenInfo(chain, address) })),
    );
    const limited = probes.find(
      (result) => result.status === "rejected" && isRateLimit(result.reason),
    );
    if (limited?.status === "rejected") throw limited.reason;
    const found = probes.flatMap((result) => {
      if (result.status !== "fulfilled") return [];
      const { chain, info } = result.value;
      const exists = Boolean(
        info.symbol ||
          info.name ||
          info.standard ||
          info.biggest_pool_address ||
          info.pool?.pool_address ||
          info.price?.address,
      );
      return exists ? [{ chain, info }] : [];
    });
    if (!found.length) throw new Error("GMGN could not find that contract on any enabled chain");
    return found;
  }
  async resolveTokenChains(address: string): Promise<Chain[]> {
    return (await this.resolveTokenLocations(address)).map((item) => item.chain);
  }
  async evaluateAddress(address: string) {
    const locations = await this.resolveTokenLocations(address);
    return Promise.all(
      locations.map(({ chain, info }) => this.evaluateToken(chain, address, info)),
    );
  }
  private async tokenHolders(chain: Chain, address: string): Promise<Json[]> {
    try {
      return await this.gmgn.tokenHolders(chain, address, 5);
    } catch (error) {
      if (isRateLimit(error)) throw error;
      console.warn(`${chain}: GMGN top holders unavailable for ${address}`, String(error));
      return [];
    }
  }
  async evaluateToken(chain: Chain, address: string, knownInfo?: Json): Promise<TokenSnapshot> {
    const cfg = configForChain(this.config, chain);
    const [info, security, pool, holders] = await Promise.all([
      knownInfo ?? this.gmgn.tokenInfo(chain, address),
      this.gmgn.tokenSecurity(chain, address),
      this.gmgn.tokenPool(chain, address),
      this.tokenHolders(chain, address),
    ]);
    const verdict = scoreToken(
      info,
      security,
      pool,
      {
        median_entry_price_usd: number(info.price?.price, null),
        max_price_chase_ratio: cfg.cluster.max_price_chase_ratio,
      },
      cfg.token,
    );
    return buildTokenSnapshot(chain, address, info, security, pool, holders, verdict);
  }

  private catalysts(cfg: Json): Json {
    const path = join(ROOT, cfg.catalysts_file ?? "catalysts.json");
    if (!existsSync(path)) return {};
    const now = Date.now() / 1000,
      data = JSON.parse(readFileSync(path, "utf8"));
    return Object.fromEntries(
      Object.entries(data).filter(([, v]: any) => !v.expires_at || v.expires_at > now),
    );
  }
  private candidate(
    map: Map<string, SignalCandidate>,
    chain: Chain,
    address: string,
    symbol?: string,
  ): SignalCandidate {
    const key = addressKey(address);
    let item = map.get(key);
    if (!item) {
      item = {
        chain,
        address,
        ...(symbol ? { symbol } : {}),
        sources: new Set(),
        sellSources: new Set(),
        sourceIds: new Set(),
        wallets: new Set(),
        buyWallets: new Set(),
        sellWallets: new Set(),
        traderLabels: new Set(),
        sellTraderLabels: new Set(),
        twitterAccounts: new Set(),
        firstTimestamp: Math.floor(Date.now() / 1000),
        aggregateBuyUsd: 0,
        aggregateSellUsd: 0,
      };
      map.set(key, item);
    }
    if (symbol && !item.symbol) item.symbol = symbol;
    return item;
  }
  private addEvent(
    map: Map<string, SignalCandidate>,
    chain: Chain,
    row: Json,
    source: SignalSource,
  ): void {
    const address = String(
      row.base_address ?? row.token_address ?? row.token?.address ?? row.address ?? "",
    );
    if (
      !validTokenAddress(chain, address) ||
      !recent(row, envNumber("SIGNAL_LOOKBACK_SECONDS", 1800))
    )
      return;
    const item = this.candidate(
        map,
        chain,
        address,
        row.base_token?.symbol ?? row.token?.symbol ?? row.symbol,
      ),
      side = String(row.side ?? row.event_type ?? row.type ?? "buy").toLowerCase(),
      selling = side === "sell",
      wallet = addressKey(String(row.maker ?? row.wallet ?? row.wallet_address ?? "")),
      label = String(row.fomo_handle ?? row.trader_label ?? row.maker_info?.name ?? wallet);
    if (selling) {
      item.sellSources ??= new Set();
      item.sellSources.add(source);
    } else item.sources.add(source);
    if (wallet) {
      if (selling) {
        item.sellWallets ??= new Set();
        item.sellWallets.add(wallet);
        item.sellTraderLabels ??= new Set();
        item.sellTraderLabels.add(label);
      } else {
        item.wallets.add(wallet);
        item.buyWallets.add(wallet);
        item.traderLabels?.add(label);
      }
    }
    const observedMarketCap = finiteNumber(
      row.market_cap ?? row.marketCap ?? row.token?.market_cap ?? row.token?.marketCap,
    );
    if (observedMarketCap !== undefined && observedMarketCap > 0) {
      item.observedMarketCap ??= observedMarketCap;
      item.marketCapObservedAt ??= timestamp(row) || Math.floor(Date.now() / 1000);
    }
    const id = String(row.transaction_hash ?? row.tx_hash ?? row.trade_id ?? row.id ?? "");
    if (id) item.sourceIds.add(id);
    const amount = Number(row.amount_usd ?? row.cost_usd ?? 0) || 0;
    if (selling) item.aggregateSellUsd = (item.aggregateSellUsd ?? 0) + amount;
    else item.aggregateBuyUsd += amount;
    const ts = timestamp(row);
    if (ts) item.firstTimestamp = Math.min(item.firstTimestamp, ts);
  }

  private loadTrackedWalletRows(): Json[] {
    return this.walletRoster.rows();
  }
  private loadTrackedWallets(): Map<Chain, string[]> {
    return this.walletRoster.wallets();
  }
  invalidateTrackedWalletCache(): void {
    this.walletRoster.invalidate();
  }
  async refreshTrackedWalletsFromMongo(): Promise<void> {
    await this.walletRoster.refreshFromMongo();
  }
  private async collectWalletSignals(
    chain: Chain,
    map: Map<string, SignalCandidate>,
  ): Promise<void> {
    const every = envNumber("TRACKED_WALLET_SCAN_EVERY_MS", 60000),
      now = Date.now();
    if (now - (this.walletScanAt.get(chain) ?? 0) < every) return;
    this.walletScanAt.set(chain, now);
    const trackedRows = this.loadTrackedWalletRows().filter((row) => row.chain === chain),
      qualifiedWallets = this.loadTrackedWallets().get(chain) ?? [],
      qualified = new Set(qualifiedWallets.map(addressKey)),
      labels = new Map(
        trackedRows.map((row) => [
          addressKey(String(row.wallet ?? "")),
          String(row.fomo_handle ?? row.name ?? row.wallet),
        ]),
      ),
      stats: Json = {
        started_at: new Date(now).toISOString(),
        refreshed_at: null,
        tracked_wallets: qualifiedWallets.length,
        attempted_wallets: 0,
        followed_events: 0,
        activity_events: 0,
        events: 0,
        rate_limited: false,
        error: null,
      };
    if (
      process.env.GMGN_FOLLOWED_WALLET_FEED_ENABLED === "true" &&
      typeof this.gmgn.followedWallets === "function"
    )
      try {
        for (const row of await this.gmgn.followedWallets(chain, 100)) {
          const wallet = addressKey(String(row.maker ?? ""));
          if (!qualified.has(wallet)) continue;
          this.addEvent(
            map,
            chain,
            { ...row, trader_label: labels.get(wallet) ?? wallet },
            "followed_wallet",
          );
          if (recent(row, envNumber("SIGNAL_LOOKBACK_SECONDS", 1800))) stats.followed_events++;
        }
      } catch (error) {
        if (isRateLimit(error)) {
          stats.rate_limited = true;
          stats.error = String(error);
          this.trackedWalletPollStats.set(chain, stats);
          return;
        }
        console.warn(`${chain}: GMGN followed-wallet feed unavailable`, String(error));
      }
    if (process.env.DISABLE_TRACKED_WALLET_FALLBACK === "true") {
      stats.events = stats.followed_events;
      stats.refreshed_at = new Date().toISOString();
      this.trackedWalletPollStats.set(chain, stats);
      return;
    }
    const limit = Math.max(
        0,
        Math.floor(
          envNumber(
            `TRACKED_WALLET_FALLBACK_LIMIT_${chain.toUpperCase()}`,
            envNumber("TRACKED_WALLET_FALLBACK_LIMIT", 5),
          ),
        ),
      ),
      start = qualifiedWallets.length
        ? (this.walletScanCursor.get(chain) ?? 0) % qualifiedWallets.length
        : 0,
      batch = rotatingSlice(qualifiedWallets, start, limit);
    if (qualifiedWallets.length)
      this.walletScanCursor.set(chain, (start + batch.length) % qualifiedWallets.length);
    if (typeof this.gmgn.walletActivity === "function")
      for (const wallet of batch) {
        stats.attempted_wallets++;
        try {
          for (const row of await this.gmgn.walletActivity(chain, wallet, 20))
            if (["buy", "sell"].includes(String(row.event_type ?? row.type))) {
              this.addEvent(
                map,
                chain,
                { ...row, wallet, trader_label: labels.get(addressKey(wallet)) ?? wallet },
                "tracked_wallet",
              );
              if (recent(row, envNumber("SIGNAL_LOOKBACK_SECONDS", 1800))) stats.activity_events++;
            }
        } catch (error) {
          if (isRateLimit(error)) {
            stats.rate_limited = true;
            stats.error = String(error);
            console.warn(
              `${chain}: tracked-wallet fallback paused at ${wallet}; collected wallet events are preserved`,
              String(error),
            );
            break;
          }
          console.warn(`${chain}: could not scan tracked wallet ${wallet}`, String(error));
        }
      }
    stats.events = Number(stats.followed_events) + Number(stats.activity_events);
    stats.refreshed_at = new Date().toISOString();
    this.trackedWalletPollStats.set(chain, stats);
  }
  private async refreshTwitter(): Promise<void> {
    if (!this.twitter.enabled) return;
    const every = envNumber("TWITTER_SCAN_EVERY_MS", 120000),
      now = Date.now();
    if (now - this.twitterScanAt < every) return;
    this.twitterScanAt = now;
    const accounts = (
      process.env.TWITTER_ACCOUNTS ?? "elonmusk,WhiteHouse,realDonaldTrump,cz_binance"
    )
      .split(",")
      .map((x) => x.trim().replace(/^@/, ""))
      .filter(Boolean);
    const cutoff = Math.floor(now / 1000) - envNumber("TWITTER_LOOKBACK_SECONDS", 3600);
    for (const [address, mention] of this.twitterMentions)
      if (mention.seenAt < cutoff) this.twitterMentions.delete(address);
    for (const account of accounts) {
      try {
        for (const tweet of await this.twitter.userTweets(account, 10)) {
          const ts =
            Number(
              tweet.timestamp ??
                tweet.created_at_timestamp ??
                Date.parse(tweet.created_at ?? "") / 1000,
            ) || Math.floor(now / 1000);
          if (ts < cutoff) continue;
          const text = String(tweet.text ?? tweet.full_text ?? tweet.content ?? "");
          for (const address of extractContractAddresses(text)) {
            const key = addressKey(address),
              mention = this.twitterMentions.get(key) ?? {
                accounts: new Set<string>(),
                seenAt: ts,
              };
            mention.accounts.add(account);
            mention.seenAt = Math.max(mention.seenAt, ts);
            this.twitterMentions.set(key, mention);
          }
        }
      } catch (error) {
        console.warn(`OpenTwitter scan failed for @${account}`, String(error));
      }
    }
  }
  private attachTwitter(map: Map<string, SignalCandidate>): void {
    for (const [key, item] of map) {
      const mention = this.twitterMentions.get(key);
      if (!mention) continue;
      item.sources.add("twitter");
      for (const account of mention.accounts) item.twitterAccounts.add(account);
    }
  }
  private async enrichTrackedBuyCandidates(
    chain: Chain,
    candidates: Map<string, SignalCandidate>,
  ): Promise<void> {
    const tracked = [...candidates.values()].filter(
        (candidate) => candidate.buyWallets.size || (candidate.sellWallets?.size ?? 0),
      ),
      concurrency = Math.max(1, Math.floor(envNumber("TRACKED_BUY_ENRICH_CONCURRENCY", 3))),
      stats: Json = { checked: 0, passed: 0, suppressed: 0, unavailable: 0, recent_suppressed: [] };
    let cooling = false;
    await mapLimit(tracked, concurrency, async (candidate) => {
      const fromMarket = finiteNumber(candidate.market?.market_cap);
      if (candidate.observedMarketCap === undefined && fromMarket !== undefined && fromMarket > 0) {
        candidate.observedMarketCap = fromMarket;
        candidate.marketCapObservedAt = Math.floor(Date.now() / 1000);
      }
      const hasBuys = candidate.buyWallets.size > 0;
      if (cooling) {
        candidate.trackedBuySafety = {
          passed: false,
          reasons: ["FAIL GMGN safety checks unavailable during cooldown"],
          warnings: [],
        };
        if (hasBuys) {
          stats.unavailable++;
          stats.suppressed++;
        }
        return;
      }
      try {
        const [info, security, pool] = await Promise.all([
            this.gmgn.tokenInfo(chain, candidate.address),
            this.gmgn.tokenSecurity(chain, candidate.address),
            this.gmgn.tokenPool(chain, candidate.address),
          ]),
          price = finiteNumber(info.price?.price),
          circulating = finiteNumber(info.circulating_supply ?? info.total_supply),
          marketCap =
            price !== undefined && circulating !== undefined
              ? price * circulating
              : finiteNumber(info.market_cap ?? info.price?.market_cap),
          liquidity = finiteNumber(pool.liquidity ?? info.liquidity ?? info.pool?.liquidity),
          safety = screenTrackedBuyToken(
            info,
            security,
            pool,
            configForChain(this.config, chain).token,
          );
        candidate.tokenInfo = info;
        candidate.tokenSecurity = security;
        candidate.tokenPool = pool;
        candidate.trackedBuySafety = safety;
        if (!candidate.symbol && info.symbol) candidate.symbol = String(info.symbol);
        if (candidate.observedMarketCap === undefined && marketCap !== undefined && marketCap > 0) {
          candidate.observedMarketCap = marketCap;
          candidate.marketCapObservedAt = Math.floor(Date.now() / 1000);
        }
        candidate.market = {
          ...(candidate.market ?? {}),
          address: candidate.address,
          symbol: candidate.symbol,
          market_cap: candidate.observedMarketCap,
          liquidity,
          holder_count: finiteNumber(info.holder_count ?? info.stat?.holder_count),
          top_10_holder_rate: finiteNumber(
            info.stat?.top_10_holder_rate ?? info.dev?.top_10_holder_rate,
          ),
        };
        if (hasBuys) {
          stats.checked++;
          if (safety.passed) stats.passed++;
          else {
            const top10 = finiteNumber(
              security.top_10_holder_rate ??
                info.stat?.top_10_holder_rate ??
                info.dev?.top_10_holder_rate,
            );
            stats.suppressed++;
            stats.recent_suppressed.push({
              address: candidate.address,
              symbol: candidate.symbol,
              name: info.name,
              traders: [...(candidate.traderLabels ?? [])],
              wallets: [...candidate.buyWallets],
              wallet_count: candidate.buyWallets.size,
              aggregate_buy_usd: Math.round(candidate.aggregateBuyUsd * 100) / 100,
              bought_at: candidate.firstTimestamp,
              price,
              market_cap: marketCap,
              liquidity,
              liquidity_to_market_cap_ratio:
                liquidity !== undefined && marketCap !== undefined && marketCap > 0
                  ? liquidity / marketCap
                  : undefined,
              holder_count: finiteNumber(info.holder_count ?? info.stat?.holder_count),
              top_10_holder_rate: top10,
              smart_wallets: finiteNumber(info.wallet_tags_stat?.smart_wallets),
              renowned_wallets: finiteNumber(info.wallet_tags_stat?.renowned_wallets),
              fresh_wallet_rate: finiteNumber(info.stat?.fresh_wallet_rate),
              volume_1h: finiteNumber(info.price?.volume_1h),
              volume_24h: finiteNumber(info.price?.volume_24h),
              buys_1h: finiteNumber(info.price?.buys_1h),
              sells_1h: finiteNumber(info.price?.sells_1h),
              honeypot: security.is_honeypot ?? security.honeypot,
              blacklist: security.is_blacklist ?? security.blacklist,
              cannot_sell: security.can_not_sell,
              open_source: security.is_open_source ?? security.open_source,
              renounced: security.is_renounced ?? security.owner_renounced ?? security.renounced,
              liquidity_locked: security.lock_summary?.is_locked,
              buy_tax: finiteNumber(security.buy_tax),
              sell_tax: finiteNumber(security.sell_tax),
              dex: pool.exchange ?? info.pool?.exchange,
              pool_address:
                pool.address ??
                pool.pool_address ??
                info.biggest_pool_address ??
                info.pool?.pool_address,
              creator: info.dev?.creator_address,
              gmgn_url: info.link?.gmgn,
              reasons: safety.reasons
                .filter((reason: string) => reason.startsWith("FAIL "))
                .slice(0, 8),
            });
          }
        }
      } catch (error) {
        if (isRateLimit(error)) cooling = true;
        else
          console.warn(
            `${chain}: tracked-buy safety lookup unavailable for ${candidate.address}`,
            String(error),
          );
        candidate.trackedBuySafety = {
          passed: false,
          reasons: [`FAIL GMGN safety checks unavailable: ${String(error)}`],
          warnings: [],
        };
        if (hasBuys) {
          stats.unavailable++;
          stats.suppressed++;
          stats.recent_suppressed.push({
            address: candidate.address,
            symbol: candidate.symbol,
            traders: [...(candidate.traderLabels ?? [])],
            wallets: [...candidate.buyWallets],
            wallet_count: candidate.buyWallets.size,
            aggregate_buy_usd: Math.round(candidate.aggregateBuyUsd * 100) / 100,
            bought_at: candidate.firstTimestamp,
            reasons: ["GMGN safety checks unavailable"],
          });
        }
      }
    });
    stats.recent_suppressed = stats.recent_suppressed.slice(0, 10);
    this.trackedBuySafetyStats.set(chain, stats);
  }

  private async refreshPons(): Promise<void> {
    if (!this.pons.enabled) return;
    const every = envNumber("PONS_SCAN_EVERY_MS", 300000),
      now = Date.now();
    if (now - this.ponsScanAt < every) return;
    this.ponsScanAt = now;
    try {
      const snapshot = await this.pons.launches(),
        nowSeconds = Math.floor(now / 1000),
        store = this.store("robinhood"),
        normalized = [...snapshot.active, ...snapshot.graduated]
          .map((row) => normalizePonsLaunch(row, nowSeconds))
          .filter((row): row is Json => Boolean(row));
      const probes = selectPonsProbeRows(
          snapshot.active,
          snapshot.graduated,
          envNumber("PONS_GMGN_PROBE_LIMIT", 12),
          nowSeconds,
        ),
        probeKeys = new Set(probes.map((row) => addressKey(String(row.address)))),
        qualified: Json[] = [];
      for (const row of normalized) {
        const key = addressKey(String(row.address)),
          price = Number(row.price),
          progress = Number(row.graduation_progress_percent),
          changes: {
            price_change_5m?: number | undefined;
            price_change_30m?: number | undefined;
            progress_change_30m?: number | undefined;
          } = {};
        if (Number.isFinite(price) && price > 0) {
          changes.price_change_5m = store.trendingPriceChange(
            `pons:${key}`,
            price,
            300,
            nowSeconds,
          );
          changes.price_change_30m = store.trendingPriceChange(
            `pons:${key}`,
            price,
            1800,
            nowSeconds,
          );
        }
        if (Number.isFinite(progress))
          changes.progress_change_30m = store.metricDelta(
            key,
            "pons_graduation_progress",
            progress,
            1800,
            nowSeconds,
          );
        if (
          probeKeys.has(key) &&
          (changes.price_change_5m === undefined || changes.price_change_30m === undefined)
        )
          try {
            const kline = ponsKlineChanges(
              await this.gmgn.kline("robinhood", String(row.address), 1900, "5m"),
            );
            changes.price_change_5m ??= kline.price_change_5m;
            changes.price_change_30m ??= kline.price_change_30m;
          } catch (error) {
            if (isRateLimit(error)) throw error;
            console.warn(
              `Pons: GMGN price confirmation unavailable for ${row.address}`,
              String(error),
            );
          }
        const signal = qualifyPonsDegen(row, changes);
        if (signal) qualified.push(signal);
        if (Number.isFinite(price) && price > 0)
          store.recordTrendingPrice(`pons:${key}`, price, nowSeconds);
        if (Number.isFinite(progress))
          store.recordMetric(key, "pons_graduation_progress", progress, nowSeconds);
      }
      this.ponsRows = qualified;
      this.ponsStats = {
        active: snapshot.active.length,
        graduated: snapshot.graduated.length,
        qualified: qualified.length,
        refreshed_at: new Date(now).toISOString(),
      };
    } catch (error) {
      if (isRateLimit(error)) throw error;
      console.warn("Pons Robinhood discovery scan failed", String(error));
    }
  }

  private async refreshLong(): Promise<void> {
    if (!this.long.enabled) return;
    const every = Math.max(30000, envNumber("LONG_SCAN_EVERY_MS", 60000)),
      now = Date.now();
    if (now - this.longScanAt < every) return;
    this.longScanAt = now;
    try {
      const snapshot = await this.long.assets(),
        nowSeconds = Math.floor(now / 1000),
        qualified = qualifyLongAssets(snapshot.assets, nowSeconds, !this.longInitialized);
      this.longInitialized = true;
      this.longRows = qualified;
      this.longStats = {
        assets: snapshot.assets.length,
        qualified: qualified.length,
        refreshed_at: new Date(now).toISOString(),
        error: null,
      };
    } catch (error) {
      this.longStats = {
        ...this.longStats,
        error: String(error),
        failed_at: new Date(now).toISOString(),
      };
      console.warn("Long Robinhood launch discovery scan failed", String(error));
    }
  }

  private async refreshDexScreener(chain: Chain): Promise<boolean> {
    if (!this.dexScreener.enabled) return false;
    const enabled = new Set(
      String(process.env.DEXSCREENER_CHAINS ?? "robinhood")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    if (!enabled.has(chain)) return false;
    const every = Math.max(30000, envNumber("DEXSCREENER_SCAN_EVERY_MS", 60000)),
      now = Date.now(),
      last = this.dexScreenerScanAt.get(chain) ?? 0;
    if (now - last < every) return false;
    this.dexScreenerScanAt.set(chain, now);
    try {
      const snapshot = await this.dexScreener.discover(chain),
        nowSeconds = Math.floor(now / 1000),
        normalized = normalizeDexScreenerPairs(chain, snapshot.pairs, nowSeconds),
        qualified = qualifyDexScreenerPairs(chain, snapshot.pairs, nowSeconds);
      this.dexScreenerRows.set(chain, qualified);
      this.dexScreenerStats.set(chain, {
        discovered: snapshot.discovered,
        pairs: snapshot.pairs.length,
        qualified: qualified.length,
        refreshed_at: new Date(now).toISOString(),
        error: null,
      });
      for (const row of normalized)
        this.recordDiscoveryAudit(
          row,
          "pending",
          row.degen_signal_labels.length
            ? ["GMGN safety evaluation pending"]
            : ["Observed by DexScreener; movement thresholds not met"],
          nowSeconds,
        );
      return true;
    } catch (error) {
      this.dexScreenerStats.set(chain, {
        ...(this.dexScreenerStats.get(chain) ?? {}),
        error: String(error),
        failed_at: new Date(now).toISOString(),
      });
      console.warn(`${chain}: DexScreener discovery scan failed`, String(error));
      return false;
    }
  }

  async pollDexScreenerDiscovery(
    chains: Chain[],
  ): Promise<{ safe: Json[]; surged: Json[]; potential: Json[] }> {
    if (this.gmgn.cooldownUntil) return { safe: [], surged: [], potential: [] };
    const candidates: Json[] = [];
    for (const chain of priorityChains(chains)) {
      if (!(await this.refreshDexScreener(chain))) continue;
      const dexRows = this.dexScreenerRows.get(chain) ?? [],
        existing = (this.degenRows.get(chain) ?? []).filter(
          (row) => !(row.degen_sources ?? []).includes("DEXSCREENER"),
        );
      this.degenRows.set(chain, mergeDegenRows(existing, dexRows));
      candidates.push(...dexRows);
    }
    if (!candidates.length || this.gmgn.cooldownUntil)
      return { safe: [], surged: [], potential: [] };
    const safe = await this.enrichDegenRows(candidates),
      surged = safe
        .filter((row) => isSurgedToken(row) && this.discoveryDispatchAllowed("surged", row))
        .sort(
          (a, b) =>
            Number(b.price_change_5m ?? 0) - Number(a.price_change_5m ?? 0) ||
            Number(b.volume_5m ?? 0) - Number(a.volume_5m ?? 0),
        )
        .slice(0, Math.max(0, envNumber("SURGED_DIGEST_LIMIT", 10))),
      surgedKeys = new Set(surged.map((row) => rowKey(row))),
      scored: Json[] = safe.map((row) => ({
        ...row,
        potential_runner_score: potentialRunnerScore(row),
      })),
      potential = scored
        .filter(
          (row) =>
            !surgedKeys.has(rowKey(row)) &&
            row.potential_runner_score >= envNumber("POTENTIAL_RUNNER_MIN_SCORE", 45) &&
            passesHighMarketCapPolicy(row) &&
            this.discoveryDispatchAllowed("potential", row),
        )
        .sort(
          (a, b) =>
            Number(b.potential_runner_score) - Number(a.potential_runner_score) ||
            Number(b.volume_5m ?? 0) - Number(a.volume_5m ?? 0),
        )
        .slice(0, Math.max(0, envNumber("POTENTIAL_DIGEST_LIMIT", 10)));
    return { safe, surged, potential };
  }

  private async collectCandidates(
    chain: Chain,
    limit: number,
  ): Promise<Map<string, SignalCandidate>> {
    const cfg = configForChain(this.config, chain),
      map = new Map<string, SignalCandidate>(),
      store = this.store(chain);
    const supportsPublicFeeds = ["sol", "bsc", "base", "eth"].includes(chain),
      qualified = new Set((this.loadTrackedWallets().get(chain) ?? []).map(addressKey));
    const [trending, signals, smartMoney, kols] = await Promise.all([
      this.gmgn.trending(
        chain,
        cfg.market_filters ?? [],
        Math.min(limit, envNumber("TRENDING_LIMIT", 30)),
      ),
      this.gmgn.marketSignals(chain),
      supportsPublicFeeds ? this.gmgn.smartMoney(chain, Math.min(limit, 100)) : Promise.resolve([]),
      supportsPublicFeeds ? this.gmgn.kol(chain, Math.min(limit, 100)) : Promise.resolve([]),
    ]);
    const normalizedTrending: Json[] = trending.map((row) => {
      const market: Json = { ...marketSnapshot(row), chain },
        address = String(market.address ?? ""),
        price = Number(market.price),
        gate = passesMarketGate(market, cfg.token),
        valid = validTokenAddress(chain, address);
      if (valid && Number.isFinite(price) && price > 0) {
        const key = addressKey(address),
          change30 = store.trendingPriceChange(
            key,
            price,
            envNumber("TRENDING_PRICE_LOOKBACK_SECONDS", 1800),
          );
        if (change30 !== undefined) market.price_change_30m = change30;
        store.recordTrendingPrice(key, price);
      }
      market.quality_passed = gate.passed && valid;
      market.quality_reasons = valid ? gate.reasons : [...gate.reasons, "invalid token address"];
      return market;
    });
    let degen = buildDegenRows(
      chain,
      normalizedTrending,
      signals,
      cfg.token,
      envNumber("DEGEN_MAX_MARKET_CAP_USD", 100000),
    );
    await this.refreshDexScreener(chain);
    degen = mergeDegenRows(degen, this.dexScreenerRows.get(chain) ?? []);
    if (chain === "robinhood") {
      await Promise.all([this.refreshPons(), this.refreshLong()]);
      degen = mergeDegenRows(degen, this.ponsRows, this.longRows);
    }
    for (const row of degen) {
      const labels = new Set<string>((row.degen_signal_labels ?? []).map(String)),
        change = finiteNumber(
          row.price_change_5m ?? row.price_change_percent5m ?? row.price_change_percent,
        ),
        fromDex = (row.degen_sources ?? []).includes("DEXSCREENER"),
        surging =
          labels.has("PRICE SURGE") ||
          labels.has("PONS PRICE SURGE") ||
          labels.has("DEXSCREENER PRICE SURGE") ||
          (change !== undefined && change >= envNumber("MIN_PRICE_SURGE_5M_PERCENT", 10));
      if (!surging || (!fromDex && !passesSurgeDiscoveryGate(row, cfg.token).passed)) continue;
      const item = this.candidate(map, chain, String(row.address), row.symbol);
      item.market = row;
      item.sources.add("trending_momentum");
      if (fromDex) item.sources.add("dexscreener_market");
    }
    this.degenRows.set(chain, degen);
    const probeLimit = envNumber("TRENDING_MULTIWINDOW_CHECK_LIMIT_PER_CHAIN", 10),
      probeOrder = normalizedTrending
        .filter((row) => row.quality_passed === true)
        .sort((a, b) => Number(b.volume ?? 0) - Number(a.volume ?? 0));
    for (const [index, market] of probeOrder.entries()) {
      if (index >= probeLimit) {
        market.multiwindow_passed = false;
        market.multiwindow_grade = "NOT_CHECKED";
        continue;
      }
      try {
        Object.assign(
          market,
          analyzeTrendingCandles(
            await this.gmgn.kline(chain, String(market.address), 3900, "5m"),
            market,
            cfg.token.min_volume_5m_usd,
          ),
        );
      } catch (error) {
        if (isRateLimit(error)) throw error;
        market.multiwindow_passed = false;
        market.multiwindow_grade = "UNAVAILABLE";
        market.multiwindow_reasons = [String(error)];
        console.warn(
          `${chain}: multi-window trend unavailable for ${market.address}`,
          String(error),
        );
      }
    }
    const surgeThreshold = envNumber("TRENDING_30M_PRICE_INCREASE_PERCENT", 100),
      smallCapMax = envNumber("TRENDING_MAX_MARKET_CAP_USD", 500000);
    for (const market of normalizedTrending) {
      market.momentum_30m_signal = Number(market.price_change_30m) >= surgeThreshold;
      market.small_cap_signal =
        Number(market.market_cap) > 0 && Number(market.market_cap) <= smallCapMax;
      market.momentum_30m_threshold = surgeThreshold;
      market.small_cap_threshold = smallCapMax;
    }
    this.trendingRows.set(chain, normalizedTrending);
    for (const market of normalizedTrending) {
      const address = String(market.address ?? "");
      if (!validTokenAddress(chain, address) || market.quality_passed !== true) continue;
      const item = this.candidate(map, chain, address, market.symbol);
      item.market = market;
      const change5m = Number(market.price_change_percent5m ?? market.price_change_5m ?? 0),
        change30m = Number(market.price_change_30m),
        volume = Number(market.volume_5m ?? market.volume ?? 0);
      if (market.multiwindow_passed === true) {
        item.sources.add("trending_early_volume");
        item.sources.add("trending_multiwindow_stability");
      }
      if (
        (change5m >= envNumber("MIN_PRICE_SURGE_5M_PERCENT", 10) &&
          volume >= cfg.token.min_volume_5m_usd) ||
        change30m >= envNumber("TRENDING_30M_PRICE_INCREASE_PERCENT", 100)
      )
        item.sources.add("trending_momentum");
      if (
        Number(market.market_cap) > 0 &&
        Number(market.market_cap) <= envNumber("TRENDING_MAX_MARKET_CAP_USD", 500000)
      )
        item.sources.add("trending_small_cap");
      if (Number(market.smart_degen_count ?? market.smart_money_count ?? 0) >= 3)
        item.sources.add("trending_smart_money");
      if (!item.sources.size) map.delete(addressKey(address));
    }
    for (const row of signals) {
      const market = marketSnapshot(row),
        address = String(market.address ?? "");
      if (!validTokenAddress(chain, address) || !passesMarketGate(market, cfg.token).passed)
        continue;
      const item = this.candidate(map, chain, address, market.symbol);
      item.market = market;
      const type = Number(row.signal_type);
      item.sources.add(type === 12 ? "smart_money_signal" : "price_surge");
      if (row.id) item.sourceIds.add(String(row.id));
    }
    for (const row of smartMoney)
      if (qualified.has(addressKey(String(row.maker ?? ""))))
        this.addEvent(map, chain, row, "smart_money_wallet");
    for (const row of kols)
      if (qualified.has(addressKey(String(row.maker ?? ""))))
        this.addEvent(map, chain, row, "kol_wallet");
    await this.collectWalletSignals(chain, map);
    this.attachTwitter(map);
    for (const market of normalizedTrending) {
      const candidate = map.get(addressKey(String(market.address ?? "")));
      market.signal_sources = candidate ? [...candidate.sources] : [];
      market.tracked_buy_wallet_count = candidate?.buyWallets.size ?? 0;
    }
    for (const row of degen) {
      const candidate = map.get(addressKey(String(row.address ?? "")));
      row.tracked_buy_wallet_count = candidate?.buyWallets.size ?? 0;
      row.tracked_buy_traders = [...(candidate?.traderLabels ?? [])];
    }
    return map;
  }

  private async enrichSurgeAttributions(
    chain: Chain,
    candidates: Map<string, SignalCandidate>,
  ): Promise<void> {
    if (process.env.SURGE_WALLET_ATTRIBUTION_ENABLED === "false") return;
    const targetLimit = Math.max(0, envNumber("SURGE_ATTRIBUTION_MAX_TOKENS_PER_CYCLE", 1)),
      walletLimit = Math.max(1, envNumber("SURGE_ATTRIBUTION_MAX_WALLETS", 5)),
      activityLimit = Math.max(1, envNumber("SURGE_ATTRIBUTION_ACTIVITY_CHECK_WALLETS", 3)),
      lookback = Math.max(900, envNumber("SURGE_ATTRIBUTION_LOOKBACK_SECONDS", 7200)),
      recentWindow = Math.max(300, envNumber("SURGE_ATTRIBUTION_RECENT_SECONDS", 1800)),
      minimumRoi = envNumber("SURGE_ATTRIBUTION_MIN_POSITION_ROI_PERCENT", 300),
      lead = Math.max(60, envNumber("SURGE_ATTRIBUTION_MAX_ENTRY_LEAD_SECONDS", 1800)),
      buyLead = Math.max(60, envNumber("SURGE_ATTRIBUTION_CONFIRMED_BUY_LEAD_SECONDS", 900)),
      minimumGlobalRoi = envNumber("SURGE_ATTRIBUTION_MIN_WALLET_ROI_PERCENT", 200),
      minimumTrades = envNumber("SURGE_ATTRIBUTION_MIN_30D_TRADES", 20),
      cacheSeconds = Math.max(60, envNumber("SURGE_ATTRIBUTION_CACHE_SECONDS", 300)),
      now = Math.floor(Date.now() / 1000);
    const stats: Json = {
        tokens_checked: 0,
        surge_events: 0,
        confirmed_profitable_wallets: 0,
        track_worthy_wallets: 0,
        rate_limited: false,
      },
      targets = [...candidates.values()]
        .filter(
          (candidate) =>
            candidate.sources.has("price_surge") || candidate.sources.has("trending_momentum"),
        )
        .sort(
          (a, b) =>
            Number(b.market?.volume_1m ?? b.market?.volume_5m ?? b.market?.volume ?? 0) -
            Number(a.market?.volume_1m ?? a.market?.volume_5m ?? a.market?.volume ?? 0),
        )
        .slice(0, targetLimit);
    this.surgeAttributionStats.set(chain, stats);
    for (const candidate of targets) {
      try {
        stats.tokens_checked++;
        const cacheKey = `${chain}:${addressKey(candidate.address)}`,
          cached = this.surgeAttributionCache.get(cacheKey);
        if (cached && now - cached.checkedAt < cacheSeconds) {
          if (cached.attribution) {
            candidate.surgeAttribution = cached.attribution;
            stats.surge_events += Number(Boolean(cached.attribution.event));
            stats.confirmed_profitable_wallets += Number(cached.attribution.wallets?.length ?? 0);
            stats.track_worthy_wallets += Number(cached.attribution.track_worthy_wallets ?? 0);
            for (const row of this.degenRows.get(chain) ?? [])
              if (addressKey(String(row.address)) === addressKey(candidate.address))
                row.surge_attribution = cached.attribution;
            if ((cached.attribution.wallets ?? []).length)
              candidate.sources.add("profitable_surge_wallet");
          }
          continue;
        }
        const candles = await this.gmgn.kline(chain, candidate.address, lookback, "1m"),
          events = detectSurgeEvents(candles, {
            min_candle_change_percent: envNumber("SURGE_ATTRIBUTION_MIN_CANDLE_PERCENT", 15),
            min_trailing_5m_change_percent: envNumber("SURGE_ATTRIBUTION_MIN_5M_PERCENT", 25),
            min_volume_ratio: envNumber("SURGE_ATTRIBUTION_MIN_VOLUME_RATIO", 2.5),
            max_sideways_range_percent: envNumber(
              "SURGE_ATTRIBUTION_MAX_SIDEWAYS_RANGE_PERCENT",
              18,
            ),
            min_reversal_drawdown_percent: envNumber(
              "SURGE_ATTRIBUTION_MIN_REVERSAL_DRAWDOWN_PERCENT",
              20,
            ),
          }),
          event = events.filter((row) => now - row.ended_at <= recentWindow).at(-1);
        if (!event) continue;
        stats.surge_events++;
        const traders = await this.gmgn.tokenTraders(chain, candidate.address, 100),
          attributed = traders
            .map((row) => profitablePreMoveTrader(row, event, minimumRoi, lead))
            .filter((row): row is Json => Boolean(row))
            .sort(
              (a, b) =>
                Number(b.entered_at) - Number(a.entered_at) ||
                Number(b.position_roi_percent) - Number(a.position_roi_percent),
            )
            .slice(0, walletLimit),
          checked = attributed.slice(0, activityLimit),
          confirmed: Json[] = [];
        for (const row of checked) {
          try {
            const activity = await this.gmgn.walletTokenActivity(
                chain,
                String(row.wallet),
                candidate.address,
                50,
              ),
              buys = activity.filter(
                (item) =>
                  (item.event_type ?? item.type) === "buy" &&
                  timestamp(item) >= event.started_at - buyLead &&
                  timestamp(item) <= event.ended_at,
              );
            if (buys.length)
              confirmed.push({
                ...row,
                confirmed_buy_at: Math.max(...buys.map(timestamp)),
                confirmed_buy_usd: buys.reduce(
                  (sum, item) => sum + (finiteNumber(item.cost_usd) ?? 0),
                  0,
                ),
                confirmed_buy_count: buys.length,
              });
          } catch (error) {
            if (isRateLimit(error)) throw error;
            console.warn(
              `${chain}: surge-wallet activity unavailable for ${row.wallet}`,
              String(error),
            );
          }
        }
        if (!confirmed.length) {
          const attribution = { event, wallets: [], minimum_position_roi_percent: minimumRoi };
          candidate.surgeAttribution = attribution;
          for (const row of this.degenRows.get(chain) ?? [])
            if (addressKey(String(row.address)) === addressKey(candidate.address))
              row.surge_attribution = attribution;
          this.surgeAttributionCache.set(cacheKey, { checkedAt: now, attribution });
          continue;
        }
        const wallets = confirmed.map((row) => String(row.wallet)),
          [p30, pall] = await Promise.all([
            this.gmgn.walletProfits(chain, wallets, "30d"),
            this.gmgn.walletProfits(chain, wallets, "all"),
          ]),
          by30 = new Map(p30.map((row) => [addressKey(String(row.wallet_address)), row])),
          byAll = new Map(pall.map((row) => [addressKey(String(row.wallet_address)), row])),
          assessed = confirmed.map((row) => ({
            ...row,
            ...assessWalletPerformance(
              by30.get(addressKey(String(row.wallet))),
              byAll.get(addressKey(String(row.wallet))),
              minimumGlobalRoi,
              minimumTrades,
            ),
          })),
          attribution = {
            event,
            wallets: assessed,
            minimum_position_roi_percent: minimumRoi,
            track_worthy_wallets: assessed.filter((row) => row.worth_tracking).length,
          };
        candidate.surgeAttribution = attribution;
        candidate.sources.add("profitable_surge_wallet");
        stats.confirmed_profitable_wallets += assessed.length;
        stats.track_worthy_wallets += Number(attribution.track_worthy_wallets);
        for (const row of this.degenRows.get(chain) ?? [])
          if (addressKey(String(row.address)) === addressKey(candidate.address))
            row.surge_attribution = attribution;
        this.surgeAttributionCache.set(cacheKey, { checkedAt: now, attribution });
      } catch (error) {
        if (isRateLimit(error)) {
          stats.rate_limited = true;
          console.warn(
            `${chain}: surge-wallet attribution paused by GMGN rate limit`,
            String(error),
          );
          break;
        }
        console.warn(
          `${chain}: surge-wallet attribution unavailable for ${candidate.address}`,
          String(error),
        );
      }
    }
  }

  private trackedWalletAlerts(chain: Chain, candidates: Map<string, SignalCandidate>): Alert[] {
    return buildTrackedWalletAlerts(chain, candidates, this.store(chain));
  }

  async scanTrackedWallets(chain: Chain): Promise<Alert[]> {
    const candidates = new Map<string, SignalCandidate>();
    await this.collectWalletSignals(chain, candidates);
    if (!candidates.size) return [];
    await this.enrichTrackedBuyCandidates(chain, candidates);
    return this.trackedWalletAlerts(chain, candidates);
  }

  async scan(chain: Chain, limit = 200): Promise<Alert[]> {
    if (this.running.has(chain)) throw new Error(`A ${chain} scan is already running`);
    this.running.add(chain);
    try {
      await this.refreshTwitter();
      const candidates = await this.loadCandidatesWithFallback(chain, limit);
      await this.enrichTrackedBuyCandidates(chain, candidates);
      await this.enrichSurgeAttributions(chain, candidates);
      return [
        ...this.trackedWalletAlerts(chain, candidates),
        ...(await this.evaluateSelectedCandidates(chain, candidates)),
      ];
    } finally {
      this.running.delete(chain);
    }
  }

  private async loadCandidatesWithFallback(
    chain: Chain,
    limit: number,
  ): Promise<Map<string, SignalCandidate>> {
    try {
      return await this.collectCandidates(chain, limit);
    } catch (error) {
      const candidates = new Map<string, SignalCandidate>();
      this.attachTwitter(candidates);
      if (!candidates.size) throw error;

      console.warn(
        `${chain}: market feeds unavailable; continuing with ${candidates.size} OpenTwitter candidate(s)`,
        String(error),
      );
      return candidates;
    }
  }

  private selectedCandidates(candidates: Map<string, SignalCandidate>): SignalCandidate[] {
    return [...candidates.values()]
      .filter((candidate) => shouldInvestigate(candidate, envNumber("MIN_SIGNAL_STRENGTH", 3)))
      .sort((left, right) => signalStrength(right) - signalStrength(left))
      .slice(0, envNumber("MAX_CANDIDATES_PER_CHAIN", 5));
  }

  private async evaluateSelectedCandidates(
    chain: Chain,
    candidates: Map<string, SignalCandidate>,
  ): Promise<Alert[]> {
    const alerts: Alert[] = [];
    for (const candidate of this.selectedCandidates(candidates)) {
      try {
        const alert = await this.evaluateCandidate(chain, candidate);
        if (alert) alerts.push(alert);
      } catch (error) {
        if (isRateLimit(error)) {
          console.warn(
            `${chain}: full token checks paused after direct tracked-buy alerts were preserved`,
            String(error),
          );
          break;
        }
        console.warn(
          `${chain}: full token check unavailable for ${candidate.address}`,
          String(error),
        );
      }
    }
    return alerts;
  }

  private async evaluateCandidate(
    chain: Chain,
    candidate: SignalCandidate,
  ): Promise<Alert | undefined> {
    const store = this.store(chain);
    const cooldown = envNumber("SIGNAL_ALERT_COOLDOWN_MS", 21_600_000);
    if (Date.now() / 1000 - store.lastAlertAt(candidate.address) < cooldown / 1000)
      return undefined;

    const cfg = configForChain(this.config, chain);
    const [info, security, pool] = await this.candidateSafetyData(chain, candidate);
    const verdict = scoreToken(
      info,
      security,
      pool,
      {
        median_entry_price_usd: number(info.price?.price, null),
        max_price_chase_ratio: cfg.cluster.max_price_chase_ratio,
      },
      cfg.token,
    );
    const catalysts = this.catalysts(cfg);
    const catalyst = catalysts[`${chain}:${candidate.address}`] ?? catalysts[candidate.address];
    const tier = alertTier(verdict, catalyst, Boolean(cfg.require_catalyst_for_call));
    const holders = tier === "REJECT" ? [] : await this.tokenHolders(chain, candidate.address);
    const snapshot = buildTokenSnapshot(
      chain,
      candidate.address,
      info,
      security,
      pool,
      holders,
      verdict,
    );
    const alert = buildCandidateAlert({
      chain,
      candidate,
      snapshot,
      verdict,
      catalyst,
      requireCatalyst: Boolean(cfg.require_catalyst_for_call),
    });

    return store.saveAlert(alert, candidate.firstTimestamp) ? alert : undefined;
  }

  private async candidateSafetyData(
    chain: Chain,
    candidate: SignalCandidate,
  ): Promise<[Json, Json, Json]> {
    if (candidate.tokenInfo && candidate.tokenSecurity && candidate.tokenPool) {
      return [candidate.tokenInfo, candidate.tokenSecurity, candidate.tokenPool];
    }
    return Promise.all([
      this.gmgn.tokenInfo(chain, candidate.address),
      this.gmgn.tokenSecurity(chain, candidate.address),
      this.gmgn.tokenPool(chain, candidate.address),
    ]);
  }
  async scanAll(limit = 200): Promise<Alert[]> {
    const output: Alert[] = [];
    for (const chain of priorityChains(this.config.enabled_chains)) {
      try {
        output.push(...(await this.scan(chain, limit)));
      } catch (error) {
        if (isRateLimit(error)) throw error;
        console.error(`${chain} scan failed`, String(error));
      }
    }
    return output;
  }
}

export function rotatingSlice<T>(items: T[], start: number, limit: number): T[] {
  if (!items.length || limit <= 0) return [];
  const count = Math.min(items.length, Math.floor(limit)),
    offset = ((Math.floor(start) % items.length) + items.length) % items.length;
  return Array.from({ length: count }, (_, index) => items[(offset + index) % items.length]!);
}
