import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_ROOT, ROOT } from "./config.js";
import {
  GmgnCooldownError,
  GmgnRateGate,
  gmgnRequestWeight,
  parseRateLimitReset,
} from "./gmgn-rate-limit.js";
import type { Chain, Json } from "./types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const transientNetwork = (error: unknown) =>
  /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|socket hang up|SocketError|other side closed|bad record mac/i.test(
    String(error),
  );

export class GmgnError extends Error {}
export class GmgnRateLimitError extends GmgnError {
  constructor(
    message: string,
    readonly resetAt: number,
  ) {
    super(message);
    this.name = "GmgnRateLimitError";
  }
}
export const isRateLimit = (error: unknown) =>
  error instanceof GmgnCooldownError ||
  error instanceof GmgnRateLimitError ||
  /429|RATE_LIMIT|GMGN cooldown/i.test(String(error));

export class GmgnClient {
  private checked = false;
  private configCheck: Promise<void> | undefined;
  private readonly cliPath =
    process.env.GMGN_CLI_PATH ??
    [
      join(ROOT, "node_modules", ".bin", "gmgn-cli"),
      join(dirname(process.execPath), "gmgn-cli"),
    ].find(existsSync) ??
    "gmgn-cli";
  private readonly gate = new GmgnRateGate({
    stateFile:
      process.env.GMGN_COOLDOWN_FILE ?? join(DATA_ROOT, ".runtime", "gmgn-rate-limit.json"),
  });
  private readonly children = new Set<ChildProcess>();
  private closed = false;

  get cooldownUntil(): number {
    return this.gate.cooldownUntil;
  }
  get cooldownRemainingMs(): number {
    return this.gate.cooldownRemainingMs;
  }

  private invoke(
    args: string[],
    options: { maxBuffer?: number } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.closed) return Promise.reject(new GmgnError("GMGN client is shutting down"));
    const command = existsSync(this.cliPath) ? process.execPath : "gmgn-cli",
      commandArgs = existsSync(this.cliPath) ? [this.cliPath, ...args] : args;
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        commandArgs,
        { ...options, encoding: "utf8" },
        (error, stdout, stderr) => {
          this.children.delete(child);
          if (error) {
            Object.assign(error, { stdout, stderr });
            reject(error);
          } else resolve({ stdout, stderr });
        },
      );
      this.children.add(child);
      child.once("error", () => this.children.delete(child));
    });
  }

  close(): void {
    this.closed = true;
    for (const child of this.children) if (child.exitCode === null) child.kill("SIGTERM");
    this.children.clear();
  }

  async checkConfig(): Promise<void> {
    if (this.checked) return;
    if (!this.configCheck)
      this.configCheck = (async () => {
        try {
          await this.invoke(["config", "--check"]);
          this.checked = true;
        } catch (error: any) {
          const message = error.stderr?.trim() || error.stdout?.trim() || String(error);
          if (/429|RATE_LIMIT_(?:EXCEEDED|BANNED)/i.test(message)) {
            const resetAt = this.gate.blockUntil(parseRateLimitReset(message));
            throw new GmgnRateLimitError(message, resetAt);
          }
          throw new GmgnError(message);
        }
      })().finally(() => {
        this.configCheck = undefined;
      });
    await this.configCheck;
  }

  async run(...args: string[]): Promise<any> {
    this.gate.assertAvailable();
    // Configuration validation can contact GMGN. Put it through the same gate
    // so process startup cannot validate and immediately burst an API route.
    if (!this.checked) await this.gate.schedule(1, () => this.checkConfig());
    const weight = gmgnRequestWeight(args);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { stdout, stderr } = await this.gate.schedule(weight, async () => {
          try {
            return await this.invoke([...args, "--raw"], { maxBuffer: 16 * 1024 * 1024 });
          } catch (error: any) {
            const message =
              error.stderr?.trim() || error.stdout?.trim() || error.message || String(error);
            if (/429|RATE_LIMIT_(?:EXCEEDED|BANNED)/i.test(message)) {
              const resetAt = this.gate.blockUntil(parseRateLimitReset(message));
              throw new GmgnRateLimitError(message, resetAt);
            }
            throw error;
          }
        });
        if (/suspicious metadata|neutralized\s+\d+\s+suspicious/i.test(stderr))
          throw new GmgnError(
            "Suspicious token metadata was neutralized; refusing automatic evaluation",
          );
        return JSON.parse(stdout);
      } catch (error: any) {
        if (error instanceof GmgnError || error instanceof GmgnCooldownError) throw error;
        const message =
          error.stderr?.trim() || error.stdout?.trim() || error.message || String(error);
        if (attempt < 2 && transientNetwork(message)) {
          console.warn(`GMGN transient network failure; retrying in ${attempt + 1}s`);
          await sleep((attempt + 1) * 1000);
          continue;
        }
        throw new GmgnError(message);
      }
    }
    throw new GmgnError("GMGN request exhausted transient-network retries");
  }

  async track(chain: Chain, limit: number): Promise<Json[]> {
    return (
      (await this.run("track", "smartmoney", "--chain", chain, "--limit", String(limit))).list ?? []
    );
  }
  async smartMoney(chain: Chain, limit = 100): Promise<Json[]> {
    return (
      (
        await this.run(
          "track",
          "smartmoney",
          "--chain",
          chain,
          "--side",
          "buy",
          "--limit",
          String(limit),
        )
      ).list ?? []
    );
  }
  async kol(chain: Chain, limit = 100): Promise<Json[]> {
    return (
      (await this.run("track", "kol", "--chain", chain, "--side", "buy", "--limit", String(limit)))
        .list ?? []
    );
  }
  async followedWallets(chain: Chain, limit = 100): Promise<Json[]> {
    return (
      (await this.run("track", "follow-wallet", "--chain", chain, "--limit", String(limit))).list ??
      []
    );
  }
  async walletActivity(chain: Chain, wallet: string, limit = 30): Promise<Json[]> {
    return (
      (
        await this.run(
          "portfolio",
          "activity",
          "--chain",
          chain,
          "--wallet",
          wallet,
          "--limit",
          String(limit),
          "--type",
          "buy",
          "--type",
          "sell",
        )
      ).activities ?? []
    );
  }
  async walletTokenActivity(
    chain: Chain,
    wallet: string,
    token: string,
    limit = 50,
  ): Promise<Json[]> {
    return (
      (
        await this.run(
          "portfolio",
          "activity",
          "--chain",
          chain,
          "--wallet",
          wallet,
          "--token",
          token,
          "--limit",
          String(limit),
          "--type",
          "buy",
          "--type",
          "sell",
        )
      ).activities ?? []
    );
  }
  async walletProfits(
    chain: Chain,
    wallets: string[],
    period: "7d" | "30d" | "all",
  ): Promise<Json[]> {
    return (
      (
        await this.run(
          "portfolio",
          "profits",
          "--chain",
          chain,
          ...wallets.flatMap((wallet) => ["--wallet", wallet]),
          "--period",
          period,
        )
      ).list ?? []
    );
  }
  async walletStats(chain: Chain, wallet: string): Promise<Json> {
    return this.run("portfolio", "stats", "--chain", chain, "--wallet", wallet, "--period", "30d");
  }
  async trending(chain: Chain, filters: string[], limit = 30): Promise<Json[]> {
    const args = [
      "market",
      "trending",
      "--chain",
      chain,
      "--interval",
      "5m",
      "--limit",
      String(limit),
      "--order-by",
      "volume",
      "--direction",
      "desc",
      ...filters.flatMap((filter) => ["--filter", filter]),
    ];
    return (await this.run(...args)).data?.rank ?? [];
  }
  async kline(
    chain: Chain,
    address: string,
    lookbackSeconds = 3900,
    resolution = "5m",
  ): Promise<Json[]> {
    const to = Math.floor(Date.now() / 1000),
      from = to - lookbackSeconds;
    const data = await this.run(
      "market",
      "kline",
      "--chain",
      chain,
      "--address",
      address,
      "--resolution",
      resolution,
      "--from",
      String(from),
      "--to",
      String(to),
    );
    return Array.isArray(data?.list) ? data.list : [];
  }
  async priceChange(
    chain: Chain,
    address: string,
    lookbackSeconds = 1800,
  ): Promise<number | undefined> {
    const candles = (await this.kline(chain, address, lookbackSeconds, "5m"))
      .filter(
        (row: Json) => Number.isFinite(Number(row.open)) && Number.isFinite(Number(row.close)),
      )
      .sort((a: Json, b: Json) => Number(a.time) - Number(b.time));
    const open = Number(candles[0]?.open),
      close = Number(candles.at(-1)?.close);
    return open > 0 && Number.isFinite(close) ? (close / open - 1) * 100 : undefined;
  }
  async marketSignals(chain: Chain): Promise<Json[]> {
    if (!["sol", "bsc", "robinhood", "arc", "stable"].includes(chain)) return [];
    const data = await this.run(
      "market",
      "signal",
      "--chain",
      chain,
      "--signal-type",
      "6",
      "--signal-type",
      "7",
      "--signal-type",
      "12",
    );
    return Array.isArray(data) ? data : [];
  }
  async tokenInfo(chain: Chain, address: string) {
    return this.run("token", "info", "--chain", chain, "--address", address);
  }
  async tokenSecurity(chain: Chain, address: string) {
    return this.run("token", "security", "--chain", chain, "--address", address);
  }
  async tokenPool(chain: Chain, address: string) {
    return this.run("token", "pool", "--chain", chain, "--address", address);
  }
  async tokenHolders(chain: Chain, address: string, limit = 5): Promise<Json[]> {
    return (
      (
        await this.run(
          "token",
          "holders",
          "--chain",
          chain,
          "--address",
          address,
          "--limit",
          String(limit),
          "--order-by",
          "amount_percentage",
          "--direction",
          "desc",
        )
      ).list ?? []
    );
  }
  async tokenTraders(chain: Chain, address: string, limit = 100): Promise<Json[]> {
    return (
      (
        await this.run(
          "token",
          "traders",
          "--chain",
          chain,
          "--address",
          address,
          "--limit",
          String(limit),
          "--order-by",
          "profit",
          "--direction",
          "desc",
        )
      ).list ?? []
    );
  }
}
