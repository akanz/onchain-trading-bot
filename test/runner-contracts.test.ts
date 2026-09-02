import assert from "node:assert/strict";
import test from "node:test";
import { parseRunnerContracts } from "../src/tracker/runner-contracts.js";

test("runner contracts retain valid Robinhood and Solana addresses", () => {
  const rows = parseRunnerContracts({
    contracts: [
      {
        chain: "robinhood",
        address: "0x1111111111111111111111111111111111111111",
        symbol: "RUN",
      },
      { chain: "sol", address: "9EmtjLFXwWSz828eyLunxmoWZNdoEjpw1nbxsEwGpump" },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.symbol, "RUN");
});

test("runner contracts reject duplicate and malformed entries", () => {
  assert.throws(
    () =>
      parseRunnerContracts({
        contracts: [
          { chain: "bsc", address: "0x1111111111111111111111111111111111111111" },
          { chain: "bsc", address: "0x1111111111111111111111111111111111111111" },
        ],
      }),
    /duplicates/,
  );
  assert.throws(
    () => parseRunnerContracts({ contracts: [{ chain: "robinhood", address: "not-a-ca" }] }),
    /invalid address/,
  );
});
