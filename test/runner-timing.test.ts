import assert from "node:assert/strict";
import test from "node:test";
import { detectRunnerMove, enteredBeforeMove } from "../src/runner-timing.js";

test("detects the first volume-confirmed minute pump", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({
    time: 1_000 + index * 60,
    open: index === 6 ? 1 : 1,
    close: index === 6 ? 1.25 : 1,
    volume: index === 6 ? 500 : 100,
  }));
  const move = detectRunnerMove(rows);
  assert.equal(move?.started_at, 1_360);
  assert.equal(Math.round(move?.candle_change_percent ?? 0), 25);
  assert.equal(Math.round(move?.volume_ratio ?? 0), 5);
});
test("ignores price jumps without abnormal volume", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    time: 1_000 + index * 60,
    open: 1,
    close: index === 6 ? 1.5 : 1,
    volume: 100,
  }));
  assert.equal(detectRunnerMove(rows), undefined);
});
test("counts only entries shortly before the move", () => {
  assert.equal(enteredBeforeMove({ start_holding_at: 9_500 }, 10_000, 1_000), true);
  assert.equal(enteredBeforeMove({ start_holding_at: 8_000 }, 10_000, 1_000), false);
  assert.equal(enteredBeforeMove({ start_holding_at: 10_001 }, 10_000, 1_000), false);
});
