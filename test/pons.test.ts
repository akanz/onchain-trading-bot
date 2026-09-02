import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePonsLaunch,
  ponsKlineChanges,
  qualifyPonsDegen,
  selectPonsProbeRows,
} from "../src/pons/analysis.js";
import { TrackerStore } from "../src/store.js";

const now = 2_000_000,
  address = "0x1111111111111111111111111111111111111111";
test("normalizes Pons active and graduated launch fields", () => {
  const row = normalizePonsLaunch(
    {
      token: address,
      name: "Launch",
      symbol: "NEW",
      marketCapUsd: 5000,
      priceUsd: 0.000005,
      graduated: false,
      graduationProgressPct: 60,
      launchedAt: new Date((now - 600) * 1000).toISOString(),
      latestBuyAt: new Date((now - 60) * 1000).toISOString(),
      quoteAsset: { symbol: "ETH", assetClass: "native" },
    },
    now,
  )!;
  assert.equal(row.chain, "robinhood");
  assert.equal(row.pons_status, "ACTIVE");
  assert.equal(row.graduation_progress_percent, 60);
  assert.equal(row.latest_buy_age_seconds, 60);
});
test("detects Pons price surges and distinguishes graduation states", () => {
  const active = normalizePonsLaunch(
    {
      token: address,
      marketCapUsd: 8000,
      priceUsd: 0.000008,
      graduated: false,
      graduationProgressPct: 55,
      launchedAt: new Date((now - 600) * 1000).toISOString(),
      latestBuyAt: new Date((now - 60) * 1000).toISOString(),
    },
    now,
  )!;
  const result = qualifyPonsDegen(active, {
    price_change_5m: 40,
    price_change_30m: 120,
    progress_change_30m: 8,
  })!;
  assert.ok(result.degen_signal_labels.includes("PONS PRICE SURGE"));
  assert.ok(result.degen_signal_labels.includes("PONS PROGRESS SURGE"));
  assert.ok(result.degen_signal_labels.includes("NEAR GRADUATION"));
});
test("computes Pons momentum from GMGN candles", () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({
      time: (now - 1800 + index * 300) * 1000,
      open: 1,
      close: index === 6 ? 2 : 1,
    })),
    changes = ponsKlineChanges(rows);
  assert.equal(Math.round(changes.price_change_30m ?? 0), 100);
});
test("Pons probe selection prioritizes fresh graduated and active launches", () => {
  const active = [
      {
        token: address,
        marketCapUsd: 5000,
        graduated: false,
        launchedAt: new Date((now - 60) * 1000).toISOString(),
        latestBuyAt: new Date((now - 30) * 1000).toISOString(),
      },
    ],
    graduated = [
      {
        token: "0x2222222222222222222222222222222222222222",
        marketCapUsd: 10000,
        graduated: true,
        launchedAt: new Date((now - 5000) * 1000).toISOString(),
        graduatedAt: new Date((now - 10) * 1000).toISOString(),
      },
    ];
  assert.equal(selectPonsProbeRows(active, graduated, 1, now)[0]?.pons_status, "GRADUATED");
});
test("stores Pons progress snapshots and measures a 30-minute point change", () => {
  const store = new TrackerStore(":memory:");
  try {
    store.recordMetric(address, "pons_graduation_progress", 40, now - 1800);
    assert.equal(store.metricDelta(address, "pons_graduation_progress", 48, 1800, now), 8);
  } finally {
    store.close();
  }
});
