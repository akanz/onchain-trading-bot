import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AlertStream, isDeliverableAlert } from "./alert-stream.js";
import { DATA_ROOT, ROOT } from "./config.js";
import { isRateLimit } from "./gmgn.js";
import { DistributedLeaseRepository } from "./mongo.js";
import { RuntimeService } from "./runtime.service.js";
import {
  buildDexScreenerStatus,
  buildScanStatus,
  buildTrackedWalletStatus,
  emptyDelivery,
  serializeSuppressed,
  type DiscoveryBatch,
  type DiscoveryDeliveries,
} from "./scanner/status.js";
import { TelegramService, type DeliveryResult } from "./telegram.service.js";
import type { Alert, Chain, Json } from "./types.js";

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const discoveryKey = (row: Json): string => `${row.chain}:${String(row.address).toLowerCase()}`;

type ScannerActivity =
  | "signal-scan"
  | "tracked-wallets"
  | "dexscreener"
  | "multiples"
  | "wallet-refresh";

interface ChainScanResult {
  alerts: Alert[];
  completedChains: Chain[];
}

@Injectable()
export class ScannerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ScannerService.name);
  private readonly scanStatusPath = join(DATA_ROOT, ".runtime", "last-scan.json");
  private readonly trackedWalletStatusPath = join(
    DATA_ROOT,
    ".runtime",
    "last-tracked-wallet-monitor.json",
  );
  private readonly walletRefreshStatusPath = join(
    DATA_ROOT,
    ".runtime",
    "last-wallet-refresh.json",
  );
  private readonly dexScreenerStatusPath = join(
    DATA_ROOT,
    ".runtime",
    "last-dexscreener-monitor.json",
  );
  private activeActivity: ScannerActivity | undefined;
  private rosterReloading = false;
  private walletRefreshProcess: ChildProcess | undefined;
  private lastWalletRefreshDate = "";
  private announcedCooldown = 0;
  private readonly leaseOwnerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private ownsGmgnLease = false;
  private announcedLeaseStandby = false;
  private readonly gmgnStartupNotBefore =
    Date.now() + Math.max(0, Number(process.env.GMGN_STARTUP_GRACE_MS ?? 35_000));
  private shuttingDown = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly startupTimers = new Set<NodeJS.Timeout>();

  constructor(
    @Inject(RuntimeService) private readonly runtime: RuntimeService,
    @Inject(TelegramService) private readonly telegram: TelegramService,
    @Inject(AlertStream) private readonly stream: AlertStream,
    @Inject(SchedulerRegistry) private readonly scheduler: SchedulerRegistry,
  ) {
    try {
      this.lastWalletRefreshDate = String(
        JSON.parse(readFileSync(this.walletRefreshStatusPath, "utf8")).date ?? "",
      );
    } catch {}
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SCANNER_ENABLED === "false") {
      this.logger.warn("Scanner scheduling is disabled by SCANNER_ENABLED=false.");
      return;
    }
    await this.refreshGmgnLease();
    this.addInterval(
      "gmgn-scanner-lease",
      Math.max(30000, Math.floor(this.gmgnLeaseTtlMs() / 3)),
      () => this.runTracked(() => this.refreshGmgnLease().then(() => undefined)),
    );
    this.addInterval(
      "tracked-wallet-monitor",
      Math.max(30000, Number(process.env.TRACKED_WALLET_MONITOR_POLL_MS ?? 60000)),
      () => this.runTracked(() => this.pollTrackedWallets()),
    );
    this.addOffsetInterval(
      "dexscreener-discovery",
      Math.max(30000, Number(process.env.DEXSCREENER_SCAN_EVERY_MS ?? 60000)),
      10000,
      () => this.runTracked(() => this.pollDexScreener()),
    );
    this.addOffsetInterval(
      "signal-scan",
      Math.max(Number(process.env.SCAN_INTERVAL_MS ?? 300000), 30000),
      20000,
      () => this.runTracked(() => this.scanAndPublish()),
    );
    this.addInterval(
      "multiple-monitor",
      Math.max(5000, Number(process.env.MULTIPLE_MONITOR_POLL_MS ?? 15000)),
      () => this.runTracked(() => this.pollTriggeredMultiples()),
    );
    this.addInterval(
      "mongo-roster-reload",
      Math.max(60000, Number(process.env.MONGO_ROSTER_RELOAD_MS ?? 300000)),
      () => this.runTracked(() => this.reloadMongoRoster()),
    );
    this.addInterval("wallet-refresh-check", 60000, () =>
      this.runTracked(() => this.walletRefreshCheck()),
    );
    const startupScan = setTimeout(
      () => {
        this.startupTimers.delete(startupScan);
        this.runTracked(async () => {
          await this.pollTrackedWallets();
          await this.scanAndPublish();
        });
      },
      Math.max(0, this.gmgnStartupNotBefore - Date.now()),
    );
    startupScan.unref();
    this.startupTimers.add(startupScan);
    this.runTracked(() => this.walletRefreshCheck());
  }

  private gmgnLeaseTtlMs(): number {
    return Math.max(60_000, Number(process.env.GMGN_SCANNER_LEASE_TTL_MS ?? 300_000));
  }

  private async refreshGmgnLease(): Promise<boolean> {
    if (process.env.GMGN_DISTRIBUTED_LEASE_ENABLED === "false" || !this.runtime.mongo) return true;
    const acquired = await new DistributedLeaseRepository(this.runtime.mongo).acquire(
      process.env.GMGN_SCANNER_LEASE_NAME ?? "gmgn-background-scanner",
      this.leaseOwnerId,
      this.gmgnLeaseTtlMs(),
    );
    if (acquired) {
      if (!this.ownsGmgnLease) this.logger.log("This process owns the shared GMGN scanner lease.");
      this.ownsGmgnLease = true;
      this.announcedLeaseStandby = false;
      return true;
    }
    this.ownsGmgnLease = false;
    if (!this.announcedLeaseStandby) {
      this.logger.warn(
        "GMGN scanning is in standby because another process owns the shared scanner lease; Telegram delivery and cached API reads remain available.",
      );
      this.announcedLeaseStandby = true;
    }
    return false;
  }

  private async canUseGmgn(): Promise<boolean> {
    if (this.runtime.mongo && Date.now() < this.gmgnStartupNotBefore) return false;
    return this.refreshGmgnLease();
  }

  private addInterval(name: string, milliseconds: number, handler: () => void): void {
    const timer = setInterval(handler, milliseconds);
    timer.unref();
    this.scheduler.addInterval(name, timer);
  }
  private addOffsetInterval(
    name: string,
    milliseconds: number,
    offset: number,
    handler: () => void,
  ): void {
    const starter = setTimeout(
      () => {
        this.startupTimers.delete(starter);
        if (this.shuttingDown) return;
        handler();
        this.addInterval(name, milliseconds, handler);
      },
      Math.max(0, offset),
    );
    starter.unref();
    this.startupTimers.add(starter);
  }
  private runTracked(task: () => Promise<void>): void {
    if (this.shuttingDown) return;
    const pending = task();
    this.inFlight.add(pending);
    void pending
      .finally(() => this.inFlight.delete(pending))
      .catch((error) =>
        this.logger.error(
          "Background task failed",
          error instanceof Error ? error.stack : String(error),
        ),
      );
  }
  private saveScanStatus(status: Record<string, unknown>): void {
    mkdirSync(join(DATA_ROOT, ".runtime"), { recursive: true });
    writeFileSync(this.scanStatusPath, JSON.stringify(status, null, 2));
  }
  private mergeDelivery(target: DeliveryResult, next: DeliveryResult): void {
    target.attempted += next.attempted;
    target.sent += next.sent;
    target.failed += next.failed;
  }

  private startActivity(activity: ScannerActivity): boolean {
    if (this.shuttingDown || this.activeActivity) return false;
    this.activeActivity = activity;
    return true;
  }

  private finishActivity(activity: ScannerActivity): void {
    if (this.activeActivity === activity) this.activeActivity = undefined;
  }

  private async publishMultipleAlerts(alerts: Alert[]): Promise<DeliveryResult> {
    const delivery: DeliveryResult = { attempted: 0, sent: 0, failed: 0 };
    for (const alert of alerts) {
      this.stream.publishAlert(alert);
      const result = await this.telegram.alert(alert);
      this.mergeDelivery(delivery, result);
      if (result.sent > 0) this.runtime.tracker.acknowledgeCallMultiple(alert);
    }
    return delivery;
  }

  async scanAndPublish(): Promise<void> {
    const { tracker, botStore } = this.runtime;
    if (!(await this.canUseGmgn())) return;
    this.announceGmgnCooldown(tracker.gmgn.cooldownUntil);
    if (tracker.gmgn.cooldownUntil || !this.startActivity("signal-scan")) return;

    try {
      const { alerts, completedChains } = await this.scanScheduledChains();
      if (this.shuttingDown) return;
      const deliverableAlerts = alerts.filter(isDeliverableAlert);
      const alertDelivery = await this.publishAlerts(deliverableAlerts);
      const discoveries = await this.loadDiscoveryBatch(completedChains);
      const discoveryDeliveries = await this.publishDiscoveryBatch(completedChains, discoveries);
      const multipleAlerts = await this.loadMultipleAlerts(completedChains, discoveries);
      const multipleDelivery = await this.publishMultipleAlerts(multipleAlerts);

      this.saveScanStatus(
        buildScanStatus({
          ...discoveries,
          ...discoveryDeliveries,
          completedChains,
          cooldownUntil: tracker.gmgn.cooldownUntil,
          diagnostics: tracker.diagnostics(completedChains),
          suppressedDiscoveries: this.suppressedDiscoveries(completedChains),
          multipleAlerts,
          deliverableAlerts,
          multipleDelivery,
          alertDelivery,
          telegramEnabled: this.telegram.enabled,
          subscriptionCount: botStore.subscriptionCount(),
        }),
      );
      this.stream.publishScan({
        scannedAt: new Date().toISOString(),
        found: deliverableAlerts.length + multipleAlerts.length,
      });
    } catch (error) {
      this.saveScanStatus({
        scanned_at: new Date().toISOString(),
        error: String(error),
        subscribed_chats: botStore.subscriptionCount(),
      });
      this.logger.error(
        "Scheduled scan failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.finishActivity("signal-scan");
    }
  }

  private announceGmgnCooldown(cooldownUntil?: number): void {
    if (!cooldownUntil) {
      this.announcedCooldown = 0;
      return;
    }
    if (cooldownUntil === this.announcedCooldown) return;

    this.announcedCooldown = cooldownUntil;
    this.logger.warn(
      `All GMGN-dependent scans are paused until ${new Date(cooldownUntil).toLocaleString()}; cached discovery and wallet state is preserved.`,
    );
  }

  private async scanScheduledChains(): Promise<ChainScanResult> {
    const alerts: Alert[] = [];
    const completedChains: Chain[] = [];

    for (const chain of this.runtime.scheduledChains) {
      if (this.shuttingDown) break;
      try {
        alerts.push(...(await this.runtime.tracker.scan(chain)));
        completedChains.push(chain);
      } catch (error) {
        if (isRateLimit(error)) {
          this.logger.warn(
            `${chain} scan paused by GMGN rate limit; preserving completed-chain results and deferring remaining chains.`,
          );
          break;
        }
        this.logger.error(`${chain} scheduled scan failed: ${String(error)}`);
      }
    }

    return { alerts, completedChains };
  }

  private async publishAlerts(alerts: Alert[]): Promise<DeliveryResult> {
    const delivery = emptyDelivery();
    for (const alert of alerts) {
      this.stream.publishAlert(alert);
      this.mergeDelivery(delivery, await this.telegram.alert(alert));
    }
    return delivery;
  }

  private async loadDiscoveryBatch(completedChains: Chain[]): Promise<DiscoveryBatch> {
    const tracker = this.runtime.tracker;
    const trending = completedChains.length
      ? await tracker.latestTrendingAcross(
          completedChains,
          Number(process.env.TRENDING_DIGEST_LIMIT ?? 10),
        )
      : [];
    const discoveryEnabled =
      !tracker.gmgn.cooldownUntil &&
      process.env.DEGEN_MODE === "true" &&
      completedChains.length > 0;
    if (!discoveryEnabled) return { trending, surged: [], potential: [] };

    const surgedRanked = tracker.latestSurgedAcross(
      completedChains,
      Number(process.env.SURGED_DIGEST_LIMIT ?? 10),
    );
    const potentialRanked = tracker.latestPotentialAcross(
      completedChains,
      Number(process.env.POTENTIAL_DIGEST_LIMIT ?? 10),
    );
    const surgedKeys = new Set(surgedRanked.map(discoveryKey));
    const potentialKeys = new Set(potentialRanked.map(discoveryKey));
    const uniqueRows = new Map(
      [...surgedRanked, ...potentialRanked].map((row) => [discoveryKey(row), row]),
    );
    const enriched = uniqueRows.size ? await tracker.enrichDegenRows([...uniqueRows.values()]) : [];

    return {
      trending,
      surged: enriched.filter((row) => surgedKeys.has(discoveryKey(row))),
      potential: enriched.filter(
        (row) => potentialKeys.has(discoveryKey(row)) && !surgedKeys.has(discoveryKey(row)),
      ),
    };
  }

  private async publishDiscoveryBatch(
    completedChains: Chain[],
    batch: DiscoveryBatch,
  ): Promise<DiscoveryDeliveries> {
    const tracker = this.runtime.tracker;
    const trendingDelivery = batch.trending.length
      ? await this.telegram.trending(completedChains, batch.trending)
      : emptyDelivery();
    if (trendingDelivery.sent > 0) tracker.acknowledgeTrending(batch.trending);

    const surgedDelivery = batch.surged.length
      ? await this.telegram.surged(completedChains, batch.surged)
      : emptyDelivery();
    if (surgedDelivery.sent > 0) tracker.acknowledgeDiscovery("surged", batch.surged);

    const potentialDelivery = batch.potential.length
      ? await this.telegram.potential(completedChains, batch.potential)
      : emptyDelivery();
    if (potentialDelivery.sent > 0) tracker.acknowledgeDiscovery("potential", batch.potential);

    return { trendingDelivery, surgedDelivery, potentialDelivery };
  }

  private async loadMultipleAlerts(
    completedChains: Chain[],
    discoveries: DiscoveryBatch,
  ): Promise<Alert[]> {
    if (this.runtime.tracker.gmgn.cooldownUntil || !completedChains.length) return [];
    return this.runtime.tracker.monitorCallMultiples(completedChains, [
      ...discoveries.trending,
      ...discoveries.surged,
      ...discoveries.potential,
    ]);
  }

  private suppressedDiscoveries(chains: Chain[]): Json[] {
    if (typeof this.runtime.tracker.discoveryDecisions !== "function") return [];
    const rows = chains.flatMap((chain) =>
      this.runtime.tracker
        .discoveryDecisions(chain, 10, "suppressed")
        .map((row) => ({ chain, row })),
    );
    return serializeSuppressed(rows);
  }

  private async pollTrackedWallets(): Promise<void> {
    const tracker = this.runtime.tracker;
    if (!(await this.canUseGmgn())) return;
    if (tracker.gmgn.cooldownUntil || !this.startActivity("tracked-wallets")) return;

    const delivery = emptyDelivery();
    const alerts: Alert[] = [];
    const completedChains: Chain[] = [];
    try {
      for (const chain of this.runtime.scheduledChains) {
        if (this.shuttingDown) break;
        try {
          const found = await tracker.scanTrackedWallets(chain);
          alerts.push(...found);
          completedChains.push(chain);
          for (const alert of found) {
            this.stream.publishAlert(alert);
            this.mergeDelivery(delivery, await this.telegram.alert(alert));
          }
        } catch (error) {
          if (isRateLimit(error)) {
            this.logger.warn(
              `${chain}: tracked-wallet monitor paused by GMGN rate limit; already collected wallet alerts are preserved.`,
            );
            break;
          }
          this.logger.error(`${chain}: tracked-wallet monitor failed: ${String(error)}`);
        }
      }
      mkdirSync(join(DATA_ROOT, ".runtime"), { recursive: true });
      writeFileSync(
        this.trackedWalletStatusPath,
        JSON.stringify(
          buildTrackedWalletStatus({
            completedChains,
            alerts,
            diagnostics: tracker.diagnostics(this.runtime.scheduledChains),
            delivery,
          }),
          null,
          2,
        ),
      );
      if (alerts.length)
        this.logger.log(
          `Tracked-wallet monitor: ${alerts.length} safe buy/sell alert(s), ${delivery.sent} Telegram delivery/deliveries.`,
        );
    } finally {
      this.finishActivity("tracked-wallets");
    }
  }

  private async pollDexScreener(): Promise<void> {
    const tracker = this.runtime.tracker;
    if (!(await this.canUseGmgn())) return;
    if (tracker.gmgn.cooldownUntil || !this.startActivity("dexscreener")) return;
    try {
      const result = await tracker.pollDexScreenerDiscovery(this.runtime.scheduledChains);
      const surgedDelivery = result.surged.length
        ? await this.telegram.surged(this.runtime.scheduledChains, result.surged)
        : emptyDelivery();
      const potentialDelivery = result.potential.length
        ? await this.telegram.potential(this.runtime.scheduledChains, result.potential)
        : emptyDelivery();
      if (surgedDelivery.sent > 0) tracker.acknowledgeDiscovery("surged", result.surged);
      if (potentialDelivery.sent > 0) tracker.acknowledgeDiscovery("potential", result.potential);
      const suppressed = this.runtime.scheduledChains.flatMap((chain) =>
        tracker.discoveryDecisions(chain, 10, "suppressed"),
      );
      mkdirSync(join(DATA_ROOT, ".runtime"), { recursive: true });
      writeFileSync(
        this.dexScreenerStatusPath,
        JSON.stringify(
          buildDexScreenerStatus({
            ...result,
            suppressed,
            diagnostics: tracker.diagnostics(this.runtime.scheduledChains),
            surgedDelivery,
            potentialDelivery,
          }),
          null,
          2,
        ),
      );
      if (result.surged.length || result.potential.length)
        this.logger.log(
          `DexScreener monitor: ${result.surged.length} safe surge(s), ${result.potential.length} safe potential runner(s).`,
        );
    } catch (error) {
      this.logger.error(
        "DexScreener monitor failed",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.finishActivity("dexscreener");
    }
  }

  private async pollTriggeredMultiples(): Promise<void> {
    const tracker = this.runtime.tracker;
    if (!(await this.canUseGmgn())) return;
    if (
      process.env.MULTIPLE_MONITOR_ENABLED === "false" ||
      tracker.gmgn.cooldownUntil ||
      !this.startActivity("multiples")
    )
      return;
    try {
      const alerts = await tracker.monitorTriggeredCallMultiples(this.runtime.scheduledChains);
      if (alerts.length) {
        const delivery = await this.publishMultipleAlerts(alerts);
        this.logger.log(
          `Multiplier monitor: ${alerts.length} milestone(s), ${delivery.sent} Telegram delivery/deliveries.`,
        );
      }
    } catch (error) {
      if (isRateLimit(error))
        this.logger.warn(
          `Real-time multiplier monitor paused until ${tracker.gmgn.cooldownUntil ? new Date(tracker.gmgn.cooldownUntil).toLocaleString() : "the GMGN cooldown ends"}.`,
        );
      else
        this.logger.error(
          "Real-time multiplier monitor failed",
          error instanceof Error ? error.stack : String(error),
        );
    } finally {
      this.finishActivity("multiples");
    }
  }

  private async reloadMongoRoster(): Promise<void> {
    if (this.shuttingDown || this.rosterReloading) return;
    this.rosterReloading = true;
    try {
      await this.runtime.tracker.refreshTrackedWalletsFromMongo();
    } catch (error) {
      this.logger.error(
        "Could not reload the tracked-wallet roster from MongoDB",
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.rosterReloading = false;
    }
  }

  private async walletRefreshCheck(): Promise<void> {
    if (!(await this.canUseGmgn())) return;
    if (process.env.DAILY_WALLET_REFRESH_ENABLED === "false" || this.activeActivity) return;
    const now = new Date(),
      hour = Math.min(23, Math.max(0, Number(process.env.DAILY_WALLET_REFRESH_HOUR_LOCAL ?? 3))),
      date = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    if (now.getHours() !== hour || this.lastWalletRefreshDate === date) return;
    if (!this.startActivity("wallet-refresh")) return;
    this.lastWalletRefreshDate = date;
    mkdirSync(join(DATA_ROOT, ".runtime"), { recursive: true });
    writeFileSync(
      this.walletRefreshStatusPath,
      JSON.stringify({ date, started_at: now.toISOString() }, null, 2),
    );
    this.logger.log("Starting daily GMGN wallet-roster reshuffle…");
    try {
      await new Promise<void>((resolve) => {
        this.walletRefreshProcess = spawn(
          process.execPath,
          ["--import", "tsx", join(ROOT, "scripts", "wallet-scan.ts")],
          { cwd: ROOT, stdio: "inherit", env: process.env },
        );
        this.walletRefreshProcess.once("error", (error) => {
          this.logger.error("Daily wallet-roster refresh could not start", error.stack);
          resolve();
        });
        this.walletRefreshProcess.once("exit", (code) => {
          if (this.shuttingDown) {
            resolve();
            return;
          }
          void this.runtime.tracker
            .refreshTrackedWalletsFromMongo()
            .catch((error) =>
              this.logger.error(
                "Could not reload MongoDB wallet roster",
                error instanceof Error ? error.stack : String(error),
              ),
            )
            .finally(resolve);
          writeFileSync(
            this.walletRefreshStatusPath,
            JSON.stringify(
              {
                date,
                started_at: now.toISOString(),
                finished_at: new Date().toISOString(),
                exit_code: code,
              },
              null,
              2,
            ),
          );
          if (code === 0) this.logger.log("Daily wallet-roster reshuffle complete.");
          else
            this.logger.error(
              `Daily wallet-roster refresh exited with code ${code}; any successfully refreshed partial roster will still be loaded.`,
            );
        });
      });
    } finally {
      this.walletRefreshProcess = undefined;
      this.finishActivity("wallet-refresh");
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.startupTimers) clearTimeout(timer);
    this.startupTimers.clear();
    for (const name of [
      "tracked-wallet-monitor",
      "dexscreener-discovery",
      "signal-scan",
      "multiple-monitor",
      "mongo-roster-reload",
      "wallet-refresh-check",
      "gmgn-scanner-lease",
    ])
      try {
        this.scheduler.deleteInterval(name);
      } catch {}
    this.walletRefreshProcess?.kill("SIGTERM");
    await Promise.race([Promise.allSettled([...this.inFlight]), sleep(1500)]);
    if (this.ownsGmgnLease && this.runtime.mongo)
      await new DistributedLeaseRepository(this.runtime.mongo)
        .release(
          process.env.GMGN_SCANNER_LEASE_NAME ?? "gmgn-background-scanner",
          this.leaseOwnerId,
        )
        .catch(() => undefined);
  }
}
