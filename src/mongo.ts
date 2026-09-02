import { MongoClient, ServerApiVersion, type Db } from "mongodb";
import type { Json } from "./types.js";

export class MongoState {
  constructor(
    readonly client: MongoClient,
    readonly db: Db,
  ) {}
  async close(): Promise<void> {
    await this.client.close();
  }
}

export async function initializeMongo(client: MongoClient, db: Db): Promise<MongoState> {
  await db.command({ ping: 1 });
  await Promise.all([
    db.collection("subscriptions").createIndex({ chat_id: 1, chain: 1 }, { unique: true }),
    db.collection("bot_admins").createIndex({ user_id: 1 }, { unique: true }),
    db.collection("admin_invites").createIndex({ token_hash: 1 }, { unique: true }),
    db.collection("admin_invites").createIndex({ expires_at: 1 }),
    db
      .collection("tracker_alerts")
      .createIndex({ scope: 1, token: 1, window_start: 1 }, { unique: true }),
    db.collection("tracker_alerts").createIndex({ scope: 1, created_at: -1 }),
    db.collection("trending_prices").createIndex({ scope: 1, token: 1, sampled_at: -1 }),
    db.collection("metric_samples").createIndex({ scope: 1, token: 1, metric: 1, sampled_at: -1 }),
    db.collection("call_performance").createIndex({ scope: 1, token: 1 }, { unique: true }),
    db.collection("discovery_decisions").createIndex({ scope: 1, token: 1 }, { unique: true }),
    db.collection("discovery_decisions").createIndex({ scope: 1, status: 1, last_detected_at: -1 }),
    db
      .collection("tracked_wallets")
      .createIndex({ source: 1, chain: 1, wallet: 1 }, { unique: true }),
    db.collection("scanner_leases").createIndex({ name: 1 }, { unique: true }),
    db.collection("scanner_leases").createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
  ]);
  return new MongoState(client, db);
}

export class DistributedLeaseRepository {
  constructor(private readonly mongo: MongoState) {}

  async acquire(name: string, ownerId: string, ttlMs: number): Promise<boolean> {
    const now = new Date(),
      expiresAt = new Date(now.getTime() + Math.max(60_000, ttlMs)),
      collection = this.mongo.db.collection<Json>("scanner_leases");
    try {
      const lease = await collection.findOneAndUpdate(
        {
          name,
          $or: [{ owner_id: ownerId }, { expires_at: { $lte: now } }],
        },
        {
          $set: { owner_id: ownerId, expires_at: expiresAt, updated_at: now },
          $setOnInsert: { name, created_at: now },
        },
        { upsert: true, returnDocument: "after" },
      );
      return lease?.owner_id === ownerId;
    } catch (error: any) {
      // Another process owns the unique lease name. The failed upsert is the
      // expected atomic loser path, not an operational error.
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  async release(name: string, ownerId: string): Promise<void> {
    await this.mongo.db.collection<Json>("scanner_leases").deleteOne({ name, owner_id: ownerId });
  }
}

export async function connectMongo(required = true): Promise<MongoState | undefined> {
  const uri = process.env.MONGODB_URI ?? process.env.MONGO_URL;
  if (!uri) {
    if (required)
      throw new Error("MONGODB_URI is required for durable bot and tracked-wallet state");
    return undefined;
  }
  const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: true },
    maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE ?? 10),
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE ?? "onchain_trading_bot");
  return initializeMongo(client, db);
}

export class TrackedWalletRepository {
  constructor(private readonly mongo: MongoState) {}
  async upsert(
    source: "gmgn" | "dexscreener" | "fomo",
    generatedAt: string,
    rows: Json[],
  ): Promise<void> {
    const collection = this.mongo.db.collection<Json>("tracked_wallets");
    const deduped = [
      ...new Map(
        rows
          .filter((row) => row.chain && row.wallet)
          .map((row) => [`${row.chain}:${String(row.wallet).toLowerCase()}`, row]),
      ).values(),
    ];
    if (!deduped.length) return;
    await collection.bulkWrite(
      deduped.map((row) => ({
        updateOne: {
          filter: { source, chain: row.chain, wallet: row.wallet },
          update: { $set: { ...row, source, generated_at: generatedAt, updated_at: new Date() } },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async replace(
    source: "gmgn" | "dexscreener" | "fomo",
    generatedAt: string,
    rows: Json[],
  ): Promise<void> {
    const collection = this.mongo.db.collection<Json>("tracked_wallets");
    await this.upsert(source, generatedAt, rows);
    await collection.deleteMany({ source, generated_at: { $ne: generatedAt } });
  }
  async loadAll(): Promise<Json[]> {
    return this.mongo.db.collection<Json>("tracked_wallets").find({}).toArray();
  }
}
