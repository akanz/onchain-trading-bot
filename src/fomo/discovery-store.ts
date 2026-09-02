import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Json } from "../types.js";

export type FomoDiscoveryKind = "trending" | "most_held";
interface FomoDiscoverySnapshot {
  captured_at: string;
  trending: Json[];
  most_held: Json[];
}

const empty = (): FomoDiscoverySnapshot => ({
  captured_at: new Date(0).toISOString(),
  trending: [],
  most_held: [],
});

export function readFomoDiscoverySnapshot(
  path: string,
  maxAgeSeconds = 3600,
): FomoDiscoverySnapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FomoDiscoverySnapshot>;
    const capturedAt = Date.parse(String(parsed.captured_at ?? ""));
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > maxAgeSeconds * 1000) return null;
    return {
      captured_at: new Date(capturedAt).toISOString(),
      trending: Array.isArray(parsed.trending) ? parsed.trending : [],
      most_held: Array.isArray(parsed.most_held) ? parsed.most_held : [],
    };
  } catch {
    return null;
  }
}

export function saveFomoDiscoverySnapshot(
  path: string,
  kind: FomoDiscoveryKind,
  rows: Json[],
): boolean {
  if (!Array.isArray(rows) || !rows.length) return false;
  const current = readFomoDiscoverySnapshot(path, Number.MAX_SAFE_INTEGER) ?? empty();
  const previous = new Map(
    current[kind].map((row) => [
      `${row.token?.networkId}:${String(row.token?.address ?? "").toLowerCase()}`,
      row,
    ]),
  );
  const enriched = rows.map((row) => {
    const prior = previous.get(
        `${row.token?.networkId}:${String(row.token?.address ?? "").toLowerCase()}`,
      ),
      observedPeak = Math.max(
        Number(row.marketCap ?? 0),
        Number(row.athMarketCap ?? 0),
        Number(prior?.marketCap ?? 0),
        Number(prior?.athMarketCap ?? 0),
      );
    return {
      ...row,
      ...(observedPeak > 0
        ? { athMarketCap: observedPeak, athMarketCapSource: "fomo_observed_peak" }
        : {}),
    };
  });
  const next: FomoDiscoverySnapshot = {
    ...current,
    captured_at: new Date().toISOString(),
    [kind]: enriched,
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  return true;
}

export function mergeFomoDiscoveryRows(primary: Json[], secondary: Json[]): Json[] {
  const rows = new Map<string, Json>();
  for (const row of [...secondary, ...primary]) {
    const networkId = String(row.token?.networkId ?? ""),
      address = String(row.token?.address ?? "").toLowerCase();
    if (networkId && address) rows.set(`${networkId}:${address}`, row);
  }
  return [...rows.values()];
}
