import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AlertStream, isDeliverableAlert } from "./alert-stream.js";
import { DATA_ROOT, ROOT } from "./config.js";
import { startFomoSessionBridge, type FomoSessionBridge } from "./fomo/session.js";
import { isRateLimit } from "./gmgn.js";
import { RuntimeService } from "./runtime.service.js";
import { TelegramService, type DeliveryResult } from "./telegram.service.js";
import type { Alert, Chain, Json } from "./types.js";

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

@Injectable()
export class ScannerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ScannerService.name);
  private readonly scanStatusPath = join(DATA_ROOT, ".runtime", "last-scan.json");
  private readonly trackedWalletStatusPath = join(DATA_ROOT, ".runtime", "last-tracked-wallet-monitor.json");
  private readonly walletRefreshStatusPath = join(DATA_ROOT, ".runtime", "last-wallet-refresh.json");
  private readonly dexScreenerStatusPath = join(DATA_ROOT, ".runtime", "last-dexscreener-monitor.json");
  private scanning = false;
  private walletRefreshRunning = false;
  private multipleMonitoring = false;
  private trackedWalletMonitoring = false;
  private dexScreenerMonitoring = false;
  private rosterReloading = false;
  private walletRefreshProcess: ChildProcess | undefined;
  private lastWalletRefreshDate = "";
  private announcedCooldown = 0;
  private fomoSession?: FomoSessionBridge | null;
  private fomoConnecting = false;
  private fomoAbort: AbortController | undefined;
  private shuttingDown = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly startupTimers = new Set<NodeJS.Timeout>();

  constructor(@Inject(RuntimeService) private readonly runtime: RuntimeService, @Inject(TelegramService) private readonly telegram: TelegramService, @Inject(AlertStream) private readonly stream: AlertStream, @Inject(SchedulerRegistry) private readonly scheduler: SchedulerRegistry) { try { this.lastWalletRefreshDate = String(JSON.parse(readFileSync(this.walletRefreshStatusPath, "utf8")).date ?? ""); } catch { } }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.SCANNER_ENABLED === "false") { this.logger.warn("Scanner scheduling is disabled by SCANNER_ENABLED=false."); return; }
    await this.ensureFomoSession();
    this.addInterval("tracked-wallet-monitor", Math.max(30000, Number(process.env.TRACKED_WALLET_MONITOR_POLL_MS ?? 60000)), () => this.runTracked(() => this.pollTrackedWallets()));
    this.addOffsetInterval("dexscreener-discovery", Math.max(30000, Number(process.env.DEXSCREENER_SCAN_EVERY_MS ?? 60000)), 10000, () => this.runTracked(() => this.pollDexScreener()));
    this.addOffsetInterval("signal-scan", Math.max(Number(process.env.SCAN_INTERVAL_MS ?? 300000), 30000), 20000, () => this.runTracked(() => this.scanAndPublish()));
    this.addInterval("multiple-monitor", Math.max(5000, Number(process.env.MULTIPLE_MONITOR_POLL_MS ?? 15000)), () => this.runTracked(() => this.pollTriggeredMultiples()));
    this.addInterval("mongo-roster-reload", Math.max(60000, Number(process.env.MONGO_ROSTER_RELOAD_MS ?? 300000)), () => this.runTracked(() => this.reloadMongoRoster()));
    this.addInterval("wallet-refresh-check", 60000, () => this.runTracked(() => this.walletRefreshCheck()));
    this.addInterval("fomo-session-health", Math.max(30000, Number(process.env.FOMO_BROWSER_RECONNECT_MS ?? 60000)), () => this.runTracked(() => this.ensureFomoSession()));
    this.runTracked(async() => { await this.pollTrackedWallets(); await this.scanAndPublish(); }); this.runTracked(() => this.walletRefreshCheck());
  }

  private addInterval(name: string, milliseconds: number, handler: () => void): void { const timer = setInterval(handler, milliseconds); timer.unref(); this.scheduler.addInterval(name, timer); }
  private addOffsetInterval(name:string,milliseconds:number,offset:number,handler:()=>void):void{const starter=setTimeout(()=>{this.startupTimers.delete(starter);if(this.shuttingDown)return;handler();this.addInterval(name,milliseconds,handler);},Math.max(0,offset));starter.unref();this.startupTimers.add(starter);}
  private runTracked(task: () => Promise<void>): void { if (this.shuttingDown) return; const pending = task(); this.inFlight.add(pending); void pending.finally(() => this.inFlight.delete(pending)).catch(error => this.logger.error("Background task failed", error instanceof Error ? error.stack : String(error))); }
  private async ensureFomoSession(): Promise<void> {
    if (this.shuttingDown || process.env.FOMO_BROWSER_SESSION !== "true" || this.fomoConnecting || this.fomoSession?.connected) return;
    this.fomoConnecting = true;
    try {
      await this.fomoSession?.close();
      const controller = new AbortController(); this.fomoAbort = controller;
      const session = await startFomoSessionBridge(controller.signal);
      if (this.shuttingDown) await session?.close(); else this.fomoSession = session;
    } catch (error) { if (!this.shuttingDown) this.logger.warn(`Fomo browser reconnect failed: ${String(error)}`); }
    finally { this.fomoAbort = undefined; this.fomoConnecting = false; }
  }
  private saveScanStatus(status: Record<string, unknown>): void { mkdirSync(join(DATA_ROOT, ".runtime"), { recursive: true }); writeFileSync(this.scanStatusPath, JSON.stringify(status, null, 2)); }
  private mergeDelivery(target: DeliveryResult, next: DeliveryResult): void { target.attempted += next.attempted; target.sent += next.sent; target.failed += next.failed; }

  private async publishMultipleAlerts(alerts: Alert[]): Promise<DeliveryResult> {
    const delivery: DeliveryResult = { attempted: 0, sent: 0, failed: 0 };
    for (const alert of alerts) { this.stream.publishAlert(alert); const result = await this.telegram.alert(alert); this.mergeDelivery(delivery, result); if (result.sent > 0) this.runtime.tracker.acknowledgeCallMultiple(alert); }
    return delivery;
  }

  async scanAndPublish(): Promise<void> {
    if (this.shuttingDown || this.scanning || this.walletRefreshRunning || this.multipleMonitoring || this.trackedWalletMonitoring || this.dexScreenerMonitoring) return;
    const { tracker, botStore } = this.runtime, cooldownUntil = tracker.gmgn.cooldownUntil;
    if (cooldownUntil) { if (cooldownUntil !== this.announcedCooldown) { this.announcedCooldown = cooldownUntil; this.logger.warn(`GMGN-dependent scans are paused until ${new Date(cooldownUntil).toLocaleString()}; Fomo wallet polling continues, but token alerts remain blocked until GMGN safety checks pass.`); } }
    else this.announcedCooldown = 0; this.scanning = true;
    try {
      const alerts: Alert[] = [], completedChains: Chain[] = [];
      for (const chain of this.runtime.scheduledChains) { if (this.shuttingDown) break; try { alerts.push(...await tracker.scan(chain)); completedChains.push(chain); } catch (error) { if (isRateLimit(error)) { this.logger.warn(`${chain} scan paused by GMGN rate limit; preserving completed-chain results and deferring remaining chains.`); break; } this.logger.error(`${chain} scheduled scan failed: ${String(error)}`); } }
      if (this.shuttingDown) return;
      const deliverable = alerts.filter(isDeliverableAlert), alertDelivery: DeliveryResult = { attempted: 0, sent: 0, failed: 0 };
      for (const alert of deliverable) { this.stream.publishAlert(alert); this.mergeDelivery(alertDelivery, await this.telegram.alert(alert)); }
      const gmgnAvailable = !tracker.gmgn.cooldownUntil, trending = completedChains.length ? await tracker.latestTrendingAcross(completedChains, Number(process.env.TRENDING_DIGEST_LIMIT ?? 10)) : [], discoveryEnabled = gmgnAvailable && process.env.DEGEN_MODE === "true" && completedChains.length > 0, surgedRanked = discoveryEnabled ? tracker.latestSurgedAcross(completedChains, Number(process.env.SURGED_DIGEST_LIMIT ?? 10)) : [], potentialRanked = discoveryEnabled ? tracker.latestPotentialAcross(completedChains, Number(process.env.POTENTIAL_DIGEST_LIMIT ?? 10)) : [], surgedKeys = new Set(surgedRanked.map(row => `${row.chain}:${String(row.address).toLowerCase()}`)), potentialKeys = new Set(potentialRanked.map(row => `${row.chain}:${String(row.address).toLowerCase()}`)), discoveryRows = [...new Map([...surgedRanked, ...potentialRanked].map(row => [`${row.chain}:${String(row.address).toLowerCase()}`, row])).values()], enriched = discoveryRows.length ? await tracker.enrichDegenRows(discoveryRows) : [], surged = enriched.filter(row => surgedKeys.has(`${row.chain}:${String(row.address).toLowerCase()}`)), potential = enriched.filter(row => potentialKeys.has(`${row.chain}:${String(row.address).toLowerCase()}`) && !surgedKeys.has(`${row.chain}:${String(row.address).toLowerCase()}`));
      const trendingDelivery = completedChains.length && trending.length ? await this.telegram.trending(completedChains, trending) : { attempted: 0, sent: 0, failed: 0 }; if (trendingDelivery.sent > 0) tracker.acknowledgeTrending(trending);
      const surgedDelivery = surged.length && this.telegram.surged ? await this.telegram.surged(completedChains, surged) : { attempted: 0, sent: 0, failed: 0 };if(surgedDelivery.sent>0)tracker.acknowledgeDiscovery("surged",surged);const potentialDelivery = potential.length && this.telegram.potential ? await this.telegram.potential(completedChains, potential) : { attempted: 0, sent: 0, failed: 0 };if(potentialDelivery.sent>0)tracker.acknowledgeDiscovery("potential",potential);const multipleAlerts = !tracker.gmgn.cooldownUntil && completedChains.length ? await tracker.monitorCallMultiples(completedChains, [...trending, ...surged, ...potential]) : [], multipleDelivery = await this.publishMultipleAlerts(multipleAlerts);
      this.saveScanStatus({ scanned_at: new Date().toISOString(), completed_chains: completedChains, gmgn_cooldown_until: tracker.gmgn.cooldownUntil ? new Date(tracker.gmgn.cooldownUntil).toISOString() : null, diagnostics: tracker.diagnostics(completedChains), trending_contracts: trending.map(row => this.trendingStatus(row)), surged_contracts: surged.map(row => this.degenStatus(row)), potential_contracts: potential.map(row => ({ ...this.degenStatus(row), potential_runner_score: row.potential_runner_score })), suppressed_discoveries: completedChains.flatMap(chain=>typeof tracker.discoveryDecisions==="function"?tracker.discoveryDecisions(chain,10,"suppressed").map(row=>({chain,address:row.address,symbol:row.symbol,status:row.status,sources:row.sources,signals:row.signals,reasons:row.reasons,market_cap:row.market_cap,liquidity:row.liquidity,volume_5m:row.volume_5m,price_change_5m:row.price_change_5m,last_detected_at:row.last_detected_at})):[]), multiple_alerts: multipleAlerts.map(alert => ({ chain: alert.chain, address: alert.address, symbol: alert.symbol, milestone: alert.milestone, multiple: alert.multiple, age_seconds: alert.age_seconds })), alerts: deliverable.map(alert => ({ chain: alert.chain, address: alert.address, symbol: alert.symbol, tier: alert.tier, kind: alert.kind, tracking_label: alert.tracking_label, traders: alert.traders, market_cap_at_detection: alert.market_cap_at_detection })), subscribed_chats: botStore.subscriptionCount(), telegram: { enabled: this.telegram.enabled, trending: trendingDelivery, surged: surgedDelivery, potential: potentialDelivery, multiples: multipleDelivery, alerts: alertDelivery } });
      this.stream.publishScan({ scannedAt: new Date().toISOString(), found: deliverable.length + multipleAlerts.length });
    } catch (error) { this.saveScanStatus({ scanned_at: new Date().toISOString(), error: String(error), subscribed_chats: botStore.subscriptionCount() }); this.logger.error("Scheduled scan failed", error instanceof Error ? error.stack : String(error)); }
    finally { this.scanning = false; }
  }

  private trendingStatus(row: Json): Json { return { chain: row.chain, address: row.address, symbol: row.symbol, quality_passed: row.quality_passed, multiwindow_passed: row.multiwindow_passed, multiwindow_grade: row.multiwindow_grade, multiwindow_score: row.multiwindow_score, pattern: row.pattern, market_cap: row.market_cap, liquidity: row.liquidity, volume_5m: row.volume_5m ?? row.volume, volume_15m: row.volume_15m, volume_30m: row.volume_30m, volume_1h: row.volume_1h, price_change_5m: row.price_change_5m, price_change_15m: row.price_change_15m, price_change_30m: row.price_change_30m, price_change_1h: row.price_change_1h, drawdown_1h_percent: row.drawdown_1h_percent }; }
  private degenStatus(row: Json): Json { return { chain: row.chain, address: row.address, symbol: row.symbol, market_cap: row.market_cap, liquidity: row.liquidity, volume_5m: row.volume, price_change_5m: row.price_change_5m ?? row.price_change_percent5m ?? row.price_change_percent, price_change_30m: row.price_change_30m, pons_status: row.pons_status, graduation_progress_percent: row.graduation_progress_percent, progress_change_30m: row.progress_change_30m, sources: row.degen_sources, surge_attribution: row.surge_attribution ? { event: row.surge_attribution.event, confirmed_profitable_wallets: row.surge_attribution.wallets?.length ?? 0, track_worthy_wallets: row.surge_attribution.track_worthy_wallets ?? 0 } : undefined, failed_gates: row.quality_reasons }; }

  private async pollTrackedWallets():Promise<void>{
    const tracker=this.runtime.tracker;if(this.shuttingDown||this.trackedWalletMonitoring||this.dexScreenerMonitoring||this.scanning||this.walletRefreshRunning||this.multipleMonitoring||tracker.gmgn.cooldownUntil)return;this.trackedWalletMonitoring=true;
    const delivery:DeliveryResult={attempted:0,sent:0,failed:0},alerts:Alert[]=[],completed:Chain[]=[];
    try{
      for(const chain of this.runtime.scheduledChains){if(this.shuttingDown)break;try{const found=await tracker.scanTrackedWallets(chain);alerts.push(...found);completed.push(chain);for(const alert of found){this.stream.publishAlert(alert);this.mergeDelivery(delivery,await this.telegram.alert(alert));}}catch(error){if(isRateLimit(error)){this.logger.warn(`${chain}: tracked-wallet monitor paused by GMGN rate limit; already collected wallet alerts are preserved.`);break;}this.logger.error(`${chain}: tracked-wallet monitor failed: ${String(error)}`);}}
      mkdirSync(join(DATA_ROOT,".runtime"),{recursive:true});writeFileSync(this.trackedWalletStatusPath,JSON.stringify({scanned_at:new Date().toISOString(),completed_chains:completed,alerts:alerts.map(alert=>({chain:alert.chain,address:alert.address,symbol:alert.symbol,kind:alert.kind,tracking_label:alert.tracking_label,traders:alert.traders,market_cap_at_detection:alert.market_cap_at_detection})),diagnostics:tracker.diagnostics(this.runtime.scheduledChains),telegram:delivery},null,2));
      if(alerts.length)this.logger.log(`Tracked-wallet monitor: ${alerts.length} safe buy/sell alert(s), ${delivery.sent} Telegram delivery/deliveries.`);
    }finally{this.trackedWalletMonitoring=false;}
  }

  private async pollDexScreener():Promise<void>{
    if(this.shuttingDown||this.dexScreenerMonitoring||this.scanning||this.walletRefreshRunning||this.multipleMonitoring||this.trackedWalletMonitoring)return;this.dexScreenerMonitoring=true;
    try{const tracker=this.runtime.tracker,result=await tracker.pollDexScreenerDiscovery(this.runtime.scheduledChains),surgedDelivery=result.surged.length?await this.telegram.surged(this.runtime.scheduledChains,result.surged):{attempted:0,sent:0,failed:0},potentialDelivery=result.potential.length?await this.telegram.potential(this.runtime.scheduledChains,result.potential):{attempted:0,sent:0,failed:0};if(surgedDelivery.sent>0)tracker.acknowledgeDiscovery("surged",result.surged);if(potentialDelivery.sent>0)tracker.acknowledgeDiscovery("potential",result.potential);const suppressed=this.runtime.scheduledChains.flatMap(chain=>tracker.discoveryDecisions(chain,10,"suppressed"));mkdirSync(join(DATA_ROOT,".runtime"),{recursive:true});writeFileSync(this.dexScreenerStatusPath,JSON.stringify({scanned_at:new Date().toISOString(),safe_candidates:result.safe.length,surged:result.surged.map(row=>this.degenStatus(row)),potential:result.potential.map(row=>({...this.degenStatus(row),potential_runner_score:row.potential_runner_score})),suppressed:suppressed.map(row=>({chain:row.scope,address:row.address,symbol:row.symbol,reasons:row.reasons,last_detected_at:row.last_detected_at})),diagnostics:tracker.diagnostics(this.runtime.scheduledChains),telegram:{surged:surgedDelivery,potential:potentialDelivery}},null,2));if(result.surged.length||result.potential.length)this.logger.log(`DexScreener monitor: ${result.surged.length} safe surge(s), ${result.potential.length} safe potential runner(s).`);}
    catch(error){this.logger.error("DexScreener monitor failed",error instanceof Error?error.stack:String(error));}finally{this.dexScreenerMonitoring=false;}
  }

  private async pollTriggeredMultiples(): Promise<void> {
    const tracker = this.runtime.tracker; if (this.shuttingDown || process.env.MULTIPLE_MONITOR_ENABLED === "false" || this.scanning || this.walletRefreshRunning || this.multipleMonitoring || this.trackedWalletMonitoring || this.dexScreenerMonitoring || tracker.gmgn.cooldownUntil) return; this.multipleMonitoring = true;
    try { const alerts = await tracker.monitorTriggeredCallMultiples(this.runtime.scheduledChains); if (alerts.length) { const delivery = await this.publishMultipleAlerts(alerts); this.logger.log(`Multiplier monitor: ${alerts.length} milestone(s), ${delivery.sent} Telegram delivery/deliveries.`); } }
    catch (error) { if (isRateLimit(error)) this.logger.warn(`Real-time multiplier monitor paused until ${tracker.gmgn.cooldownUntil ? new Date(tracker.gmgn.cooldownUntil).toLocaleString() : "the GMGN cooldown ends"}.`); else this.logger.error("Real-time multiplier monitor failed", error instanceof Error ? error.stack : String(error)); }
    finally { this.multipleMonitoring = false; }
  }

  private async reloadMongoRoster(): Promise<void> {
    if (this.shuttingDown || this.rosterReloading) return; this.rosterReloading = true;
    try { await this.runtime.tracker.refreshTrackedWalletsFromMongo(); }
    catch (error) { this.logger.error("Could not reload the tracked-wallet roster from MongoDB", error instanceof Error ? error.stack : String(error)); }
    finally { this.rosterReloading = false; }
  }

  private async walletRefreshCheck(): Promise<void> {
    if (this.shuttingDown || process.env.DAILY_WALLET_REFRESH_ENABLED === "false" || this.scanning || this.walletRefreshRunning || this.multipleMonitoring || this.trackedWalletMonitoring || this.dexScreenerMonitoring) return;
    const now = new Date(), hour = Math.min(23, Math.max(0, Number(process.env.DAILY_WALLET_REFRESH_HOUR_LOCAL ?? 3))), date = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`; if (now.getHours() !== hour || this.lastWalletRefreshDate === date) return;
    this.lastWalletRefreshDate = date; mkdirSync(join(DATA_ROOT, ".runtime"), { recursive: true }); writeFileSync(this.walletRefreshStatusPath, JSON.stringify({ date, started_at: now.toISOString() }, null, 2)); this.walletRefreshRunning = true; this.logger.log("Starting daily GMGN + Fomo wallet-roster reshuffle…");
    try { await new Promise<void>(resolve => { this.walletRefreshProcess = spawn(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "wallet-scan.ts")], { cwd: ROOT, stdio: "inherit", env: process.env }); this.walletRefreshProcess.once("error", error => { this.logger.error("Daily wallet-roster refresh could not start", error.stack); resolve(); }); this.walletRefreshProcess.once("exit", code => { if (this.shuttingDown) { resolve(); return; } void this.runtime.tracker.refreshTrackedWalletsFromMongo().catch(error => this.logger.error("Could not reload MongoDB wallet roster", error instanceof Error ? error.stack : String(error))).finally(resolve); writeFileSync(this.walletRefreshStatusPath, JSON.stringify({ date, started_at: now.toISOString(), finished_at: new Date().toISOString(), exit_code: code }, null, 2)); if (code === 0) this.logger.log("Daily wallet-roster reshuffle complete."); else this.logger.error(`Daily wallet-roster refresh exited with code ${code}; any successfully refreshed partial roster will still be loaded.`); }); }); }
    finally { this.walletRefreshProcess = undefined; this.walletRefreshRunning = false; }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.fomoAbort?.abort();
    for(const timer of this.startupTimers)clearTimeout(timer);this.startupTimers.clear();
    for (const name of ["tracked-wallet-monitor", "dexscreener-discovery", "signal-scan", "multiple-monitor", "mongo-roster-reload", "wallet-refresh-check", "fomo-session-health"]) try { this.scheduler.deleteInterval(name); } catch { }
    this.walletRefreshProcess?.kill("SIGTERM");
    if (this.fomoSession) await this.fomoSession.close();
    await Promise.race([Promise.allSettled([...this.inFlight]), sleep(1500)]);
  }
}
