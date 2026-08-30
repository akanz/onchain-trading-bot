# Profitable-wallet on-chain tracker

This is a conservative GMGN research/alert engine for Solana, BSC, Base, and GMGN's Robinhood chain. It never constructs, signs, or submits a trade.

`robinhood` means the on-chain network exposed by GMGN. It does not connect to, inspect, or place orders in a Robinhood brokerage account.

## Documentation

- [Complete system guide](docs/SYSTEM_GUIDE.md): architecture, wallet admission, Fomo and GMGN research, runner analysis, early-token discovery, price surges, safety gates, alerts, and operations.
- [Fomo API research guide](fomo/README.md): authenticated endpoints, mixed-chain normalization, leaderboard/holder analysis, trade samples, and browser-session renewal.
- [Fomo endpoint catalog](fomo/endpoints.json): machine-readable request inventory.

The continuous pipeline is deliberately layered:

1. Seed candidates from GMGN Smart Money, KOL, personally followed-wallet feeds, and traders with at least 500% realized, unrealized, or total position ROI across runner contracts whose ATH market cap crossed $1m. Current market cap is not a discovery floor, so retraced runners remain useful wallet evidence.
2. Monitor every locally clean GMGN high-return wallet as `elite_observed`, then use repeat runner appearances, 7-day, 30-day, and all-time realized P&L; realized ROI; a Wilson-adjusted win rate; trade count; token sample size; and recent bot/spray behavior to upgrade repeatable wallets to `qualified`. Qualification requires at least 200% ROI for both the 30-day and all-time windows; requiring every admitted wallet to clear the floor prevents a few extreme winners from hiding weak wallets behind a misleading group average. KOL-backed runners also receive a 1-minute pre-move timing study; entering before one pump is evidence, never sufficient qualification.
3. Nominate tokens from GMGN trending momentum, price surges, Smart Money signals, Smart Money buys, the account's native followed-wallet feed, and both monitored wallet tiers.
4. Require a complete, safe market snapshot plus capital confirmation before expensive contract checks. Twitter/X can strengthen an existing candidate but can never create an alert by itself.
5. Reject tokens that fail liquidity, market-cap, volume, holder, authority, concentration, bundler, bot, insider, entrapment, or price-chase gates.
6. Deduplicate alerts with a six-hour per-contract cooldown. Emit `CALL` only when a separately verified, unexpired catalyst is present; otherwise a clean setup is `RESEARCH`.

Solana uses mint/freeze-authority gates. BSC, Base, and Robinhood use EVM-style honeypot, blacklist, sellability, verified-source, renounced-owner, tax, and liquidity-lock gates. Every deliverable token must also clear the configured absolute liquidity floor, a 5% liquidity-to-market-cap floor, holder-count limits, and a populated/non-zero GMGN holder-analysis result. GMGN's all-zero holder block is treated as unavailable, never as a safe 0% concentration reading. No method can guarantee zero false positives and zero false negatives. These defaults prioritize precision and loss containment; alerts, price history, multiplier baselines, users, and tracked wallets are retained in MongoDB for later analysis.

Each chain has an independent candidate set, qualified roster, event history, and alert history. A profitable Solana wallet is never assumed profitable on Base or BSC.

## Telegram bot + web API (TypeScript)

NestJS on TypeScript is the bot runtime and web API implementation. The application is split into API, database, scanner, Telegram, and runtime modules; Nest manages the MongoDB connection through Mongoose, while the repository layer uses native collections for heterogeneous market documents. SQLite is only read by the one-time migration command.

Requires Node.js 24 or newer:

```bash
npm install
cp .env.example .env
npm test
npm run typecheck
npm run dev
```

Set `MONGODB_URI`, `TELEGRAM_BOT_TOKEN`, and your numeric Telegram user ID in `TELEGRAM_ADMIN_USER_IDS`. Add `TWITTER_TOKEN` from [6551/OpenTwitter](https://6551.io/mcp) to enable X context. If the Twitter token is absent, the on-chain scanner still runs. Locally, GMGN credentials may remain in `~/.config/gmgn/.env`; on a hosting provider, add `GMGN_API_KEY` and the API request-signing `GMGN_PRIVATE_KEY` as secret environment variables. Never commit either key.

The default X watch list is `elonmusk,WhiteHouse,realDonaldTrump,cz_binance`; change `TWITTER_ACCOUNTS` to a comma-separated list. Only explicit contract addresses in recent posts are associated with candidates, and an X mention is never sufficient to send a token.

Fomo discovery lives in [`fomo/`](fomo/README.md). `npm run scan:fomo-wallets` merges the 24h, 7d, and 30d leaderboards with most-held and trending-token holders. Every public leaderboard profile remains available for research. Live monitoring admits profiles with at least 500% total, realized, or unrealized position ROI and elite leaderboard traders with at least `FOMO_ELITE_MIN_LEADERBOARD_PNL_USD` profit (default $100K), even when a narrow recent closed-trade sample fails. A retrace below $1m does not remove its wallets from the research universe. Passing the repeatability gates upgrades a wallet to `qualified`; it is no longer a prerequisite for monitoring. The browser-session bridge keeps the short-lived Fomo bearer current without storing Google credentials.

The gitignored local `tracked-wallet-seeds.json` can hold a contract-specific research roster. Generated rosters use three distinct states: broad `observed` research rows, monitored `elite_observed` wallets with auditable high-return or elite-profit evidence, and repeatability-validated `qualified` wallets. Both monitored tiers are polled; qualification changes confidence metadata, not whether the wallet disappears. GMGN entries are polled through GMGN on-chain wallet activity in rotating batches, while Fomo entries retain their public Fomo user ID and can use Fomo's native user-swap feed because Fomo profile addresses often do not appear in GMGN. Generated daily rosters remain separate and continue to refresh normally; MongoDB remains the deployed source of truth.

Robinhood degen discovery also reads Pons' public active-launch and graduated catalogs every five minutes. It snapshots price and bonding-curve progress locally, then labels new active launches, near-graduation launches, just-graduated tokens, 5m/30m price surges, and 30m progress surges. A capped set receives GMGN K-line confirmation so Pons discovery does not consume the GMGN rate-limit budget unchecked. The top-20 degen digest reserves 75% of its available slots for Robinhood when enough Robinhood candidates exist. Ranked Pons candidates are rendered as individual cards enriched with GMGN market activity and top-holder data, plus Pons, chart, explorer, social, GMGN, Axiom, and direct third-party trading-bot links. Bot links contain no borrowed referral IDs and never submit a trade. Pons names and symbols are escaped display metadata only; they are never treated as instructions or as evidence that a contract is safe.

Telegram commands:

- `/start` (subscribe; also consumes a one-time admin invite link)
- `/help` and `/status`
- `/trackstatus [sol|bsc|base|robinhood|all]` (tracked-wallet coverage and recent Fomo buys)
- `/suppressed [sol|bsc|base|robinhood|all]` (recent blocked-token details)
- `/export1d` (admin-only JSONL export of this chat's captured last 24 hours)
- `/roster [sol|bsc|base|robinhood|all]`
- `/subscribe [chain|all]` and `/unsubscribe [chain|all]`
- `/scan [chain|all]` (admin-only)
- `/check <contract>` (admin-only; resolves exact GMGN matches across enabled chains)
- `/admininvite [minutes]` (permanent owner only; creates a single-use link)
- `/admins` and `/revokeadmin <user_id>` (permanent owner only)

IDs in `TELEGRAM_ADMIN_USER_IDS` are permanent owners. An owner can run `/admininvite 60` and privately send the resulting `https://t.me/...?...` link to a user. When that user opens it in a private chat, Telegram supplies and verifies `ctx.from.id`; the raw invitation is consumed once and only its SHA-256 hash is stored. The invited user can then use `/check` and `/scan` without sending their numeric ID to the owner. Invited access persists in MongoDB and can be removed with `/revokeadmin`. Links expire after `ADMIN_INVITE_TTL_SECONDS` by default (one hour), accept an explicit 5–1440 minute lifetime, and cannot be claimed in groups. Keep at least one permanent owner in the hosting environment; an invited admin cannot create more admins.

`/export1d` is scoped to the chat where the command is run and includes inbound messages plus the bot's outgoing messages as timestamped JSONL. Telegram's Bot API cannot retrieve older history, so capture begins only after this version is deployed. To capture ordinary group chatter, disable privacy mode for the bot through BotFather or make the bot a group administrator. Stored chat messages are retained for `CHAT_HISTORY_RETENTION_SECONDS` (seven days by default); only owners and invite-verified admins can export them.

The future web app can consume `GET /health`, `/api/chains`, `/api/roster/:chain`, and `/api/alerts/:chain`. Scan and contract-evaluation routes are POST requests protected by `Authorization: Bearer $WEB_API_TOKEN`.

The service scans immediately at startup and then every `SCAN_INTERVAL_MS` (five minutes by default). Tokens actually shown in a trending or degen digest receive a persistent initial price baseline for two hours. During that window the GMGN market-signal feed is polled every `MULTIPLE_MONITOR_POLL_MS` (15 seconds by default); a matching token is repriced and fully re-scanned immediately, and Telegram receives a one-time `2X`, `3X`, or later whole-number milestone alert. The five-minute pass catches milestones missed by the signal feed. A milestone that fails an ordinary quality threshold is still reported as a `NEEDS REVIEW` performance update; explicit honeypot, rug, malicious-contract, or sellability evidence remains suppressed, and unavailable safety data remains fail-closed. The initial baseline is never silently reset while the token remains continuously visible, and monitoring state survives a restart.

Trending delivery is event-based rather than a repeated snapshot. A token is sent when it newly enters the qualified ranking, develops positive price action or a price surge, or gains a new Smart Money confirmation. An unchanged signal stays silent; after `TRENDING_SIGNAL_COOLDOWN_SECONDS`, it can return only if price has improved by at least `TRENDING_REEMIT_MIN_PRICE_GAIN_PERCENT`. Empty trending cycles are not posted. Tracked-wallet buys keep their immediate standalone notices so the same event is not duplicated in the digest.

Tracked-wallet observations use a dedicated early-token risk gate, not the mature CALL thresholds. They require at least $500 real liquidity, at least 1% liquidity relative to market cap, 10 holders, populated/non-zero holder analysis, acceptable top-10 concentration, and clean contract, sellability, tax, and liquidity-lock checks. The stricter $50K liquidity, $100K market cap, and 300-holder thresholds remain requirements for CALL-quality promotion only.

Every tracked-wallet buy in the lookback window is considered for an immediate activity notice whether or not it appears in trending, most-held, or a surge feed. Before delivery, the contract must pass the same fail-closed safety screen described above; failed or unavailable checks are recorded in `/trackstatus` diagnostics and are not sent to chat. `/suppressed [chain|all]` shows the retained market, holder, contract-safety, pool, and tracked-buyer details for blocked tokens without promoting them as signals. One distinct buyer is labelled `OBSERVE`, two are `POTENTIAL`, and three or more are `BUY SIGNAL`. Each notice names the tracked Fomo handle when available, shows observed buy size, and records a GMGN market-cap quote at detection because the Fomo swap endpoint itself does not return market cap. Confidence upgrades have separate deduplication keys, so an earlier `OBSERVE` cooldown cannot suppress a later `POTENTIAL` or `BUY SIGNAL`. These notices are delivered before trending and degen digests. Fomo activity polling continues during a GMGN cooldown, but delivery waits until GMGN contract, holder, and liquidity checks are available and pass. The GMGN fallback roster is scanned in rotating batches so `TRACKED_WALLET_FALLBACK_LIMIT` bounds API work without permanently excluding wallets after the first batch. `/trackstatus` exposes roster coverage, Fomo profile errors, recent qualifying swaps, and safety-suppression reasons. New `/start` users and non-bot members joining a group receive an explanation of these alert types and their safety meaning. Token cards and digests use friendly contextual emoji; `⚠️` is reserved for explicit rug evidence such as a detected honeypot, rug/scam flag, malicious contract, or sellability failure. New `CALL` and `RESEARCH` results are sent to Telegram chats that ran `/start` or `/subscribe`, and streamed to web clients over SSE:

```js
const events = new EventSource("http://127.0.0.1:3000/api/stream");
events.addEventListener("alert", event => console.log(JSON.parse(event.data)));
events.addEventListener("scan", event => console.log(JSON.parse(event.data)));
```

You can run the same pipeline once, without starting the web server or Telegram polling loop:

```bash
npm run scan:signals
```

Rebuild the combined GMGN and Fomo wallet roster once a day. The local variant attaches to the dedicated Chrome profile, captures a fresh Fomo bearer, runs both scans, and writes the resulting rosters directly to the configured MongoDB:

```bash
npm run sync:wallets:local
```

Log into Fomo once in the Chrome window created by the command. The dedicated profile retains the login locally; Google credentials and the captured bearer are never committed. A local cron can then refresh the roster every day:

```cron
15 3 * * * cd /Users/akanz/projects/trenches/trading_bot && /Users/akanz/.nvm/versions/node/v24.3.0/bin/npm run sync:wallets:local >> wallet-scan-cron.log 2>&1
```

Set `DAILY_WALLET_REFRESH_ENABLED=false` on the hosted bot so it does not duplicate this work. The hosted process reloads the MongoDB roster every `MONGO_ROSTER_RELOAD_MS` (five minutes by default), so a local update becomes active without a restart. The Mac must be awake with a logged-in desktop session when Chrome starts; check `wallet-scan-cron.log` after the first scheduled run.

Optional one-shot signal cron when `npm run dev` is not running:

```cron
*/5 * * * * cd /Users/akanz/projects/trenches/trading_bot && /Users/akanz/.nvm/versions/node/v24.3.0/bin/npm run scan:signals >> signal-cron.log 2>&1
```

Run `/start` in the Telegram bot once before relying on cron delivery. The one-shot command warns when no chats are subscribed. Do not run the always-on `npm run dev` scanner and cron simultaneously unless you intentionally want duplicate API work; the alert cooldown prevents duplicate messages but not duplicate GMGN requests.

## MongoDB migration and hosting

MongoDB is the durable source of truth for Telegram subscriptions, invite-verified admins, alert deduplication, price/metric samples, multiplier baselines, and the daily GMGN/Fomo tracked-wallet rosters. Generated reports remain local diagnostics and are intentionally excluded from Git.

To import the existing local SQLite state and current wallet-report JSON files once, put a MongoDB connection string in the ignored `.env` and run:

```bash
npm run migrate:mongodb
```

The command is idempotent and prints counts, never credentials. Back up the local SQLite files until the deployed bot and `/roster` have been verified.

### Railway

Railway can run this as one persistent service. Do not create a cron whose purpose is to ping the service. Leave Railway Serverless/app-sleeping disabled because Telegram long polling and the five-minute scan are continuous workloads. Use exactly one replica; multiple replicas would run duplicate Telegram pollers and duplicate API scans.

1. Create a Railway project from the GitHub repository.
2. Set build command `npm ci --include=dev && npm run build`, start command `npm start`, and health-check path `/health`.
3. Set `HOST=0.0.0.0`, `NODE_ENV=production`, `FOMO_BROWSER_SESSION=false`, `DAILY_WALLET_REFRESH_ENABLED=false`, and the secret variables listed below. Railway injects `PORT`.
4. Use MongoDB Atlas and set its URI as `MONGODB_URI`, or add Railway's MongoDB template and reference its private `MONGO_URL`. The application accepts either name.
5. Keep Serverless disabled and deploy one replica.

Railway variables that must be secrets:

- `MONGODB_URI` (or Railway-provided `MONGO_URL`)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_USER_IDS`
- `GMGN_API_KEY`
- `GMGN_PRIVATE_KEY` when signed GMGN follow-wallet/trading routes are enabled
- `TWITTER_TOKEN`
- `WEB_API_TOKEN`

`FOMO_TOKEN` is optional on Railway. Leave it unset when Fomo is used only for the local daily roster refresh. In that mode Railway monitors Mongo-synced wallet addresses through GMGN, but it cannot query Fomo-native recent swaps. Set a current bearer on Railway only if continuous Fomo-native swap monitoring is required.

The Railway MongoDB template is self-hosted and unmanaged. MongoDB Atlas is preferable when managed backups and database maintenance matter.

### Render

`render.yaml` defines the equivalent Render web service and prompts for secrets during Blueprint creation. MongoDB removes the need for a Render persistent disk. Do not use a free sleeping web service for production alerts: a sleeping instance cannot continuously poll Telegram or perform scans on schedule. The Fomo browser-session bridge and built-in roster refresh are disabled in hosted environments; the local daily sync writes refreshed wallets to their shared MongoDB.

## Alert semantics

- `REJECT`: at least one hard gate or unknown critical field.
- `RESEARCH`: all on-chain gates passed, but no verified catalyst.
- `CALL`: all on-chain gates passed and an unexpired catalyst exists in `catalysts.json`. Prefer keys such as `base:0x...` or `sol:...` so the catalyst is chain-specific.

Even `CALL` means “review now,” not “buy blindly.” Quote/slippage, current liquidity, invalidation, and position size must be checked at execution time.
