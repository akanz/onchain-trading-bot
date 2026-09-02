import assert from "node:assert/strict";
import test from "node:test";
import {
  GmgnCooldownError,
  GmgnRateGate,
  gmgnRequestWeight,
  parseRateLimitReset,
} from "../src/gmgn-rate-limit.js";

test("GMGN route weights match the documented leaky-bucket costs", () => {
  assert.equal(gmgnRequestWeight(["market", "trending"]), 1);
  assert.equal(gmgnRequestWeight(["market", "signal"]), 3);
  assert.equal(gmgnRequestWeight(["track", "follow-wallet"]), 3);
  assert.equal(gmgnRequestWeight(["track", "smartmoney"]), 1);
  assert.equal(gmgnRequestWeight(["token", "holders"]), 5);
  assert.equal(gmgnRequestWeight(["token", "info"]), 1);
  assert.equal(gmgnRequestWeight(["portfolio", "activity"]), 5);
});

test("GMGN reset parser understands body timestamps and CLI countdowns", () => {
  assert.equal(parseRateLimitReset('{"reset_at":1788003000}', 1000), 1788003000000);
  assert.equal(parseRateLimitReset("Rate limit resets soon (~39s remaining)", 1000), 40000);
});

test("weighted gate serializes bursts and waits for enough units", async () => {
  let now = 0;
  const waits: number[] = [];
  const gate = new GmgnRateGate({
    ratePerSecond: 10,
    capacity: 5,
    minimumIntervalMs: 0,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  const order: string[] = [];
  await Promise.all([
    gate.schedule(5, async () => {
      order.push("heavy");
    }),
    gate.schedule(1, async () => {
      order.push("light");
    }),
  ]);
  assert.deepEqual(order, ["heavy", "light"]);
  assert.deepEqual(waits, [100]);
});

test("the GMGN gate spaces requests even while burst tokens remain", async () => {
  let now = 0;
  const waits: number[] = [];
  const gate = new GmgnRateGate({
    ratePerSecond: 100,
    capacity: 20,
    minimumIntervalMs: 5000,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  await gate.schedule(1, async () => undefined);
  await gate.schedule(1, async () => undefined);
  assert.deepEqual(waits, [5000]);
});

test("a ban cancels already queued calls and blocks new calls without executing them", async () => {
  let now = 1000,
    calls = 0;
  const gate = new GmgnRateGate({
    ratePerSecond: 10,
    capacity: 5,
    minimumIntervalMs: 0,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const first = gate.schedule(1, async () => {
    calls++;
    gate.blockUntil(now + 30_000);
    throw new Error("429");
  });
  const queued = gate.schedule(1, async () => {
    calls++;
  });
  const results = await Promise.allSettled([first, queued]);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "rejected");
  assert.ok(results[1]?.status === "rejected" && results[1].reason instanceof GmgnCooldownError);
  assert.equal(calls, 1);
  assert.throws(() => gate.assertAvailable(), GmgnCooldownError);
});
