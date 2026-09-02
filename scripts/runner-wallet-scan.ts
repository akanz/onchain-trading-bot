import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { DATA_ROOT, loadConfig } from "../src/config.js";
import { DexScreenerTraderBrowser } from "../src/dexscreener/traders.js";
import { GmgnClient, isRateLimit } from "../src/gmgn.js";
import { buildEliteGmgnWalletsFromTokenResults } from "../src/gmgn-wallet-analysis.js";
import { connectMongo, DistributedLeaseRepository, TrackedWalletRepository } from "../src/mongo.js";
import { loadRunnerContracts } from "../src/tracker/runner-contracts.js";
import type { Chain, Json } from "../src/types.js";

const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) loadEnvFile(envPath);

// Wallet-profit routes are expensive. DexScreener supplies the token-level
// trader rows; GMGN is reserved for wallet-wide qualification and monitoring.
const runnerRequestIntervalMs = Math.max(
  10_000,
  Number(process.env.GMGN_RUNNER_SCAN_REQUEST_INTERVAL_MS ?? 35_000),
);
process.env.GMGN_RATE_LIMIT_UNITS_PER_SECOND = String(5_000 / runnerRequestIntervalMs);
process.env.GMGN_RATE_LIMIT_BURST_UNITS = "5";

const config = loadConfig(),
  client = new GmgnClient(),
  contracts = loadRunnerContracts().filter((row) => config.enabled_chains.includes(row.chain)),
  generatedAt = new Date().toISOString(),
  stamp = generatedAt.replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z"),
  reportDirectory = join(DATA_ROOT, "reports"),
  reportPath = join(reportDirectory, `runner-wallet-scan-${stamp}.json`),
  cachePath = join(reportDirectory, "dexscreener-runner-wallet-scan.cache.json"),
  minimumPositionRoi = Number(
    process.env.DEXSCREENER_MIN_TRADER_ROI_PERCENT ??
      process.env.GMGN_MIN_TRENDING_TRADER_ROI_PERCENT ??
      500,
  );

mkdirSync(reportDirectory, { recursive: true });

const cache: Record<string, Json> = existsSync(cachePath)
  ? JSON.parse(readFileSync(cachePath, "utf8"))
  : {};
// Increment when the extracted Dex row schema changes so malformed historical
// cache entries can never silently re-enter the tracked-wallet roster.
const cacheKey = (chain: Chain, address: string) => `v3:${chain}:${address.toLowerCase()}`;
const walletKey = (chain: Chain, wallet: unknown) => `${chain}:${String(wallet).toLowerCase()}`;
const walletArgs = (wallets: string[]) => wallets.flatMap((wallet) => ["--wallet", wallet]);
const chunks = <T>(items: T[], size: number): T[][] => {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    output.push(items.slice(index, index + size));
  return output;
};

const tokenResults: Json[] = [],
  dex = await DexScreenerTraderBrowser.connect();
let stoppedByDexScreener: string | undefined,
  stoppedByRateLimit: string | undefined,
  stoppedByLease: string | undefined;
try {
  for (const [index, contract] of contracts.entries()) {
    const key = cacheKey(contract.chain, contract.address),
      cached = cache[key];
    const incompleteRender =
      cached && !cached.unavailable_reason && Number(cached.raw_trader_count ?? 0) === 0;
    if (cached && !incompleteRender) {
      tokenResults.push(cached);
      console.log(`[${index + 1}/${contracts.length}] ${key} cached`);
      continue;
    }
    try {
      const scraped = await dex.scrape(contract.chain, contract.address),
        result: Json = {
          ...scraped,
          token: {
            address: contract.address,
            symbol: contract.symbol,
            trader_source: "dexscreener",
          },
        };
      cache[key] = result;
      tokenResults.push(result);
      writeFileSync(cachePath, JSON.stringify(cache));
      console.log(
        `[${index + 1}/${contracts.length}] ${key} traders=${result.raw_trader_count} usable=${result.traders.length}`,
      );
    } catch (error) {
      if (/DexScreener has no pair/i.test(String(error))) {
        const result: Json = {
          chain: contract.chain,
          token: { address: contract.address, symbol: contract.symbol },
          raw_trader_count: 0,
          traders: [],
          unavailable_reason: String(error),
        };
        cache[key] = result;
        tokenResults.push(result);
        writeFileSync(cachePath, JSON.stringify(cache));
        console.log(`[${index + 1}/${contracts.length}] ${key} has no DexScreener pair`);
        continue;
      }
      stoppedByDexScreener = String(error);
      break;
    }
  }
} finally {
  await dex.close();
}

const mongo = await connectMongo(false),
  leaseOwnerId = `runner-wallet-scan:${process.pid}:${randomUUID()}`,
  leaseRepository = mongo ? new DistributedLeaseRepository(mongo) : undefined,
  leaseEnabled = process.env.GMGN_DISTRIBUTED_LEASE_ENABLED !== "false" && leaseRepository,
  leaseAcquired = leaseEnabled
    ? await leaseRepository.acquire(
        process.env.GMGN_SCANNER_LEASE_NAME ?? "gmgn-background-scanner",
        leaseOwnerId,
        Number(process.env.GMGN_SCANNER_LEASE_TTL_MS ?? 300_000),
      )
    : true,
  leaseHeartbeat =
    leaseEnabled && leaseAcquired
      ? setInterval(
          () =>
            void leaseRepository.acquire(
              process.env.GMGN_SCANNER_LEASE_NAME ?? "gmgn-background-scanner",
              leaseOwnerId,
              Number(process.env.GMGN_SCANNER_LEASE_TTL_MS ?? 300_000),
            ),
          60_000,
        )
      : undefined;
leaseHeartbeat?.unref();
if (!leaseAcquired)
  stoppedByLease = "GMGN phase deferred because the always-on bot owns the shared scanner lease";

if (!stoppedByDexScreener && !stoppedByLease && tokenResults.length === contracts.length) {
  for (const result of tokenResults.filter((row) => !row.traders?.length)) {
    try {
      const chain = result.chain as Chain,
        address = String(result.token?.address),
        response = await client.run(
          "token",
          "traders",
          "--chain",
          chain,
          "--address",
          address,
          "--limit",
          "100",
          "--order-by",
          "profit",
          "--direction",
          "desc",
        );
      result.traders = response.list ?? [];
      result.raw_trader_count = result.traders.length;
      result.token.trader_source = "gmgn_fallback";
      cache[cacheKey(chain, address)] = result;
      writeFileSync(cachePath, JSON.stringify(cache));
      console.log(`GMGN fallback ${chain}:${address} traders=${result.traders.length}`);
    } catch (error) {
      if (!isRateLimit(error)) throw error;
      stoppedByRateLimit = String(error);
      break;
    }
  }
}

const trackedByWallet = new Map<string, Json>(
  buildEliteGmgnWalletsFromTokenResults(tokenResults, minimumPositionRoi).map((row) => [
    walletKey(row.chain as Chain, row.wallet),
    {
      ...row,
      source: "dexscreener",
      verification_source: "dexscreener_or_gmgn_position_roi",
      discovery_sources: ["user_confirmed_runner_500pct"],
      qualifying_positions: (row.tokens ?? []).map((token: Json) => ({
        ...token,
        token_address: token.address,
        token_symbol: token.symbol,
      })),
    },
  ]),
);

async function walletProfits(
  chain: Chain,
  wallets: string[],
  period: "30d" | "all",
): Promise<Map<string, Json>> {
  const rows: Json[] = [];
  for (const batch of chunks(wallets, 100)) {
    const response = await client.run(
      "portfolio",
      "profits",
      "--chain",
      chain,
      ...walletArgs(batch),
      "--period",
      period,
    );
    rows.push(...(response.list ?? []));
  }
  return new Map(rows.map((row) => [String(row.wallet_address).toLowerCase(), row]));
}

if (
  !stoppedByDexScreener &&
  !stoppedByRateLimit &&
  !stoppedByLease &&
  tokenResults.length === contracts.length
) {
  for (const chain of config.enabled_chains) {
    const chainRows = [...trackedByWallet.values()].filter((row) => row.chain === chain),
      wallets = chainRows.map((row) => String(row.wallet));
    if (!wallets.length) continue;
    try {
      const by30 = await walletProfits(chain, wallets, "30d"),
        byAll = await walletProfits(chain, wallets, "all");
      for (const row of chainRows) {
        const wallet = String(row.wallet),
          p30 = by30.get(wallet.toLowerCase()) ?? {},
          pall = byAll.get(wallet.toLowerCase()) ?? {},
          realized30 = Number(p30.realized_profit ?? 0),
          cost30 = Number(p30.realized_profit_cost ?? 0),
          realizedAll = Number(pall.total_realized_profit ?? pall.realized_profit ?? 0),
          costAll = Number(pall.total_realized_profit_cost ?? pall.realized_profit_cost ?? 0),
          roi30 = cost30 > 0 ? realized30 / cost30 : undefined,
          roiAll = costAll > 0 ? realizedAll / costAll : undefined,
          trades30 = Number(p30.buy ?? 0) + Number(p30.sell ?? 0),
          qualified =
            roi30 !== undefined &&
            roiAll !== undefined &&
            roi30 >= Number(config.wallet.min_roi_30d ?? 2) &&
            roiAll >= Number(config.wallet.min_roi_all ?? 2) &&
            trades30 >= 30;
        Object.assign(row, {
          tracking_tier: qualified ? "qualified" : "elite_observed",
          realized_profit_30d: realized30,
          realized_profit_all: realizedAll,
          roi30,
          roiall: roiAll,
          trades30,
          wallet_quality_passed: qualified,
        });
      }
    } catch (error) {
      if (!isRateLimit(error)) throw error;
      stoppedByRateLimit = String(error);
      break;
    }
  }
}

const trackedWallets = [...trackedByWallet.values()].sort(
  (left, right) =>
    Number(right.tracking_tier === "qualified") - Number(left.tracking_tier === "qualified") ||
    Number(right.max_position_roi_percent ?? 0) - Number(left.max_position_roi_percent ?? 0),
);
let alreadyTracked = 0;
if (mongo) {
  const existing = new Set(
    (await new TrackedWalletRepository(mongo).loadAll())
      // Compare against independently tracked sources. The previous
      // DexScreener snapshot is about to be replaced and must not make its
      // own wallets appear pre-existing.
      .filter((row) => row.source !== "fomo" && row.source !== "dexscreener")
      .map((row) => walletKey(row.chain as Chain, row.wallet)),
  );
  alreadyTracked = trackedWallets.filter((row) =>
    existing.has(walletKey(row.chain as Chain, row.wallet)),
  ).length;
  await new TrackedWalletRepository(mongo).replace("dexscreener", generatedAt, trackedWallets);
}

const report = {
  generated_at: generatedAt,
  scan_complete:
    !stoppedByDexScreener &&
    !stoppedByRateLimit &&
    !stoppedByLease &&
    tokenResults.length === contracts.length,
  stopped_by_dexscreener: stoppedByDexScreener,
  stopped_by_rate_limit: stoppedByRateLimit,
  stopped_by_lease: stoppedByLease,
  definition: {
    contracts: contracts.length,
    trader_limit_per_token: 100,
    token_trader_source: "dexscreener_web_top_traders_30d_with_gmgn_fallback",
    order_by: "pnl_desc",
    minimum_position_roi_percent: minimumPositionRoi,
    position_roi_formula: "(sold_usd + current_balance_value_usd - bought_usd) / bought_usd",
    zero_cost_rows: "excluded",
    qualified_wallet_minimum_roi_30d_percent: Number(config.wallet.min_roi_30d ?? 2) * 100,
    qualified_wallet_minimum_roi_all_percent: Number(config.wallet.min_roi_all ?? 2) * 100,
  },
  counts: {
    contracts_completed: tokenResults.length,
    raw_top_trader_rows: tokenResults.reduce(
      (total, result) => total + Number(result.raw_trader_count ?? 0),
      0,
    ),
    usable_trader_rows: tokenResults.reduce(
      (total, result) => total + Number(result.traders?.length ?? 0),
      0,
    ),
    clean_position_roi_wallets: trackedWallets.length,
    already_tracked_wallets: alreadyTracked,
    new_wallets: Math.max(0, trackedWallets.length - alreadyTracked),
    qualified_wallets: trackedWallets.filter((row) => row.tracking_tier === "qualified").length,
    elite_observed_wallets: trackedWallets.filter((row) => row.tracking_tier === "elite_observed")
      .length,
  },
  tokens: tokenResults,
  tracked_wallets: trackedWallets,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({ reportPath, ...report.counts, scan_complete: report.scan_complete }, null, 2),
);
client.close();
if (leaseHeartbeat) clearInterval(leaseHeartbeat);
if (leaseEnabled && leaseAcquired)
  await leaseRepository.release(
    process.env.GMGN_SCANNER_LEASE_NAME ?? "gmgn-background-scanner",
    leaseOwnerId,
  );
await mongo?.close();
if (stoppedByDexScreener) {
  console.error(stoppedByDexScreener);
  process.exitCode = 2;
}
if (stoppedByRateLimit) {
  console.error(stoppedByRateLimit);
  process.exitCode = 2;
}
if (stoppedByLease) console.warn(stoppedByLease);
