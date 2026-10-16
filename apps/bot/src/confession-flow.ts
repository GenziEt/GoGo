import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "./db.js";
import { t, type Locale } from "./i18n.js";
import { moderateAndEnforce } from "./safety.js";
import { getSession, setConfessionSession, clearSession, fromPrismaLocale, abandonOpenWork } from "./session-store.js";
import { publishConfession, deleteChannelMessage } from "./telegram-publisher.js";
import { addDiscussRow } from "./post-buttons.js";
import { getUser } from "./post-flow.js";
import { logger } from "./logger.js";

const CONFESSION_MAX = 800;

const REACTION_CHOICES = [
  { key: "approach", emoji: "❤️", am: "ልቅረባት/ልቅረበው", en: "Approach them" },
  { key: "forget", emoji: "😂", am: "ተወው/ተይው", en: "Forget it" },
  { key: "ask_friend", emoji: "👀", am: "ጓደኛ ጠይቅ", en: "Ask a friend" },
  { key: "stay_single", emoji: "💀", am: "ብቻ ቆይ", en: "Stay single" },
] as const;

type ReactionRow = {
  choice: string;
  _count: { _all: number };
};

const isPrivate = (ctx: Context): boolean => ctx.chat?.type === "private";

export async function reactionCounts(confessionId: string): Promise<Record<string, number>> {
  const rows = await db.confessionReaction.groupBy({
    by: ["choice"],
    where: { confessionId },
    _count: { _all: true },
  });
  const typedRows = rows as unknown as ReactionRow[];
  const counts: Record<string, number> = {};
  for (const choice of REACTION_CHOICES)
    counts[choice.key] = typedRows.find((r) => r.choice === choice.key)?._count._all ?? 0;
  return counts;
}

export function confessionKeyboard(confessionId: string, counts: Record<string, number>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const choice of REACTION_CHOICES) {
    kb.text(`${choice.emoji} ${counts[choice.key] ?? 0}`, `confess_react:${confessionId}:${choice.key}`).row();
  }
  return kb;
}

// Re-draws the vote counts on the channel message (used when a vote arrives through the API,
// which previously left the channel buttons stale). The 💬 Discuss URL row is re-applied so
// refreshes never strip the community button from a published confession.
export async function refreshConfessionKeyboard(bot: Bot, confessionId: string): Promise<void> {
  const row = await db.confession.findUnique({
    where: { id: confessionId },
    select: { state: true, telegramChatId: true, telegramMessageId: true },
  });
  if (!row || row.state !== "PUBLISHED" || !row.telegramChatId || row.telegramMessageId === null) return;
  try {
    await bot.api.editMessageReplyMarkup(row.telegramChatId, row.telegramMessageId, {
      reply_markup: addDiscussRow(confessionKeyboard(confessionId, await reactionCounts(confessionId))),
    });
  } catch {
    /* markup unchanged or message gone — non-fatal */
  }
}

export class ConfessionNotReadyError extends Error {
  constructor() {
    super("Confession is not in a publishable state");
  }
}

// Number allocation + state claim happen under an in-process lock (the bot runs as one
// process), and the next number is max(number)+1 over ALL rows. The previous
// count(PUBLISHED)+1 re-used numbers after a moderator removed a confession and raced when two
// confessions were published at once.
let claimLock: Promise<unknown> = Promise.resolve();
function withClaimLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = claimLock.then(fn, fn);
  claimLock = run.catch(() => undefined);
  return run;
}

/**
 * Single publish path for confessions (bot confirm button, Mini App publish, moderator approve).
 * Atomically claims the row (so double-taps can't double-post), publishes to the channel, and
 * restores the previous state if anything fails.
 */
export async function publishConfessionNow(
  bot: Bot,
  confessionId: string,
  fromStates: string[]
): Promise<{ number: number; chatId: string; messageId: number }> {
  const claimed = await withClaimLock(async () => {
    const before = await db.confession.findUnique({ where: { id: confessionId }, select: { state: true } });
    if (!before) return null;
    const agg = await db.confession.aggregate({ _max: { number: true } });
    const next = (agg._max.number ?? 0) + 1;
    const result = await db.confession.updateMany({
      where: { id: confessionId, state: { in: fromStates }, body: { not: null } },
      data: { state: "PUBLISHING", number: next },
    });
    return result.count === 1 ? { number: next, previous: before.state } : null;
  });
  if (!claimed) throw new ConfessionNotReadyError();

  const restore = () =>
    db.confession.updateMany({ where: { id: confessionId, state: "PUBLISHING" }, data: { state: claimed.previous } });
  const confession = await db.confession.findUniqueOrThrow({ where: { id: confessionId } });
  let published: { chatId: string; messageId: number };
  try {
    published = await publishConfession(
      bot,
      confession.body ?? "",
      claimed.number,
      // Reaction callbacks + the URL-type 💬 Discuss row (skipped silently when unconfigured).
      addDiscussRow(confessionKeyboard(confession.id, await reactionCounts(confession.id)))
    );
  } catch (error) {
    await db.confession.updateMany({ where: { id: confessionId, state: "PUBLISHING" }, data: { state: claimed.previous, number: null } });
    throw error;
  }
  try {
    await db.confession.update({
      where: { id: confessionId },
      data: { state: "PUBLISHED", telegramChatId: published.chatId, telegramMessageId: published.messageId },
    });
  } catch (error) {
    await deleteChannelMessage(bot, published.chatId, published.messageId);
    await restore();
    throw error;
  }
  return { number: claimed.number, chatId: published.chatId, messageId: published.messageId };
}

export function registerConfessionFlow(bot: Bot): void {
  bot.callbackQuery("confession", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = fromPrismaLocale(user.locale);
    await abandonOpenWork(user.id);
    const confession = await db.confession.create({
      data: { telegramUserId: String(ctx.from.id), userId: user.id, state: "INPUT" },
    });
    await setConfessionSession(ctx.from.id, confession.id, "confession_body", locale);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(locale, "confessionIntro"));
  });

  bot.callbackQuery(/^confess_confirm:(yes|no)$/, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const session = await getSession(ctx.from.id);
    const confessionId = session?.confessionId;
    if (!session || !confessionId || session.step !== "confession_confirm")
      return ctx.answerCallbackQuery(t(fromPrismaLocale(session?.locale ?? "AMHARIC"), "sessionExpired"));
    const locale = fromPrismaLocale(session.locale);

    if (ctx.match[1] === "no") {
      await db.confession.updateMany({ where: { id: confessionId, state: "PREVIEW" }, data: { state: "REJECTED" } });
      await clearSession(ctx.from.id);
      await ctx.answerCallbackQuery();
      await ctx.reply(t(locale, "confessionCancelled"));
      return;
    }

    let published: { number: number };
    try {
      published = await publishConfessionNow(bot, confessionId, ["PREVIEW"]);
    } catch (error) {
      if (error instanceof ConfessionNotReadyError) {
        await ctx.answerCallbackQuery(t(locale, "notReady"));
      } else {
        logger.error("GENZI confession publication failed", { error: String(error) });
        await ctx.answerCallbackQuery(t(locale, "publishFailed"));
      }
      return;
    }
    await clearSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(`${t(locale, "confessionPublished")}\n\n🆔 #${String(published.number).padStart(5, "0")}`);
  });

  bot.callbackQuery(/^confess_react:([^:]+):([a-z_]+)$/, async (ctx) => {
    if (!ctx.from) return ctx.answerCallbackQuery();
    const confessionId = ctx.match[1];
    const choiceKey = ctx.match[2];
    if (!confessionId || !choiceKey) {
      await ctx.answerCallbackQuery();
      return;
    }
    const choice = REACTION_CHOICES.find((c) => c.key === choiceKey);
    if (!choice) {
      await ctx.answerCallbackQuery();
      return;
    }
    const user = await getUser(ctx);
    const confession = await db.confession.findUnique({ where: { id: confessionId } });
    if (!confession || confession.state !== "PUBLISHED") {
      await ctx.answerCallbackQuery();
      return;
    }
    await db.confessionReaction.upsert({
      where: { confessionId_userId: { confessionId, userId: user.id } },
      update: { choice: choiceKey },
      create: { confessionId, userId: user.id, choice: choiceKey },
    });
    const counts = await reactionCounts(confessionId);
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: confessionKeyboard(confessionId, counts) });
    } catch {
      /* markup may already match, or the message is no longer editable — non-fatal */
    }
    const locale = fromPrismaLocale(user.locale);
    await ctx.answerCallbackQuery(locale === "am" ? "✅ ድምጽዎ ተመዝግቧል።" : "✅ Your vote is recorded.");
  });

  bot.on("message", async (ctx, next) => {
    if (!ctx.from || !isPrivate(ctx)) return next();
    const session = await getSession(ctx.from.id);
    const confessionId = session?.confessionId;
    if (!session || !confessionId) return next();

    const locale: Locale = fromPrismaLocale(session.locale);
    const text = ctx.message.text ?? "";
    // Commands (including /cancel, handled in post-flow) pass through untouched.
    if (text.startsWith("/")) return next();

    if (ctx.message.forward_origin) {
      await db.confession.updateMany({ where: { id: confessionId, state: { in: ["INPUT", "PREVIEW"] } }, data: { state: "REJECTED" } });
      await clearSession(ctx.from.id);
      await ctx.reply(t(locale, "forwardedDenied"));
      return;
    }

    if (session.step === "confession_confirm") {
      await ctx.reply(t(locale, "useButtons"));
      return;
    }
    if (session.step !== "confession_body") return next();

    const user = await getUser(ctx);
    if (!text || text.length > CONFESSION_MAX) {
      await ctx.reply(
        locale === "am"
          ? `❌ መልዕክቱ አስፈላጊ ነው እና ከ${CONFESSION_MAX} ፊደል አይበልጥም።`
          : `❌ Message is required and must be under ${CONFESSION_MAX} characters.`
      );
      return;
    }

    // Same shared enforcement as posts/API: logs the event, bans or restricts on repeat offences.
    const moderation = await moderateAndEnforce(user.id, false, [text]);
    if (moderation.decision === "BAN" || moderation.decision === "REJECT") {
      await db.confession.update({
        where: { id: confessionId },
        data: { state: "REJECTED", moderationJson: JSON.stringify(moderation) },
      });
      await clearSession(ctx.from.id);
      await ctx.reply(moderation.category === "LINK" ? t(locale, "linkDenied") : t(locale, "rejected"));
      return;
    }
    if (moderation.decision === "QUARANTINE") {
      // Same state the Mini App uses, so every held confession shows up in the moderator list
      // (the bot used to park these as PENDING, which no screen listed). The session is closed so
      // the user's next message isn't swallowed by this wizard.
      await db.confession.update({
        where: { id: confessionId },
        data: { body: text, moderationJson: JSON.stringify(moderation), state: "QUARANTINED" },
      });
      await clearSession(ctx.from.id);
      await ctx.reply(t(locale, "quarantined"));
      return;
    }

    await db.confession.update({
      where: { id: confessionId },
      data: { body: text, state: "PREVIEW", moderationJson: JSON.stringify(moderation) },
    });
    await setConfessionSession(ctx.from.id, confessionId, "confession_confirm", locale);

    const preview = [t(locale, "confessionPreviewLabel"), "", text, "", t(locale, "confessionConfirmPrompt")].join("\n");
    const keyboard = new InlineKeyboard()
      .text(t(locale, "confessionYes"), "confess_confirm:yes")
      .text(t(locale, "confessionNo"), "confess_confirm:no");
    await ctx.reply(preview, { reply_markup: keyboard });
  });
}
