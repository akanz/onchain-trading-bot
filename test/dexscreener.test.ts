import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDexScreenerPairs, qualifyDexScreenerPairs } from "../src/dexscreener/analysis.js";
import { DexScreenerClient } from "../src/dexscreener/client.js";

const address = "0x1111111111111111111111111111111111111111",
  now = 2_000_000;
const pair = (overrides: Record<string, unknown> = {}) => ({
  chainId: "robinhood",
  dexId: "uniswap",
  pairAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  url: "https://dexscreener.com/robinhood/pair",
  baseToken: { address, name: "Runner", symbol: "RUN" },
  quoteToken: { address: "0x2222222222222222222222222222222222222222", symbol: "WETH" },
  priceUsd: "0.02",
  pairCreatedAt: (now - 300) * 1000,
  marketCap: 20000,
  fdv: 20000,
  liquidity: { usd: 8000 },
  volume: { m5: 12000 },
  txns: { m5: { buys: 18, sells: 6 } },
  priceChange: { m5: 20 },
  ...overrides,
});

test("DexScreener client discovers Robinhood profiles and boosts through documented REST endpoints", async () => {
  const requested: string[] = [],
    client = new DexScreenerClient(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes("token-profiles"))
        return new Response(JSON.stringify([{ chainId: "robinhood", tokenAddress: address }]), {
          headers: { "content-type": "application/json" },
        });
      if (url.includes("token-boosts"))
        return new Response(JSON.stringify([{ chainId: "robinhood", tokenAddress: address }]), {
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/search"))
        return new Response(JSON.stringify({ pairs: [pair()] }), {
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify([pair()]), {
        headers: { "content-type": "application/json" },
      });
    });
  const snapshot = await client.discover("robinhood");
  assert.equal(snapshot.discovered, 1);
  assert.equal(snapshot.pairs.length, 1);
  assert.ok(snapshot.pairs[0]?.dexscreener_discovery_sources.includes("DEXSCREENER PROFILE"));
  assert.ok(snapshot.pairs[0]?.dexscreener_discovery_sources.includes("DEXSCREENER BOOST"));
  assert.ok(
    snapshot.pairs[0]?.dexscreener_discovery_sources.some((source: string) =>
      source.startsWith("DEXSCREENER SEARCH"),
    ),
  );
  assert.ok(requested.some((url) => url.includes("/latest/dex/search?q=")));
  assert.ok(requested.some((url) => url.includes(`/tokens/v1/robinhood/${address}`)));
});

test("DexScreener pairs are consolidated by token and qualify on real price/volume activity", () => {
  const second = pair({
      pairAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      liquidity: { usd: 2000 },
      volume: { m5: 3000 },
      txns: { m5: { buys: 2, sells: 1 } },
      dexscreener_discovery_sources: ["DEXSCREENER BOOST"],
    }),
    rows = normalizeDexScreenerPairs(
      "robinhood",
      [{ ...pair(), dexscreener_discovery_sources: ["DEXSCREENER PROFILE"] }, second],
      now,
    );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.dexscreener_pair_count, 2);
  assert.equal(rows[0]?.liquidity, 10000);
  assert.equal(rows[0]?.volume_5m, 15000);
  assert.ok(rows[0]?.degen_signal_labels.includes("DEXSCREENER PRICE SURGE"));
  assert.ok(rows[0]?.degen_signal_labels.includes("DEXSCREENER NEW PAIR"));
  assert.equal(qualifyDexScreenerPairs("robinhood", [pair()], now).length, 1);
});
