# On-chain wallet and token discovery system

This guide explains how the complete research and alert system works: how wallets are discovered, how profitable traders are evaluated, how runner tokens are mined for repeat winners, how early tokens and price surges are detected, and how evidence becomes a Telegram alert.

The system is a research scanner. It does not construct, sign, or submit trades. No filter can guarantee zero false positives or zero false negatives.

## 1. Core definitions

The following terms must remain separate:

- **Discovered wallet:** a wallet or Fomo profile returned by a leaderboard, token-holder list, Smart Money feed, KOL feed, followed-wallet feed, or runner trader list. Discovery alone is not a recommendation.
- **Observed profile:** a public Fomo leaderboard profile retained so its history can be examined. An observed profile is not automatically a high-signal tracked wallet.
- **High-return wallet:** a wallet with auditable evidence that at least one token position reached at least 500% using total position return, realized position return, or unrealized position return. The implemented source thresholds are `FOMO_MIN_POSITION_ROI_PERCENT` and `GMGN_MIN_TRENDING_TRADER_ROI_PERCENT`, both 500% by default.
- **Elite observed wallet:** a monitored high-return wallet, or a Fomo leaderboard trader above `FOMO_ELITE_MIN_LEADERBOARD_PNL_USD` (default $100,000), that has not necessarily passed the narrower repeatability sample.
- **Qualified wallet:** a high-return wallet that also passes repeatability, realized-profit, at least 200% 30-day and all-time ROI, sample-size, win-rate, Wilson-bound, trade-frequency, position-size, and noisy-wallet checks. The floor applies per wallet, not merely to the roster average.
- **Tracked-wallet activity:** a recent on-chain buy made by an admitted wallet. A single buy is an activity notice; it is not a token safety verdict.
- **Wallet cluster:** at least `MIN_TRACKED_BUY_WALLETS` distinct admitted wallets buying the same token inside the active lookback. The default is three.
- **Runner:** a token whose historical high market capitalization crossed the runner floor, currently $1 million. Its present market capitalization can be below the floor.
- **Candidate token:** a contract nominated by wallet activity, trending structure, a GMGN signal, Fomo holder activity, or Pons launch activity.
- **RESEARCH:** a candidate that passed configured token checks but has no separately verified catalyst.
- **CALL:** a candidate that passed configured token checks and has an unexpired catalyst in `catalysts.json`.
- **REJECT:** a candidate with a failed or unknown critical token-safety field.

### The 500% admission policy

The intended high-signal roster rule is:

```text
maximum(total position return %, realized position return %, unrealized position return %) >= 500%
```

Dollar PnL alone does not satisfy the position-return rule. Fomo leaderboard profit is retained as a second, explicit elite admission path because managed Fomo addresses and the latest-25 closed-trade sample can materially understate a public trader's history. The qualifying evidence, chain, and discovery source are retained so every admission is auditable.

Fomo stores a broad `tracked_wallets` research report, but the runtime admits only `elite_observed` and `qualified` rows. Plain `observed` leaderboard rows remain available for analysis and do not enter live wallet polling. GMGN uses the same two monitored tiers. A single buyer still produces only `OBSERVE`; elite wallet status does not manufacture cluster confirmation.

## 2. System architecture

The system has two loops sharing MongoDB.

### Independent daily wallet-research jobs

Fomo and GMGN run as separate processes and have separate schedules, logs, reports, and failure domains:

```bash
npm run sync:fomo-wallets:local
npm run scan:gmgn-wallets
```

The Fomo job opens the dedicated local Chrome profile, captures a short-lived bearer and the official mixed-chain trending/most-held responses, scans Fomo leaderboards and holder/trade samples, then writes only the Fomo roster. The GMGN job independently scans GMGN runners and their top traders, then writes only the GMGN roster. Both leave detailed local reports under the gitignored `reports/` directory.

The hosted NestJS process reloads MongoDB roster changes every `MONGO_ROSTER_RELOAD_MS`, five minutes by default.

### Continuous token-signal loop

The NestJS scanner starts immediately and repeats every `SCAN_INTERVAL_MS`, five minutes by default. All collection and delivery is ordered Robinhood, BSC, then Solana:

1. Pull GMGN 5-minute trending rankings and market signals.
2. Pull supported Smart Money, KOL, and followed-wallet activity.
3. Rotate through the `elite_observed` and `qualified` wallet roster using chain-specific budgets (Robinhood 12, BSC 8, Solana 5 by default), retaining both buys and sells.
4. Optionally pull Fomo discovery and Fomo-native recent swaps when a valid bearer is available.
5. Pull Robinhood Pons active launches and recent graduations.
6. Build token candidates and combine independent evidence.
7. Run market and contract gates on the strongest candidates.
8. Publish tracked-wallet activity, trending tokens, confirmed surge events, and serious-potential runners as separate feeds, in that order.
9. Deduplicate eligible Telegram/SSE alerts and maintain two-hour price baselines for whole-number multiple updates.

MongoDB stores subscriptions, admins, roster state, alerts, price samples, metric samples, and multiplier baselines. Local browser state, bearer files, generated reports, and `.env` secrets never belong in Git.

## 3. Fomo profitable-trader discovery

Fomo discovery is API collection from an authenticated first-party session; it is not HTML parsing. Network responses can contain multiple chains, so every token is routed by `networkId`.

### 3.1 Leaderboards

The daily job requests only:

- `GET /v2/leaderboard/24h`
- `GET /v2/leaderboard/7d`
- `GET /v2/leaderboard/30d`

It does not use the general `/v2/leaderboard` route. Profiles are merged by Fomo user ID while preserving:

- 24-hour, 7-day, and 30-day membership;
- rank in each period;
- PnL in each period;
- total volume and trade count;
- top holdings and their profitability;
- follower count, swap count, and number of networks traded.

The leaderboard prefilter rejects private or restricted profiles and defaults to:

| Metric | Default |
|---|---:|
| Best leaderboard PnL | at least $1,000 |
| Total volume | at least $5,000 |
| Trades | at least 30 |
| Profitable top-holding rate | at least 50% |

Leaderboard rank is a discovery feature, not proof of skill. A leaderboard profile still needs token-level high-return evidence and repeatability checks before it should count as a high-signal tracked wallet.

### 3.2 Most-held and trending tokens

The daily job requests:

- `POST /proxy/mostHeld`
- `POST /proxy/trendingTokens`
- batched `GET /hodlers/top?...` requests for token holders

For each holder, the scanner records:

- wallet and Fomo profile ID;
- cost basis and current value;
- total PnL;
- realized and unrealized PnL;
- total, realized, and unrealized return percentage;
- average holding time;
- source token, symbol, network, market cap, liquidity, volume, and price change.

Default holder hygiene gates are:

| Metric | Default |
|---|---:|
| Position return | at least 500% |
| Cost basis | at least $100 |
| Current position value | at least $100 |
| User trades | at least 20 |
| User total volume | at least $1,000 |
| Dev, private, or restricted account | rejected |

Most-held positions do not require a runner ATH floor. Trending-token positions require the token's historical high market cap to have crossed `FOMO_TRENDING_WALLET_MIN_ATH_MARKET_CAP_USD`, $1 million by default. This is an ATH rule, not a current-market-cap rule; retraced runners remain valid research evidence.

### 3.3 Deep Fomo wallet checks

`GET /trades?userId=...` provides the latest closed-trade sample and active positions. The native Fomo quality gate measures:

- realized PnL from recent closed trades;
- realized ROI on deployed cost;
- raw win rate;
- 95% Wilson lower bound for win rate;
- number of closed trades in the sample;
- median position cost;
- number of unique active tokens;
- whether the returned closed sample appears complete.

Default requirements include at least 10 closed trades, $500 realized PnL, 5% ROI, 40% raw win rate, 0.25 Wilson lower bound, $50 median cost, and no more than 60 active tokens. These gates combat one-hit wonders, tiny lucky samples, dust-size entries, and spray behavior.

When `FOMO_GMGN_VALIDATION=true`, the job also checks GMGN 7-day, 30-day, and all-time realized profitability. It is disabled by default because Fomo-managed addresses have often returned no indexed GMGN activity while consuming GMGN quota.

### 3.4 Continuous Fomo activity

With a valid bearer, `GET /v2/users/:id/swaps?limit=100` supplies recent Fomo-native activity. A row counts as a buy only when `outTradeId` exists; the purchased contract is `outTokenAddress`. Updated position timestamps are never treated as purchases.

Only swaps newer than `SIGNAL_LOOKBACK_SECONDS`, 30 minutes by default, enter candidate clustering. Calls are deduplicated by wallet and contract.

If the hosted service has no valid `FOMO_TOKEN`, the local daily job can still refresh wallet research in MongoDB, and Railway can monitor address activity through GMGN. It cannot see Fomo-native swaps that GMGN does not index. Daily roster renewal and real-time Fomo-native monitoring are different capabilities.

## 4. GMGN profitable-trader discovery

### 4.1 Runner universe

For every enabled chain, the daily GMGN job requests the top 100 tokens from the 24-hour trending ranking ordered by volume. It retains only tokens whose best evidenced historical market cap crossed `GMGN_RUNNER_MIN_ATH_MARKET_CAP_USD`, $1 million by default.

Historical market cap is the maximum available value from:

- reported historical-high market cap;
- reported ATH market cap;
- current market cap as a lower bound;
- ATH price multiplied by circulating or total supply when available.

The current market cap can be below $1 million. This allows the system to learn from runners after they retrace.

### 4.2 Top traders on every runner

For each qualifying runner, the job requests up to 100 traders ordered by profit. A locally clean GMGN trader currently requires:

- a normal wallet address and address type;
- no suspicious, transfer-in, or new-wallet flag;
- no bundler, rat-trader, DEX-bot, sniper, Axiom, Photon, BullX, Trojan, PepeBoost, or Padre tag;
- at least $100 historical bought cost;
- at least $100 realized profit;
- at least 500% realized position ROI;
- at least one current sell transaction;
- no more than 50 current buy transactions.

The wallet is linked to the exact runner contract and its entry evidence. A trending-derived wallet normally needs at least two runner appearances before expensive global validation, preventing one lucky 100x from becoming a roster slot.

GMGN Smart Money, KOL, and personally followed-wallet feeds provide additional discovery and supporting source evidence. Feed membership alone should not replace token-level high-return proof.

### 4.3 Global wallet profitability and behavior

Candidates are checked over 7 days, 30 days, and all time. The current default gates are:

| Metric | Default |
|---|---:|
| 7-day realized profit | at least $0 |
| 30-day realized profit | at least $1,000 |
| All-time realized profit | at least $5,000 |
| 30-day realized ROI | at least 5% |
| All-time realized ROI | at least 2% |
| 30-day trades | 30–5,000 |
| 30-day token count | 20–300 |
| Raw 30-day win rate | at least 40% |
| 95% Wilson win-rate lower bound | at least 35% |
| Unique tokens in latest 100 actions | no more than 60 |
| Median recent buy | at least $50 |

The Wilson lower bound penalizes small samples. Two wallets with the same raw win rate do not receive equal confidence when one has traded only a handful of tokens.

The final wallet score combines 30-day and all-time realized profit, ROI, Wilson confidence, token sample size, non-negative 7-day performance, and repeat pre-move evidence. Wallets sharing the same known funding address are deduplicated so one operator's side wallets do not look like independent conviction.

## 5. Reverse-engineering coins that ran

The runner loop is designed to answer “which wallets repeatedly arrived before expansion?” rather than merely copying current top traders.

For tokens with at least `GMGN_RUNNER_MIN_RENOWNED_COUNT` renowned/KOL wallets, two by default, the job downloads 1-minute candles for the prior 24 hours.

The first runner move is detected when:

- the current 1-minute volume is at least three times the preceding five-candle average; and
- either the candle gains at least 20%, or the trailing five-minute move gains at least 35%.

A trader is marked pre-move only when its first acquisition occurred before that expansion and no more than `GMGN_RUNNER_PRE_MOVE_LEAD_SECONDS`, six hours by default, beforehand.

Pre-move evidence strengthens a wallet score but never qualifies a wallet by itself. The system looks for:

- appearances across multiple runners;
- repeated pre-move entries;
- meaningful position sizes;
- repeat realized profitability after the runner;
- controlled token breadth rather than buying every launch;
- independent funding rather than a related-wallet cluster.

This converts the manual loop—find runner, inspect chart minute by minute, identify early buyers, validate wallets, repeat—into a reproducible daily process.

## 6. Finding early coins that are running

### 6.1 GMGN 5-minute trending discovery

Every scan pulls `market trending` at a 5-minute interval, ordered by volume, for up to `TRENDING_LIMIT` rows per chain. “5-minute trending” means the token appears in GMGN's current 5-minute ranking; it does not mean the token is only five minutes old or that its price rose during those five minutes.

Before chart analysis, a market row must provide acceptable values for:

- token address;
- liquidity;
- market-cap range;
- holder count;
- rug ratio;
- wash-trading and honeypot flags;
- top-10 concentration;
- bundler share;
- insider/rat share;
- entrapment share;
- dev-team share when available.

The top `TRENDING_MULTIWINDOW_CHECK_LIMIT_PER_CHAIN`, ten by default, are examined using approximately 65 minutes of 5-minute candles. The analyzer measures:

- 5m, 15m, 30m, and 1h price changes;
- 5m, 15m, 30m, and 1h volume;
- latest volume versus its recent baseline;
- 30-minute volume coefficient of variation;
- 15-minute volume/liquidity turnover;
- short-versus-long moving structure;
- 1-hour drawdown from the range high;
- intrabar volatility;
- distance from the range low;
- buy/sell ratio;
- Smart Money and renowned-wallet participation;
- current market-cap bonus for early-range tokens.

Positive price change is not required. Persistent volume, stable structure, and contained drawdown can qualify a flat or mildly red token. Breakdown and slow-bleed patterns are hard failures.

The default multi-window gate requires:

- stability score at least 60;
- 15-minute volume at least $50,000;
- 1-hour drawdown no greater than 45%;
- 1-hour candle volatility ratio no greater than 0.30;
- 30-minute return no worse than -30%;
- no breakdown or slow-bleed pattern.

The cross-chain Telegram digest returns the top ten passing tokens ranked by stability score and persistent volume.

### 6.2 Fomo early-token discovery

When a valid Fomo bearer is available, most-held and trending tokens can nominate candidates when they have eligible high-return holders and satisfy liquidity, market-cap, and 24-hour volume gates. Fomo strengthens capital evidence but does not bypass contract checks.

### 6.3 Robinhood Pons discovery

Pons discovery collects active bonding-curve launches and recent graduations. It tracks price and graduation progress locally, then labels:

- new active launches;
- near-graduation launches;
- just-graduated tokens;
- 5-minute and 30-minute price surges;
- 30-minute graduation-progress surges.

Default Pons thresholds are 30% in 5 minutes, 100% in 30 minutes, five graduation-progress points in 30 minutes, 50% curve progress for near graduation, a recent buy within 15 minutes, graduation within six hours, and at least $3,000 market cap for a new active launch. GMGN K-line confirmation is capped to preserve rate-limit headroom.

## 7. Price-surge detection

Price surge is not one signal; it is a set of independent detectors.

### GMGN market-signal events

The scanner consumes recent GMGN signal types:

- type 6: price surge;
- type 7: new ATH;
- type 12: Smart Money.

Only events inside `SIGNAL_LOOKBACK_SECONDS` are considered. Normal candidates must pass the standard market gate. In high-risk discovery mode, recent signal events are added only when their market cap is at or below `DEGEN_MAX_MARKET_CAP_USD`, $100,000 by default.

### Measured trending momentum

A trending token receives momentum evidence when either:

- its 5-minute price change is at least `MIN_PRICE_SURGE_5M_PERCENT`, 10% by default, and its 5-minute volume is at least $25,000; or
- its measured 30-minute price increase reaches `TRENDING_30M_PRICE_INCREASE_PERCENT`, 100% by default.

Market cap at or below $500,000 adds an early-range signal but is not sufficient by itself. Three or more Smart Money wallets add separate capital evidence.

### High-risk discovery mode

High-risk discovery includes ordinary trending rows that failed normal filters plus qualifying microcap signal events. Rows are ranked by:

1. microcap status;
2. price-surge, new-ATH, and Smart Money priority;
3. momentum;
4. volume/market-cap turnover;
5. raw volume.

The feed is explicitly a watchlist. A filtered-out token has not passed the contract and market gates.

### Multiple monitoring

Tokens actually displayed in trending or high-risk discovery receive a persistent initial price baseline for two hours. The market-signal trigger is polled every 15 seconds by default, while the five-minute scan provides a fallback. A fresh token and contract evaluation is performed before a new whole-number `2X`, `3X`, and later milestone alert. Continuous rediscovery does not reset the baseline; rearming defaults to one day after the token disappears.

## 8. Candidate evidence and token safety

Candidate sources have different signal weights. Current high-value evidence includes multi-window stability, Smart Money signals, followed/tracked-wallet activity, Fomo leaderboard or tracked-wallet activity, and multi-wallet Smart Money/KOL participation. Twitter contributes context only and cannot nominate a token without capital confirmation.

A rich candidate must have a market snapshot, capital confirmation, and a signal-strength score of at least `MIN_SIGNAL_STRENGTH`, three by default. Only the top `MAX_CANDIDATES_PER_CHAIN`, five by default, receive the expensive full token evaluation in each cycle.

The full token evaluation checks:

- liquidity of at least $50,000;
- current market cap from $100,000 to $20 million;
- at least 300 holders;
- at least $25,000 volume in five minutes;
- top-10 concentration no greater than 30%;
- dev-team holding no greater than 10%;
- bundler share no greater than 15%;
- bot share no greater than 20%;
- insider/rat share no greater than 5%;
- entrapment share no greater than 15%;
- a configured price-chase ceiling of 15%.
- chain-specific authority, honeypot, source-verification, ownership, tax, and liquidity-lock requirements.

Unknown critical fields fail closed. Solana requires renounced mint and freeze authority. BSC, Base, and Robinhood require a non-honeypot, verified source, renounced ownership, locked liquidity, and acceptable buy/sell taxes.

The token scorer supports comparing current price with a median tracked entry. The continuous candidate path currently supplies the current price as that reference, so its live price-chase result is effectively neutral rather than a true wallet-entry measurement. Do not cite price-chase protection as fully implemented until candidate events propagate their actual median entry price into the scorer.

## 9. Alerts

The system can publish:

- **Tracked-wallet buy:** one or more admitted wallets bought a contract. Activity evidence only.
- **Wallet cluster:** at least three distinct admitted wallets bought the same contract; four or more is labelled strong.
- **Trending digest:** up to ten tokens with persistent multi-window quality across all scheduled chains.
- **High-risk discovery digest:** up to the configured cap, emphasizing Robinhood and sub-$100,000 launches/surges.
- **RESEARCH:** all required token gates passed, but there is no verified catalyst.
- **CALL:** all required token gates passed and a current catalyst exists.
- **Multiple:** a displayed token crossed a new whole-number multiple from the bot's original baseline and was rechecked.

Activity notices and high-risk discovery rows are intentionally less strict than RESEARCH/CALL cards. A wallet buy is not evidence that the token can be sold safely.

## 10. Rate limiting and deduplication

GMGN requests pass through a weighted leaky-bucket limiter with persistent cooldown state. Defaults use eight units per second and an eight-unit burst, leaving headroom below GMGN's documented ceiling. A 429 or ban timestamp stops queued work until the reset plus a safety buffer. Repeated requests are not sent during cooldown.

Additional controls include:

- rotating tracked-wallet batches, 25 wallets per chain by default;
- capped K-line and Pons enrichment probes;
- sequential chain scans;
- six-hour rich-alert cooldown;
- 30-minute tracked-wallet activity/cluster cooldown;
- source-ID and distinct-wallet deduplication;
- one active scanner operation per chain.

## 11. Operating the system

### Daily local research

```bash
npm run sync:fomo-wallets:local
npm run scan:gmgn-wallets
```

These are separate processes and should be separate LaunchAgents/crons with separate logs. Fomo runs at 03:15 and GMGN at 03:30 in the supplied templates; neither waits for or invokes the other. The machine must be awake with a logged-in desktop session for the Fomo process. Verify each resulting report independently rather than assuming a zero-row scan succeeded.

### Continuous hosted process

```bash
npm start
```

Use one Railway replica, MongoDB Atlas, `FOMO_BROWSER_SESSION=false`, and `DAILY_WALLET_REFRESH_ENABLED=false`. Leave Railway Serverless disabled. On the local always-on bot, set `FOMO_BROWSER_SESSION=true` only when continuous Fomo-native swap monitoring is required; the dedicated signed-in Chrome profile then renews the short-lived bearer. If only daily roster refresh is needed, leave it `false` and let `npm run sync:fomo-wallets:local` attach to Chrome for the refresh and close afterward.

### Manual checks

```bash
npm run scan:daily-wallets
npm run scan:gmgn-wallets
npm run scan:fomo-wallets
npm run scan:signals
npm test
npm run typecheck
```

Use Telegram `/status`, `/roster all`, `/check <contract>`, and admin `/scan all` to verify runtime behavior.

## 12. Review checklist

Before treating a wallet as high signal, verify:

1. The exact contract and chain for its 500%+ position are stored.
2. The return is computed from a nonzero cost basis.
3. Realized and unrealized components are not conflated.
4. The wallet appears across multiple independent winners or has a sufficiently strong closed-trade sample.
5. Its raw win rate survives Wilson adjustment.
6. It is not a bot, bundler, sniper, transfer-in wallet, spray wallet, or related side wallet counted as independent.
7. Recent position size is meaningful.
8. Its profits are not solely one outlier.

Before treating a token as actionable, verify:

1. The contract address and chain are exact.
2. Wallet evidence is recent and distinct.
3. Liquidity, volume, holder count, and concentration remain acceptable.
4. Contract safety fields are known and passing.
5. The move is early enough that price-chase risk is controlled.
6. There is a plausible catalyst or thesis.
7. Invalidation is defined before entry.

The system finds contracts worth investigating. It does not replace position sizing, execution checks, or risk management.
