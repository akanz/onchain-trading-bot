import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";
import type { Chain, Json } from "../types.js";

export interface RunnerContract {
  chain: Chain;
  address: string;
  symbol?: string;
}

const supportedChains = new Set<Chain>(["sol", "bsc", "base", "robinhood", "eth"]);
const evmAddress = /^0x[0-9a-fA-F]{40}$/;
const solAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseRunnerContracts(payload: unknown): RunnerContract[] {
  const contracts = (payload as Json | null)?.contracts;
  if (!Array.isArray(contracts)) throw new Error("runner-contracts.json needs a contracts array");

  const seen = new Set<string>();
  return contracts.map((value, index) => {
    if (!value || typeof value !== "object")
      throw new Error(`runner contract ${index + 1} must be an object`);
    const row = value as Json,
      chain = String(row.chain ?? "") as Chain,
      address = String(row.address ?? ""),
      validAddress = chain === "sol" ? solAddress.test(address) : evmAddress.test(address);
    if (!supportedChains.has(chain))
      throw new Error(`runner contract ${index + 1} has an unsupported chain`);
    if (!validAddress) throw new Error(`runner contract ${index + 1} has an invalid address`);
    const key = `${chain}:${address.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`runner contract ${index + 1} duplicates ${key}`);
    seen.add(key);
    return { chain, address, ...(row.symbol ? { symbol: String(row.symbol) } : {}) };
  });
}

export function loadRunnerContracts(path = join(ROOT, "runner-contracts.json")): RunnerContract[] {
  return parseRunnerContracts(JSON.parse(readFileSync(path, "utf8")));
}
