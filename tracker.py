#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from scoring import Verdict, cluster_events, number, score_token, score_wallet


ROOT = Path(__file__).resolve().parent


class GMGNError(RuntimeError):
    pass


def is_rate_limit(error: BaseException) -> bool:
    message = str(error)
    return "429" in message or "RATE_LIMIT" in message


class GMGN:
    def __init__(self) -> None:
        self.check_config()

    @staticmethod
    def check_config() -> None:
        result = subprocess.run(["gmgn-cli", "config", "--check"], text=True, capture_output=True)
        if result.returncode:
            raise GMGNError(result.stderr.strip() or result.stdout.strip() or "GMGN configuration check failed")

    @staticmethod
    def run(*args: str) -> dict[str, Any]:
        command = ["gmgn-cli", *args, "--raw"]
        result = subprocess.run(command, text=True, capture_output=True)
        if result.returncode:
            raise GMGNError(result.stderr.strip() or result.stdout.strip() or f"Command failed: {' '.join(command[:-1])}")
        if "suspicious metadata" in result.stderr.lower():
            raise GMGNError("GMGN neutralized suspicious token metadata; refusing automatic evaluation")
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise GMGNError(f"GMGN returned invalid JSON: {exc}") from exc

    def track(self, chain: str, limit: int) -> list[dict[str, Any]]:
        return self.run("track", "smartmoney", "--chain", chain, "--limit", str(limit)).get("list", [])

    def profits(self, chain: str, wallets: list[str], period: str) -> dict[str, dict[str, Any]]:
        if not wallets:
            return {}
        data = self.run("portfolio", "profits", "--chain", chain, "--wallet", *wallets, "--period", period)
        return {row["wallet_address"]: row for row in data.get("list", []) if row.get("wallet_address")}

    def stats(self, chain: str, wallet: str) -> dict[str, Any]:
        return self.run("portfolio", "stats", "--chain", chain, "--wallet", wallet, "--period", "30d")

    def activity(self, chain: str, wallet: str) -> list[dict[str, Any]]:
        return self.run("portfolio", "activity", "--chain", chain, "--wallet", wallet, "--limit", "100", "--type", "buy", "sell").get("activities", [])

    def token_info(self, chain: str, address: str) -> dict[str, Any]:
        return self.run("token", "info", "--chain", chain, "--address", address)

    def token_security(self, chain: str, address: str) -> dict[str, Any]:
        return self.run("token", "security", "--chain", chain, "--address", address)

    def token_pool(self, chain: str, address: str) -> dict[str, Any]:
        return self.run("token", "pool", "--chain", chain, "--address", address)

    def token_traders(self, chain: str, address: str) -> list[dict[str, Any]]:
        return self.run("token", "traders", "--chain", chain, "--address", address, "--limit", "100", "--order-by", "profit", "--direction", "desc").get("list", [])

    def trending_runners(self, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        token_cfg = cfg["token"]
        discovery = cfg["discovery"]
        args = [
            "market", "trending", "--chain", cfg["chain"],
            "--interval", discovery["runner_interval"],
            "--min-liquidity", str(token_cfg["min_liquidity_usd"]),
            "--min-marketcap", str(token_cfg["min_market_cap_usd"]),
            "--max-marketcap", str(token_cfg["max_market_cap_usd"]),
            "--min-holder-count", str(token_cfg["min_holders"]),
            "--max-top10-holder-rate", str(token_cfg["max_top_10_holder_rate"]),
            "--max-bundler-rate", str(token_cfg["max_bundler_rate"]),
            "--max-insider-rate", str(token_cfg["max_rat_trader_rate"]),
            "--max-entrapment-ratio", str(token_cfg.get("max_entrapment_rate", 1.0)),
            "--order-by", "volume", "--direction", "desc",
            "--limit", str(discovery["runner_limit"]),
        ]
        for market_filter in cfg.get("market_filters", []):
            args.extend(("--filter", market_filter))
        data = self.run(*args)
        return ((data.get("data") or {}).get("rank")) or []


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise SystemExit(f"Missing {path}. Copy config.example.json to config.json and tune it before live use.")
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def config_for_chain(config: dict[str, Any], chain: str) -> dict[str, Any]:
    if chain not in config.get("enabled_chains", [config.get("default_chain", "sol")]):
        raise SystemExit(f"Chain {chain!r} is not enabled in config.json")
    selected = copy.deepcopy(config)
    selected["chain"] = chain
    chain_settings = (config.get("chain_settings") or {}).get(chain, {})
    selected["market_filters"] = chain_settings.get("market_filters", [])
    selected["token"].update(chain_settings.get("token", {}))
    return selected


def database_path(config: dict[str, Any], chain: str) -> Path:
    # Preserve the existing Solana history; every additional chain gets an isolated store.
    raw = config.get("database") if chain == "sol" else None
    raw = raw or config.get("database_template", "tracker.{chain}.sqlite3").format(chain=chain)
    path = Path(raw)
    return path if path.is_absolute() else ROOT / path


def connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS candidates (
            wallet TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS events (
            tx_hash TEXT NOT NULL,
            maker TEXT NOT NULL,
            token TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            payload TEXT NOT NULL,
            PRIMARY KEY (tx_hash, maker, token)
        );
        CREATE TABLE IF NOT EXISTS candidate_sources (
            wallet TEXT NOT NULL,
            token TEXT NOT NULL,
            source_rank INTEGER,
            seen_at INTEGER NOT NULL,
            PRIMARY KEY (wallet, token)
        );
        CREATE TABLE IF NOT EXISTS profiles (
            wallet TEXT PRIMARY KEY,
            passed INTEGER NOT NULL,
            score REAL NOT NULL,
            funder TEXT,
            assessed_at INTEGER NOT NULL,
            payload TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alerts (
            token TEXT NOT NULL,
            window_start INTEGER NOT NULL,
            tier TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (token, window_start)
        );
    """)
    return db


def remember_candidates(db: sqlite3.Connection, wallets: list[str], source: str) -> None:
    now = int(time.time())
    db.executemany(
        """INSERT INTO candidates(wallet, source, first_seen, last_seen) VALUES(?,?,?,?)
           ON CONFLICT(wallet) DO UPDATE SET last_seen=excluded.last_seen""",
        [(w, source, now, now) for w in wallets if w],
    )
    db.commit()


def remember_runner_wallets(db: sqlite3.Connection, token: str, wallets: list[str]) -> None:
    remember_candidates(db, wallets, f"runner:{token}")
    now = int(time.time())
    db.executemany(
        """INSERT INTO candidate_sources(wallet, token, source_rank, seen_at) VALUES(?,?,?,?)
           ON CONFLICT(wallet, token) DO UPDATE SET source_rank=excluded.source_rank, seen_at=excluded.seen_at""",
        [(wallet, token, rank, now) for rank, wallet in enumerate(wallets, 1)],
    )
    db.commit()


def remember_events(db: sqlite3.Connection, events: list[dict[str, Any]]) -> None:
    rows = []
    for event in events:
        tx_hash, maker, token = event.get("transaction_hash"), event.get("maker"), event.get("base_address")
        if tx_hash and maker and token:
            rows.append((tx_hash, maker, token, int(event.get("timestamp") or 0), json.dumps(event, separators=(",", ":"))))
    db.executemany("INSERT OR IGNORE INTO events VALUES(?,?,?,?,?)", rows)
    db.commit()


def batch(items: list[str], size: int = 100):
    for index in range(0, len(items), size):
        yield items[index:index + size]


def profile_candidates(client: GMGN, db: sqlite3.Connection, cfg: dict[str, Any], max_wallets: int) -> None:
    min_appearances = cfg["discovery"]["min_runner_appearances"]
    wallets = [row[0] for row in db.execute(
        """SELECT c.wallet FROM candidates c
           JOIN candidate_sources s ON s.wallet=c.wallet
           LEFT JOIN profiles p ON p.wallet=c.wallet
           GROUP BY c.wallet HAVING COUNT(DISTINCT s.token) >= ?
           ORDER BY (p.wallet IS NOT NULL) ASC, COUNT(DISTINCT s.token) DESC, c.last_seen DESC LIMIT ?""",
        (min_appearances, max_wallets),
    )]
    if not wallets:
        print(f"No wallets appeared among top traders of at least {min_appearances} distinct runners. Nothing to profile.")
        return
    period_rows: dict[str, dict[str, dict[str, Any]]] = {p: {} for p in ("7d", "30d", "all")}
    try:
        for group in batch(wallets):
            for period in period_rows:
                period_rows[period].update(client.profits(cfg["chain"], group, period))
    except GMGNError as exc:
        print(f"Stopped before wallet profiling: {exc}", file=sys.stderr)
        return

    for index, wallet in enumerate(wallets, 1):
        profits = {period: rows.get(wallet, {}) for period, rows in period_rows.items()}
        try:
            stats = client.stats(cfg["chain"], wallet)
            activity = client.activity(cfg["chain"], wallet)
            verdict = score_wallet(profits, stats, activity, cfg["wallet"])
        except GMGNError as exc:
            print(f"[{index}/{len(wallets)}] {wallet}: profile error: {exc}", file=sys.stderr)
            if is_rate_limit(exc):
                print("Rate limit reached; saved completed profiles and stopped to avoid extending the cooldown.", file=sys.stderr)
                break
            continue
        funder = ((stats.get("common") or {}).get("fund_from_address")) or None
        payload = {"profits": profits, "stats": stats, "activity": activity, "verdict": verdict.__dict__}
        db.execute(
            """INSERT INTO profiles VALUES(?,?,?,?,?,?)
               ON CONFLICT(wallet) DO UPDATE SET passed=excluded.passed, score=excluded.score,
               funder=excluded.funder, assessed_at=excluded.assessed_at, payload=excluded.payload""",
            (wallet, int(verdict.passed), verdict.score, funder, int(time.time()), json.dumps(payload, separators=(",", ":"))),
        )
        db.commit()
        print(f"[{index}/{len(wallets)}] {'QUALIFIED' if verdict.passed else 'rejected':9} {verdict.score:5.1f} {wallet}")


def rescore_profiles(db: sqlite3.Connection, cfg: dict[str, Any]) -> None:
    rows = db.execute("SELECT wallet, payload FROM profiles ORDER BY wallet").fetchall()
    for row in rows:
        payload = json.loads(row["payload"])
        verdict = score_wallet(payload.get("profits", {}), payload.get("stats", {}), payload.get("activity", []), cfg["wallet"])
        payload["verdict"] = verdict.__dict__
        db.execute(
            "UPDATE profiles SET passed=?, score=?, assessed_at=?, payload=? WHERE wallet=?",
            (int(verdict.passed), verdict.score, int(time.time()), json.dumps(payload, separators=(",", ":")), row["wallet"]),
        )
        print(f"{'QUALIFIED' if verdict.passed else 'rejected':9} {verdict.score:5.1f} {row['wallet']}")
    db.commit()


def catalysts(cfg: dict[str, Any]) -> dict[str, Any]:
    path = ROOT / cfg.get("catalysts_file", "catalysts.json")
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    now = int(time.time())
    return {address: item for address, item in data.items() if not item.get("expires_at") or item["expires_at"] > now}


def qualified_events(db: sqlite3.Connection, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    qualified = {row[0] for row in db.execute("SELECT wallet FROM profiles WHERE passed=1")}
    return [event for event in events if event.get("maker") in qualified]


def independent_funders(db: sqlite3.Connection, wallets: list[str]) -> int:
    identities: set[str] = set()
    for wallet in wallets:
        row = db.execute("SELECT funder FROM profiles WHERE wallet=? AND passed=1", (wallet,)).fetchone()
        identities.add((row[0] if row and row[0] else f"wallet:{wallet}"))
    return len(identities)


def evaluate_cluster(client: GMGN, db: sqlite3.Connection, cfg: dict[str, Any], cluster: dict[str, Any]) -> dict[str, Any]:
    c_cfg = cfg["cluster"]
    cluster["max_price_chase_ratio"] = c_cfg["max_price_chase_ratio"]
    failures = []
    if cluster["aggregate_buy_usd"] < c_cfg["min_aggregate_buy_usd"]:
        failures.append("aggregate tracked buy is too small")
    if cluster["median_buy_usd"] < c_cfg["min_median_buy_usd"]:
        failures.append("median tracked buy is too small")
    funders = independent_funders(db, cluster["wallets"])
    if funders < c_cfg["min_independent_funders"]:
        failures.append(f"only {funders} independent funding sources")

    info = client.token_info(cfg["chain"], cluster["address"])
    security = client.token_security(cfg["chain"], cluster["address"])
    pool = client.token_pool(cfg["chain"], cluster["address"])
    token_verdict = score_token(info, security, pool, cluster, cfg["token"])
    failures.extend(reason for reason in token_verdict.reasons if reason.startswith("FAIL "))
    failures.extend(token_verdict.warnings)

    catalyst_data = catalysts(cfg)
    catalyst = catalyst_data.get(f"{cfg['chain']}:{cluster['address']}") or catalyst_data.get(cluster["address"])
    tier = "REJECT"
    if not failures and token_verdict.passed:
        tier = "CALL" if catalyst or not cfg.get("require_catalyst_for_call", True) else "RESEARCH"
    return {
        "tier": tier,
        "chain": cfg["chain"],
        "address": cluster["address"],
        "symbol": cluster.get("symbol"),
        "wallet_count": cluster["wallet_count"],
        "independent_funders": funders,
        "aggregate_buy_usd": round(cluster["aggregate_buy_usd"], 2),
        "median_buy_usd": round(cluster["median_buy_usd"], 2),
        "window_seconds": cluster["last_timestamp"] - cluster["first_timestamp"],
        "wallets": cluster["wallets"],
        "token_score": token_verdict.score,
        "token_reasons": token_verdict.reasons,
        "warnings": token_verdict.warnings,
        "failures": failures,
        "catalyst": catalyst,
        "invalidation": "Downgrade immediately if qualified wallets distribute, liquidity falls below threshold, or catalyst is disproven/expired.",
    }


def scan(client: GMGN, db: sqlite3.Connection, cfg: dict[str, Any], limit: int) -> list[dict[str, Any]]:
    events = client.track(cfg["chain"], limit)
    remember_events(db, events)
    remember_candidates(db, sorted({e.get("maker") for e in events if e.get("maker")}), "smartmoney-feed")
    q_events = qualified_events(db, events)
    clusters = cluster_events(q_events, cfg["cluster"])
    output = []
    for cluster in clusters:
        result = evaluate_cluster(client, db, cfg, cluster)
        db.execute(
            "INSERT OR IGNORE INTO alerts VALUES(?,?,?,?,?)",
            (result["address"], cluster["first_timestamp"], result["tier"], json.dumps(result, separators=(",", ":")), int(time.time())),
        )
        output.append(result)
    db.commit()
    return output


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description="High-precision GMGN wallet-cluster research tracker (never places trades).")
    cli.add_argument("--config", type=Path, default=ROOT / "config.json")
    cli.add_argument("--chain", choices=("sol", "bsc", "base", "robinhood", "eth", "arc", "stable"), help="Operate on one enabled chain")
    cli.add_argument("--all-chains", action="store_true", help="Operate on every enabled chain (not valid for address-specific commands)")
    sub = cli.add_subparsers(dest="command", required=True)
    seed = sub.add_parser("seed-token", help="Add the top traders of a known runner to the profiling queue")
    seed.add_argument("address")
    discover = sub.add_parser("discover-runners", help="Find current filtered runners and cross-check their top traders")
    discover.add_argument("--limit", type=int, help="Override the configured runner count for this pass")
    profile = sub.add_parser("profile", help="Profile queued wallets across 7d/30d/all horizons")
    profile.add_argument("--max-wallets", type=int, default=25)
    sub.add_parser("rescore", help="Reapply current thresholds to stored profile data without API calls")
    scan_cmd = sub.add_parser("scan", help="Scan one recent Smart Money page using the qualified roster")
    scan_cmd.add_argument("--limit", type=int, default=200)
    evaluate = sub.add_parser("evaluate-token", help="Run token gates for a contract address (without inventing a cluster)")
    evaluate.add_argument("address")
    sub.add_parser("roster", help="Print the currently qualified wallet roster")
    return cli


def run_for_chain(args: argparse.Namespace, base_cfg: dict[str, Any], chain: str) -> int:
    cfg = config_for_chain(base_cfg, chain)
    db = connect(database_path(base_cfg, chain))
    if args.command == "roster":
        rows = db.execute("SELECT wallet, score, assessed_at FROM profiles WHERE passed=1 ORDER BY score DESC").fetchall()
        for row in rows:
            print(f"{row['score']:5.1f}  {row['wallet']}  assessed={row['assessed_at']}")
        print(f"qualified_wallets={len(rows)}")
        return 0
    if args.command == "rescore":
        rescore_profiles(db, cfg)
        return 0

    client = GMGN()
    if args.command == "discover-runners":
        if args.limit is not None:
            cfg["discovery"]["runner_limit"] = args.limit
        runners = client.trending_runners(cfg)
        for index, runner in enumerate(runners, 1):
            address = runner.get("address")
            if not address:
                continue
            cached = db.execute("SELECT COUNT(*) FROM candidate_sources WHERE token=?", (address,)).fetchone()[0]
            if cached:
                print(f"[{index}/{len(runners)}] {runner.get('symbol') or '?':12} {address} cached={cached}")
                continue
            try:
                traders = client.token_traders(cfg["chain"], address)
            except GMGNError as exc:
                if is_rate_limit(exc):
                    print(f"Rate limited after {index - 1} runners; saved progress. Retry discover-runners after the reset time in the error.", file=sys.stderr)
                    print(str(exc), file=sys.stderr)
                    break
                raise
            wallets = [row.get("address") for row in traders if row.get("address")]
            remember_runner_wallets(db, address, wallets)
            print(f"[{index}/{len(runners)}] {runner.get('symbol') or '?':12} {address} traders={len(wallets)}")
            time.sleep(1.25)
        repeated = db.execute(
            "SELECT COUNT(*) FROM (SELECT wallet FROM candidate_sources GROUP BY wallet HAVING COUNT(DISTINCT token) >= ?)",
            (cfg["discovery"]["min_runner_appearances"],),
        ).fetchone()[0]
        print(f"recurrent_wallet_candidates={repeated}")
    elif args.command == "seed-token":
        traders = client.token_traders(cfg["chain"], args.address)
        wallets = [row.get("address") for row in traders if row.get("address")]
        remember_runner_wallets(db, args.address, wallets)
        print(f"queued {len(wallets)} wallets from {args.address}; run `python3 tracker.py --chain {chain} profile`")
    elif args.command == "profile":
        profile_candidates(client, db, cfg, args.max_wallets)
    elif args.command == "scan":
        results = scan(client, db, cfg, args.limit)
        if not results:
            print(f"No qualified-wallet cluster met the count threshold on {chain}. No call.")
        else:
            print(json.dumps(results, indent=2))
    elif args.command == "evaluate-token":
        info = client.token_info(cfg["chain"], args.address)
        security = client.token_security(cfg["chain"], args.address)
        pool = client.token_pool(cfg["chain"], args.address)
        synthetic_cluster = {"median_entry_price_usd": number((info.get("price") or {}).get("price"), None), "max_price_chase_ratio": cfg["cluster"]["max_price_chase_ratio"]}
        verdict = score_token(info, security, pool, synthetic_cluster, cfg["token"])
        print(json.dumps({"chain": chain, "address": args.address, **verdict.__dict__}, indent=2))
    return 0


def main() -> int:
    args = parser().parse_args()
    base_cfg = load_config(args.config)
    if args.all_chains and args.chain:
        raise SystemExit("Use either --chain or --all-chains, not both")
    if args.all_chains and args.command in {"seed-token", "evaluate-token"}:
        raise SystemExit(f"{args.command} is address-specific; select exactly one --chain")
    chains = base_cfg.get("enabled_chains", [base_cfg.get("default_chain", "sol")]) if args.all_chains else [args.chain or base_cfg.get("default_chain", "sol")]
    exit_code = 0
    for chain in chains:
        if len(chains) > 1:
            print(f"\n=== {chain.upper()} ===")
        try:
            exit_code = max(exit_code, run_for_chain(args, base_cfg, chain))
        except GMGNError as exc:
            print(f"{chain}: {exc}", file=sys.stderr)
            exit_code = 1
            if is_rate_limit(exc):
                return exit_code
            if not args.all_chains:
                break
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
