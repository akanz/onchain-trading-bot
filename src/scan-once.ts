import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { Bot } from "grammy";
import { loadConfig, ROOT } from "./config.js";
import { TrackerService } from "./service.js";
import { BotStore } from "./store.js";
import { isDeliverableAlert } from "./alert-stream.js";
import { broadcast } from "./telegram.js";
import { connectMongo, DistributedLeaseRepository } from "./mongo.js";

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) loadEnvFile(envPath);
const config = loadConfig(),
  mongo = await connectMongo();
if (!mongo) throw new Error("MONGODB_URI is required for a one-shot signal scan");
const leaseOwnerId = `signal-scan:${process.pid}:${randomUUID()}`,
  leaseRepository = new DistributedLeaseRepository(mongo),
  leaseEnabled = process.env.GMGN_DISTRIBUTED_LEASE_ENABLED !== "false",
  leaseAcquired = leaseEnabled
    ? await leaseRepository.acquire(
        process.env.GMGN_SCANNER_LEASE_NAME ?? "gmgn-background-scanner",
        leaseOwnerId,
        Number(process.env.GMGN_SCANNER_LEASE_TTL_MS ?? 300_000),
      )
    : true;
if (!leaseAcquired) {
  console.log("One-shot signal scan deferred because the always-on bot owns the shared lease.");
  await mongo.close();
  process.exit(0);
}
const leaseHeartbeat = leaseEnabled
  ? setInterval(
      () =>
        void leaseRepository.acquire(
          process.env.GMGN_SCANNER_LEASE_NAME ?? "gmgn-background-scanner",
          leaseOwnerId,
          Number(process.env.GMGN_SCANNER_LEASE_TTL_MS ?? 300_000),
        ),
      60_000,
    )
  : undefined;
leaseHeartbeat?.unref();
const service = new TrackerService(config, undefined, undefined, undefined, mongo),
  store = new BotStore(mongo);
await Promise.all([service.init(), store.init()]);
const alerts = await service.scanAll(),
  deliverable = alerts.filter(isDeliverableAlert),
  token = process.env.TELEGRAM_BOT_TOKEN;
if (!token)
  console.warn("TELEGRAM_BOT_TOKEN is unset; scan completed but Telegram delivery is disabled.");
else if (!store.subscriptionCount())
  console.warn("No Telegram chats are subscribed. Open the bot and run /start once.");
else {
  const bot = new Bot(token);
  for (const alert of deliverable) await broadcast(bot, store, alert);
}
console.log(
  JSON.stringify({
    scanned_at: new Date().toISOString(),
    results: alerts.length,
    delivered_candidates: deliverable.length,
    subscribed_chats: store.subscriptionCount(),
  }),
);
await Promise.all([service.close(), store.close()]);
if (leaseHeartbeat) clearInterval(leaseHeartbeat);
if (leaseEnabled)
  await leaseRepository.release(
    process.env.GMGN_SCANNER_LEASE_NAME ?? "gmgn-background-scanner",
    leaseOwnerId,
  );
await mongo.close();
