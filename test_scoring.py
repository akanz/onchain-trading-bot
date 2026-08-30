import unittest
import json
from pathlib import Path

from scoring import cluster_events, score_token, score_wallet, wilson_lower_bound
from tracker import config_for_chain, database_path


WALLET_CFG = {
    "min_realized_profit_7d": 0,
    "min_realized_profit_30d": 1000,
    "min_realized_profit_all": 5000,
    "min_roi_30d": 0.05,
    "min_roi_all": 0.02,
    "min_trades_30d": 30,
    "max_trades_30d": 5000,
    "min_tokens_30d": 20,
    "max_tokens_30d": 300,
    "min_win_rate_30d": 0.4,
    "min_wilson_win_rate_30d": 0.35,
    "max_unique_tokens_in_100_actions": 60,
    "min_median_buy_usd": 50,
}


class ScoringTests(unittest.TestCase):
    def test_wilson_shrinks_small_samples(self):
        self.assertLess(wilson_lower_bound(1, 1), 0.3)
        self.assertGreater(wilson_lower_bound(70, 100), 0.59)

    def test_smart_label_does_not_rescue_losing_wallet(self):
        profits = {
            "7d": {"realized_profit": "-20"},
            "30d": {"realized_profit": "-3291", "realized_profit_cost": "268223", "buy": 3683, "sell": 3203},
            "all": {"total_realized_profit": "9849", "total_realized_profit_cost": "1037043"},
        }
        stats = {"pnl_stat": {"token_num": 755, "winrate": 0.29}}
        activity = [{"event_type": "buy", "cost_usd": 100, "token": {"address": f"t{i}"}} for i in range(20)]
        self.assertFalse(score_wallet(profits, stats, activity, WALLET_CFG).passed)

    def test_cluster_requires_distinct_wallets(self):
        cfg = {"window_seconds": 300, "min_qualified_wallets": 4}
        events = []
        for index, wallet in enumerate(["a", "a", "b", "c"]):
            events.append({"side": "buy", "is_open_or_close": 0, "base_address": "token", "maker": wallet, "timestamp": 100 + index, "amount_usd": 100, "price_usd": 1})
        self.assertEqual(cluster_events(events, cfg), [])

    def test_profitable_launch_sprayer_is_rejected(self):
        profits = {
            "7d": {"realized_profit": "61976"},
            "30d": {"realized_profit": "112342", "realized_profit_cost": "887000", "buy": 2100, "sell": 2025},
            "all": {"total_realized_profit": "112342", "total_realized_profit_cost": "887000"},
        }
        stats = {"pnl_stat": {"token_num": 1021, "winrate": 0.457}}
        activity = [{"event_type": "buy", "cost_usd": 612, "token": {"address": f"t{i % 6}"}} for i in range(20)]
        verdict = score_wallet(profits, stats, activity, WALLET_CFG)
        self.assertFalse(verdict.passed)
        self.assertTrue(any("spray ceiling" in reason and reason.startswith("FAIL") for reason in verdict.reasons))

    def test_bot_heavy_token_is_rejected(self):
        info = {
            "price": {"price": "0.00003", "volume_5m": "72440"},
            "circulating_supply": "1000000000",
            "holder_count": 169,
            "stat": {"top_10_holder_rate": "0.2169", "dev_team_hold_rate": "0.1429", "top_bundler_trader_percentage": "0.3899", "bot_degen_rate": "0.4095", "top_rat_trader_percentage": "0.0002"},
        }
        security = {"renounced_mint": True, "renounced_freeze_account": True, "top_10_holder_rate": "0.2169"}
        pool = {"liquidity": "20519"}
        cfg = {"min_liquidity_usd": 50000, "min_market_cap_usd": 100000, "max_market_cap_usd": 20000000, "min_holders": 300, "min_volume_5m_usd": 25000, "max_top_10_holder_rate": 0.3, "max_dev_team_hold_rate": 0.1, "max_bundler_rate": 0.15, "max_bot_rate": 0.2, "max_rat_trader_rate": 0.05, "require_renounced_mint": True, "require_renounced_freeze": True}
        cluster = {"median_entry_price_usd": 0.00003, "max_price_chase_ratio": 0.15}
        self.assertFalse(score_token(info, security, pool, cluster, cfg).passed)


class MultiChainConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads((Path(__file__).parent / "config.json").read_text(encoding="utf-8"))

    def test_evm_and_solana_gates_are_distinct(self):
        sol = config_for_chain(self.config, "sol")["token"]
        bsc = config_for_chain(self.config, "bsc")["token"]
        self.assertTrue(sol["require_renounced_mint"])
        self.assertFalse(sol["require_honeypot_false"])
        self.assertFalse(bsc["require_renounced_mint"])
        self.assertTrue(bsc["require_honeypot_false"])

    def test_each_non_sol_chain_has_an_isolated_database(self):
        self.assertEqual(database_path(self.config, "sol").name, "tracker.sqlite3")
        self.assertEqual(database_path(self.config, "base").name, "tracker.base.sqlite3")
        self.assertEqual(database_path(self.config, "robinhood").name, "tracker.robinhood.sqlite3")

    def test_clean_evm_token_passes_evm_specific_gates(self):
        info = {
            "price": {"price": "0.001", "volume_5m": "80000"},
            "circulating_supply": "1000000000",
            "holder_count": 2500,
            "stat": {
                "top_10_holder_rate": "0.12",
                "dev_team_hold_rate": "0.01",
                "top_bundler_trader_percentage": "0.02",
                "bot_degen_rate": "0.03",
                "top_rat_trader_percentage": "0.01",
                "top_entrapment_trader_percentage": "0.02",
            },
        }
        security = {
            "is_honeypot": False,
            "is_open_source": True,
            "is_renounced": True,
            "buy_tax": "0",
            "sell_tax": "0.01",
            "top_10_holder_rate": "0.12",
            "lock_summary": {"is_locked": True},
        }
        pool = {"liquidity": "150000"}
        cfg = {
            "min_liquidity_usd": 50000, "min_market_cap_usd": 100000,
            "max_market_cap_usd": 20000000, "min_holders": 300,
            "min_volume_5m_usd": 25000, "max_top_10_holder_rate": 0.3,
            "max_dev_team_hold_rate": 0.1, "max_bundler_rate": 0.15,
            "max_bot_rate": 0.2, "max_rat_trader_rate": 0.05,
            "max_entrapment_rate": 0.15, "max_buy_tax": 0.05,
            "max_sell_tax": 0.05, "require_renounced_mint": False,
            "require_renounced_freeze": False, "require_honeypot_false": True,
            "require_open_source": True, "require_owner_renounced": True,
            "require_liquidity_locked": True,
        }
        cluster = {"median_entry_price_usd": 0.001, "max_price_chase_ratio": 0.15}
        self.assertTrue(score_token(info, security, pool, cluster, cfg).passed)

    def test_evm_honeypot_is_rejected(self):
        info = {
            "price": {"price": "0.001", "volume_5m": "80000"},
            "circulating_supply": "1000000000", "holder_count": 2500,
            "stat": {"top_10_holder_rate": "0.12", "dev_team_hold_rate": "0.01", "top_bundler_trader_percentage": "0.02", "bot_degen_rate": "0.03", "top_rat_trader_percentage": "0.01", "top_entrapment_trader_percentage": "0.02"},
        }
        security = {"is_honeypot": True, "is_open_source": True, "is_renounced": True, "buy_tax": "0", "sell_tax": "0", "top_10_holder_rate": "0.12", "lock_summary": {"is_locked": True}}
        pool = {"liquidity": "150000"}
        cfg = {"min_liquidity_usd": 50000, "min_market_cap_usd": 100000, "max_market_cap_usd": 20000000, "min_holders": 300, "min_volume_5m_usd": 25000, "max_top_10_holder_rate": 0.3, "max_dev_team_hold_rate": 0.1, "max_bundler_rate": 0.15, "max_bot_rate": 0.2, "max_rat_trader_rate": 0.05, "max_entrapment_rate": 0.15, "max_buy_tax": 0.05, "max_sell_tax": 0.05, "require_renounced_mint": False, "require_renounced_freeze": False, "require_honeypot_false": True, "require_open_source": True, "require_owner_renounced": True, "require_liquidity_locked": True}
        cluster = {"median_entry_price_usd": 0.001, "max_price_chase_ratio": 0.15}
        self.assertFalse(score_token(info, security, pool, cluster, cfg).passed)


if __name__ == "__main__":
    unittest.main()
