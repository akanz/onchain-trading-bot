import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { DATA_ROOT } from "../config.js";
import { validWalletAddress } from "../gmgn-wallet-analysis.js";
import type { Chain, Json } from "../types.js";

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const chainId = (chain: Chain) =>
  chain === "sol" ? "solana" : chain === "eth" ? "ethereum" : chain;

export interface DexTraderCells {
  wallet: string;
  cells: string[];
}

export function parseDexMoney(value: string): number | undefined {
  const match = value.trim().match(/^\$?(-?[\d,.]+)\s*([KMB])?/i);
  if (!match) return undefined;
  const amount = Number(match[1]?.replaceAll(",", ""));
  if (!Number.isFinite(amount)) return undefined;
  const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[String(match[2] ?? "").toUpperCase()] ?? 1;
  return amount * multiplier;
}

const transactionCount = (value: string): number => {
  const match = value.match(/\/\s*([\d,]+)\s+txns?/i);
  return Number(match?.[1]?.replaceAll(",", "") ?? 0);
};

export function normalizeDexTrader(chain: Chain, row: DexTraderCells): Json | undefined {
  if (!validWalletAddress(chain, row.wallet)) return undefined;
  const bought = parseDexMoney(row.cells[2] ?? ""),
    sold = parseDexMoney(row.cells[3] ?? "") ?? 0,
    currentValue = parseDexMoney(row.cells[5] ?? "") ?? 0;
  if (bought === undefined || bought <= 0) return undefined;
  const realizedProfit = sold - bought,
    totalProfit = sold + currentValue - bought;
  return {
    address: row.wallet,
    addr_type: 0,
    history_bought_cost: bought,
    history_sold_income: sold,
    realized_profit: realizedProfit,
    profit: totalProfit,
    realized_pnl: realizedProfit / bought,
    profit_change: totalProfit / bought,
    current_balance_value_usd: currentValue,
    buy_tx_count_cur: transactionCount(row.cells[2] ?? ""),
    sell_tx_count_cur: transactionCount(row.cells[3] ?? ""),
    dexscreener_cells: row.cells,
  };
}

const chromeExecutable = (): string | undefined =>
  [
    process.env.DEXSCREENER_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ]
    .filter((value): value is string => Boolean(value))
    .find(existsSync);

async function cdpReady(endpoint: string): Promise<boolean> {
  try {
    return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function connectBrowser(): Promise<{ browser: Browser; chrome?: ChildProcess }> {
  const endpoint = process.env.DEXSCREENER_CDP_URL ?? "http://127.0.0.1:9224";
  if (await cdpReady(endpoint)) return { browser: await chromium.connectOverCDP(endpoint) };

  const executable = chromeExecutable();
  if (!executable)
    throw new Error("DexScreener trader scan needs Google Chrome or DEXSCREENER_CDP_URL");
  const profile =
    process.env.DEXSCREENER_BROWSER_PROFILE ??
    join(DATA_ROOT, ".runtime", "dexscreener-chrome-profile");
  mkdirSync(profile, { recursive: true });
  const port = new URL(endpoint).port || "9224",
    chrome = spawn(
      executable,
      [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "https://dexscreener.com",
      ],
      { stdio: "ignore" },
    );
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await cdpReady(endpoint))
      return { browser: await chromium.connectOverCDP(endpoint), chrome };
    await sleep(250);
  }
  chrome.kill("SIGTERM");
  throw new Error("DexScreener Chrome did not expose its debugging endpoint");
}

const rowsFromPage = async (page: Page): Promise<DexTraderCells[]> =>
  page.locator('a[aria-label="Open in block explorer"]').evaluateAll((links) =>
    links.flatMap((link) => {
      const row = link.parentElement?.parentElement,
        rank = row?.firstElementChild?.textContent?.trim() ?? "",
        wallet = link.getAttribute("href")?.match(/\/address\/([^/?#]+)/i)?.[1];
      if (!row || !rank.startsWith("#") || !wallet) return [];
      return [
        {
          wallet,
          // Dex renders the USD amount and token quantity as adjacent spans. A
          // plain textContent read joins `$744` and `426.7K` into
          // `$744426.7K`, which looks like a huge (and false) dollar amount.
          // Preserve a boundary between the direct cell children so the money
          // parser reads only the leading USD value.
          cells: [...row.children].map((cell) =>
            [...cell.childNodes]
              .map((node) => node.textContent?.trim() ?? "")
              .filter(Boolean)
              .join(" "),
          ),
        },
      ];
    }),
  );

async function waitForTraderRows(page: Page): Promise<DexTraderCells[]> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rows = await rowsFromPage(page);
    if (rows.length) return rows;
    await page.waitForTimeout(500);
  }
  return [];
}

async function mainPair(chain: Chain, address: string): Promise<Json> {
  const response = await fetch(
    `https://api.dexscreener.com/tokens/v1/${chainId(chain)}/${encodeURIComponent(address)}`,
    { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) },
  );
  if (!response.ok) throw new Error(`DexScreener pair lookup failed (HTTP ${response.status})`);
  const rows = (await response.json()) as Json[];
  const candidates = rows.filter(
    (row) => String(row.baseToken?.address ?? "").toLowerCase() === address.toLowerCase(),
  );
  const pair = candidates.sort(
    (left, right) => Number(right.liquidity?.usd ?? 0) - Number(left.liquidity?.usd ?? 0),
  )[0];
  if (!pair?.url) throw new Error(`DexScreener has no pair for ${chain}:${address}`);
  return pair;
}

export class DexScreenerTraderBrowser {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly chrome?: ChildProcess,
  ) {}

  static async connect(): Promise<DexScreenerTraderBrowser> {
    const { browser, chrome } = await connectBrowser(),
      context = browser.contexts()[0];
    if (!context) throw new Error("DexScreener Chrome has no browser context");
    return new DexScreenerTraderBrowser(browser, context, chrome);
  }

  async scrape(chain: Chain, address: string): Promise<Json> {
    const pair = await mainPair(chain, address),
      page = await this.context.newPage();
    try {
      await page.goto(String(pair.url), { waitUntil: "domcontentloaded", timeout: 30000 });
      const topTraders = page.getByRole("button", { name: "Top Traders", exact: true });
      await topTraders.waitFor({ state: "visible", timeout: 30000 });
      await topTraders.click();
      const rawRows = (await waitForTraderRows(page)).slice(0, 100),
        traders = rawRows
          .map((row) => normalizeDexTrader(chain, row))
          .filter((row): row is Json => Boolean(row));
      return {
        chain,
        pair_address: pair.pairAddress,
        pair_url: pair.url,
        quote_address: pair.quoteToken?.address,
        raw_trader_count: rawRows.length,
        traders,
      };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => {});
    this.chrome?.kill("SIGTERM");
  }
}
