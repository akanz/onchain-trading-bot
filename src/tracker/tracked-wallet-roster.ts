import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_ROOT, ROOT } from "../config.js";
import { buildEliteGmgnWalletsFromTokenResults } from "../gmgn-wallet-analysis.js";
import { TrackedWalletRepository, type MongoState } from "../mongo.js";
import { addressKey } from "../signals.js";
import { loadTrackedWalletSeeds } from "../tracked-wallet-seeds.js";
import type { Chain, Json, TrackerConfig } from "../types.js";

type WalletSource = "gmgn";

interface ReportPaths {
  gmgn: string | undefined;
  runners: string | undefined;
  seeds: string;
}

const reportDirectory = join(DATA_ROOT, "reports");
const seedPath = join(ROOT, "tracked-wallet-seeds.json");

function latestReport(pattern: RegExp, excludedText?: string): string | undefined {
  if (!existsSync(reportDirectory)) return undefined;

  const filename = readdirSync(reportDirectory)
    .filter((name) => pattern.test(name) && !name.includes(excludedText ?? ""))
    .sort()
    .reverse()
    .at(0);

  return filename ? join(reportDirectory, filename) : undefined;
}

function resolveReportPaths(): ReportPaths {
  return {
    gmgn: latestReport(/^daily-wallet-scan-.*\.json$/, "cache"),
    runners: latestReport(/^runner-wallet-scan-.*\.json$/, "cache"),
    seeds: seedPath,
  };
}

function existingPaths(paths: ReportPaths): string[] {
  return Object.values(paths).filter(
    (path): path is string => path !== undefined && existsSync(path),
  );
}

function performanceScore(row: Json): number {
  return Number(row.score ?? row.fomo_leaderboard_pnl ?? row.max_position_roi_percent ?? 0);
}

function trackingPriority(row: Json): number {
  if (row.tracking_tier === "qualified") return 3;
  if (row.tracking_tier === "elite_observed") return 2;
  return 1;
}

function isTrackable(row: Json): boolean {
  return (
    row.tracking_tier === undefined ||
    row.tracking_tier === "qualified" ||
    row.tracking_tier === "elite_observed"
  );
}

function safeSeedRows(): Json[] {
  try {
    return loadTrackedWalletSeeds(seedPath);
  } catch (error) {
    console.warn("Could not load tracked-wallet-seeds.json", String(error));
    return [];
  }
}

export class TrackedWalletRoster {
  private walletCache: Map<Chain, string[]> | undefined;
  private rowCache: Json[] | undefined;
  private signature = "";
  private mongoRows: Json[] = [];

  constructor(
    private readonly config: TrackerConfig,
    private readonly mongo?: MongoState,
  ) {}

  rows(): Json[] {
    const paths = resolveReportPaths();
    const signature = this.buildSignature(paths);
    if (this.rowCache && signature === this.signature) return this.rowCache;

    const rows = [
      ...this.readReport(paths.gmgn, "gmgn"),
      ...this.readReport(paths.runners, "gmgn"),
      ...safeSeedRows(),
      ...this.mongoRows,
    ].filter((row) => row.source !== "fomo");

    this.signature = signature;
    this.walletCache = undefined;
    this.rowCache = this.dedupeAndSort(rows);
    return this.rowCache;
  }

  wallets(): Map<Chain, string[]> {
    if (this.walletCache) return this.walletCache;

    const wallets = new Map<Chain, string[]>();
    for (const row of this.rows()) {
      const chain = row.chain as Chain;
      const wallet = String(row.wallet);
      const chainWallets = wallets.get(chain) ?? [];
      if (!chainWallets.some((value) => addressKey(value) === addressKey(wallet))) {
        wallets.set(chain, [...chainWallets, wallet]);
      }
    }

    this.walletCache = wallets;
    return wallets;
  }

  invalidate(): void {
    this.walletCache = undefined;
    this.rowCache = undefined;
    this.signature = "";
  }

  replaceMongoRows(rows: Json[]): void {
    this.mongoRows = rows;
    this.invalidate();
  }

  async refreshFromMongo(): Promise<void> {
    if (this.mongo) this.mongoRows = await new TrackedWalletRepository(this.mongo).loadAll();
    this.invalidate();
  }

  private buildSignature(paths: ReportPaths): string {
    const latestMongoUpdate = this.mongoRows
      .map((row) => String(row.updated_at ?? row.generated_at ?? ""))
      .sort()
      .at(-1);
    const fileSignature = existingPaths(paths)
      .map((path) => `${path}:${statSync(path).mtimeMs}`)
      .join("|");

    return `mongo:${this.mongoRows.length}:${latestMongoUpdate ?? ""}:${fileSignature}`;
  }

  private readReport(path: string | undefined, source: WalletSource): Json[] {
    if (!path || !existsSync(path)) return [];

    try {
      const report = JSON.parse(readFileSync(path, "utf8"));
      const tracked: Json[] | undefined = report.tracked_wallets;
      const selected: Json[] = tracked ?? report.qualified_wallets ?? [];
      const rows: Json[] = selected.map((row) => ({
        ...row,
        source: row.source ?? source,
        tracking_tier:
          row.tracking_tier ?? (source === "gmgn" || !tracked ? "qualified" : undefined),
      }));

      if (source === "gmgn" && report.tokens) {
        rows.push(...buildEliteGmgnWalletsFromTokenResults(report.tokens));
      }

      return rows;
    } catch (error) {
      console.warn(`Could not load ${source.toUpperCase()} tracked-wallet report`, String(error));
      return [];
    }
  }

  private normalizeTier(input: Json): Json {
    const inferredTier =
      input.tracking_tier ??
      (input.verification_source ||
      input.roi30 !== undefined ||
      input.roi_closed_sample !== undefined
        ? "qualified"
        : undefined);
    const row =
      inferredTier === input.tracking_tier ? input : { ...input, tracking_tier: inferredTier };

    if (row.tracking_tier !== "qualified") return row;
    return this.applyPerformanceFloor(row);
  }

  private applyPerformanceFloor(row: Json): Json {
    const roi30 = this.finiteNumber(row.roi30 ?? row.roi_closed_sample);
    const roiAll = this.finiteNumber(row.roiall ?? row.roi_all);
    const minimum30 = Number(this.config.wallet.min_roi_30d ?? 2);
    const minimumAll = Number(this.config.wallet.min_roi_all ?? 2);
    if (roi30 !== undefined && roiAll !== undefined && (roi30 < minimum30 || roiAll < minimumAll)) {
      return { ...row, tracking_tier: "observed" };
    }
    return row;
  }

  private dedupeAndSort(rows: Json[]): Json[] {
    const deduped = new Map<string, Json>();

    for (const input of rows) {
      const row = this.normalizeTier(input);
      const chain = row.chain as Chain;
      const wallet = String(row.wallet ?? "");
      if (!this.config.enabled_chains.includes(chain) || !wallet || !isTrackable(row)) continue;

      const key = `${row.source ?? "generated"}:${chain}:${wallet.toLowerCase()}`;
      const current = deduped.get(key);
      if (!current || trackingPriority(row) > trackingPriority(current)) deduped.set(key, row);
    }

    return [...deduped.values()].sort(
      (left, right) =>
        trackingPriority(right) - trackingPriority(left) ||
        performanceScore(right) - performanceScore(left),
    );
  }

  private finiteNumber(value: unknown): number | undefined {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
