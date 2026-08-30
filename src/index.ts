import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { join } from "node:path";
import { DATA_ROOT, loadConfig, ROOT } from "./config.js";
import { TrackerService } from "./service.js";
import { BotStore } from "./store.js";
import { createTelegramBot, broadcast, broadcastDegen, broadcastTrending } from "./telegram.js";
import { createServer } from "./server.js";
import { AlertStream, isDeliverableAlert } from "./alert-stream.js";
import { isRateLimit } from "./gmgn.js";
import type { Alert, Chain } from "./types.js";
import { startFomoSessionBridge } from "./fomo/session.js";
import { spawn, type ChildProcess } from "node:child_process";
import { connectMongo } from "./mongo.js";

const envPath=join(ROOT,".env"); if(existsSync(envPath))loadEnvFile(envPath);
const config=loadConfig(),mongo=await connectMongo(),service=new TrackerService(config,undefined,undefined,undefined,undefined,mongo),botStore=new BotStore(mongo),stream=new AlertStream();
await Promise.all([service.init(),botStore.init()]);
const scheduledNames=new Set((process.env.SCHEDULED_CHAINS??"sol,bsc,robinhood").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
const scheduledChains=config.enabled_chains.filter(chain=>scheduledNames.has(chain));
if(!scheduledChains.length)throw new Error("SCHEDULED_CHAINS does not contain any enabled chain");
const app=createServer(service,config,stream), port=Number(process.env.PORT??3000), host=process.env.HOST??"127.0.0.1";
await app.listen({port,host});
const fomoSession=await startFomoSessionBridge();

const token=process.env.TELEGRAM_BOT_TOKEN;
const bot=token?createTelegramBot(token,service,config,botStore):undefined;
if(!bot) console.warn("TELEGRAM_BOT_TOKEN is unset; SSE remains active but Telegram polling is disabled.");
else {
  bot.start({onStart:info=>console.log(`Telegram bot @${info.username} started`)});
}

const interval=Math.max(Number(process.env.SCAN_INTERVAL_MS??300000),30000);
const scanStatusPath=join(DATA_ROOT,".runtime","last-scan.json");
const saveScanStatus=(status:Record<string,unknown>)=>{mkdirSync(join(DATA_ROOT,".runtime"),{recursive:true});writeFileSync(scanStatusPath,JSON.stringify(status,null,2));};
let scanning=false;
const walletRefreshStatusPath=join(DATA_ROOT,".runtime","last-wallet-refresh.json");
let walletRefreshRunning=false,multipleMonitoring=false,walletRefreshProcess:ChildProcess|undefined,lastWalletRefreshDate="";
try{lastWalletRefreshDate=String(JSON.parse(readFileSync(walletRefreshStatusPath,"utf8")).date??"");}catch{}
let announcedCooldown=0;
const publishMultipleAlerts=async(alerts:Alert[])=>{
  const delivery={attempted:0,sent:0,failed:0};
  for(const alert of alerts){
    stream.publishAlert(alert);
    if(!bot)continue;
    const result=await broadcast(bot,botStore,alert);
    delivery.attempted+=result.attempted;delivery.sent+=result.sent;delivery.failed+=result.failed;
    if(result.sent>0)service.acknowledgeCallMultiple(alert);
  }
  return delivery;
};
const scanAndPublish=async()=>{
  if(scanning||walletRefreshRunning||multipleMonitoring)return;
  const cooldownUntil=service.gmgn.cooldownUntil;
  if(cooldownUntil){if(cooldownUntil!==announcedCooldown){announcedCooldown=cooldownUntil;console.warn(`GMGN scans paused until ${new Date(cooldownUntil).toLocaleString()} to avoid extending the rate-limit ban.`);}return;}
  announcedCooldown=0;
  scanning=true;
  try {
    const alerts:Alert[]=[],completedChains:Chain[]=[];
    for(const chain of scheduledChains)try{alerts.push(...await service.scan(chain));completedChains.push(chain);}catch(error){if(isRateLimit(error))throw error;console.error(`${chain} scheduled scan failed`,String(error));}
    const deliverable=alerts.filter(isDeliverableAlert),trending=completedChains.length?await service.latestTrendingAcross(completedChains,Number(process.env.TRENDING_DIGEST_LIMIT??10)):[],rankedDegen=process.env.DEGEN_MODE==="true"&&completedChains.length?service.latestDegenAcross(completedChains,Number(process.env.DEGEN_DIGEST_LIMIT??20)):[],degen=rankedDegen.length?await service.enrichDegenRows(rankedDegen):[],multipleAlerts=completedChains.length?await service.monitorCallMultiples(completedChains,[...trending,...degen]):[];
    const multipleDelivery=await publishMultipleAlerts(multipleAlerts);
    const trendingDelivery=bot&&completedChains.length?await broadcastTrending(bot,botStore,completedChains,trending):{attempted:0,sent:0,failed:0},degenDelivery=bot&&process.env.DEGEN_MODE==="true"&&completedChains.length?await broadcastDegen(bot,botStore,completedChains,degen):{attempted:0,sent:0,failed:0},alertDelivery={attempted:0,sent:0,failed:0};
    for(const alert of deliverable){stream.publishAlert(alert);if(bot){const result=await broadcast(bot,botStore,alert);alertDelivery.attempted+=result.attempted;alertDelivery.sent+=result.sent;alertDelivery.failed+=result.failed;}}
    saveScanStatus({scanned_at:new Date().toISOString(),completed_chains:completedChains,diagnostics:service.diagnostics(completedChains),trending_contracts:trending.map(row=>({chain:row.chain,address:row.address,symbol:row.symbol,quality_passed:row.quality_passed,multiwindow_passed:row.multiwindow_passed,multiwindow_grade:row.multiwindow_grade,multiwindow_score:row.multiwindow_score,pattern:row.pattern,market_cap:row.market_cap,liquidity:row.liquidity,volume_5m:row.volume_5m??row.volume,volume_15m:row.volume_15m,volume_30m:row.volume_30m,volume_1h:row.volume_1h,price_change_5m:row.price_change_5m,price_change_15m:row.price_change_15m,price_change_30m:row.price_change_30m,price_change_1h:row.price_change_1h,drawdown_1h_percent:row.drawdown_1h_percent})),degen_contracts:degen.map(row=>({chain:row.chain,address:row.address,symbol:row.symbol,market_cap:row.market_cap,liquidity:row.liquidity,volume_5m:row.volume,price_change_5m:row.price_change_5m??row.price_change_percent5m??row.price_change_percent,price_change_30m:row.price_change_30m,pons_status:row.pons_status,graduation_progress_percent:row.graduation_progress_percent,progress_change_30m:row.progress_change_30m,sources:row.degen_sources,failed_gates:row.quality_reasons})),multiple_alerts:multipleAlerts.map(alert=>({chain:alert.chain,address:alert.address,symbol:alert.symbol,milestone:alert.milestone,multiple:alert.multiple,age_seconds:alert.age_seconds})),alerts:deliverable.map(alert=>({chain:alert.chain,address:alert.address,tier:alert.tier,kind:alert.kind})),subscribed_chats:botStore.subscriptionCount(),telegram:{enabled:Boolean(bot),trending:trendingDelivery,degen:degenDelivery,multiples:multipleDelivery,alerts:alertDelivery}});
    stream.publishScan({scannedAt:new Date().toISOString(),found:deliverable.length+multipleAlerts.length});
  } catch(e){saveScanStatus({scanned_at:new Date().toISOString(),error:String(e),subscribed_chats:botStore.subscriptionCount()});console.error("Scheduled scan failed",e);}
  finally{scanning=false;}
};
void scanAndPublish();
const timer=setInterval(()=>void scanAndPublish(),interval); timer.unref();
const multiplePollInterval=Math.max(5000,Number(process.env.MULTIPLE_MONITOR_POLL_MS??15000));
const pollTriggeredMultiples=async()=>{
  if(process.env.MULTIPLE_MONITOR_ENABLED==="false"||scanning||walletRefreshRunning||multipleMonitoring||service.gmgn.cooldownUntil)return;
  multipleMonitoring=true;
  try {
    const alerts=await service.monitorTriggeredCallMultiples(scheduledChains);
    if(alerts.length){const delivery=await publishMultipleAlerts(alerts);console.log(`Multiplier monitor: ${alerts.length} milestone(s), ${delivery.sent} Telegram delivery/deliveries.`);}
  } catch(error) {
    if(isRateLimit(error))console.warn(`Real-time multiplier monitor paused until ${service.gmgn.cooldownUntil?new Date(service.gmgn.cooldownUntil).toLocaleString():"the GMGN cooldown ends"}.`);
    else console.error("Real-time multiplier monitor failed",error);
  } finally { multipleMonitoring=false; }
};
const multipleTimer=setInterval(()=>void pollTriggeredMultiples(),multiplePollInterval);multipleTimer.unref();
const walletRefreshCheck=async()=>{
  if(process.env.DAILY_WALLET_REFRESH_ENABLED==="false"||scanning||walletRefreshRunning||multipleMonitoring)return;
  const now=new Date(),hour=Math.min(23,Math.max(0,Number(process.env.DAILY_WALLET_REFRESH_HOUR_LOCAL??3))),date=`${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;if(now.getHours()!==hour||lastWalletRefreshDate===date)return;
  lastWalletRefreshDate=date;mkdirSync(join(DATA_ROOT,".runtime"),{recursive:true});writeFileSync(walletRefreshStatusPath,JSON.stringify({date,started_at:now.toISOString()},null,2));walletRefreshRunning=true;console.log("Starting daily GMGN + Fomo wallet-roster reshuffle…");
  try{await new Promise<void>(resolve=>{walletRefreshProcess=spawn(process.execPath,["--import","tsx",join(ROOT,"scripts","wallet-scan.ts")],{cwd:ROOT,stdio:"inherit",env:process.env});walletRefreshProcess.once("error",error=>{console.error("Daily wallet-roster refresh could not start",error);resolve();});walletRefreshProcess.once("exit",code=>{void service.refreshTrackedWalletsFromMongo().catch(error=>console.error("Could not reload MongoDB wallet roster",error)).finally(()=>resolve());writeFileSync(walletRefreshStatusPath,JSON.stringify({date,started_at:now.toISOString(),finished_at:new Date().toISOString(),exit_code:code},null,2));if(code===0)console.log("Daily wallet-roster reshuffle complete.");else console.error(`Daily wallet-roster refresh exited with code ${code}; any successfully refreshed partial roster will still be loaded.`);});});}finally{walletRefreshProcess=undefined;walletRefreshRunning=false;}
};
const walletRefreshTimer=setInterval(()=>void walletRefreshCheck(),60000);walletRefreshTimer.unref();void walletRefreshCheck();
const stop=async()=>{clearInterval(timer);clearInterval(multipleTimer);clearInterval(walletRefreshTimer);walletRefreshProcess?.kill("SIGTERM");if(bot)await bot.stop();if(fomoSession)await fomoSession.close();await app.close();await Promise.all([service.close(),botStore.close()]);await mongo?.close();};
process.once("SIGINT",stop);process.once("SIGTERM",stop);
