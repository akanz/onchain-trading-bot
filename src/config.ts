import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Chain, Json, TrackerConfig } from "./types.js";

export const ROOT = resolve(process.env.TRACKER_ROOT ?? process.cwd());
export const DATA_ROOT = resolve(process.env.TRACKER_DATA_ROOT ?? ROOT);

export function loadConfig(path = join(ROOT, "config.json")): TrackerConfig {
  return JSON.parse(readFileSync(path, "utf8")) as TrackerConfig;
}

export function configForChain(base: TrackerConfig, chain: Chain): Json {
  if (!base.enabled_chains.includes(chain)) throw new Error(`Chain ${chain} is not enabled`);
  const selected = structuredClone(base);
  const settings = base.chain_settings?.[chain] ?? {};
  selected.chain = chain;
  selected.market_filters = settings.market_filters ?? [];
  selected.token = { ...selected.token, ...(settings.token ?? {}) };
  return selected;
}

export function databasePath(config: TrackerConfig, chain: Chain): string {
  const raw = chain === "sol"
    ? config.database
    : (config.database_template ?? "tracker.{chain}.sqlite3").replace("{chain}", chain);
  return isAbsolute(raw) ? raw : join(DATA_ROOT, raw);
}

export function parseChain(value: string, config: TrackerConfig): Chain {
  const chain = value.toLowerCase() as Chain;
  if (!config.enabled_chains.includes(chain)) throw new Error(`Unknown or disabled chain: ${value}`);
  return chain;
}
