import { signalStrength, type SignalCandidate } from "../signals.js";
import type { Alert, Chain, Json, TokenSnapshot, Verdict } from "../types.js";

interface CandidateAlertInput {
  chain: Chain;
  candidate: SignalCandidate;
  snapshot: TokenSnapshot;
  verdict: Verdict;
  catalyst: unknown;
  requireCatalyst: boolean;
  nowSeconds?: number;
}

export function alertTier(
  verdict: Verdict,
  catalyst: unknown,
  requireCatalyst: boolean,
): Alert["tier"] {
  const failures = verdict.reasons.filter((reason) => reason.startsWith("FAIL "));
  if (!verdict.passed || failures.length || verdict.warnings.length) return "REJECT";
  return catalyst || !requireCatalyst ? "CALL" : "RESEARCH";
}

function alertSymbol(snapshot: TokenSnapshot, candidate: SignalCandidate): Partial<Alert> {
  if (snapshot.symbol) return { symbol: snapshot.symbol };
  return candidate.symbol ? { symbol: candidate.symbol } : {};
}

export function buildCandidateAlert(input: CandidateAlertInput): Alert {
  const { chain, candidate, snapshot, verdict, catalyst, requireCatalyst } = input;
  const market: Json = candidate.market ?? {};
  const failures = [
    ...verdict.reasons.filter((reason) => reason.startsWith("FAIL ")),
    ...verdict.warnings,
  ];
  const tier = alertTier(verdict, catalyst, requireCatalyst);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  return {
    tier,
    chain,
    address: candidate.address,
    ...alertSymbol(snapshot, candidate),
    name: snapshot.name,
    wallet_count: candidate.wallets.size,
    tracked_buy_wallet_count: candidate.buyWallets.size,
    independent_funders: candidate.wallets.size,
    aggregate_buy_usd: Math.round(candidate.aggregateBuyUsd * 100) / 100,
    median_buy_usd: 0,
    window_seconds: Math.max(0, nowSeconds - candidate.firstTimestamp),
    wallets: [...candidate.wallets],
    traders: [...(candidate.traderLabels ?? [])],
    sources: [...candidate.sources],
    signal_strength: signalStrength(candidate),
    twitter_accounts: [...candidate.twitterAccounts],
    surge_attribution: candidate.surgeAttribution,
    market_cap: snapshot.marketCap ?? market.market_cap,
    liquidity: snapshot.liquidity ?? market.liquidity,
    price_change_5m: market.price_change_percent5m ?? market.price_change_5m,
    token_score: verdict.score,
    token_reasons: verdict.reasons,
    warnings: verdict.warnings,
    failures,
    catalyst,
    token_snapshot: snapshot,
    invalidation:
      "Downgrade if tracked wallets distribute, liquidity falls below threshold, momentum reverses, or contract safety changes.",
  };
}
