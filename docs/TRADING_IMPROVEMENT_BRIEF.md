# Trading Bot Improvement Brief

## Goal

Improve realized profitability while detecting credible runners earlier. Preserve the fail-closed rug/honeypot checks. Treat discovery, tradeability, and conviction as separate concepts.

## Current signal model

- `OBSERVE`: one tracked wallet bought.
- `POTENTIAL`: two distinct tracked wallets bought.
- `BUY SIGNAL`: at least three distinct tracked wallets bought.
- Fomo and GMGN provide wallet activity.
- Pons and GMGN trending provide early-launch, graduation, price, and volume discovery.
- Unsafe tokens may appear only in explicitly labelled high-risk discovery; they must never become actionable calls.

## 2026-08-30 baseline

Source: `ChatExport_2026-08-30/messages.html` and `messages2.html`, covering 09:01–23:23 WAT. Collector/admin chatter was excluded. Results are observed maximums from chat snapshots, not realized P&L.

| Metric | Result |
|---|---:|
| Bot messages | 1,339 (94/hour) |
| Unique contracts | 700 |
| Mature contracts with at least 2h observation | 627 |
| Observed 2x+ | 66 / 627 (10.5%) |
| Observed 5x+ | 15 / 627 (2.4%) |
| Explicit milestone runners | 63 |
| Milestone runners fully passing safety | 2 / 63 |

Signal findings:

| Segment | Mature sample | 2x+ rate |
|---|---:|---:|
| One wallet (`OBSERVE`) | 113 | 6.2% |
| Two wallets (`POTENTIAL`) | 20 | 0% |
| Three+ wallets (`BUY SIGNAL`) | 8 | 37.5% |
| Pons active/pre-graduation | 30 | 20.0% |
| Pons already graduated | 61 | 13.1% |

Entry-market-cap findings:

| Entry MC | 2x+ rate |
|---|---:|
| Below $10K | 6.1% |
| $10K–$25K | 13.7% |
| $25K–$100K | 13.8% |
| $100K–$500K | 3.8% |
| Above $500K | 0% |

The strongest current hypothesis is that **three independently funded, historically profitable wallets entering between $10K and $100K** is more useful than raw price momentum. Samples are small and must be validated prospectively.

## Required trading context

Before changing thresholds, obtain explicit decisions from the operator:

- target chains and launchpads;
- maximum acceptable entry market cap and slippage;
- intended holding period;
- stop-loss and take-profit ladder;
- whether high-risk discovery is informational or tradeable;
- minimum liquidity, holder count, and liquidity/MC ratio;
- risk per trade and maximum concurrent positions;
- acceptable alert frequency;
- whether wallet P&L should be realized-only or realized plus unrealized;
- definition of an independent wallet/funder;
- minimum history required to label a developer or cabal as good.

Never infer profitability from ATH or maximum observed multiple alone.

## Priority improvements

### 1. Create a durable call-performance ledger

For every first observation, store chain, contract, source, entry timestamp, price, MC, liquidity, holder data, safety result, graduation state/progress, developer, full wallet set, funders, and 5m/15m/30m volume. Snapshot price at 5m, 15m, 30m, 1h, 2h, 6h, and 24h. Record maximum gain, maximum drawdown, rug/sellability status, and simulated exit results.

### 2. Reduce noise

- Send immediate alerts only for material conviction changes.
- Move ordinary one-wallet observations and repeated Pons cards into a digest.
- Do not send empty trending cycles.
- Re-emit only after graduation, a new independent wallet, a material MC increase, a safety upgrade, or a new multiple.
- Redact admin-invitation tokens from exports.

### 3. Track good developers

Score creator history using launch count, graduation rate, 2x/5x rate from a consistent baseline, median ATH, liquidity survival at 6h/24h, holder retention, rug rate, developer selling, and repeat participation by profitable independent wallets. Do not label a developer good from one launch; require a meaningful sample (normally at least 3–5 launches) and zero confirmed rugs.

### 4. Detect cabal wallets

Build a wallet co-buy graph. Add an edge when wallets buy the same launch within a short window, especially before graduation. Score repeated profitable co-occurrence, entry lead time, median entry MC, exit behavior, and independent funding. Collapse same-funder/Sybil wallets and penalize bundlers, snipers, transfer-ins, wash trading, identical sizes, and synchronized funding.

### 5. Detect earlier setups without selecting pure noise

Prioritize:

- active tokens around 40%–90% bonding progress with accelerating progress and volume;
- independent wallet accumulation before graduation;
- just-graduated continuation with liquidity and holder growth;
- 35%–60% post-graduation dips where liquidity/holders remain stable, sell velocity decelerates, and cluster buying resumes;
- 5m/15m/30m volume acceleration before price becomes vertical.

Do not equate “earlier” with “lowest MC.” The observed sweet spot was $10K–$100K; sub-$10K calls had lower precision.

## Safety invariants

- Missing/all-zero holder analysis is unavailable, not a safe 0% concentration value.
- Block honeypots, unsellable tokens, malicious contracts, extreme taxes, unsafe authorities, inadequate liquidity, and clear rug evidence.
- Count independently funded wallets, not raw addresses.
- A high-return wallet or developer does not override token safety.
- Keep `OBSERVE`, `POTENTIAL`, and `BUY SIGNAL` separate from `RESEARCH`/`CALL` safety verdicts.

## Prospective evaluation

Avoid tuning solely to this one-day export. Run the revised rules prospectively and compare them with the current baseline. Report by source and confidence tier:

- eligible calls and alert volume;
- 2x/3x/5x hit rates;
- median return and drawdown at fixed horizons;
- rug/unsellable rate;
- entry MC and time relative to graduation;
- simulated realized return under the operator's fixed exit policy;
- confidence intervals for small samples.

The next version should be considered better only if it improves simulated realized expectancy and rug-adjusted precision while materially reducing chat volume—not merely if it discovers more maximum-multiple winners.
