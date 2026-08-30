import { existsSync, readFileSync } from "node:fs";
import type { Chain, Json } from "./types.js";

const CHAINS = new Set<Chain>(["sol", "bsc", "base", "robinhood", "eth", "arc", "stable"]);
const SOURCES = new Set(["fomo", "gmgn"]);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseTrackedWalletSeeds(payload: unknown): Json[] {
  const rows = Array.isArray(payload) ? payload : (payload as Json | null)?.wallets;
  if (!Array.isArray(rows)) throw new Error("tracked-wallet-seeds.json must contain a wallets array");
  const seen = new Set<string>();
  return rows.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error(`tracked wallet row ${index + 1} must be an object`);
    const row = value as Json, chain = String(row.chain ?? "") as Chain, source = String(row.source ?? ""), rawWallet = String(row.wallet ?? "");
    if (!CHAINS.has(chain)) throw new Error(`tracked wallet row ${index + 1} has an invalid chain`);
    if (!SOURCES.has(source)) throw new Error(`tracked wallet row ${index + 1} has an invalid source`);
    const validWallet = chain === "sol" ? SOL_ADDRESS.test(rawWallet) : EVM_ADDRESS.test(rawWallet);
    if (!validWallet) throw new Error(`tracked wallet row ${index + 1} has an invalid wallet address`);
    if (source === "fomo" && !String(row.fomo_user_id ?? "")) throw new Error(`tracked Fomo row ${index + 1} is missing fomo_user_id`);
    const wallet = chain === "sol" ? rawWallet : rawWallet.toLowerCase(), key = `${source}:${chain}:${wallet}`;
    if (seen.has(key)) throw new Error(`tracked wallet row ${index + 1} duplicates ${key}`);
    seen.add(key);
    return { ...row, chain, source, wallet };
  });
}

export function loadTrackedWalletSeeds(path: string): Json[] {
  if (!existsSync(path)) return [];
  return parseTrackedWalletSeeds(JSON.parse(readFileSync(path, "utf8")));
}
