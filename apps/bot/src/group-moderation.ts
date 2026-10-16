import type { Bot, Context } from "grammy";
import { db } from "./db.js";
import { moderateText } from "./moderation.js";
import { env } from "./config.js";

async function ensureUser(ctx: Context) {
  const from = ctx.from;
  if (!from) return null;
  const owner = String(from.id) === env.TELEGRAM_OWNER_ID;
  return db.user.upsert({
    where: { telegramId: String(from.id) },
    update: {
      ...(from.username !== undefined ? { username: from.username } : {}),
      firstName: from.first_name,
      ...(from.last_name !== undefined ? { lastName: from.last_name } : {}),
      ...(owner ? { role: "OWNER" as const } : {}),
    },
    create: {
      telegramId: String(from.id),
      ...(from.username !== undefined ? { username: from.username } : {}),
      firstName: from.first_name,
      ...(from.last_name !== undefined ? { lastName: from.last_name } : {}),
      role: owner ? "OWNER" : "USER",
    },
  });
}

export function registerGroupModeration(bot: Bot) {
  bot.on("message", async (ctx, next) => {
    if (!ctx.chat || !["group", "supergroup"].includes(ctx.chat.type))
      return next();
    const from = ctx.from;
    if (!from) return next();
    // In a channel's linked discussion group Telegram auto-forwards every channel post into the
    // group (from the service account 777000, is_automatic_forward). Comments are replies to that
    // message; deleting it as "forwarded content" made commenting fail with "Message doesn't
    // exist". Channel/anonymous-admin posts (sender_chat) are not user content either.
    if (ctx.message.is_automatic_forward || from.id === 777000 || ctx.message.sender_chat) return next();
    const user = await ensureUser(ctx);
    if (!user) return next();
    const isAdmin = user.role !== "USER";
    const text = ctx.message.text ?? ctx.message.caption ?? "";
    const forwarded = Boolean(ctx.message.forward_origin);
    const result = moderateText(text, { isAdmin, isForwarded: forwarded });

    if (forwarded || result.decision === "BAN" || result.decision === "REJECT") {
      try {
        await ctx.deleteMessage();
      } catch {
        /* bot may not have delete permission */
      }
      await db.moderationEvent.create({
        data: {
          targetUserId: user.id,
          category: forwarded ? "FORWARDED" : result.category,
          action: result.decision === "BAN" ? "BAN" : "REJECT",
          reason: result.reason,
          evidence: text.slice(0, 500),
        },
      });
      if (result.decision === "BAN") {
        try {
          await ctx.banChatMember(from.id);
        } catch {
          /* owner/admin policy can override */
        }
      }
      return;
    }
    return next();
  });
}