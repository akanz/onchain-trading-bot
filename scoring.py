from __future__ import annotations

import math
import statistics
import time
from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class Verdict:
    passed: bool
    score: float
    reasons: tuple[str, ...]
    warnings: tuple[str, ...] = ()


def number(value: Any, default: float | None = 0.0) -> float | None:
    if value in (None, ""):
        return default
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def ratio(numerator: Any, denominator: Any) -> float:
    den = number(denominator, 0.0) or 0.0
    return (number(numerator, 0.0) or 0.0) / den if den > 0 else 0.0


def wilson_lower_bound(wins: int, total: int, z: float = 1.96) -> float:
    if total <= 0:
        return 0.0
    p = wins / total
    denominator = 1 + z * z / total
    centre = p + z * z / (2 * total)
    spread = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)
    return (centre - spread) / denominator


def _profit_row(payload: dict[str, Any], period: str) -> dict[str, Any]:
    row = payload.get(period, {})
    return row if isinstance(row, dict) else {}


def score_wallet(
    profits: dict[str, dict[str, Any]],
    stats: dict[str, Any],
    activity: Iterable[dict[str, Any]],
    cfg: dict[str, Any],
) -> Verdict:
    reasons: list[str] = []
    warnings: list[str] = []
    hard_failures = 0

    p7 = _profit_row(profits, "7d")
    p30 = _profit_row(profits, "30d")
    pall = _profit_row(profits, "all")
    rp7 = number(p7.get("realized_profit"), 0.0) or 0.0
    rp30 = number(p30.get("realized_profit"), 0.0) or 0.0
    rpall = number(pall.get("total_realized_profit", pall.get("realized_profit")), 0.0) or 0.0
    roi30 = ratio(rp30, p30.get("realized_profit_cost"))
    roiall = ratio(rpall, pall.get("total_realized_profit_cost", pall.get("realized_profit_cost")))
    trades30 = int(number(p30.get("buy"), 0) or 0) + int(number(p30.get("sell"), 0) or 0)

    pnl_stat = stats.get("pnl_stat") or {}
    token_count = int(number(pnl_stat.get("token_num"), 0) or 0)
    winrate = number(pnl_stat.get("winrate"), 0.0) or 0.0
    wins = int(round(winrate * token_count))
    winrate_lb = wilson_lower_bound(wins, token_count)

    checks = [
        (rp7 >= cfg["min_realized_profit_7d"], f"7d realized P&L ${rp7:,.0f}"),
        (rp30 >= cfg["min_realized_profit_30d"], f"30d realized P&L ${rp30:,.0f}"),
        (rpall >= cfg["min_realized_profit_all"], f"all-time realized P&L ${rpall:,.0f}"),
        (roi30 >= cfg["min_roi_30d"], f"30d realized ROI {roi30:.1%}"),
        (roiall >= cfg["min_roi_all"], f"all-time realized ROI {roiall:.1%}"),
        (trades30 >= cfg["min_trades_30d"], f"30d trades {trades30}"),
        (trades30 <= cfg["max_trades_30d"], f"30d trades {trades30} (spray ceiling)"),
        (token_count >= cfg["min_tokens_30d"], f"30d token sample {token_count}"),
        (token_count <= cfg["max_tokens_30d"], f"30d tokens {token_count} (spray ceiling)"),
        (winrate >= cfg["min_win_rate_30d"], f"30d win rate {winrate:.1%}"),
        (winrate_lb >= cfg["min_wilson_win_rate_30d"], f"95% Wilson win-rate floor {winrate_lb:.1%}"),
    ]
    for ok, label in checks:
        reasons.append(("PASS " if ok else "FAIL ") + label)
        hard_failures += int(not ok)

    activities = list(activity)
    buys = [a for a in activities if (a.get("event_type") or a.get("type")) == "buy"]
    unique_tokens = {((a.get("token") or {}).get("address")) for a in activities}
    unique_tokens.discard(None)
    buy_sizes = [number(a.get("cost_usd"), 0.0) or 0.0 for a in buys]
    median_buy = statistics.median(buy_sizes) if buy_sizes else 0.0
    if activities:
        spray_ok = len(unique_tokens) <= cfg["max_unique_tokens_in_100_actions"]
        size_ok = median_buy >= cfg["min_median_buy_usd"]
        reasons.append(("PASS " if spray_ok else "FAIL ") + f"{len(unique_tokens)} unique tokens in {len(activities)} sampled actions")
        reasons.append(("PASS " if size_ok else "FAIL ") + f"median sampled buy ${median_buy:,.0f}")
        hard_failures += int(not spray_ok) + int(not size_ok)
    else:
        warnings.append("No activity sample; bot/spray and position-size checks are unknown")
        hard_failures += 1

    # Score rewards repeatable, realized performance while shrinking small samples.
    score = 0.0
    score += min(max(rp30 / 10_000, 0), 1) * 20
    score += min(max(rpall / 100_000, 0), 1) * 10
    score += min(max(roi30 / 0.25, 0), 1) * 20
    score += min(max(roiall / 0.15, 0), 1) * 10
    score += min(max(winrate_lb / 0.60, 0), 1) * 25
    score += min(max(token_count / 100, 0), 1) * 10
    score += 5 if rp7 >= 0 else 0
    return Verdict(hard_failures == 0, round(score, 1), tuple(reasons), tuple(warnings))


def _flag(value: Any) -> bool | None:
    if value is True or value in (1, "1", "yes", "true"):
        return True
    if value is False or value in (0, "0", "no", "false"):
        return False
    return None


def score_token(
    info: dict[str, Any],
    security: dict[str, Any],
    pool: dict[str, Any],
    cluster: dict[str, Any],
    cfg: dict[str, Any],
) -> Verdict:
    reasons: list[str] = []
    warnings: list[str] = []
    failures = 0

    price = number((info.get("price") or {}).get("price"), None)
    supply = number(info.get("circulating_supply"), None)
    market_cap = price * supply if price is not None and supply is not None else None
    liquidity = number(pool.get("liquidity", info.get("liquidity")), None)
    holders = int(number(info.get("holder_count"), 0) or 0)
    stat = info.get("stat") or {}
    top10 = number(security.get("top_10_holder_rate", stat.get("top_10_holder_rate")), None)
    dev_hold = number(security.get("dev_team_hold_rate", stat.get("dev_team_hold_rate")), None)
    bundler = number(security.get("bundler_trader_amount_rate", stat.get("top_bundler_trader_percentage")), None)
    bot = number(stat.get("bot_degen_rate"), None)
    rat = number(security.get("rat_trader_amount_rate", stat.get("top_rat_trader_percentage")), None)
    entrapment = number(stat.get("top_entrapment_trader_percentage"), None)
    volume5m = number((info.get("price") or {}).get("volume_5m"), None)
    mint = _flag(security.get("renounced_mint"))
    freeze = _flag(security.get("renounced_freeze_account"))
    honeypot = _flag(security.get("is_honeypot"))
    open_source = _flag(security.get("is_open_source", security.get("open_source")))
    owner_renounced = _flag(security.get("is_renounced", security.get("owner_renounced", security.get("renounced"))))
    lock_summary = security.get("lock_summary") or {}
    liquidity_locked = _flag(lock_summary.get("is_locked"))
    buy_tax = number(security.get("buy_tax"), None)
    sell_tax = number(security.get("sell_tax"), None)

    def required(ok: bool, label: str) -> None:
        nonlocal failures
        reasons.append(("PASS " if ok else "FAIL ") + label)
        failures += int(not ok)

    def known_max(value: float | None, limit: float, label: str) -> None:
        nonlocal failures
        if value is None:
            warnings.append(f"Unknown critical field: {label}")
            failures += 1
        else:
            required(value <= limit, f"{label} {value:.1%} <= {limit:.1%}")

    if cfg.get("require_honeypot_false"):
        required(honeypot is False, "honeypot check passed")
    elif honeypot is True:
        required(False, "honeypot detected")
    if cfg.get("require_open_source"):
        required(open_source is True, "contract source verified")
    if cfg.get("require_owner_renounced"):
        required(owner_renounced is True, "contract ownership renounced")
    if cfg.get("require_liquidity_locked"):
        required(liquidity_locked is True, "liquidity lock confirmed")
    if cfg.get("require_renounced_mint"):
        required(mint is True, "mint authority renounced")
    if cfg.get("require_renounced_freeze"):
        required(freeze is True, "freeze authority renounced")
    required(liquidity is not None and liquidity >= cfg["min_liquidity_usd"], f"liquidity ${liquidity or 0:,.0f}")
    required(market_cap is not None and cfg["min_market_cap_usd"] <= market_cap <= cfg["max_market_cap_usd"], f"market cap ${market_cap or 0:,.0f}")
    required(holders >= cfg["min_holders"], f"holders {holders}")
    required(volume5m is not None and volume5m >= cfg["min_volume_5m_usd"], f"5m volume ${volume5m or 0:,.0f}")
    known_max(top10, cfg["max_top_10_holder_rate"], "top-10 concentration")
    known_max(dev_hold, cfg["max_dev_team_hold_rate"], "dev-team holding")
    known_max(bundler, cfg["max_bundler_rate"], "bundler activity")
    known_max(bot, cfg["max_bot_rate"], "bot activity")
    known_max(rat, cfg["max_rat_trader_rate"], "insider/rat activity")
    known_max(entrapment, cfg.get("max_entrapment_rate", 1.0), "entrapment activity")
    if cfg.get("require_honeypot_false"):
        known_max(buy_tax, cfg.get("max_buy_tax", 0.05), "buy tax")
        known_max(sell_tax, cfg.get("max_sell_tax", 0.05), "sell tax")

    cluster_price = number(cluster.get("median_entry_price_usd"), None)
    if price is None or cluster_price is None or cluster_price <= 0:
        warnings.append("Cannot measure price chase from cluster entry")
        failures += 1
    else:
        chase = price / cluster_price - 1
        required(chase <= cluster.get("max_price_chase_ratio", 0.15), f"price moved {chase:.1%} since median tracked entry")

    passed_count = sum(r.startswith("PASS ") for r in reasons)
    score = 100 * passed_count / max(len(reasons) + len(warnings), 1)
    return Verdict(failures == 0, round(score, 1), tuple(reasons), tuple(warnings))


def cluster_events(events: Iterable[dict[str, Any]], cfg: dict[str, Any]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        if event.get("side") != "buy" or event.get("is_open_or_close") != 0:
            continue
        address = event.get("base_address")
        if address:
            grouped.setdefault(address, []).append(event)

    clusters: list[dict[str, Any]] = []
    for address, rows in grouped.items():
        rows.sort(key=lambda row: int(row.get("timestamp") or 0))
        for start in range(len(rows)):
            window = [r for r in rows[start:] if int(r.get("timestamp") or 0) - int(rows[start].get("timestamp") or 0) <= cfg["window_seconds"]]
            by_wallet: dict[str, dict[str, Any]] = {}
            for row in window:
                maker = row.get("maker")
                if maker and maker not in by_wallet:
                    by_wallet[maker] = row
            selected = list(by_wallet.values())
            if len(selected) < cfg["min_qualified_wallets"]:
                continue
            amounts = [number(r.get("amount_usd"), 0.0) or 0.0 for r in selected]
            prices = [number(r.get("price_usd"), 0.0) or 0.0 for r in selected]
            prices = [p for p in prices if p > 0]
            clusters.append({
                "address": address,
                "symbol": ((selected[0].get("base_token") or {}).get("symbol")),
                "wallets": sorted(by_wallet),
                "events": selected,
                "wallet_count": len(selected),
                "aggregate_buy_usd": sum(amounts),
                "median_buy_usd": statistics.median(amounts),
                "median_entry_price_usd": statistics.median(prices) if prices else None,
                "first_timestamp": min(int(r.get("timestamp") or 0) for r in selected),
                "last_timestamp": max(int(r.get("timestamp") or 0) for r in selected),
            })
            break
    return clusters
