import type { Chain } from "./types.js";

export const CHAIN_PRIORITY: readonly Chain[] = [
  "robinhood",
  "bsc",
  "sol",
  "base",
  "eth",
  "arc",
  "stable",
];

export function chainPriority(chain: Chain): number {
  const index = CHAIN_PRIORITY.indexOf(chain);
  return index < 0 ? CHAIN_PRIORITY.length : index;
}

export function priorityChains(chains: readonly Chain[]): Chain[] {
  return [...new Set(chains)].sort((a, b) => chainPriority(a) - chainPriority(b));
}

export function compareChainPriority(a: Chain, b: Chain): number {
  return chainPriority(a) - chainPriority(b);
}
