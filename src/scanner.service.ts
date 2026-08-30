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

@Injectable()
export class ScannerService implements OnApplicationBootstrap,OnApplicationShutdown {
  private readonly logger=new Logger(ScannerService.name);
  private readonly scanStatusPath=join(DATA_ROOT,".runtime","last-scan.json");
  private readonly walletRefreshStatusPath=join(DATA_ROOT,".runtime","last-wallet-refresh.json");
  private scanning=false;
  private walletRefreshRunning=false;
  private multipleMonitoring=false;
  private rosterReloading=false;
  private walletRefreshProcess:ChildProcess|undefined;
  private lastWalletRefreshDate="";
  private announcedCooldown=0;
  private fomoSession?:FomoSessionBridge|null;

  constructor(@Inject(RuntimeService) private readonly runtime:RuntimeService,@Inject(TelegramService) private readonly telegram:TelegramService,@Inject(AlertStream) private readonly stream:AlertStream,@Inject(SchedulerRegistry) private readonly scheduler:SchedulerRegistry){try{this.lastWalletRefreshDate=String(JSON.parse(readFileSync(this.walletRefreshStatusPath,"utf8")).date??"");}catch{}}

  async onApplicationBootstrap():Promise<void>{
    if(process.env.SCANNER_ENABLED==="false"){this.logger.warn("Scanner scheduling is disabled by SCANNER_ENABLED=false.");return;}
    this.fomoSession=await startFomoSessionBridge();
    this.addInterval("signal-scan",Math.max(Number(process.env.SCAN_INTERVAL_MS??300000),30000),()=>void this.scanAndPublish());
    this.addInterval("multiple-monitor",Math.max(5000,Number(process.env.MULTIPLE_MONITOR_POLL_MS??15000)),()=>void this.pollTriggeredMultiples());
    this.addInterval("mongo-roster-reload",Math.max(60000,Number(process.env.MONGO_ROSTER_RELOAD_MS??300000)),()=>void this.reloadMongoRoster());
    this.addInterval("wallet-refresh-check",60000,()=>void this.walletRefreshCheck());
    void this.scanAndPublish();void this.walletRefreshCheck();
  }

  private addInterval(name:string,milliseconds:number,handler:()=>void):void {const timer=setInterval(handler,milliseconds);timer.unref();this.scheduler.addInterval(name,timer);}
  private saveScanStatus(status:Record<string,unknown>):void {mkdirSync(join(DATA_ROOT,".runtime"),{recursive:true});writeFileSync(this.scanStatusPath,JSON.stringify(status,null,2));}
  private mergeDelivery(target:DeliveryResult,next:DeliveryResult):void {target.attempted+=next.attempted;target.sent+=next.sent;target.failed+=next.failed;}

  private async publishMultipleAlerts(alerts:Alert[]):Promise<DeliveryResult>{
    const delivery:DeliveryResult={attempted:0,sent:0,failed:0};
    for(const alert of alerts){this.stream.publishAlert(alert);const result=await this.telegram.alert(alert);this.mergeDelivery(delivery,result);if(result.sent>0)this.runtime.tracker.acknowledgeCallMultiple(alert);}
    return delivery;
  }

  async scanAndPublish():Promise<void>{
    if(this.scanning||this.walletRefreshRunning||this.multipleMonitoring)return;
    const {tracker,botStore}=this.runtime,cooldownUntil=tracker.gmgn.cooldownUntil;
    if(cooldownUntil){if(cooldownUntil!==this.announcedCooldown){this.announcedCooldown=cooldownUntil;this.logger.warn(`GMGN-dependent scans are paused until ${new Date(cooldownUntil).toLocaleString()}; Fomo wallet polling continues, but token alerts remain blocked until GMGN safety checks pass.`);}}
    else this.announcedCooldown=0;this.scanning=true;
    try {
      const alerts:Alert[]=[],completedChains:Chain[]=[];
      for(const chain of this.runtime.scheduledChains)try{alerts.push(...await tracker.scan(chain));completedChains.push(chain);}catch(error){if(isRateLimit(error))throw error;this.logger.error(`${chain} scheduled scan failed: ${String(error)}`);}
      const deliverable=alerts.filter(isDeliverableAlert),alertDelivery:DeliveryResult={attempted:0,sent:0,failed:0};
      for(const alert of deliverable){this.stream.publishAlert(alert);this.mergeDelivery(alertDelivery,await this.telegram.alert(alert));}
      const gmgnAvailable=!tracker.gmgn.cooldownUntil,trending=gmgnAvailable&&completedChains.length?await tracker.latestTrendingAcross(completedChains,Number(process.env.TRENDING_DIGEST_LIMIT??10)):[],rankedDegen=gmgnAvailable&&process.env.DEGEN_MODE==="true"&&completedChains.length?tracker.latestDegenAcross(completedChains,Number(process.env.DEGEN_DIGEST_LIMIT??20)):[],degen=rankedDegen.length?await tracker.enrichDegenRows(rankedDegen):[],multipleAlerts=gmgnAvailable&&completedChains.length?await tracker.monitorCallMultiples(completedChains,[...trending,...degen]):[];
      const multipleDelivery=await this.publishMultipleAlerts(multipleAlerts),trendingDelivery=gmgnAvailable&&completedChains.length&&trending.length?await this.telegram.trending(completedChains,trending):{attempted:0,sent:0,failed:0},degenDelivery=gmgnAvailable&&process.env.DEGEN_MODE==="true"&&completedChains.length?await this.telegram.degen(completedChains,degen):{attempted:0,sent:0,failed:0};if(trendingDelivery.sent>0)tracker.acknowledgeTrending(trending);
      this.saveScanStatus({scanned_at:new Date().toISOString(),completed_chains:completedChains,diagnostics:tracker.diagnostics(completedChains),trending_contracts:trending.map(row=>this.trendingStatus(row)),degen_contracts:degen.map(row=>this.degenStatus(row)),multiple_alerts:multipleAlerts.map(alert=>({chain:alert.chain,address:alert.address,symbol:alert.symbol,milestone:alert.milestone,multiple:alert.multiple,age_seconds:alert.age_seconds})),alerts:deliverable.map(alert=>({chain:alert.chain,address:alert.address,symbol:alert.symbol,tier:alert.tier,kind:alert.kind,tracking_label:alert.tracking_label,traders:alert.traders,market_cap_at_detection:alert.market_cap_at_detection})),subscribed_chats:botStore.subscriptionCount(),telegram:{enabled:this.telegram.enabled,trending:trendingDelivery,degen:degenDelivery,multiples:multipleDelivery,alerts:alertDelivery}});
      this.stream.publishScan({scannedAt:new Date().toISOString(),found:deliverable.length+multipleAlerts.length});
    } catch(error){this.saveScanStatus({scanned_at:new Date().toISOString(),error:String(error),subscribed_chats:botStore.subscriptionCount()});this.logger.error("Scheduled scan failed",error instanceof Error?error.stack:String(error));}
    finally{this.scanning=false;}
  }

  private trendingStatus(row:Json):Json{return {chain:row.chain,address:row.address,symbol:row.symbol,quality_passed:row.quality_passed,multiwindow_passed:row.multiwindow_passed,multiwindow_grade:row.multiwindow_grade,multiwindow_score:row.multiwindow_score,pattern:row.pattern,market_cap:row.market_cap,liquidity:row.liquidity,volume_5m:row.volume_5m??row.volume,volume_15m:row.volume_15m,volume_30m:row.volume_30m,volume_1h:row.volume_1h,price_change_5m:row.price_change_5m,price_change_15m:row.price_change_15m,price_change_30m:row.price_change_30m,price_change_1h:row.price_change_1h,drawdown_1h_percent:row.drawdown_1h_percent};}
  private degenStatus(row:Json):Json{return {chain:row.chain,address:row.address,symbol:row.symbol,market_cap:row.market_cap,liquidity:row.liquidity,volume_5m:row.volume,price_change_5m:row.price_change_5m??row.price_change_percent5m??row.price_change_percent,price_change_30m:row.price_change_30m,pons_status:row.pons_status,graduation_progress_percent:row.graduation_progress_percent,progress_change_30m:row.progress_change_30m,sources:row.degen_sources,failed_gates:row.quality_reasons};}

  private async pollTriggeredMultiples():Promise<void>{
    const tracker=this.runtime.tracker;if(process.env.MULTIPLE_MONITOR_ENABLED==="false"||this.scanning||this.walletRefreshRunning||this.multipleMonitoring||tracker.gmgn.cooldownUntil)return;this.multipleMonitoring=true;
    try {const alerts=await tracker.monitorTriggeredCallMultiples(this.runtime.scheduledChains);if(alerts.length){const delivery=await this.publishMultipleAlerts(alerts);this.logger.log(`Multiplier monitor: ${alerts.length} milestone(s), ${delivery.sent} Telegram delivery/deliveries.`);}}
    catch(error){if(isRateLimit(error))this.logger.warn(`Real-time multiplier monitor paused until ${tracker.gmgn.cooldownUntil?new Date(tracker.gmgn.cooldownUntil).toLocaleString():"the GMGN cooldown ends"}.`);else this.logger.error("Real-time multiplier monitor failed",error instanceof Error?error.stack:String(error));}
    finally{this.multipleMonitoring=false;}
  }

  private async reloadMongoRoster():Promise<void>{
    if(this.rosterReloading)return;this.rosterReloading=true;
    try{await this.runtime.tracker.refreshTrackedWalletsFromMongo();}
    catch(error){this.logger.error("Could not reload the tracked-wallet roster from MongoDB",error instanceof Error?error.stack:String(error));}
    finally{this.rosterReloading=false;}
  }

  private async walletRefreshCheck():Promise<void>{
    if(process.env.DAILY_WALLET_REFRESH_ENABLED==="false"||this.scanning||this.walletRefreshRunning||this.multipleMonitoring)return;
    const now=new Date(),hour=Math.min(23,Math.max(0,Number(process.env.DAILY_WALLET_REFRESH_HOUR_LOCAL??3))),date=`${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;if(now.getHours()!==hour||this.lastWalletRefreshDate===date)return;
    this.lastWalletRefreshDate=date;mkdirSync(join(DATA_ROOT,".runtime"),{recursive:true});writeFileSync(this.walletRefreshStatusPath,JSON.stringify({date,started_at:now.toISOString()},null,2));this.walletRefreshRunning=true;this.logger.log("Starting daily GMGN + Fomo wallet-roster reshuffle…");
    try {await new Promise<void>(resolve=>{this.walletRefreshProcess=spawn(process.execPath,["--import","tsx",join(ROOT,"scripts","wallet-scan.ts")],{cwd:ROOT,stdio:"inherit",env:process.env});this.walletRefreshProcess.once("error",error=>{this.logger.error("Daily wallet-roster refresh could not start",error.stack);resolve();});this.walletRefreshProcess.once("exit",code=>{void this.runtime.tracker.refreshTrackedWalletsFromMongo().catch(error=>this.logger.error("Could not reload MongoDB wallet roster",error instanceof Error?error.stack:String(error))).finally(resolve);writeFileSync(this.walletRefreshStatusPath,JSON.stringify({date,started_at:now.toISOString(),finished_at:new Date().toISOString(),exit_code:code},null,2));if(code===0)this.logger.log("Daily wallet-roster reshuffle complete.");else this.logger.error(`Daily wallet-roster refresh exited with code ${code}; any successfully refreshed partial roster will still be loaded.`);});});}
    finally{this.walletRefreshProcess=undefined;this.walletRefreshRunning=false;}
  }

  async onApplicationShutdown():Promise<void>{for(const name of ["signal-scan","multiple-monitor","mongo-roster-reload","wallet-refresh-check"])try{this.scheduler.deleteInterval(name);}catch{}this.walletRefreshProcess?.kill("SIGTERM");if(this.fomoSession)await this.fomoSession.close();}
}
