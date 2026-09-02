import assert from "node:assert/strict";
import test from "node:test";
import { DistributedLeaseRepository } from "../src/mongo.js";

test("a Mongo scanner lease admits only one owner until release", async () => {
  let lease: Record<string, any> | undefined;
  const collection = {
      async findOneAndUpdate(filter: any, update: any) {
        const owner = filter.$or[0].owner_id,
          expired = !lease || lease.expires_at <= filter.$or[1].expires_at.$lte,
          sameOwner = lease?.owner_id === owner;
        if (lease && !expired && !sameOwner) {
          const error: any = new Error("duplicate lease");
          error.code = 11000;
          throw error;
        }
        lease = { ...lease, ...update.$setOnInsert, ...update.$set };
        return lease;
      },
      async deleteOne(filter: any) {
        if (lease?.name === filter.name && lease?.owner_id === filter.owner_id) lease = undefined;
      },
    },
    mongo = { db: { collection: () => collection } } as any,
    repository = new DistributedLeaseRepository(mongo);

  assert.equal(await repository.acquire("gmgn", "railway", 300_000), true);
  assert.equal(await repository.acquire("gmgn", "local", 300_000), false);
  await repository.release("gmgn", "local");
  assert.equal(await repository.acquire("gmgn", "local", 300_000), false);
  await repository.release("gmgn", "railway");
  assert.equal(await repository.acquire("gmgn", "local", 300_000), true);
});
