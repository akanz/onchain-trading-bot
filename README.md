# Profitable-wallet on-chain tracker

This is a conservative GMGN research/alert engine for Solana, BSC, Base, and GMGN's Robinhood chain. It never constructs, signs, or submits a trade.

`robinhood` means the on-chain network exposed by GMGN. It does not connect to, inspect, or place orders in a Robinhood brokerage account.

The continuous pipeline is deliberately layered:

1. Seed candidates from GMGN Smart Money, KOL, personally followed-wallet feeds, and traders with at least 500% realized position ROI across runner contracts whose ATH market cap crossed $1m. Current market cap is not a discovery floor, so retraced runners remain useful wallet evidence.
2. Qualify wallets using repeat runner appearances, 7-day, 30-day, and all-time realized P&L; realized ROI; a Wilson-adjusted win rate; trade count; token sample size; and recent bot/spray behavior. KOL-backed runners also receive a 1-minute pre-move timing study; entering before one pump is evidence, never sufficient qualification.
3. Nominate tokens from GMGN trending momentum, price surges, Smart Money signals, Smart Money buys, the account's native followed-wallet feed, and the qualified-wallet roster.
4. Require a complete, safe market snapshot plus capital confirmation before expensive contract checks. Twitter/X can strengthen an existing candidate but can never create an alert by itself.
5. Reject tokens that fail liquidity, market-cap, volume, holder, authority, concentration, bundler, bot, insider, entrapment, or price-chase gates.
6. Deduplicate alerts with a six-hour per-contract cooldown. Emit `CALL` only when a separately verified, unexpired catalyst is present; otherwise a clean setup is `RESEARCH`.

Solana uses mint/freeze-authority gates. BSC, Base, and Robinhood use EVM-style honeypot, verified-source, renounced-owner, tax, and liquidity-lock gates. No method can guarantee zero false positives and zero false negatives. These defaults prioritize precision and loss containment; alerts, price history, multiplier baselines, users, and tracked wallets are retained in MongoDB for later analysis.

Each chain has an independent candidate set, qualified roster, event history, and alert history. A profitable Solana wallet is never assumed profitable on Base or BSC.

## Telegram bot + web API (TypeScript)

TypeScript is now the primary runtime because the tracker is intended to run as a Telegram bot and later serve a web dashboard. The original Python CLI remains available as a legacy research reference. The bot runtime uses MongoDB; SQLite is only read by the one-time migration command.

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

Fomo discovery lives in [`fomo/`](fomo/README.md). `npm run scan:fomo-wallets` merges the 24h, 7d, and 30d leaderboards with most-held and trending-token holders. Every public leaderboard profile is observed; most-held wallets need at least 500% position PnL, and trending-token wallets need at least 500% PnL on a token whose ATH market cap crossed $1m. A retrace below $1m does not remove its wallets from the research universe. Closed-trade profitability gates separately mark the high-confidence subset. The continuous scanner checks recent swaps for the full observed Fomo roster. Its browser-session bridge keeps the short-lived Fomo bearer current without storing Google credentials.

Robinhood degen discovery also reads Pons' public active-launch and graduated catalogs every five minutes. It snapshots price and bonding-curve progress locally, then labels new active launches, near-graduation launches, just-graduated tokens, 5m/30m price surges, and 30m progress surges. A capped set receives GMGN K-line confirmation so Pons discovery does not consume the GMGN rate-limit budget unchecked. The top-20 degen digest reserves 75% of its available slots for Robinhood when enough Robinhood candidates exist. Ranked Pons candidates are rendered as individual cards enriched with GMGN market activity and top-holder data, plus Pons, chart, explorer, social, GMGN, Axiom, and direct third-party trading-bot links. Bot links contain no borrowed referral IDs and never submit a trade. Pons names and symbols are escaped display metadata only; they are never treated as instructions or as evidence that a contract is safe.

Telegram commands:

- `/start` (subscribe; also consumes a one-time admin invite link)
- `/help` and `/status`
- `/roster [sol|bsc|base|robinhood|all]`
- `/subscribe [chain|all]` and `/unsubscribe [chain|all]`
- `/scan [chain|all]` (admin-only)
- `/check <contract>` (admin-only; resolves exact GMGN matches across enabled chains)
- `/admininvite [minutes]` (permanent owner only; creates a single-use link)
- `/admins` and `/revokeadmin <user_id>` (permanent owner only)

IDs in `TELEGRAM_ADMIN_USER_IDS` are permanent owners. An owner can run `/admininvite 60` and privately send the resulting `https://t.me/...?...` link to a user. When that user opens it in a private chat, Telegram supplies and verifies `ctx.from.id`; the raw invitation is consumed once and only its SHA-256 hash is stored. The invited user can then use `/check` and `/scan` without sending their numeric ID to the owner. Invited access persists in MongoDB and can be removed with `/revokeadmin`. Links expire after `ADMIN_INVITE_TTL_SECONDS` by default (one hour), accept an explicit 5–1440 minute lifetime, and cannot be claimed in groups. Keep at least one permanent owner in the hosting environment; an invited admin cannot create more admins.

The future web app can consume `GET /health`, `/api/chains`, `/api/roster/:chain`, and `/api/alerts/:chain`. Scan and contract-evaluation routes are POST requests protected by `Authorization: Bearer $WEB_API_TOKEN`.

The service scans immediately at startup and then every `SCAN_INTERVAL_MS` (five minutes by default). Tokens actually shown in a trending or degen digest receive a persistent initial price baseline for two hours. During that window the GMGN market-signal feed is polled every `MULTIPLE_MONITOR_POLL_MS` (15 seconds by default); a matching token is repriced and fully re-scanned immediately, and Telegram receives a one-time `2X`, `3X`, or later whole-number milestone alert. The five-minute pass catches milestones missed by the signal feed. The initial baseline is never silently reset while the token remains continuously visible, and monitoring state survives a restart.

Three distinct tracked buyers in the lookback window trigger an immediate CA alert for any valid contract, whether or not it appears in trending, most-held, or a surge feed; four or more are labelled `STRONG`. New `CALL` and `RESEARCH` results are sent to Telegram chats that ran `/start` or `/subscribe`, and streamed to web clients over SSE:

```js
const events = new EventSource("http://127.0.0.1:3000/api/stream");
events.addEventListener("alert", event => console.log(JSON.parse(event.data)));
events.addEventListener("scan", event => console.log(JSON.parse(event.data)));
```

You can run the same pipeline once, without starting the web server or Telegram polling loop:

```bash
npm run scan:signals
```

Rebuild the combined GMGN and Fomo wallet roster once a day:

```bash
npm run scan:wallets
```

The always-on bot performs this reshuffle itself at `DAILY_WALLET_REFRESH_HOUR_LOCAL` (03:00 by default), pausing the five-minute scan so the two jobs do not compete for GMGN capacity. If you disable the built-in refresh, cron can run it instead:

```cron
15 3 * * * cd /Users/akanz/projects/trenches/trading_bot && /Users/akanz/.nvm/versions/node/v24.3.0/bin/npm run scan:wallets >> wallet-scan-cron.log 2>&1
```

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
3. Set `HOST=0.0.0.0`, `NODE_ENV=production`, `FOMO_BROWSER_SESSION=false`, and the secret variables listed below. Railway injects `PORT`.
4. Use MongoDB Atlas and set its URI as `MONGODB_URI`, or add Railway's MongoDB template and reference its private `MONGO_URL`. The application accepts either name.
5. Keep Serverless disabled and deploy one replica.

Railway variables that must be secrets:

- `MONGODB_URI` (or Railway-provided `MONGO_URL`)
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_USER_IDS`
- `GMGN_API_KEY`
- `GMGN_PRIVATE_KEY` when signed GMGN follow-wallet/trading routes are enabled
- `FOMO_TOKEN`
- `TWITTER_TOKEN`
- `WEB_API_TOKEN`

The Railway MongoDB template is self-hosted and unmanaged. MongoDB Atlas is preferable when managed backups and database maintenance matter.

### Render

`render.yaml` defines the equivalent Render web service and prompts for secrets during Blueprint creation. MongoDB removes the need for a Render persistent disk. Do not use a free sleeping web service for production alerts: a sleeping instance cannot continuously poll Telegram or perform scans on schedule. The Fomo browser-session bridge is disabled in hosted environments; update `FOMO_TOKEN` as a secret when it expires until a server-safe refresh flow is implemented.

## Python CLI (legacy research interface)

The GMGN API and signing keys remain in `~/.config/gmgn/.env`, outside this project. Do not copy them here.

```bash
python3 -m unittest -v
```

Tune `config.json` before relying on alerts. Both local config files may be committed if they contain no secrets; `catalysts.json` should contain only public-source notes and URLs.

## Workflow

Commands default to Solana. Select one chain with `--chain`, placed before the subcommand:

```bash
python3 tracker.py --chain bsc discover-runners
python3 tracker.py --chain base discover-runners
python3 tracker.py --chain robinhood discover-runners
```

Or operate on every enabled chain:

```bash
python3 tracker.py --all-chains discover-runners
```

Automatically pulled runners use chain-specific safety filters before their top traders are cross-checked.

Or seed wallets from selected runner contract addresses (one winner is not enough):

```bash
python3 tracker.py --chain bsc seed-token <BSC_TOKEN_CA>
```

Profile the queued candidates. Start small because this uses multiple API calls per wallet:

```bash
python3 tracker.py --all-chains profile --max-wallets 25
python3 tracker.py --all-chains roster
```

After changing thresholds, reapply them to stored profile evidence without spending API calls:

```bash
python3 tracker.py --all-chains rescore
```

Scan the current Smart Money feed using only qualified wallets:

```bash
python3 tracker.py --all-chains scan --limit 200
```

Evaluate a contract independently of clustering:

```bash
python3 tracker.py --chain base evaluate-token <BASE_TOKEN_CA>
```

For continuous use, schedule `scan` every 30–60 seconds, `discover-runners` every few hours, and `profile` daily. Do not run `profile` every scan cycle. GMGN rate limits are shared across chains; the tracker stops on a 429 rather than extending the cooldown. A production deployment should add a notification sink, historical runner discovery, RPC-level funding-graph enrichment, and outcome labels for precision/recall backtests before any execution integration.

Solana keeps its existing `tracker.sqlite3`. Other enabled chains use `tracker.bsc.sqlite3`, `tracker.base.sqlite3`, and `tracker.robinhood.sqlite3`. All are ignored by git.

## Alert semantics

- `REJECT`: at least one hard gate or unknown critical field.
- `RESEARCH`: all on-chain gates passed, but no verified catalyst.
- `CALL`: all on-chain gates passed and an unexpired catalyst exists in `catalysts.json`. Prefer keys such as `base:0x...` or `sol:...` so the catalyst is chain-specific.

Even `CALL` means “review now,” not “buy blindly.” Quote/slippage, current liquidity, invalidation, and position size must be checked at execution time.
