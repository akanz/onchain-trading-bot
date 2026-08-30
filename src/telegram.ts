import { Bot, type Context } from "grammy";
import { parseChain } from "./config.js";
import { formatAlert, formatDegenDigest, formatRoster, formatTokenCard, formatTrendingDigest } from "./format.js";
import { BotStore } from "./store.js";
import type { Chain, TrackerConfig } from "./types.js";
import type { TrackerService } from "./service.js";
import { isDeliverableAlert } from "./alert-stream.js";

const help = `<b>GMGN token signal bot</b>\n/status — bot and chain status\n/roster [chain|all] — qualified tracked wallets\n/subscribe [chain|all] — receive alerts\n/unsubscribe [chain|all] — stop alerts\n/check &lt;contract&gt; — auto-detect chain and run token gates (admin)\n/scan [chain|all] — scan now (admin)\n/admininvite [minutes] — create one-use admin link (owner)\n/admins — list invited admins (owner)\n/revokeadmin &lt;user_id&gt; — revoke invited admin (owner)\n\nDegen mode is a separately labelled high-risk microcap feed. Signals combine GMGN market, Smart Money and wallet activity. X mentions only corroborate on-chain evidence. The bot never places trades.`;

export function createTelegramBot(token: string, service: TrackerService, config: TrackerConfig, store: BotStore) {
  const bot = new Bot(token), owners = new Set((process.env.TELEGRAM_ADMIN_USER_IDS ?? "").split(",").map(x => x.trim()).filter(value => /^\d+$/.test(value)));
  const args = (ctx: Context) => ctx.message?.text?.trim().split(/\s+/).slice(1) ?? [];
  const owner = (ctx: Context) => !!ctx.from && owners.has(String(ctx.from.id));
  const admin = (ctx: Context) => !!ctx.from && (owner(ctx) || store.isAdmin(String(ctx.from.id)));
  const needAdmin = async (ctx: Context) => { if (admin(ctx)) return true; await ctx.reply("This API-heavy command requires owner or invite-verified admin access."); return false; };
  const needOwner = async (ctx: Context) => { if (owner(ctx)) return true; await ctx.reply("Only a permanent owner configured in TELEGRAM_ADMIN_USER_IDS can manage admin access."); return false; };
  const targets = (raw?: string): Chain[] => !raw || raw === "all" ? config.enabled_chains : [parseChain(raw, config)];
  bot.command("start", async ctx => { const payload = args(ctx)[0]; if (payload?.startsWith("admin_")) { if (ctx.chat.type !== "private") return void await ctx.reply("Open this invite link in a private chat with the bot to claim admin access."); if (!ctx.from) return void await ctx.reply("Telegram did not provide a user identity for this request."); const result = store.claimAdminInvite(payload.slice(6), String(ctx.from.id), ctx.from.username); if (result !== "claimed") return void await ctx.reply(result === "expired" ? "This admin invitation has expired. Ask the owner for a new link." : result === "used" ? "This admin invitation has already been used. Ask the owner for a new link." : "This admin invitation is invalid."); store.subscribe(String(ctx.chat.id), "all"); return void await ctx.reply(`${help}\n\n✅ Your Telegram user ID was verified automatically. Admin access is active and this chat is subscribed to all alerts.`, { parse_mode: "HTML" }); } store.subscribe(String(ctx.chat.id), "all"); await ctx.reply(`${help}\n\n✅ This chat is subscribed to all qualifying coin alerts.`, { parse_mode: "HTML" }); });
  bot.command("help", ctx => ctx.reply(help, { parse_mode: "HTML" }));
  bot.command("status", ctx => { const cooldown = service.gmgn.cooldownUntil; return ctx.reply(`Running. Enabled chains: ${config.enabled_chains.join(", ")}.\nScheduled feed: ${process.env.SCHEDULED_CHAINS ?? "sol,bsc,robinhood"} every ${Math.round(Number(process.env.SCAN_INTERVAL_MS ?? 300000) / 60000)}m.\nDegen mode: ${process.env.DEGEN_MODE === "true" ? `enabled (top ${Number(process.env.DEGEN_DIGEST_LIMIT ?? 20)} ranked setups; microcap highlight ≤ $${Number(process.env.DEGEN_MAX_MARKET_CAP_USD ?? 100000).toLocaleString()})` : "disabled"}.\nMultiplier alerts: ${process.env.MULTIPLE_MONITOR_ENABLED === "false" ? "disabled" : `enabled for ${Math.round(Number(process.env.MULTIPLE_MONITOR_WINDOW_SECONDS ?? 7200) / 3600)}h from initial scan; GMGN trigger poll every ${Math.round(Number(process.env.MULTIPLE_MONITOR_POLL_MS ?? 15000) / 1000)}s`}.\nAdmins: ${owners.size} permanent owner(s) + ${store.adminRows().length} invite-verified.\nGMGN: ${cooldown ? `cooldown until ${new Date(cooldown).toLocaleString()}` : "ready (weighted limiter active)"}.\nAlert tiers: ${process.env.ALERT_TIERS ?? "CALL,RESEARCH"}.\nOpenTwitter: ${service.twitter.enabled ? "enabled" : "token not configured"}.\nFomo: ${service.fomo.enabled ? `enabled${service.fomo.expiresAt ? ` until ${new Date(service.fomo.expiresAt * 1000).toISOString()}` : ""}` : "token not configured"}.`); });
  bot.command("roster", async ctx => { try { for (const chain of targets(args(ctx)[0])) await ctx.reply(formatRoster(chain, service.roster(chain)), { parse_mode: "HTML" }); } catch (e) { await ctx.reply(String(e)); } });
  bot.command("subscribe", async ctx => { try { const raw = args(ctx)[0] ?? "all"; targets(raw); store.subscribe(String(ctx.chat.id), raw); await ctx.reply(`Subscribed to ${raw} alerts.`); } catch (e) { await ctx.reply(String(e)); } });
  bot.command("unsubscribe", async ctx => { try { const raw = args(ctx)[0] ?? "all"; targets(raw); store.unsubscribe(String(ctx.chat.id), raw); await ctx.reply(`Unsubscribed from ${raw} alerts.`); } catch (e) { await ctx.reply(String(e)); } });
  bot.command("admininvite", async ctx => { if (!await needOwner(ctx) || !ctx.from) return; const raw = args(ctx)[0], fallback = Math.max(5, Math.round(Number(process.env.ADMIN_INVITE_TTL_SECONDS ?? 3600) / 60)), minutes = raw === undefined ? fallback : Number(raw); if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) return void await ctx.reply("Usage: /admininvite [minutes], where minutes is between 5 and 1440."); const invite = store.createAdminInvite(String(ctx.from.id), Math.round(minutes * 60)), url = `https://t.me/${ctx.me.username}?start=admin_${invite}`; await ctx.reply(`One-use admin invitation (expires in ${Math.round(minutes)} minutes):\n${url}\n\nSend it privately to the intended user. It becomes invalid immediately after one successful claim.`, { link_preview_options: { is_disabled: true } }); });
  bot.command("admins", async ctx => { if (!await needOwner(ctx)) return; const invited = store.adminRows(), ownerLines = [...owners].map(id => `owner ${id} (.env)`), invitedLines = invited.map(row => `admin ${row.user_id}${row.username ? ` @${String(row.username).replace(/\s+/g, "").slice(0, 64)}` : ""} · granted ${new Date(Number(row.granted_at) * 1000).toISOString()}`); await ctx.reply([...ownerLines, ...invitedLines].join("\n") || "No owners or invited admins are configured."); });
  bot.command("revokeadmin", async ctx => { if (!await needOwner(ctx)) return; const [userId] = args(ctx); if (!userId || !/^\d+$/.test(userId)) return void await ctx.reply("Usage: /revokeadmin <numeric-user-id>"); if (owners.has(userId)) return void await ctx.reply("That ID is a permanent .env owner. Remove it from TELEGRAM_ADMIN_USER_IDS and restart the bot."); await ctx.reply(store.revokeAdmin(userId) ? `Revoked admin access for ${userId}.` : `No invited admin was found for ${userId}.`); });
  bot.command("check", async ctx => { if (!await needAdmin(ctx)) return; const [address] = args(ctx); if (!address) return void await ctx.reply("Usage: /check <contract-address>"); try { await ctx.reply("Resolving contract chain and building the full token card…"); for (const result of await service.evaluateAddress(address)) await ctx.reply(formatTokenCard(result), { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); } catch (e) { await ctx.reply(`Evaluation failed: ${String(e)}`); } });
  bot.command("scan", async ctx => { if (!await needAdmin(ctx)) return; try { await ctx.reply("Signal scan started…"); const raw = args(ctx)[0] ?? config.default_chain; const alerts = raw === "all" ? await service.scanAll() : await service.scan(parseChain(raw, config)), deliverable = alerts.filter(isDeliverableAlert); await ctx.reply(deliverable.length ? `Scan complete: ${deliverable.length} potential call(s) passed the delivery filters.` : `Scan complete: no corroborated token passed the delivery filters.`); for (const alert of deliverable) await broadcast(bot, store, alert); } catch (e) { await ctx.reply(`Scan failed: ${String(e)}`); } });
  bot.catch(error => console.error("Telegram error", error.error));
  return bot;
}

export async function broadcast(bot: Bot, store: BotStore, alert: any) {
  const result = { attempted: 0, sent: 0, failed: 0 };
  if (!isDeliverableAlert(alert)) return result;
  for (const chatId of store.chats(alert.chain)) { result.attempted++; try { await bot.api.sendMessage(chatId, formatAlert(alert), { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); result.sent++; } catch (e) { result.failed++; console.error(`Could not alert chat ${chatId}`, e); } }
  return result;
}

export async function broadcastTrending(bot: Bot, store: BotStore, chains: Chain[], rows: any[]) {
  const message = formatTrendingDigest(chains, rows), result = { attempted: 0, sent: 0, failed: 0 };
  for (const chatId of store.chatsForChains(chains)) { result.attempted++; try { await bot.api.sendMessage(chatId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); result.sent++; } catch (e) { result.failed++; console.error(`Could not send cross-chain trending digest to chat ${chatId}`, e); } }
  return result;
}

export async function broadcastDegen(bot: Bot, store: BotStore, chains: Chain[], rows: any[]) {
  const messages = formatDegenDigest(chains, rows), result = { attempted: 0, sent: 0, failed: 0 };
  for (const chatId of store.chatsForChains(chains)) for (const message of messages) { result.attempted++; try { await bot.api.sendMessage(chatId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }); result.sent++; } catch (e) { result.failed++; console.error(`Could not send degen digest to chat ${chatId}`, e); } }
  return result;
}
