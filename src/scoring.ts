import type { Json, Verdict } from "./types.js";

export function number(value: unknown, fallback: number | null = 0): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
const flag = (v: unknown): boolean | null => v === true || [1, "1", "yes", "true"].includes(v as any) ? true : v === false || [0, "0", "no", "false"].includes(v as any) ? false : null;

export function wilsonLowerBound(wins: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = wins / total;
  return (p + z*z/(2*total) - z*Math.sqrt((p*(1-p)+z*z/(4*total))/total)) / (1+z*z/total);
}

export function scoreToken(info: Json, security: Json, pool: Json, cluster: Json, cfg: Json): Verdict {
  const reasons: string[] = [], warnings: string[] = [];
  let failures = 0;
  const required = (ok: boolean, label: string) => { reasons.push(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures++; };
  const knownMax = (value: number | null, limit: number, label: string) => {
    if (value === null) { warnings.push(`Unknown critical field: ${label}`); failures++; }
    else required(value <= limit, `${label} ${(value*100).toFixed(1)}% <= ${(limit*100).toFixed(1)}%`);
  };
  const price = number(info.price?.price, null), supply = number(info.circulating_supply, null);
  const marketCap = price !== null && supply !== null ? price * supply : null;
  const liquidity = number(pool.liquidity ?? info.liquidity, null);
  const stat = info.stat ?? {};
  const honeypot = flag(security.is_honeypot), openSource = flag(security.is_open_source ?? security.open_source);
  const renounced = flag(security.is_renounced ?? security.owner_renounced ?? security.renounced);
  const locked = flag(security.lock_summary?.is_locked);
  if (cfg.require_honeypot_false) required(honeypot === false, "honeypot check passed"); else if (honeypot === true) required(false, "honeypot detected");
  if (cfg.require_open_source) required(openSource === true, "contract source verified");
  if (cfg.require_owner_renounced) required(renounced === true, "contract ownership renounced");
  if (cfg.require_liquidity_locked) required(locked === true, "liquidity lock confirmed");
  if (cfg.require_renounced_mint) required(flag(security.renounced_mint) === true, "mint authority renounced");
  if (cfg.require_renounced_freeze) required(flag(security.renounced_freeze_account) === true, "freeze authority renounced");
  required(liquidity !== null && liquidity >= cfg.min_liquidity_usd, `liquidity $${Math.round(liquidity ?? 0).toLocaleString()}`);
  required(marketCap !== null && marketCap >= cfg.min_market_cap_usd && marketCap <= cfg.max_market_cap_usd, `market cap $${Math.round(marketCap ?? 0).toLocaleString()}`);
  required((number(info.holder_count, 0) ?? 0) >= cfg.min_holders, `holders ${number(info.holder_count, 0)}`);
  required((number(info.price?.volume_5m, 0) ?? 0) >= cfg.min_volume_5m_usd, `5m volume $${Math.round(number(info.price?.volume_5m, 0) ?? 0).toLocaleString()}`);
  knownMax(number(security.top_10_holder_rate ?? stat.top_10_holder_rate, null), cfg.max_top_10_holder_rate, "top-10 concentration");
  knownMax(number(security.dev_team_hold_rate ?? stat.dev_team_hold_rate, null), cfg.max_dev_team_hold_rate, "dev-team holding");
  knownMax(number(security.bundler_trader_amount_rate ?? stat.top_bundler_trader_percentage, null), cfg.max_bundler_rate, "bundler activity");
  knownMax(number(stat.bot_degen_rate, null), cfg.max_bot_rate, "bot activity");
  knownMax(number(security.rat_trader_amount_rate ?? stat.top_rat_trader_percentage, null), cfg.max_rat_trader_rate, "insider/rat activity");
  knownMax(number(stat.top_entrapment_trader_percentage, null), cfg.max_entrapment_rate ?? 1, "entrapment activity");
  if (cfg.require_honeypot_false) { knownMax(number(security.buy_tax, null), cfg.max_buy_tax ?? .05, "buy tax"); knownMax(number(security.sell_tax, null), cfg.max_sell_tax ?? .05, "sell tax"); }
  const entry = number(cluster.median_entry_price_usd, null);
  if (price === null || entry === null || entry <= 0) { warnings.push("Cannot measure price chase from cluster entry"); failures++; }
  else required(price / entry - 1 <= (cluster.max_price_chase_ratio ?? .15), `price moved ${((price/entry-1)*100).toFixed(1)}% since median tracked entry`);
  const passed = reasons.filter(r => r.startsWith("PASS ")).length;
  return { passed: failures === 0, score: Math.round(1000*passed/Math.max(reasons.length+warnings.length,1))/10, reasons, warnings };
}

export function clusterEvents(events: Json[], cfg: Json): Json[] {
  const grouped = new Map<string, Json[]>();
  for (const event of events) if (event.side === "buy" && event.is_open_or_close === 0 && event.base_address) grouped.set(event.base_address, [...(grouped.get(event.base_address) ?? []), event]);
  const clusters: Json[] = [];
  for (const [address, rows] of grouped) {
    rows.sort((a,b) => Number(a.timestamp)-Number(b.timestamp));
    for (let start=0; start<rows.length; start++) {
      const window = rows.slice(start).filter(r => Number(r.timestamp)-Number(rows[start]!.timestamp) <= cfg.window_seconds);
      const unique = new Map<string, Json>(); for (const row of window) if (row.maker && !unique.has(row.maker)) unique.set(row.maker,row);
      const selected = [...unique.values()]; if (selected.length < cfg.min_qualified_wallets) continue;
      const amounts = selected.map(r => number(r.amount_usd,0) ?? 0).sort((a,b)=>a-b);
      const prices = selected.map(r => number(r.price_usd,0) ?? 0).filter(Boolean).sort((a,b)=>a-b);
      const median = (a:number[]) => a.length%2 ? a[(a.length-1)/2]! : (a[a.length/2-1]!+a[a.length/2]!)/2;
      clusters.push({ address, symbol:selected[0]?.base_token?.symbol, wallets:[...unique.keys()].sort(), events:selected, wallet_count:selected.length, aggregate_buy_usd:amounts.reduce((a,b)=>a+b,0), median_buy_usd:median(amounts), median_entry_price_usd:prices.length?median(prices):null, first_timestamp:Math.min(...selected.map(r=>Number(r.timestamp))), last_timestamp:Math.max(...selected.map(r=>Number(r.timestamp))) });
      break;
    }
  }
  return clusters;
}
