import type { Bot } from "grammy";
import { db } from "./db.js";
import { env } from "./config.js";
import { clearSession } from "./session-store.js";

// Callbacks that create or publish user content. Restricted (temporarily muted) users may still
// browse, but may not start or finish a post/confession.
const CONTENT_CALLBACKS = /^(create_post|confession|cat:.+|publish_preview|save_draft|resume_draft:.+|confess_confirm:(yes|no))$/;

// Single enforcement point for blocked / restricted users in private chats. Previously only the
// confession flow and the HTTP API checked these flags, so a banned user could keep posting
// through the bot's post wizard.
export function registerAccessGuard(bot: Bot): void {
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from) return next();
    if (ctx.chat && ctx.chat.type !== "private") return next();
    if (String(from.id) === env.TELEGRAM_OWNER_ID) return next();

    // /start always abandons any half-finished wizard.
    if (ctx.message?.text?.startsWith("/start")) await clearSession(from.id);

    const user = await db.user.findUnique({
      where: { telegramId: String(from.id) },
      select: { blocked: true, restrictedUntil: true, locale: true },
    });
    if (!user) return next();
    const am = user.locale !== "ENGLISH";

    if (user.blocked) {
      await clearSession(from.id);
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => undefined);
      await ctx.reply(am ? "⛔ መለያዎ ታግዷል።" : "⛔ Your account is blocked.").catch(() => undefined);
      return;
    }

    const data = ctx.callbackQuery?.data;
    if (data && CONTENT_CALLBACKS.test(data) && user.restrictedUntil && user.restrictedUntil > new Date()) {
      await ctx.answerCallbackQuery(
        am ? "⏳ መለያዎ ለጊዜው ተገድቧል። ቆይተው ይሞክሩ።" : "⏳ Your account is temporarily restricted. Try again later."
      ).catch(() => undefined);
      return;
    }
    return next();
  });
}
