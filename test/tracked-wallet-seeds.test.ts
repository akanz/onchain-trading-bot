import assert from "node:assert/strict";
import test from "node:test";
import { parseTrackedWalletSeeds } from "../src/tracked-wallet-seeds.js";

const wallet = "0x1111111111111111111111111111111111111111";

test("tracked-wallet seeds preserve separate Fomo and GMGN identities", () => {
  const rows = parseTrackedWalletSeeds({ wallets: [
    { chain: "robinhood", wallet: wallet.toUpperCase().replace("0X", "0x"), source: "gmgn", qualifying_positions: [] },
    { chain: "robinhood", wallet, source: "fomo", fomo_user_id: "profile-1", fomo_handle: "trader", qualifying_positions: [] },
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.wallet, wallet);
  assert.equal(rows[1]?.fomo_handle, "trader");
});

test("tracked-wallet seeds reject duplicate source wallets", () => {
  assert.throws(() => parseTrackedWalletSeeds({ wallets: [
    { chain: "robinhood", wallet, source: "gmgn" },
    { chain: "robinhood", wallet, source: "gmgn" },
  ] }), /duplicates/);
});

test("tracked Fomo seeds require a profile id", () => {
  assert.throws(() => parseTrackedWalletSeeds({ wallets: [
    { chain: "robinhood", wallet, source: "fomo", fomo_handle: "trader" },
  ] }), /fomo_user_id/);
});
