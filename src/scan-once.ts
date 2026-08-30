import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { Bot } from "grammy";
import { loadConfig, ROOT } from "./config.js";
import { TrackerService } from "./service.js";
import { BotStore } from "./store.js";
import { isDeliverableAlert } from "./alert-stream.js";
import { broadcast } from "./telegram.js";
import { connectMongo } from "./mongo.js";

const envPath=join(ROOT,".env");if(existsSync(envPath))loadEnvFile(envPath);
const config=loadConfig(),mongo=await connectMongo(),service=new TrackerService(config,undefined,undefined,undefined,undefined,mongo),store=new BotStore(mongo);await Promise.all([service.init(),store.init()]);
if(service.fomo.expiresAt&&service.fomo.expiresAt-Date.now()/1000<1800)console.warn(`FOMO_TOKEN expires at ${new Date(service.fomo.expiresAt*1000).toISOString()}; refresh it for uninterrupted Fomo tracking.`);
const alerts=await service.scanAll(),deliverable=alerts.filter(isDeliverableAlert),token=process.env.TELEGRAM_BOT_TOKEN;
if(!token)console.warn("TELEGRAM_BOT_TOKEN is unset; scan completed but Telegram delivery is disabled.");
else if(!store.subscriptionCount())console.warn("No Telegram chats are subscribed. Open the bot and run /start once.");
else {const bot=new Bot(token);for(const alert of deliverable)await broadcast(bot,store,alert);}
console.log(JSON.stringify({scanned_at:new Date().toISOString(),results:alerts.length,delivered_candidates:deliverable.length,subscribed_chats:store.subscriptionCount()}));
await Promise.all([service.close(),store.close()]);await mongo?.close();
