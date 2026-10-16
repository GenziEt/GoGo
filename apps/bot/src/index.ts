import { Bot, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { env } from "./config.js";
import { db } from "./db.js";
import { mainMenu } from "./ui.js";
import { t, type Locale } from "./i18n.js";
import { registerPostFlow } from "./post-flow.js";
import { registerConfessionFlow, publishConfessionNow, refreshConfessionKeyboard, ConfessionNotReadyError } from "./confession-flow.js";
import { registerAccessGuard } from "./guard.js";
import { registerAdmin } from "./moderation-admin.js";
import { registerGroupModeration } from "./group-moderation.js";
import { telegramAuth, adminAuth, moderatorSessionAuth, createModeratorSession, consumeModeratorLoginCode } from "./api-auth.js";
import { validateTelegramInitData } from "./telegram-webapp.js";
import { performModerationAction, type AdminDecision } from "./admin-actions.js";
import { publishToChannel, publishConfession, deleteChannelMessage } from "./telegram-publisher.js";
import { parsePlatformLink, attachChannelButtons } from "./post-buttons.js";
import { moderateText } from "./moderation.js";
import { rateLimit, moderateRequestText, collectTextValues, enforceContentModeration } from "./safety.js";
import { randomBytes } from "node:crypto";
import { logger } from "./logger.js";
import { createTelegramNotifier } from "./notifications.js";
import { setEventReminder, cancelEventReminder, startReminderSweeper } from "./event-reminders.js";

const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
const notifier = createTelegramNotifier(bot);

// Express app is created up-front: API routes are registered across this whole module,
// including groups that appear before the historical "app" declaration point.
const app = express();
// On Render every request arrives via its proxy, so without trusting it req.ip is the proxy's
// address and ALL users share one rate-limit bucket. Render sets RENDER=true automatically.
app.set("trust proxy", env.TRUST_PROXY ? true : process.env.RENDER ? 1 : false);
app.disable("x-powered-by");
// Fix: Mini App composer now supports image/video upload (base64) and the full 6000-char body,
// so the JSON payload limit grew accordingly.
app.use(express.json({ limit: "12mb" }));

async function ensureUser(telegramId: number, firstName?: string, username?: string) {
  const isOwner = String(telegramId) === env.TELEGRAM_OWNER_ID;
  return db.user.upsert({
    where: { telegramId: String(telegramId) },
    update: {
      ...(firstName !== undefined && { firstName }),
      ...(username !== undefined && { username }),
      ...(isOwner ? { role: "OWNER" } : {})
    },
    create: {
      telegramId: String(telegramId),
      firstName: firstName ?? null,
      username: username ?? null,
      role: isOwner ? "OWNER" : "USER"
    }
  });
}

// Runtime settings persisted in the Setting table (previously dead schema). Values are cached
// briefly so hot paths (sweeps, per-request checks) don't hit the DB every time; setSetting
// invalidates the cache immediately. Reads never throw — an unreachable DB simply means
// "use the default", exactly like the previous hardcoded constants.
const settingCache = new Map<string, { value: string | null; expiresAt: number }>();
const SETTING_CACHE_TTL_MS = 30_000;

async function getSetting(key: string, fallback: string): Promise<string> {
  const hit = settingCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value ?? fallback;
  let value: string | null = null;
  try {
    value = (await db.setting.findUnique({ where: { key }, select: { value: true } }))?.value ?? null;
  } catch (error) {
    logger.warn("setting read failed; using default", { key, error: String(error) });
  }
  settingCache.set(key, { value, expiresAt: Date.now() + SETTING_CACHE_TTL_MS });
  return value ?? fallback;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db.setting.upsert({ where: { key }, update: { value }, create: { key, value } });
  settingCache.delete(key);
}

const DEFAULT_SETTINGS: Record<string, string> = {
  dm_recall_window_hours: "24",
  earn_daily_limit: "200",
  referral_reward_coins: "50",
  subscription_grace_hours: "48"
};

async function ensureReferralProfile(userId: string) {
  const existing = await db.referralProfile.findUnique({ where: { userId } });
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `GZ${randomBytes(5).toString("base64url")}`;
    try {
      return await db.referralProfile.create({ data: { userId, code } });
    } catch {
      // Retry on the extremely unlikely code collision.
    }
  }
  throw new Error("Could not create referral code");
}

async function grantGrowthCoins(userId: string, amount: number, type: string, reference: string) {
  await db.$transaction(async (tx) => {
    await tx.wallet.upsert({ where: { userId }, update: {}, create: { userId, balance: 0 } });
    await tx.wallet.update({ where: { userId }, data: { balance: { increment: amount } } });
    await tx.walletTransaction.create({ data: { userId, type, amount, reference, note: "GENZI growth reward" } });
  });
}

async function completeReferral(inviterId: string, inviteeId: string, code: string) {
  if (inviterId === inviteeId) return false;
  const existing = await db.referral.findUnique({ where: { inviteeId } });
  if (existing) return false;
  const alreadyInvited = await db.referral.findFirst({ where: { inviterId, inviteeId } });
  if (alreadyInvited) return false;
  // Admin-tunable payout (Setting table); defaults match the schema column defaults.
  const inviterReward = Math.max(0, Number.parseInt(await getSetting("referral_reward_coins", DEFAULT_SETTINGS.referral_reward_coins ?? "50"), 10) || 50);
  const inviteeReward = Math.max(0, Math.round(inviterReward * 0.4));
  await db.$transaction(async (tx) => {
    const referral = await tx.referral.create({ data: { inviterId, inviteeId, code, inviterReward, inviteeReward } });
    await tx.wallet.upsert({ where: { userId: inviterId }, update: {}, create: { userId: inviterId, balance: 0 } });
    await tx.wallet.upsert({ where: { userId: inviteeId }, update: {}, create: { userId: inviteeId, balance: 0 } });
    await tx.wallet.update({ where: { userId: inviterId }, data: { balance: { increment: referral.inviterReward } } });
    await tx.wallet.update({ where: { userId: inviteeId }, data: { balance: { increment: referral.inviteeReward } } });
    await tx.walletTransaction.create({ data: { userId: inviterId, type: "REFERRAL_REWARD", amount: referral.inviterReward, reference: referral.id, note: "Successful referral reward" } });
    await tx.walletTransaction.create({ data: { userId: inviteeId, type: "WELCOME_REFERRAL_REWARD", amount: referral.inviteeReward, reference: referral.id, note: "Referral welcome reward" } });
    await tx.growthEvent.create({ data: { userId: inviterId, type: "REFERRAL_COMPLETED", targetId: inviteeId, metadata: code } });
    await tx.growthEvent.create({ data: { userId: inviteeId, type: "REFERRED_JOIN", targetId: inviterId, metadata: code } });
  });
  await db.notification.create({ data: { userId: inviterId, type: "REFERRAL", title: "🎁 አዲስ የመጋበዣ ሽልማት", body: `አዲስ ሰው በመጋበዣ ኮድዎ GENZIን ተቀላቅሏል። 🪙 ${inviterReward} GENZI Coins አግኝተዋል።` } });
  await db.notification.create({ data: { userId: inviteeId, type: "REFERRAL", title: "🎁 እንኳን ደህና መጡ", body: `በመጋበዣ 🪙 ${inviteeReward} GENZI Coins አግኝተዋል።` } });
  // Telegram push for both sides of the referral (best-effort).
  void notifier.referral(inviterId);
  return true;
}

registerAccessGuard(bot);

bot.command("start", async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const user = await ensureUser(from.id, from.first_name, from.username);
  const payload = typeof ctx.match === "string" ? ctx.match.trim() : "";
  if (payload.startsWith("ref_")) {
    const code = payload.slice(4).trim();
    if (code) {
      const profile = await db.referralProfile.findUnique({ where: { code } });
      if (profile) await completeReferral(profile.userId, user.id, code);
    }
  }
  const locale: Locale = user.locale === "ENGLISH" ? "en" : "am";
  await ctx.reply(t(locale, "welcome"), { reply_markup: mainMenu(locale, env.WEBAPP_URL) });
});

bot.command("language", async (ctx) => {
  await ctx.reply("🌐 ቋንቋ / Language", {
    reply_markup: new InlineKeyboard().text("🇪🇹 አማርኛ", "lang:am").text("🇬🇧 English", "lang:en")
  });
});

bot.callbackQuery(/^lang:(am|en)$/, async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  const locale = ctx.match[1] === "am" ? "AMHARIC" : "ENGLISH";
  await db.user.update({ where: { telegramId: String(from.id) }, data: { locale } });
  await ctx.answerCallbackQuery();
  await ctx.reply(locale === "AMHARIC" ? "🇪🇹 ቋንቋው ወደ አማርኛ ተቀይሯል።" : "🇬🇧 Language changed to English.");
});

// Telegram-safe HTML escaping for dynamic content rendered into bot messages.
const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const OPPORTUNITY_EMOJI: Record<string, string> = { JOB: "💼", GIG: "🛠️", INTERNSHIP: "🎓", SCHOLARSHIP: "🏫", TRAINING: "📚", COMPETITION: "🏆", BUSINESS: "💡", OTHER: "🚀" };

// Trending posts — computed live from the same engagement-scored query used by GET /api/me/feed?mode=trending.
async function sendTrending(ctx: any, locale: Locale): Promise<void> {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [allPosts, views, reactions, comments] = await Promise.all([
      db.post.findMany({ where: { publishedAt: { not: null } }, orderBy: { publishedAt: "desc" }, take: 200 }),
      db.feedEvent.findMany({ where: { event: "VIEW", createdAt: { gte: since } }, select: { postId: true } }),
      db.postReaction.findMany({ where: { createdAt: { gte: since } }, select: { postId: true } }),
      db.postComment.findMany({ where: { createdAt: { gte: since }, status: "VISIBLE" }, select: { postId: true } })
    ]);
    const score = new Map<string, number>();
    for (const e of views) score.set(e.postId, (score.get(e.postId) ?? 0) + 1);
    for (const e of reactions) score.set(e.postId, (score.get(e.postId) ?? 0) + 3);
    for (const e of comments) score.set(e.postId, (score.get(e.postId) ?? 0) + 4);
    allPosts.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    const top = allPosts.slice(0, 5);
    if (!top.length) {
      await ctx.reply(locale === "am" ? "🔥 አዝማሚያ\n\nእስካሁን ሊታወቅ የቻለ ፖስት የለም። ይዘት ሲደርስ እዚህ ይታያል።" : "🔥 Trending\n\nNo trending posts yet. Fresh content will show up here.");
      return;
    }
    const lines = top.map((p, i) => `${i + 1}. <b>${escapeHtml(p.title)}</b>\n✍️ ${escapeHtml(p.authorName)} · 👁 ${score.get(p.id) ?? 0} engagement`);
    const header = locale === "am" ? "🔥 <b>አዝማሚያ — ባለፉት 7 ቀናት</b>" : "🔥 <b>Trending — last 7 days</b>";
    const kb = new InlineKeyboard().text(locale === "am" ? "🌐 ሙሉውን ይመልከቱ" : "🌐 View full feed", "webapp:trending");
    await ctx.reply(`${header}\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", reply_markup: kb });
  } catch (err) {
    logger.error("trending handler failed", { error: String(err) });
    await ctx.reply(locale === "am" ? "🔥 አዝማሚያ መጫን ተስፋ አልቋል፤ እንደገና ይሞክሩ።" : "🔥 Could not load trending right now; please try again.");
  }
}

// Opportunities — latest active, non-expired listings from the Opportunity table (same source as GET /api/opportunities).
async function sendOpportunities(ctx: any, locale: Locale): Promise<void> {
  try {
    const now = new Date();
    const items = await db.opportunity.findMany({
      where: { active: true, OR: [{ deadline: null }, { deadline: { gte: now } }] },
      orderBy: [{ verified: "desc" }, { deadline: "asc" }, { createdAt: "desc" }],
      take: 8,
      include: { _count: { select: { saves: true } } }
    });
    if (!items.length) {
      await ctx.reply(locale === "am" ? "🚀 እድሎች\n\nአሁን ላይ ክፍት የሆነ እድል የለም። አዲስ እድል ለመፍጠር Web App ይክፈቱ።" : "🚀 Opportunities\n\nNo open opportunities right now. Open the Web App to post one.");
      return;
    }
    const lines = items.map(o => {
      const emoji = OPPORTUNITY_EMOJI[o.type] ?? "🚀";
      const parts = [`${emoji} <b>${escapeHtml(o.title)}</b> — ${escapeHtml(o.organization)}`];
      if (o.location) parts.push(`📍 ${escapeHtml(o.location)}`);
      parts.push(o.deadline ? `⏳ Deadline: ${o.deadline.toISOString().slice(0, 10)}` : (locale === "am" ? "⏳ ጊዜ ገደብ የለም" : "⏳ No deadline"));
      parts.push(`⭐ ${o._count.saves}`);
      return parts.join("\n");
    });
    const header = locale === "am" ? "🚀 <b>እድሎች — ክፍት ዝርዝር</b>" : "🚀 <b>Opportunities — open now</b>";
    const kb = new InlineKeyboard().text(locale === "am" ? "🌐 ሁሉንም እድሎች ይመልከቱ" : "🌐 View all opportunities", "webapp:opportunities");
    await ctx.reply(`${header}\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", reply_markup: kb });
  } catch (err) {
    logger.error("opportunities handler failed", { error: String(err) });
    await ctx.reply(locale === "am" ? "🚀 እድሎች መጫን ተስፋ አልቋል፤ እንደገና ይሞክሩ።" : "🚀 Could not load opportunities right now; please try again.");
  }
}

bot.callbackQuery("trending", async (ctx) => {
  await ctx.answerCallbackQuery();
  const tgId = ctx.from ? String(ctx.from.id) : "";
  const user = tgId ? await db.user.findUnique({ where: { telegramId: tgId }, select: { locale: true } }) : null;
  await sendTrending(ctx, user?.locale === "ENGLISH" ? "en" : "am");
});

bot.callbackQuery("opportunities", async (ctx) => {
  await ctx.answerCallbackQuery();
  const tgId = ctx.from ? String(ctx.from.id) : "";
  const user = tgId ? await db.user.findUnique({ where: { telegramId: tgId }, select: { locale: true } }) : null;
  await sendOpportunities(ctx, user?.locale === "ENGLISH" ? "en" : "am");
});

// Deep-link buttons on trending/opportunity digests: open the GENZI Web App on the matching tab.
// Audit fix: these used `.url()` buttons, which open an external browser where there is no
// Telegram initData and every API call returns 401. Now they are web_app buttons so the Mini
// App opens inside Telegram with window.Telegram.WebApp.initData available.
for (const tab of ["trending", "opportunities"]) {
  bot.callbackQuery(`webapp:${tab}`, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!env.WEBAPP_URL || env.WEBAPP_URL === "*") return;
    const url = `${env.WEBAPP_URL.replace(/\/+$/, "")}/#${tab}`;
    await ctx.reply("🌐 GENZI Web App", {
      reply_markup: new InlineKeyboard().webApp(env.TELEGRAM_BOT_USERNAME ? `Open @${env.TELEGRAM_BOT_USERNAME}` : "Open GENZI", url)
    });
  });
}

// Menu button "🌐 App" — same web_app treatment as the main menu's dedicated Mini App row.
bot.callbackQuery("webapp_open", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!env.WEBAPP_URL || env.WEBAPP_URL === "*") return;
  await ctx.reply("🌐 GENZI Web App", {
    reply_markup: new InlineKeyboard().webApp("🌐 Open GENZI", env.WEBAPP_URL)
  });
});

registerPostFlow(bot);
registerConfessionFlow(bot);
registerAdmin(bot);
registerGroupModeration(bot);

// --- Bot basics (feature commit: /help command, setMyCommands, menu button, joins) --------
bot.command("help", async (ctx) => {
  const tgId = ctx.from ? String(ctx.from.id) : "";
  const user = tgId ? await db.user.findUnique({ where: { telegramId: tgId }, select: { locale: true } }) : null;
  const locale: Locale = user?.locale === "ENGLISH" ? "en" : "am";
  const helpText = locale === "am"
    ? "🇪🇹 <b>GENZI — የእርዳታ መመሪያ</b>\n\n📝 ፖስት — ከዋናው ዝርዝር \"ፖስት ፍጠር\" ይምረጡ\n🔐 መናዘዣ — በማንነት ስውር ወደ ቻናሉ ይላኩ\n🔥 አዝማሚያ — ባለፉት 7 ቀናት ታዋቂ ልጥፎች\n🚀 እድሎች — ስራ፣ ልምምድ እና ዕድሎች\n🌐 Web App — ከዋናው ቁልፍ \"🌐 መተግበሪያ ይክፈቱ\" ማህበረሰቦች፣ ዝግጅቶች፣ መልዕክቶች እና ገቢ\n🌐 ቋንቋ — /language\n❌ ማንኛውንም ሂደት ለመሰረዝ /cancel"
    : "🇬🇧 <b>GENZI — Help</b>\n\n📝 Posts — pick \"Create Post\" in the main menu\n🔐 Confessions — anonymous submissions to the channel\n🔥 Trending — top posts of the last 7 days\n🚀 Opportunities — jobs, internships and calls\n🌐 Web App — open \"🌐 Open App\" for communities, events, messages & earnings\n🌐 Language — /language\n❌ Cancel any flow with /cancel";
  const kb = new InlineKeyboard().url(locale === "am" ? "🌐 መተግበሪያ ይክፈቱ" : "🌐 Open App", env.WEBAPP_URL);
  await ctx.reply(helpText, { parse_mode: "HTML", reply_markup: kb });
});

// Register the native Telegram command list + the chat menu button once at startup
// (best-effort: works offline-safe because failures are only logged).
async function configureBotBasics(): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "ዋና ዝርዝር / Main menu" },
      { command: "help", description: "እርዳታ / Help" },
      { command: "language", description: "ቋንቋ / Language" },
      { command: "webapp", description: "መተግበሪያ / Open app" }
    ]);
    if (env.WEBAPP_URL && env.WEBAPP_URL !== "*") {
      await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "🌐 GENZI App", web_app: { url: env.WEBAPP_URL } } });
    }
  } catch (error) {
    logger.warn("bot basics configuration failed", { error: String(error) });
  }
}
void configureBotBasics();

bot.command("webapp", async (ctx) => {
  const kb = env.WEBAPP_URL && env.WEBAPP_URL !== "*"
    ? new InlineKeyboard().url(env.TELEGRAM_BOT_USERNAME ? `Open @${env.TELEGRAM_BOT_USERNAME}` : "Open", env.WEBAPP_URL)
    : null;
  await ctx.reply(env.WEBAPP_URL && env.WEBAPP_URL !== "*" ? "🌐 GENZI Web App" : "🌐 Web App not configured", kb ? { reply_markup: kb } : undefined);
});

// Welcome private chats when someone starts a chat with the bot from a group (chat_member)
// or adds the bot somewhere (my_chat_member). Group moderation itself stays in
// group-moderation.ts; this only sends the DM onboarding nudge.
const welcomedChats = new Set<string>();
bot.on("chat_member", async (ctx) => {
  const update = ctx.chatMember;
  if (!update || update.new_chat_member.status !== "member") return;
  const userId = update.new_chat_member.user.id;
  if (update.new_chat_member.status === "member" && update.new_chat_member.user.is_bot) return;
  if (userId === Number(env.TELEGRAM_OWNER_ID)) return;
  const key = `${update.chat.id}:${userId}`;
  if (welcomedChats.has(key)) return; // dedupe rapid-fire updates within the process lifetime
  welcomedChats.add(key);
  setTimeout(() => welcomedChats.delete(key), 60 * 60_000).unref?.();
  try {
    const user = await ensureUser(userId, update.new_chat_member.user.first_name, update.new_chat_member.user.username);
    const locale: Locale = user.locale === "ENGLISH" ? "en" : "am";
    await bot.api.sendMessage(userId, `${t(locale, "welcome")}\n\n${locale === "am" ? "GENZIን ለመጠቀም /start ይላኩ።" : "Send /start to use GENZI."}`);
  } catch {
    /* user likely hasn't started the bot yet — nothing to do */
  }
});

bot.on("my_chat_member", async (ctx) => {
  // When the bot is added to a group, greet once so members discover /start.
  if (!ctx.chat || !["group", "supergroup"].includes(ctx.chat.type)) return;
  if (ctx.myChatMember.new_chat_member.status === "left") return;
  try {
    const menuKb = env.WEBAPP_URL && env.WEBAPP_URL !== "*" ? new InlineKeyboard().url("🌐 Open GENZI", env.WEBAPP_URL) : null;
    await ctx.reply("🇪🇹 GENZI is here! Members can DM me /start to join the community.", menuKb ? { reply_markup: menuKb } : undefined);
  } catch {
    /* missing post permission in that group — non-fatal */
  }
});

// --- Blocking & muting (feature commit: Block / UserMute models were dead schema) ---------
// A blocked relationship hides profiles, feeds comments/DMs both ways; a mute stops the
// target's notifications to the blocker without them knowing. Enforced below in the
// presence/messages/comments/profile routes via these helpers.
async function isBlockedBetween(aId: string, bId: string): Promise<boolean> {
  const row = await db.block.findFirst({ where: { OR: [{ blockerId: aId, blockedId: bId }, { blockerId: bId, blockedId: aId }] }, select: { id: true } });
  return !!row;
}

async function isMutedBy(muterId: string, actorId: string): Promise<boolean> {
  const until = await db.userMute.findFirst({ where: { muterId, mutedId: actorId, OR: [{ untilAt: null }, { untilAt: { gt: new Date() } }] }, select: { id: true } });
  return !!until;
}

async function shouldDeliverNotification(blockerLookupUserId: string, actorId: string | null | undefined): Promise<boolean> {
  if (!actorId) return true;
  return !await isMutedBy(blockerLookupUserId, actorId);
}

app.post("/api/users/:id/block", telegramAuth, async (req: Request, res: Response) => {
  const blockerId = res.locals.telegramUser.id;
  const blockedId = String(req.params.id);
  if (blockerId === blockedId) return res.status(400).json({ success: false, data: null, error: "Cannot block yourself", timestamp: new Date().toISOString() });
  const target = await db.user.findUnique({ where: { id: blockedId }, select: { id: true } });
  if (!target) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  await db.$transaction(async tx => {
    await tx.block.upsert({ where: { blockerId_blockedId: { blockerId, blockedId } }, update: {}, create: { blockerId, blockedId } });
    // Blocking also ends any follow relationship between the pair so feeds stay consistent.
    await tx.follow.deleteMany({ where: { OR: [{ followerId: blockerId, followingId: blockedId }, { followerId: blockedId, followingId: blockerId }] } });
  });
  res.json({ success: true, data: { blocked: true }, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/users/:id/block", telegramAuth, async (req: Request, res: Response) => {
  await db.block.deleteMany({ where: { blockerId: res.locals.telegramUser.id, blockedId: String(req.params.id) } });
  res.json({ success: true, data: { blocked: false }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/blocks", telegramAuth, async (_req: Request, res: Response) => {
  const rows = await db.block.findMany({ where: { blockerId: res.locals.telegramUser.id }, orderBy: { createdAt: "desc" }, take: 100, include: { blocked: { select: { id: true, firstName: true, lastName: true, username: true } } } });
  res.json({ success: true, data: rows.map(r => ({ id: r.blocked.id, firstName: r.blocked.firstName, lastName: r.blocked.lastName, username: r.blocked.username, blockedAt: r.createdAt })), error: null, timestamp: new Date().toISOString() });
});

const MUTE_DURATION_MS: Record<string, number> = { "1h": 60 * 60_000, "8h": 8 * 60 * 60_000, "24h": 24 * 60 * 60_000, "forever": 100 * 365 * 24 * 60 * 60 * 1000 };

app.post("/api/users/:id/mute", telegramAuth, async (req: Request, res: Response) => {
  const muterId = res.locals.telegramUser.id;
  const mutedId = String(req.params.id);
  if (muterId === mutedId) return res.status(400).json({ success: false, data: null, error: "Cannot mute yourself", timestamp: new Date().toISOString() });
  const target = await db.user.findUnique({ where: { id: mutedId }, select: { id: true } });
  if (!target) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  const duration = typeof req.body?.duration === "string" && MUTE_DURATION_MS[req.body.duration] ? req.body.duration : "24h";
  const untilAt = new Date(Date.now() + (MUTE_DURATION_MS[duration] ?? MUTE_DURATION_MS["24h"] ?? 0));
  await db.userMute.upsert({ where: { muterId_mutedId: { muterId, mutedId } }, update: { untilAt }, create: { muterId, mutedId, untilAt } });
  res.json({ success: true, data: { muted: true, untilAt }, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/users/:id/mute", telegramAuth, async (req: Request, res: Response) => {
  await db.userMute.deleteMany({ where: { muterId: res.locals.telegramUser.id, mutedId: String(req.params.id) } });
  res.json({ success: true, data: { muted: false }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/mutes", telegramAuth, async (_req: Request, res: Response) => {
  const rows = await db.userMute.findMany({ where: { muterId: res.locals.telegramUser.id, OR: [{ untilAt: null }, { untilAt: { gt: new Date() } }] }, orderBy: { createdAt: "desc" }, take: 100, include: { muted: { select: { id: true, firstName: true, lastName: true, username: true } } } });
  res.json({ success: true, data: rows.map(r => ({ id: r.muted.id, firstName: r.muted.firstName, lastName: r.muted.lastName, username: r.muted.username, untilAt: r.untilAt })), error: null, timestamp: new Date().toISOString() });
});

bot.catch((err) => {
  console.error("GENZI bot error", err);
});

const BADGES = [
  { key: "FIRST_STEP", name: "የመጀመሪያ እርምጃ", description: "የመጀመሪያ ተሳትፎዎን ያድርጉ", emoji: "🌱", threshold: 10 },
  { key: "ACTIVE_100", name: "ንቁ ተሳታፊ", description: "100 XP ይድረሱ", emoji: "⚡", threshold: 100 },
  { key: "RISING_250", name: "እየተነሳ ያለ", description: "250 XP ይድረሱ", emoji: "🚀", threshold: 250 },
  { key: "GENZI_500", name: "GENZI ኮከብ", description: "500 XP ይድረሱ", emoji: "⭐", threshold: 500 },
  { key: "GENZI_1000", name: "GENZI ሻምፒዮን", description: "1000 XP ይድረሱ", emoji: "🏆", threshold: 1000 }
];
const XP_VALUES: Record<string, number> = { DAILY_CHECKIN: 5, VIEW_POST: 1, REACTION: 2, COMMENT: 3, FOLLOW: 4, COMMUNITY_JOIN: 5, EVENT_RSVP: 5, OPPORTUNITY_SAVE: 3, POLL_VOTE: 3, QUIZ_SUBMIT: 8, CREATE_POST: 10, CREATE_COMMUNITY: 15, CREATE_EVENT: 10, TIP_SENT: 2, CREATOR_SUBSCRIBE: 5, CONTENT_PURCHASE: 3 };

// --- Coin earning rules (fix: coins previously had no earnable source) --------------------
// Small engagement rewards credit the wallet directly so every active user can accumulate
// GENZI Coins and actually use tips / paid posts / subscriptions. Daily caps keep the economy
// bounded; the ledger (WalletTransaction type EARN_*) stays fully auditable.
const EARN_RULES: Record<string, { coins: number; dailyCap: number }> = {
  DAILY_CHECKIN: { coins: 5, dailyCap: 1 },
  POST_PUBLISHED: { coins: 10, dailyCap: 5 },
  COMMENT_RECEIVED: { coins: 2, dailyCap: 10 },
  REACTION_RECEIVED: { coins: 1, dailyCap: 15 },
  NEW_FOLLOWER: { coins: 3, dailyCap: 5 }
};

async function earnCoins(userId: string, action: keyof typeof EARN_RULES): Promise<void> {
  const rule = EARN_RULES[action];
  if (!rule) return;
  try {
    const monthlyLimit = (Math.max(1, Number.parseInt(await getSetting("earn_daily_limit", DEFAULT_SETTINGS.earn_daily_limit ?? "200"), 10) || 200)) * 30;
    const dayKey = new Date().toISOString().slice(0, 10);
    const todayRows = await db.walletTransaction.findMany({
      where: { userId, type: `EARN_${action}`, createdAt: { gte: new Date(`${dayKey}T00:00:00.000Z`) } },
      select: { id: true }
    });
    if (todayRows.length >= rule.dailyCap) return;
    const monthStart = new Date(); monthStart.setUTCHours(0, 0, 0, 0); monthStart.setUTCDate(1);
    const monthTotal = await db.walletTransaction.aggregate({
      where: { userId, type: { startsWith: "EARN_" }, createdAt: { gte: monthStart } },
      _sum: { amount: true }
    });
    if ((monthTotal._sum.amount ?? 0) + rule.coins > monthlyLimit) return;
    await db.$transaction(async tx => {
      await tx.wallet.upsert({ where: { userId }, update: {}, create: { userId, balance: 0 } });
      await tx.wallet.update({ where: { userId }, data: { balance: { increment: rule.coins } } });
      await tx.walletTransaction.create({ data: { userId, type: `EARN_${action}`, amount: rule.coins, reference: action, note: "ENGAGEMENT_REWARD" } });
    });
  } catch (error) { logger.error("earnCoins failed", { userId, action, error: String(error) }); }
}

async function awardXp(userId: string, action: string) {
  const points = XP_VALUES[action] ?? 0; if (points <= 0) return;
  const today = new Date().toISOString().slice(0, 10);
  const user = await db.user.findUnique({ where: { id: userId }, select: { xp: true, level: true, currentStreak: true, longestStreak: true, lastActiveDate: true } });
  if (!user) return;
  const duplicate = action === "DAILY_CHECKIN" ? user.lastActiveDate === today : false;
  if (duplicate) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const streak = action === "DAILY_CHECKIN" ? (user.lastActiveDate === yesterday ? user.currentStreak + 1 : 1) : user.currentStreak;
  const xp = user.xp + points; const level = Math.max(1, Math.floor(xp / 100) + 1);
  await db.$transaction(async tx => {
    await tx.xpEvent.create({ data: { userId, action, points } });
    await tx.user.update({ where: { id: userId }, data: { xp, level, currentStreak: streak, longestStreak: Math.max(user.longestStreak, streak), ...(action === "DAILY_CHECKIN" ? { lastActiveDate: today } : {}) } });
    for (const b of BADGES.filter((x: typeof BADGES[number]) => xp >= x.threshold)) {
      const badge = await tx.badge.upsert({ where: { key: b.key }, update: { name: b.name, description: b.description, emoji: b.emoji, threshold: b.threshold }, create: b });
      await tx.userBadge.upsert({ where: { userId_badgeId: { userId, badgeId: badge.id } }, update: {}, create: { userId, badgeId: badge.id } });
    }
  });
}

const realtimeSubscribers = new Map<string, Set<(event: Record<string, unknown>) => void>>();
const realtimeTokens = new Map<string, { userId: string; expiresAt: number }>();
const presence = new Map<string, number>();

// Short-lived signed media URLs. Browser <img>/<video> tags cannot send the
// X-Telegram-Init-Data header, so authenticated media is delivered through a
// one-time tokenized URL instead (docs/MONETIZATION & audit fix #1).
const MEDIA_TOKEN_TTL_MS = 5 * 60_000;
const mediaTokens = new Map<string, { fileId: string; userId: string; expiresAt: number }>();
const STAFF_ROLES = ["OWNER", "MODERATOR"];

function createMediaToken(fileId: string, userId: string): string {
  const token = randomBytes(24).toString("base64url");
  mediaTokens.set(token, { fileId, userId, expiresAt: Date.now() + MEDIA_TOKEN_TTL_MS });
  return token;
}

function consumeMediaToken(token: string): { fileId: string; userId: string } | null {
  const entry = mediaTokens.get(token);
  if (!entry) return null;
  mediaTokens.delete(token); // single-use
  if (entry.expiresAt <= Date.now()) return null;
  return entry;
}

// Paid posts must not leak their media to non-buyers (audit fix #6/#1 combined).
async function canViewerSeePostMedia(userId: string | null, fileId: string): Promise<boolean> {
  if (!userId) return false;
  const viewer = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (viewer && STAFF_ROLES.includes(viewer.role)) return true;
  const post = await db.post.findFirst({ where: { mediaFileId: fileId }, orderBy: { publishedAt: "desc" }, select: { id: true, authorId: true, monetizationType: true } });
  if (!post || post.monetizationType !== "PAID") return true;
  if (post.authorId === userId) return true;
  return !!await db.contentPurchase.findUnique({ where: { postId_buyerId: { postId: post.id, buyerId: userId } } });
}

async function deliverTelegramFile(fileId: string, res: Response): Promise<void> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) { res.sendStatus(404); return; }
  const upstream = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
  if (!upstream.ok || !upstream.body) { res.sendStatus(404); return; }
  res.setHeader("Cache-Control", "no-store");
  const contentType = upstream.headers.get("content-type");
  if (contentType) res.setHeader("Content-Type", contentType);
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);
  const reader = upstream.body.getReader();
  const pump = async (): Promise<void> => {
    const { done, value } = await reader.read();
    if (done) { res.end(); return; }
    res.write(Buffer.from(value));
    await pump();
  };
  await pump();
}

function publishRealtime(userId: string, event: Record<string, unknown>): void {
  const listeners = realtimeSubscribers.get(userId);
  if (!listeners) return;
  for (const listener of listeners) listener(event);
}

function createRealtimeToken(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  realtimeTokens.set(token, { userId, expiresAt: Date.now() + 60_000 });
  return token;
}

function pruneRealtimeState(): void {
  const now = Date.now();
  for (const [token, value] of realtimeTokens) if (value.expiresAt <= now) realtimeTokens.delete(token);
  for (const [userId, lastSeen] of presence) if (lastSeen + 90_000 <= now) presence.delete(userId);
  for (const [token, value] of mediaTokens) if (value.expiresAt <= now) mediaTokens.delete(token);
}
setInterval(pruneRealtimeState, 30_000).unref();

// NOTE: the express app is declared near the top of this module (before the bot
// handlers) because several API route groups are registered mid-file.
const POST_BODY_MAX = 6000;
// CORS must run BEFORE the rate limiter: a 429 without CORS headers is invisible to the browser,
// which reports it as a generic "Network error" in the Mini App.
// Access-Control-Allow-Origin must be an ORIGIN (scheme://host[:port], no path / trailing slash).
// WEBAPP_URL is also the Mini App button URL, so for GitHub Pages it looks like
// https://owner.github.io/repo/ — echoing that raw string made every browser request fail CORS.
function toOrigin(value: string): string | null {
  try { return new URL(value.trim()).origin; } catch { return null; }
}
const corsAllowAll = env.WEBAPP_URL.trim() === "*";
const corsOrigins = new Set(
  [env.WEBAPP_URL, ...(env.CORS_ORIGINS ?? "").split(",")]
    .map((value) => toOrigin(value))
    .filter((value): value is string => value !== null)
);
app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (corsAllowAll) res.setHeader("Access-Control-Allow-Origin", "*");
  else if (origin && corsOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, X-Moderator-Session, X-Telegram-Init-Data");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Max-Age", "600");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(rateLimit);

app.post("/api/realtime/token", telegramAuth, async (_req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  presence.set(userId, Date.now());
  res.json({ success: true, data: { token: createRealtimeToken(userId), expiresInSeconds: 60 }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/realtime/stream", (req: Request, res: Response) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const session = realtimeTokens.get(token);
  if (!session || session.expiresAt <= Date.now()) return res.status(401).json({ success: false, data: null, error: "Realtime session expired", timestamp: new Date().toISOString() });
  realtimeTokens.delete(token);
  const userId = session.userId;
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (event: Record<string, unknown>) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  const listeners = realtimeSubscribers.get(userId) ?? new Set<(event: Record<string, unknown>) => void>();
  listeners.add(send); realtimeSubscribers.set(userId, listeners); presence.set(userId, Date.now());
  send({ type: "connected", at: new Date().toISOString() });
  const heartbeat = setInterval(() => { presence.set(userId, Date.now()); res.write(": heartbeat\n\n") }, 25_000);
  req.on("close", () => { clearInterval(heartbeat); listeners.delete(send); if (!listeners.size) realtimeSubscribers.delete(userId) });
});

app.post("/api/me/presence", telegramAuth, async (_req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id; presence.set(userId, Date.now());
  res.json({ success: true, data: { online: true }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/users/:id/presence", telegramAuth, async (req: Request, res: Response) => {
  const user = await db.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, blocked: true } });
  if (!user || user.blocked) return res.status(404).json({ success: false, data: null, error: "User not available", timestamp: new Date().toISOString() });
  const lastSeen = presence.get(user.id) ?? null; const online = lastSeen !== null && lastSeen + 90_000 > Date.now();
  res.json({ success: true, data: { online, lastSeen }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/messages/:userId/typing", telegramAuth, async (req: Request, res: Response) => {
  const senderId = res.locals.telegramUser.id; const recipientId = String(req.params.userId);
  if (senderId === recipientId) return res.status(400).json({ success: false, data: null, error: "Invalid recipient", timestamp: new Date().toISOString() });
  const recipient = await db.user.findUnique({ where: { id: recipientId }, select: { id: true, blocked: true } });
  if (!recipient || recipient.blocked) return res.status(404).json({ success: false, data: null, error: "User not available", timestamp: new Date().toISOString() });
  publishRealtime(recipientId, { type: "typing", userId: senderId, active: true, expiresAt: Date.now() + 3_000 });
  res.json({ success: true, data: { typing: true }, error: null, timestamp: new Date().toISOString() });
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: { service: "genzi-bot", status: "ok", version: "0.3.5" }, error: null, timestamp: new Date().toISOString() });
});

app.get("/ready", async (_req: Request, res: Response) => {
  try {
    await db.$queryRaw`SELECT 1`;
    res.status(200).json({ success: true, data: { service: "genzi-bot", status: "ready", database: "ok" }, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error("Readiness check failed", { error: error instanceof Error ? error.message : String(error) });
    res.status(503).json({ success: false, data: { service: "genzi-bot", status: "not_ready", database: "error" }, error: "Database unavailable", timestamp: new Date().toISOString() });
  }
});

app.get("/api/admin/diagnostics", adminAuth, async (_req: Request, res: Response) => {
  const started = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    res.json({ success: true, data: { status: "ok", database: "ok", databaseLatencyMs: Date.now() - started, nodeEnv: env.NODE_ENV, botMode: env.BOT_MODE, uptimeSeconds: Math.floor(process.uptime()) }, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error("Diagnostics database check failed", { error: error instanceof Error ? error.message : String(error) });
    res.status(503).json({ success: false, data: { status: "degraded", database: "error", nodeEnv: env.NODE_ENV, botMode: env.BOT_MODE, uptimeSeconds: Math.floor(process.uptime()) }, error: "Database unavailable", timestamp: new Date().toISOString() });
  }
});

// Paid content is only ever exposed to buyers, the author, or staff (audit fix #6).
// --- Subscription lifecycle helpers (fix: subs never expired / renewed / could be cancelled) --
// Subscription grace window is tunable at runtime via the Setting table (see PUT /api/admin/settings).

async function activeSubscriptionFor(subscriberId: string, creatorId: string): Promise<{ id: string } | null> {
  await expireDueSubscriptions(subscriberId, creatorId);
  return db.creatorSubscription.findFirst({ where: { subscriberId, creatorId, status: "ACTIVE" }, select: { id: true } });
}

async function expireDueSubscriptions(subscriberId?: string, creatorId?: string): Promise<void> {
  const due = await db.creatorSubscription.findMany({
    where: { status: "ACTIVE", expiresAt: { not: null, lt: new Date() }, ...(subscriberId ? { subscriberId } : {}), ...(creatorId ? { creatorId } : {}) }
  });
  for (const sub of due) {
    if (!sub.cancelAtPeriodEnd && sub.autoRenew) {
      try {
        await transferCoins(sub.subscriberId, sub.creatorId, sub.priceCoins, "SUBSCRIPTION_RENEWAL", sub.id);
        await db.creatorSubscription.update({ where: { id: sub.id }, data: { status: "ACTIVE", startedAt: new Date(), expiresAt: new Date(Date.now() + sub.periodDays * 86_400_000) } });
        await db.notification.create({ data: { userId: sub.subscriberId, type: "SUBSCRIPTION", title: "⭐ አባልነት ተሐድሷል", body: `አባልነትዎ ለሌላ ${sub.periodDays} ቀናት በ🪙 ${sub.priceCoins} Coins ተሐድሷል።` } }).catch(() => undefined);
        continue;
      } catch {
        // Not enough coins to renew — fall through and let the subscription lapse.
      }
    }
    await db.creatorSubscription.update({ where: { id: sub.id }, data: { status: "EXPIRED" } });
    await db.notification.create({ data: { userId: sub.subscriberId, type: "SUBSCRIPTION", title: "⏳ አባልነት አልቋል", body: "አባልነትዎ ጊዜው አልፎበታል። ለመቀጠል እንደገና ይጀምሩ።" } }).catch(() => undefined);
  }
}

// Background sweeper so subscriptions actually expire/renew even when nobody opens the app.
setInterval(() => { void expireDueSubscriptions().catch((error) => logger.error("subscription sweep failed", { error: String(error) })); }, 5 * 60_000).unref();

// Background sweeper for event reminders (RSVP-created EventReminder rows fire ~1 sweep tick
// after their computed fire-time). Without this call, reminders were written but never sent.
startReminderSweeper(notifier);

function hidePaidPostBody<T extends { monetizationType: string; priceCoins: number; authorId: string }>(post: T, viewerId: string | null, viewerRole: string | null): T {
  if (post.monetizationType !== "PAID") return post;
  if (viewerId && (viewerId === post.authorId || (viewerRole && STAFF_ROLES.includes(viewerRole)))) return post;
  return { ...post, body: "", excerpt: "" };
}

async function listPublishedPosts(where: Record<string, unknown>, viewer: { id: string; role: string } | null, page: number, limit: number) {
  // Quarantined posts stay hidden from public listings until a moderator approves them
  // (admin approval queue); the author can still see them in /api/me/posts.
  const scoped = { visibility: "PUBLIC", ...where };
  const [posts, total] = await Promise.all([
    db.post.findMany({ where: scoped, orderBy: { publishedAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    db.post.count({ where: scoped })
  ]);
  return { posts: await decoratePostsForViewer(posts, viewer), total };
}

// --- Paid + subscriber-only content gating ---------------------------------------------------
// A viewer unlocks a post when they are staff/author, bought it, or hold an ACTIVE subscription
// to the creator while the post is marked SUBSCRIBERS. Previously subscriptions gated nothing
// and there was no subscriber-only content type at all.
async function canViewPostBody(post: { monetizationType: string; priceCoins: number; authorId: string }, viewer: { id: string; role: string } | null): Promise<boolean> {
  if (!viewer) return false;
  if (viewer.id === post.authorId || STAFF_ROLES.includes(viewer.role)) return true;
  if (post.monetizationType === "SUBSCRIBERS") return !!await activeSubscriptionFor(viewer.id, post.authorId);
  if (post.monetizationType !== "PAID") return true;
  return !!await db.contentPurchase.findUnique({ where: { postId_buyerId: { postId: (post as { id?: string }).id ?? "", buyerId: viewer.id } } });
}

function gatePost<T extends { id: string; monetizationType: string; priceCoins: number; authorId: string; body: string; excerpt: string; mediaFileId: string | null }>(post: T, unlocked: boolean): T & { purchased: boolean; subscriberOnly: boolean } {
  const subscriberOnly = post.monetizationType === "SUBSCRIBERS";
  if (unlocked || post.monetizationType === "FREE") return { ...post, purchased: true, subscriberOnly };
  return { ...post, body: "", excerpt: "", mediaFileId: subscriberOnly ? post.mediaFileId : null, purchased: false, subscriberOnly };
}

async function decoratePostsForViewer(posts: Array<{ id: string; monetizationType: string; priceCoins: number; authorId: string; body: string; excerpt: string; mediaFileId: string | null }>, viewer: { id: string; role: string } | null) {
  const purchases = viewer ? await db.contentPurchase.findMany({ where: { buyerId: viewer.id }, select: { postId: true } }) : [];
  const bought = new Set(purchases.map((p) => p.postId));
  const subs = viewer ? await db.creatorSubscription.findMany({ where: { subscriberId: viewer.id, status: "ACTIVE" }, select: { creatorId: true } }) : [];
  const subbedCreators = new Set(subs.map((s) => s.creatorId));
  return posts.map((p) => {
    const unlocked = !viewer ? false : (p.authorId === viewer.id || (viewer.role && STAFF_ROLES.includes(viewer.role)) || bought.has(p.id) || (p.monetizationType === "SUBSCRIBERS" && subbedCreators.has(p.authorId)));
    return gatePost(p, unlocked);
  });
}

// Best-effort viewer resolution for public endpoints: if a valid Telegram WebApp
// session header is present we identify the user (needed for paid-content gating);
// anonymous visitors simply get the locked view.
async function resolveOptionalViewer(req: Request): Promise<{ id: string; role: string } | null> {
  const initData = req.header("X-Telegram-Init-Data") ?? "";
  if (!initData) return null;
  const tgUser = validateTelegramInitData(initData);
  if (!tgUser) return null;
  const user = await db.user.findUnique({ where: { telegramId: String(tgUser.id) }, select: { id: true, role: true, blocked: true } });
  if (!user || user.blocked) return null;
  return { id: user.id, role: user.role };
}

app.get("/api/posts", async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const where = {
    publishedAt: { not: null },
    ...(category ? { category } : {}),
    ...(q ? { OR: [{ title: { contains: q } }, { body: { contains: q } }, { tagsJson: { contains: q } }] } : {})
  };
  const viewer = await resolveOptionalViewer(req);
  const { posts, total } = await listPublishedPosts(where, viewer, page, limit);
  res.json({ success: true, data: { items: posts, page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

// Slug lookup used by the Mini App deep link (?startapp=post_<slug>) coming from the
// channel's "Read More" button. Registered BEFORE /api/posts/:id so "slug" is not treated
// as an id; gated exactly like the id route (published + quarantine visibility rules).
app.get("/api/posts/slug/:slug", async (req: Request, res: Response) => {
  const post = await db.post.findUnique({ where: { slug: String(req.params.slug) } });
  if (!post || !post.publishedAt) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const viewer = await resolveOptionalViewer(req);
  if (post.visibility === "QUARANTINED" && !(viewer && (viewer.id === post.authorId || STAFF_ROLES.includes(viewer.role)))) {
    return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  }
  const [decorated] = await decoratePostsForViewer([post], viewer);
  res.json({ success: true, data: decorated, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/posts/:id", async (req: Request, res: Response) => {
  const post = await db.post.findUnique({ where: { id: String(req.params.id) } });
  if (!post || !post.publishedAt) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const viewer = await resolveOptionalViewer(req);
  // Quarantined posts are only visible to their author and staff until approved.
  if (post.visibility === "QUARANTINED" && !(viewer && (viewer.id === post.authorId || STAFF_ROLES.includes(viewer.role)))) {
    return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  }
  const [decorated] = await decoratePostsForViewer([post], viewer);
  res.json({ success: true, data: decorated, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me", telegramAuth, async (_req: Request, res: Response) => { const user = res.locals.telegramUser; res.json({ success: true, data: { id: user.id, telegramId: user.telegramId, firstName: user.firstName, username: user.username, role: user.role, locale: user.locale }, error: null, timestamp: new Date().toISOString() }); });

const REACTION_TYPES = ["LIKE", "FIRE", "LOVE"] as const;
const COMMENT_MAX = 600;

app.get("/api/me/profile", telegramAuth, async (_req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  res.json({ success: true, data: {
    id: user.id, telegramId: user.telegramId, username: user.username, firstName: user.firstName,
    lastName: user.lastName, role: user.role, locale: user.locale, bio: user.bio, avatarFileId: user.avatarFileId,
    createdAt: user.createdAt
  }, error: null, timestamp: new Date().toISOString() });
});

// --- Profile management (feature commit: avatar setting + language switching) -------------
// PATCH /api/me/profile now also accepts locale ("AMHARIC"|"ENGLISH") and clearing the avatar.
app.patch("/api/me/profile", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const bio = typeof req.body?.bio === "string" ? req.body.bio.normalize("NFKC").trim().slice(0, 160) : undefined;
  const firstName = typeof req.body?.firstName === "string" ? req.body.firstName.trim().slice(0, 64) : undefined;
  const localeRaw = req.body?.locale;
  const locale = localeRaw === "AMHARIC" || localeRaw === "ENGLISH" ? (localeRaw as "AMHARIC" | "ENGLISH") : undefined;
  const updated = await db.user.update({ where: { id: user.id }, data: { ...(bio !== undefined ? { bio } : {}), ...(firstName !== undefined ? { firstName } : {}), ...(locale !== undefined ? { locale } : {}) } });
  res.json({ success: true, data: { id: updated.id, firstName: updated.firstName, bio: updated.bio, locale: updated.locale }, error: null, timestamp: new Date().toISOString() });
});

// Avatar: Mini App uploads an image via the media endpoint and attaches the resulting
// Telegram fileId; delivery to <img> reuses the signed-media route below.
app.put("/api/me/avatar", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const fileId = typeof req.body?.fileId === "string" && /^[A-Za-z0-9_-]{20,200}$/.test(req.body.fileId) ? req.body.fileId : null;
  if (!fileId) return res.status(400).json({ success: false, data: null, error: "A valid Telegram file id is required (upload first via /api/me/upload-media)", timestamp: new Date().toISOString() });
  const updated = await db.user.update({ where: { id: user.id }, data: { avatarFileId: fileId } });
  res.json({ success: true, data: { avatarFileId: updated.avatarFileId }, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/me/avatar", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  await db.user.update({ where: { id: user.id }, data: { avatarFileId: null } });
  res.json({ success: true, data: { avatarFileId: null }, error: null, timestamp: new Date().toISOString() });
});

// User search for the Mini App (find people to follow/message/block). Excludes blocked pairs.
app.get("/api/users", telegramAuth, async (req: Request, res: Response) => {
  const me = res.locals.telegramUser.id;
  const q = typeof req.query.q === "string" ? req.query.q.normalize("NFKC").trim().slice(0, 60) : "";
  if (!q) return res.json({ success: true, data: [], error: null, timestamp: new Date().toISOString() });
  const blockedRows = await db.block.findMany({ where: { OR: [{ blockerId: me }, { blockedId: me }] }, select: { blockerId: true, blockedId: true } });
  const hidden = new Set(blockedRows.flatMap(r => [r.blockerId, r.blockedId]));
  const rows = await db.user.findMany({
    where: { blocked: false, id: { not: me }, OR: [{ username: { contains: q } }, { firstName: { contains: q } }, { lastName: { contains: q } }] },
    take: 20, select: { id: true, firstName: true, lastName: true, username: true, bio: true, avatarFileId: true, _count: { select: { followers: true } } }
  });
  const followed = new Set((await db.follow.findMany({ where: { followerId: me, followingId: { in: rows.map(r => r.id) } }, select: { followingId: true } })).map(x => x.followingId));
  res.json({ success: true, data: rows.filter(r => !hidden.has(r.id)).map(r => ({ ...r, following: followed.has(r.id) })), error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/creator-dashboard", telegramAuth, async (_req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const [user, posts, followers, following, views, reactions, comments] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { id: true, firstName: true, lastName: true, username: true, bio: true, createdAt: true, _count: { select: { followers: true, following: true, posts: true } } } }),
    db.post.findMany({ where: { authorId: userId, publishedAt: { not: null } }, orderBy: { publishedAt: "desc" }, take: 100, select: { id: true, title: true, category: true, publishedAt: true, createdAt: true } }),
    db.follow.count({ where: { followingId: userId } }),
    db.follow.count({ where: { followerId: userId } }),
    db.feedEvent.findMany({ where: { event: "VIEW", post: { authorId: userId } }, select: { postId: true } }),
    db.postReaction.findMany({ where: { post: { authorId: userId } }, select: { postId: true, type: true } }),
    db.postComment.count({ where: { status: "VISIBLE", post: { authorId: userId } } })
  ]);
  const reactionCounts = { LIKE: 0, FIRE: 0, LOVE: 0 };
  for (const r of reactions) { if (r.type in reactionCounts) reactionCounts[r.type as keyof typeof reactionCounts]++; }
  const viewCounts = new Map<string, number>();
  for (const v of views) viewCounts.set(v.postId, (viewCounts.get(v.postId) ?? 0) + 1);
  const topPosts = posts.map(post => ({ ...post, views: viewCounts.get(post.id) ?? 0 })).sort((a, b) => b.views - a.views).slice(0, 10);
  res.json({ success: true, data: { profile: user, followers, following, totalPosts: posts.length, totalViews: views.length, totalReactions: reactions.length, totalComments: comments, reactionCounts, topPosts }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/users/:id/posts", telegramAuth, async (req: Request, res: Response) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12));
  const where = { authorId: String(req.params.id), publishedAt: { not: null } };
  const [items, total] = await Promise.all([
    db.post.findMany({ where, orderBy: { publishedAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    db.post.count({ where })
  ]);
  res.json({ success: true, data: { items, page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/bookmarks", telegramAuth, async (_req: Request, res: Response) => {
  const rows = await db.bookmark.findMany({ where: { userId: res.locals.telegramUser.id }, orderBy: { createdAt: "desc" }, take: 100, include: { post: true } });
  res.json({ success: true, data: rows.map(r => r.post), error: null, timestamp: new Date().toISOString() });
});

app.post("/api/posts/:id/bookmark", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const existing = await db.bookmark.findUnique({ where: { userId_postId: { userId, postId: post.id } } });
  if (existing) await db.bookmark.delete({ where: { id: existing.id } });
  else await db.bookmark.create({ data: { userId, postId: post.id } });
  res.json({ success: true, data: { saved: !existing }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/posts/:id/bookmark", telegramAuth, async (req: Request, res: Response) => {
  const saved = !!await db.bookmark.findUnique({ where: { userId_postId: { userId: res.locals.telegramUser.id, postId: String(req.params.id) } } });
  res.json({ success: true, data: { saved }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/posts/:id/view", telegramAuth, async (req: Request, res: Response) => {
  const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true, category: true } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  await db.feedEvent.create({ data: { userId: res.locals.telegramUser.id, postId: post.id, event: "VIEW" } }); await awardXp(res.locals.telegramUser.id, "VIEW_POST");
  res.json({ success: true, data: { recorded: true }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/feed", telegramAuth, async (req: Request, res: Response) => {
  const viewer = res.locals.telegramUser;
  const userId = viewer.id;
  const mode = req.query.mode === "following" || req.query.mode === "trending" ? String(req.query.mode) : "for-you";
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const skip = (page - 1) * limit;

  if (mode === "following") {
    const follows = await db.follow.findMany({ where: { followerId: userId }, select: { followingId: true } });
    const ids = follows.map(x => x.followingId);
    if (!ids.length) return res.json({ success: true, data: { items: [], page, limit, total: 0, hasMore: false, mode }, error: null, timestamp: new Date().toISOString() });
    const where = { publishedAt: { not: null }, authorId: { in: ids } };
    const { posts, total } = await listPublishedPosts(where, viewer, page, limit);
    return res.json({ success: true, data: { items: posts, page, limit, total, hasMore: page * limit < total, mode }, error: null, timestamp: new Date().toISOString() });
  }

  if (mode === "trending") {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [allPosts, views, reactions, comments] = await Promise.all([
      db.post.findMany({ where: { publishedAt: { not: null }, visibility: "PUBLIC" }, orderBy: { publishedAt: "desc" }, take: 200 }),
      db.feedEvent.findMany({ where: { event: "VIEW", createdAt: { gte: since } }, select: { postId: true } }),
      db.postReaction.findMany({ where: { createdAt: { gte: since } }, select: { postId: true } }),
      db.postComment.findMany({ where: { createdAt: { gte: since }, status: "VISIBLE" }, select: { postId: true } })
    ]);
    const score = new Map<string, number>();
    for (const e of views) score.set(e.postId, (score.get(e.postId) ?? 0) + 1);
    for (const e of reactions) score.set(e.postId, (score.get(e.postId) ?? 0) + 3);
    for (const e of comments) score.set(e.postId, (score.get(e.postId) ?? 0) + 4);
    allPosts.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
    const total = allPosts.length, items = await decoratePostsForViewer(allPosts.slice(skip, skip + limit), viewer);
    return res.json({ success: true, data: { items, page, limit, total, hasMore: page * limit < total, mode }, error: null, timestamp: new Date().toISOString() });
  }

  const events = await db.feedEvent.findMany({ where: { userId, event: "VIEW" }, orderBy: { createdAt: "desc" }, take: 200, include: { post: { select: { category: true } } } });
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.post.category, (counts.get(e.post.category) ?? 0) + 1);
  const preferred = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([category]) => category);
  const posts = await db.post.findMany({ where: { publishedAt: { not: null }, visibility: "PUBLIC" }, orderBy: { publishedAt: "desc" }, take: 200 });
  const rank = (category: string) => { const i = preferred.indexOf(category); return i < 0 ? preferred.length + 5 : i };
  posts.sort((a, b) => rank(a.category) - rank(b.category) || (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0));
  const total = posts.length;
  const items = await decoratePostsForViewer(posts.slice(skip, skip + limit), viewer);
  res.json({ success: true, data: { items, page, limit, total, hasMore: page * limit < total, preferredCategories: preferred.slice(0, 5), mode }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/discover/creators", telegramAuth, async (req: Request, res: Response) => {
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12));
  const me = res.locals.telegramUser.id;
  const creators = await db.user.findMany({
    where: { blocked: false, id: { not: me }, posts: { some: { publishedAt: { not: null } } } },
    select: { id: true, firstName: true, lastName: true, username: true, bio: true, _count: { select: { followers: true, posts: true } } },
    orderBy: { createdAt: "desc" }, take: 100
  });
  const followed = new Set((await db.follow.findMany({ where: { followerId: me }, select: { followingId: true } })).map(x => x.followingId));
  creators.sort((a, b) => b._count.followers - a._count.followers || b._count.posts - a._count.posts);
  res.json({ success: true, data: creators.slice(0, limit).map(c => ({ ...c, following: followed.has(c.id) })), error: null, timestamp: new Date().toISOString() });
});

const COMMUNITY_NAME_MAX = 60;
const COMMUNITY_DESC_MAX = 240;
const COMMUNITY_CATEGORIES = ["ዩኒቨርሲቲ", "ቴክኖሎጂ", "ሙዚቃ", "ጨዋታ", "ስራ", "ንግድ", "ፋሽን", "ከተማ", "ማህበረሰብ"] as const;
const OPPORTUNITY_TYPES = ["JOB", "GIG", "INTERNSHIP", "SCHOLARSHIP", "TRAINING", "COMPETITION", "BUSINESS", "OTHER"] as const;
const OPPORTUNITY_CATEGORIES = ["ስራ", "ፍሪላንስ", "ትምህርት", "ስኮላርሺፕ", "ስልጠና", "ውድድር", "ንግድ", "ሌላ"] as const;

// Shared opportunity validation/serialization (used by both user and admin APIs).
type OpportunityRow = {
  id: string; title: string; description: string; type: string; category: string;
  organization: string; location: string | null; deadline: Date | null;
  contactText: string | null; applicationUrl: string | null; verified: boolean; active: boolean;
};

app.get("/api/opportunities", telegramAuth, async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.normalize("NFKC").trim() : "";
  const type = typeof req.query.type === "string" ? req.query.type : "";
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const now = new Date();
  const where = { active: true, OR: [{ deadline: null }, { deadline: { gte: now } }], ...(type ? { type } : {}), ...(category ? { category } : {}), ...(q ? { OR: [{ title: { contains: q } }, { description: { contains: q } }, { organization: { contains: q } }, { location: { contains: q } }] } : {}) };
  const [items, total, savedRows] = await Promise.all([
    db.opportunity.findMany({ where, orderBy: [{ verified: "desc" }, { deadline: "asc" }, { createdAt: "desc" }], skip: (page - 1) * limit, take: limit, include: { _count: { select: { saves: true } } } }),
    db.opportunity.count({ where }),
    db.opportunitySave.findMany({ where: { userId: res.locals.telegramUser.id }, select: { opportunityId: true } })
  ]);
  const saved = new Set(savedRows.map(x => x.opportunityId));
  res.json({ success: true, data: { items: items.map(x => ({ ...x, saved: saved.has(x.id) })), page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/opportunities/:id", telegramAuth, async (req: Request, res: Response) => {
  const item = await db.opportunity.findUnique({ where: { id: String(req.params.id) }, include: { _count: { select: { saves: true } }, owner: { select: { id: true, firstName: true, username: true } } } });
  if (!item || !item.active) return res.status(404).json({ success: false, data: null, error: "Opportunity not found", timestamp: new Date().toISOString() });
  const saved = !!await db.opportunitySave.findUnique({ where: { opportunityId_userId: { opportunityId: item.id, userId: res.locals.telegramUser.id } } });
  res.json({ success: true, data: { ...item, saved }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/opportunities", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const title = typeof req.body?.title === "string" ? req.body.title.normalize("NFKC").trim().slice(0, 120) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.normalize("NFKC").trim().slice(0, 1200) : "";
  const organization = typeof req.body?.organization === "string" ? req.body.organization.normalize("NFKC").trim().slice(0, 120) : "";
  const type = typeof req.body?.type === "string" ? req.body.type : "";
  const category = typeof req.body?.category === "string" ? req.body.category : "";
  const location = typeof req.body?.location === "string" ? req.body.location.normalize("NFKC").trim().slice(0, 100) : "";
  const contactText = typeof req.body?.contactText === "string" ? req.body.contactText.normalize("NFKC").trim().slice(0, 300) : "";
  const deadlineRaw = typeof req.body?.deadline === "string" ? req.body.deadline : "";
  // Fix: users could never attach an application link — the field was only settable via the
  // admin path. Non-admin URLs are still validated against the moderation allow-list below.
  const applicationUrl = typeof req.body?.applicationUrl === "string" ? req.body.applicationUrl.normalize("NFKC").trim().slice(0, 300) : "";
  if (applicationUrl && !/^https?:\/\/\S+$/i.test(applicationUrl)) return res.status(400).json({ success: false, data: null, error: "የማመልከቻ አድናሺ ትክክለኛ URL መሆን አለበት።", timestamp: new Date().toISOString() });
  if (!title || !description || !organization || !OPPORTUNITY_TYPES.includes(type as typeof OPPORTUNITY_TYPES[number]) || !OPPORTUNITY_CATEGORIES.includes(category as typeof OPPORTUNITY_CATEGORIES[number])) return res.status(400).json({ success: false, data: null, error: "የሚያስፈልጉ መረጃዎች አልሞሉም።", timestamp: new Date().toISOString() });
  const deadline = deadlineRaw ? new Date(deadlineRaw) : null;
  if (deadlineRaw && (!deadline || Number.isNaN(deadline.getTime()))) return res.status(400).json({ success: false, data: null, error: "የመጨረሻ ቀን ትክክል አይደለም።", timestamp: new Date().toISOString() });
  const isAdmin = user.role === "OWNER" || user.role === "MODERATOR";
  const moderation = await enforceContentModeration(user.id, isAdmin, [title, description, organization, location, contactText, applicationUrl]);
  if (!moderation.ok) return res.status(moderation.status).json({ success: false, data: null, error: moderation.error, timestamp: new Date().toISOString() });
  const item = await db.opportunity.create({ data: { title, description, organization, type, category, ...(location ? { location } : {}), ...(contactText ? { contactText } : {}), ...(deadline ? { deadline } : {}), ...(applicationUrl ? { applicationUrl } : {}), ownerId: user.id, verified: isAdmin } });
  res.status(201).json({ success: true, data: { ...item, saved: false, _count: { saves: 0 } }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/opportunities/:id/save", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const item = await db.opportunity.findUnique({ where: { id: String(req.params.id) }, select: { id: true, active: true } });
  if (!item || !item.active) return res.status(404).json({ success: false, data: null, error: "Opportunity not found", timestamp: new Date().toISOString() });
  const existing = await db.opportunitySave.findUnique({ where: { opportunityId_userId: { opportunityId: item.id, userId } } });
  if (existing) await db.opportunitySave.delete({ where: { id: existing.id } }); else await db.opportunitySave.create({ data: { opportunityId: item.id, userId } });
  res.json({ success: true, data: { saved: !existing }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/opportunities/saved", telegramAuth, async (req: Request, res: Response) => {
  const rows = await db.opportunitySave.findMany({ where: { userId: res.locals.telegramUser.id }, orderBy: { createdAt: "desc" }, include: { opportunity: { include: { _count: { select: { saves: true } } } } } });
  res.json({ success: true, data: rows.map(x => ({ ...x.opportunity, saved: true })), error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/opportunities", adminAuth, async (req: Request, res: Response) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "30"), 10) || 30));
  const [items, total] = await Promise.all([
    db.opportunity.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit, include: { owner: { select: { id: true, firstName: true, username: true } }, _count: { select: { saves: true } } } }),
    db.opportunity.count()
  ]);
  res.json({ success: true, data: { items, page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/opportunities", adminAuth, async (req: Request, res: Response) => {
  const title = typeof req.body?.title === "string" ? req.body.title.normalize("NFKC").trim().slice(0, 120) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.normalize("NFKC").trim().slice(0, 1200) : "";
  const organization = typeof req.body?.organization === "string" ? req.body.organization.normalize("NFKC").trim().slice(0, 120) : "";
  const type = typeof req.body?.type === "string" ? req.body.type : "";
  const category = typeof req.body?.category === "string" ? req.body.category : "";
  const applicationUrl = typeof req.body?.applicationUrl === "string" ? req.body.applicationUrl.trim().slice(0, 500) : "";
  if (!title || !description || !organization || !OPPORTUNITY_TYPES.includes(type as typeof OPPORTUNITY_TYPES[number]) || !OPPORTUNITY_CATEGORIES.includes(category as typeof OPPORTUNITY_CATEGORIES[number])) return res.status(400).json({ success: false, data: null, error: "Required fields are missing", timestamp: new Date().toISOString() });
  if (applicationUrl) { try { const u = new URL(applicationUrl); if (u.protocol !== "https:") throw new Error("https required") } catch { return res.status(400).json({ success: false, data: null, error: "Application URL must use HTTPS", timestamp: new Date().toISOString() }) } }
  const owner = await db.user.findFirst({ where: { role: "OWNER" }, select: { id: true } });
  if (!owner) return res.status(409).json({ success: false, data: null, error: "No GENZI owner account exists", timestamp: new Date().toISOString() });
  const item = await db.opportunity.create({ data: { title, description, organization, type, category, ...(applicationUrl ? { applicationUrl } : {}), verified: true, ownerId: owner.id } });
  res.status(201).json({ success: true, data: item, error: null, timestamp: new Date().toISOString() });
});

app.patch("/api/admin/opportunities/:id", adminAuth, async (req: Request, res: Response) => {
  const verified = typeof req.body?.verified === "boolean" ? req.body.verified : undefined;
  const active = typeof req.body?.active === "boolean" ? req.body.active : undefined;
  const applicationUrl = typeof req.body?.applicationUrl === "string" ? req.body.applicationUrl.trim().slice(0, 500) : undefined;
  if (applicationUrl) { try { const u = new URL(applicationUrl); if (u.protocol !== "https:") throw new Error("https required") } catch { return res.status(400).json({ success: false, data: null, error: "Application URL must use HTTPS", timestamp: new Date().toISOString() }) } }
  if (verified === undefined && active === undefined && applicationUrl === undefined) return res.status(400).json({ success: false, data: null, error: "Nothing to update", timestamp: new Date().toISOString() });
  const item = await db.opportunity.update({ where: { id: String(req.params.id) }, data: { ...(verified !== undefined ? { verified } : {}), ...(active !== undefined ? { active } : {}), ...(applicationUrl !== undefined ? { applicationUrl: applicationUrl || null } : {}) } });
  res.json({ success: true, data: item, error: null, timestamp: new Date().toISOString() });
});

function communitySlug(name: string) { return name.normalize("NFKC").trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 70) || `community-${Date.now()}` }

app.get("/api/communities", telegramAuth, async (req: Request, res: Response) => {
  const me = res.locals.telegramUser.id;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12));
  const where = { isPublic: true, ...(category ? { category } : {}), ...(q ? { OR: [{ name: { contains: q } }, { description: { contains: q } }, { city: { contains: q } }] } : {}) };
  const [items, total, memberships] = await Promise.all([
    db.community.findMany({ where, orderBy: [{ createdAt: "desc" }], skip: (page - 1) * limit, take: limit, include: { _count: { select: { members: true, posts: true } } } }),
    db.community.count({ where }),
    db.communityMember.findMany({ where: { userId: me }, select: { communityId: true } })
  ]);
  const joined = new Set(memberships.map(x => x.communityId));
  res.json({ success: true, data: { items: items.map(x => ({ ...x, joined: joined.has(x.id) })), page, limit, total, hasMore: page * limit < total, categories: COMMUNITY_CATEGORIES }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/communities", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const name = typeof req.body?.name === "string" ? req.body.name.normalize("NFKC").trim().slice(0, COMMUNITY_NAME_MAX) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.normalize("NFKC").trim().slice(0, COMMUNITY_DESC_MAX) : "";
  const category = typeof req.body?.category === "string" ? req.body.category.trim() : "";
  const city = typeof req.body?.city === "string" ? req.body.city.normalize("NFKC").trim().slice(0, 80) : undefined;
  if (!name || !description || !COMMUNITY_CATEGORIES.includes(category as typeof COMMUNITY_CATEGORIES[number])) return res.status(400).json({ success: false, data: null, error: "የማህበረሰብ ስም፣ መግለጫ እና ትክክለኛ ምድብ ያስፈልጋል።", timestamp: new Date().toISOString() });
  const communityModeration = await enforceContentModeration(user.id, user.role !== "USER", [name, description, city ?? ""]);
  if (!communityModeration.ok) return res.status(communityModeration.status).json({ success: false, data: null, error: communityModeration.error, timestamp: new Date().toISOString() });
  let slug = communitySlug(name); let n = 1;
  while (await db.community.findUnique({ where: { slug } })) { slug = `${communitySlug(name)}-${n++}` }
  const community = await db.community.create({ data: { slug, name, description, category, ...(city ? { city } : {}), ownerId: user.id, members: { create: { userId: user.id, role: "OWNER" } } }, include: { _count: { select: { members: true, posts: true } } } });
  res.status(201).json({ success: true, data: { ...community, joined: true }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/communities/:id", telegramAuth, async (req: Request, res: Response) => {
  const me = res.locals.telegramUser.id;
  const community = await db.community.findUnique({ where: { id: String(req.params.id) }, include: { owner: { select: { id: true, firstName: true, lastName: true, username: true } }, _count: { select: { members: true, posts: true } } } });
  if (!community || !community.isPublic) return res.status(404).json({ success: false, data: null, error: "Community not found", timestamp: new Date().toISOString() });
  const membership = await db.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: me } } });
  res.json({ success: true, data: { ...community, joined: !!membership, memberRole: membership?.role ?? null }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/communities/:id/posts", telegramAuth, async (req: Request, res: Response) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const where = { communityId: String(req.params.id), publishedAt: { not: null } };
  const viewer = await resolveOptionalViewer(req);
  const { posts, total } = await listPublishedPosts(where, viewer, page, limit);
  res.json({ success: true, data: { items: posts, page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

// Audit fix #8: member list so owners/moderators can manage roles from the Mini App.
app.get("/api/communities/:id/members", telegramAuth, async (req: Request, res: Response) => {
  const me = res.locals.telegramUser;
  const community = await db.community.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true } });
  if (!community) return res.status(404).json({ success: false, data: null, error: "Community not found", timestamp: new Date().toISOString() });
  const myMembership = await db.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: me.id } } });
  if (!myMembership && !STAFF_ROLES.includes(me.role)) return res.status(403).json({ success: false, data: null, error: "ማህበረሰቡን መቀላቀል ያስፈልጋል።", timestamp: new Date().toISOString() });
  const members = await db.communityMember.findMany({ where: { communityId: community.id }, orderBy: { joinedAt: "asc" }, take: 100, include: { user: { select: { id: true, firstName: true, lastName: true, username: true } } } });
  res.json({ success: true, data: members.map(m => ({ userId: m.userId, role: m.role, joinedAt: new Date(m.joinedAt), firstName: m.user.firstName, lastName: m.user.lastName, username: m.user.username, isOwner: m.userId === community.ownerId })) , error: null, timestamp: new Date().toISOString() });
});

app.post("/api/communities/:id/join", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const community = await db.community.findUnique({ where: { id: String(req.params.id) }, select: { id: true, isPublic: true } });
  if (!community || !community.isPublic) return res.status(404).json({ success: false, data: null, error: "Community not found", timestamp: new Date().toISOString() });
  await db.communityMember.upsert({ where: { communityId_userId: { communityId: community.id, userId } }, update: {}, create: { communityId: community.id, userId, role: "MEMBER" } });
  res.json({ success: true, data: { joined: true }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/communities/:id/leave", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const membership = await db.communityMember.findUnique({ where: { communityId_userId: { communityId: String(req.params.id), userId } } });
  if (!membership) return res.json({ success: true, data: { joined: false }, error: null, timestamp: new Date().toISOString() });
  if (membership.role === "OWNER") return res.status(400).json({ success: false, data: null, error: "የማህበረሰብ ባለቤት መልቀቅ አይችልም። ባለቤትነትን መጀመሪያ ያስተላልፉ።", timestamp: new Date().toISOString() });
  await db.communityMember.delete({ where: { id: membership.id } });
  res.json({ success: true, data: { joined: false }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/communities/:id/posts/:postId", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const membership = await db.communityMember.findUnique({ where: { communityId_userId: { communityId: String(req.params.id), userId } } });
  if (!membership) return res.status(403).json({ success: false, data: null, error: "ማህበረሰቡን መቀላቀል ያስፈልጋል።", timestamp: new Date().toISOString() });
  const post = await db.post.findUnique({ where: { id: String(req.params.postId) }, select: { id: true, publishedAt: true, authorId: true, communityId: true } });
  if (!post || !post.publishedAt) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  if (post.communityId && post.communityId !== String(req.params.id)) return res.status(409).json({ success: false, data: null, error: "ይህ ልጥፍ ሌላ ማህበረሰብ ውስጥ አለ።", timestamp: new Date().toISOString() });
  if (post.authorId !== userId && !["OWNER", "MODERATOR"].includes(membership.role)) return res.status(403).json({ success: false, data: null, error: "የሌላ ሰውን ልጥፍ ለማህበረሰብ ለማከል የአስተዳደር ፈቃድ ያስፈልጋል።", timestamp: new Date().toISOString() });
  const updated = await db.post.update({ where: { id: post.id }, data: { communityId: String(req.params.id) } });
  const members = await db.communityMember.findMany({ where: { communityId: String(req.params.id), userId: { not: userId } }, select: { userId: true } });
  if (members.length) await db.notification.createMany({ data: members.map(m => ({ userId: m.userId, type: "COMMUNITY_POST", title: "🏘️ አዲስ ልጥፍ በማህበረሰብዎ", body: "አዲስ ልጥፍ ወደ የተቀላቀሉት ማህበረሰብ ተጨምሯል።", postId: post.id, actorId: userId })) });
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/communities/:id/members/:userId/moderator", telegramAuth, async (req: Request, res: Response) => {
  const ownerId = res.locals.telegramUser.id;
  const community = await db.community.findUnique({ where: { id: String(req.params.id) }, select: { ownerId: true } });
  if (!community || community.ownerId !== ownerId) return res.status(403).json({ success: false, data: null, error: "የማህበረሰብ ባለቤት ብቻ አስተዳዳሪ መሾም ይችላል።", timestamp: new Date().toISOString() });
  const member = await db.communityMember.findUnique({ where: { communityId_userId: { communityId: String(req.params.id), userId: String(req.params.userId) } } });
  if (!member) return res.status(404).json({ success: false, data: null, error: "አባሉ አልተገኘም።", timestamp: new Date().toISOString() });
  const updated = await db.communityMember.update({ where: { id: member.id }, data: { role: "MODERATOR" } });
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/communities/:id/members/:userId/moderator", telegramAuth, async (req: Request, res: Response) => {
  const ownerId = res.locals.telegramUser.id;
  const community = await db.community.findUnique({ where: { id: String(req.params.id) }, select: { ownerId: true } });
  if (!community || community.ownerId !== ownerId) return res.status(403).json({ success: false, data: null, error: "የማህበረሰብ ባለቤት ብቻ ሚና መቀየር ይችላል።", timestamp: new Date().toISOString() });
  const member = await db.communityMember.findUnique({ where: { communityId_userId: { communityId: String(req.params.id), userId: String(req.params.userId) } } });
  if (!member) return res.status(404).json({ success: false, data: null, error: "አባሉ አልተገኘም።", timestamp: new Date().toISOString() });
  const updated = await db.communityMember.update({ where: { id: member.id }, data: { role: "MEMBER" } });
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/communities/:id/posts/:postId", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const membership = await db.communityMember.findUnique({ where: { communityId_userId: { communityId: String(req.params.id), userId } } });
  if (!membership || !["OWNER", "MODERATOR"].includes(membership.role)) return res.status(403).json({ success: false, data: null, error: "የማህበረሰብ አስተዳደር ፈቃድ ያስፈልጋል።", timestamp: new Date().toISOString() });
  const post = await db.post.findFirst({ where: { id: String(req.params.postId), communityId: String(req.params.id) }, select: { id: true } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  await db.post.update({ where: { id: post.id }, data: { communityId: null } });
  res.json({ success: true, data: { removed: true }, error: null, timestamp: new Date().toISOString() });
});

const EVENT_CATEGORIES = ["ሙዚቃ", "ስፖርት", "ቴክኖሎጂ", "ትምህርት", "ንግድ", "ማህበረሰብ", "መዝናኛ", "ሌላ"];

app.get("/api/events", telegramAuth, async (req: Request, res: Response) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category : "";
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12));
  const now = new Date();
  const where = { active: true, startsAt: { gte: now }, ...(category ? { category } : {}), ...(q ? { OR: [{ title: { contains: q } }, { description: { contains: q } }, { location: { contains: q } }] } : {}) };
  const me = res.locals.telegramUser.id;
  const [rows, total, rsvps] = await Promise.all([
    db.event.findMany({ where, orderBy: { startsAt: "asc" }, skip: (page - 1) * limit, take: limit, include: { _count: { select: { rsvps: true } } } }),
    db.event.count({ where }),
    db.eventRSVP.findMany({ where: { userId: me }, select: { eventId: true, status: true } })
  ]);
  const mine = new Map(rsvps.map(x => [x.eventId, x.status]));
  res.json({ success: true, data: { items: rows.map(x => ({ ...x, rsvpStatus: mine.get(x.id) ?? null })), page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/events/:id", telegramAuth, async (req: Request, res: Response) => {
  const item = await db.event.findUnique({ where: { id: String(req.params.id) }, include: { owner: { select: { id: true, firstName: true, lastName: true, username: true } }, _count: { select: { rsvps: true } } } });
  if (!item || !item.active) return res.status(404).json({ success: false, data: null, error: "Event not found", timestamp: new Date().toISOString() });
  const rsvp = await db.eventRSVP.findUnique({ where: { eventId_userId: { eventId: item.id, userId: res.locals.telegramUser.id } } });
  res.json({ success: true, data: { ...item, rsvpStatus: rsvp?.status ?? null }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/events", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const title = typeof req.body?.title === "string" ? req.body.title.normalize("NFKC").trim().slice(0, 120) : "";
  const description = typeof req.body?.description === "string" ? req.body.description.normalize("NFKC").trim().slice(0, 1500) : "";
  const category = typeof req.body?.category === "string" && EVENT_CATEGORIES.includes(req.body.category) ? req.body.category : "ሌላ";
  const location = typeof req.body?.location === "string" ? req.body.location.trim().slice(0, 160) : "";
  const startsAt = typeof req.body?.startsAt === "string" ? new Date(req.body.startsAt) : new Date(NaN);
  const endsAt = typeof req.body?.endsAt === "string" && req.body.endsAt ? new Date(req.body.endsAt) : null;
  const isOnline = Boolean(req.body?.isOnline);
  const meetingText = typeof req.body?.meetingText === "string" ? req.body.meetingText.trim().slice(0, 300) : "";
  if (!title || !description || Number.isNaN(startsAt.getTime())) return res.status(400).json({ success: false, data: null, error: "ርዕስ፣ መግለጫ እና ትክክለኛ የመጀመሪያ ጊዜ ያስፈልጋል።", timestamp: new Date().toISOString() });
  if (startsAt.getTime() <= Date.now()) return res.status(400).json({ success: false, data: null, error: "ዝግጅቱ ወደፊት መሆን አለበት።", timestamp: new Date().toISOString() });
  if (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt <= startsAt)) return res.status(400).json({ success: false, data: null, error: "የመጨረሻ ጊዜው ከመጀመሪያው በኋላ መሆን አለበት።", timestamp: new Date().toISOString() });
  const eventModeration = await enforceContentModeration(user.id, user.role !== "USER", [title, description, location, meetingText]);
  if (!eventModeration.ok) return res.status(eventModeration.status).json({ success: false, data: null, error: eventModeration.error, timestamp: new Date().toISOString() });
  const item = await db.event.create({ data: { title, description, category, ownerId: user.id, startsAt, ...(location ? { location } : {}), ...(endsAt ? { endsAt } : {}), isOnline, ...(meetingText ? { meetingText } : {}), rsvps: { create: { userId: user.id, status: "GOING" } } }, include: { _count: { select: { rsvps: true } } } });
  res.status(201).json({ success: true, data: { ...item, rsvpStatus: "GOING" }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/events/:id/rsvp", telegramAuth, async (req: Request, res: Response) => {
  const event = await db.event.findUnique({ where: { id: String(req.params.id) }, select: { id: true, active: true, startsAt: true, title: true, ownerId: true } });
  if (!event || !event.active) return res.status(404).json({ success: false, data: null, error: "ዝግጅቱ አልተገኘም።", timestamp: new Date().toISOString() });
  if (event.startsAt <= new Date()) return res.status(400).json({ success: false, data: null, error: "ይህ ዝግጅት ጀምሯል።", timestamp: new Date().toISOString() });
  const userId = res.locals.telegramUser.id; const status = req.body?.status === "INTERESTED" ? "INTERESTED" : "GOING";
  // Optional per-user reminder lead time in minutes (5..1440); default one hour before start.
  const reminderMinutes = Math.min(1440, Math.max(5, Number(req.body?.reminderMinutes) || 60));
  const item = await db.eventRSVP.upsert({ where: { eventId_userId: { eventId: event.id, userId } }, update: { status }, create: { eventId: event.id, userId, status } });
  if (status === "GOING") await setEventReminder(userId, event.id, reminderMinutes);
  else await cancelEventReminder(userId, event.id);
  if (event.ownerId !== userId) {
    await db.notification.create({ data: { userId: event.ownerId, type: "EVENT_RSVP", title: "🎉 አዲስ RSVP", body: `አንድ ተጠቃሚ "${event.title}" ላይ ${status === "GOING" ? "መሆኑን አረጋግጧል" : "ኢንተርስትድ መሆኑን"} ምልክት አድርጋል።`, actorId: userId } }).catch(() => undefined);
  }
  const count = await db.eventRSVP.count({ where: { eventId: event.id, status: "GOING" } });
  res.json({ success: true, data: { ...item, goingCount: count, reminderMinutes: status === "GOING" ? reminderMinutes : null }, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/events/:id/rsvp", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const existing = await db.eventRSVP.findUnique({ where: { eventId_userId: { eventId: String(req.params.id), userId } } });
  if (existing) await db.eventRSVP.delete({ where: { id: existing.id } });
  await cancelEventReminder(userId, String(req.params.id));
  res.json({ success: true, data: { rsvpStatus: null }, error: null, timestamp: new Date().toISOString() });
});

// Explicit reminder control for events the user is already attending (Mini App bell UI).
app.put("/api/events/:id/reminder", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const event = await db.event.findUnique({ where: { id: String(req.params.id) }, select: { id: true, active: true, startsAt: true } });
  if (!event || !event.active) return res.status(404).json({ success: false, data: null, error: "ዝግጅቱ አልተገኘም።", timestamp: new Date().toISOString() });
  if (event.startsAt <= new Date()) return res.status(400).json({ success: false, data: null, error: "ይህ ዝግጅት ጀምሯል።", timestamp: new Date().toISOString() });
  const minutes = Math.min(1440, Math.max(5, Number(req.body?.minutes) || 60));
  await setEventReminder(userId, event.id, minutes);
  res.json({ success: true, data: { reminder: { minutes, firesAt: new Date(event.startsAt.getTime() - minutes * 60_000) } }, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/events/:id/reminder", telegramAuth, async (req: Request, res: Response) => {
  await cancelEventReminder(res.locals.telegramUser.id, String(req.params.id));
  res.json({ success: true, data: { reminder: null }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/polls", telegramAuth, async (req: Request, res: Response) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1); const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit ?? "12"), 10) || 12)); const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const where = { active: true, ...(q ? { OR: [{ question: { contains: q } }, { description: { contains: q } }] } : {}) }; const me = res.locals.telegramUser.id;
  const [rows, total, votes] = await Promise.all([db.poll.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit, include: { options: { orderBy: { position: "asc" }, include: { _count: { select: { votes: true } } } }, _count: { select: { votes: true } } } }), db.poll.count({ where }), db.pollVote.findMany({ where: { userId: me }, select: { pollId: true, optionId: true } })]);
  const mine = new Map<string, string[]>(); for (const v of votes) mine.set(v.pollId, [...(mine.get(v.pollId) ?? []), v.optionId]);
  res.json({ success: true, data: { items: rows.map(x => ({ ...x, votedOptionIds: mine.get(x.id) ?? [] })), page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/polls", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser; const question = typeof req.body?.question === "string" ? req.body.question.normalize("NFKC").trim().slice(0, 240) : ""; const description = typeof req.body?.description === "string" ? req.body.description.trim().slice(0, 500) : ""; const raw = Array.isArray(req.body?.options) ? req.body.options : []; const options = raw.filter((x: unknown): x is string => typeof x === "string").map((x: string) => x.normalize("NFKC").trim().slice(0, 120)).filter((x: string) => Boolean(x)).slice(0, 6);
  if (!question || options.length < 2 || new Set(options).size !== options.length) return res.status(400).json({ success: false, data: null, error: "ጥያቄ እና ቢያንስ 2 የተለያዩ ምርጫዎች ያስፈልጋሉ።", timestamp: new Date().toISOString() });
  const pollModeration = await enforceContentModeration(user.id, user.role !== "USER", [question, description, ...options]);
  if (!pollModeration.ok) return res.status(pollModeration.status).json({ success: false, data: null, error: pollModeration.error, timestamp: new Date().toISOString() });
  const closesAt = typeof req.body?.closesAt === "string" && req.body.closesAt ? new Date(req.body.closesAt) : null;
  const poll = await db.poll.create({ data: { question, description: description || null, ownerId: user.id, multiple: Boolean(req.body?.multiple), ...(closesAt && !Number.isNaN(closesAt.getTime()) ? { closesAt } : {}), options: { create: options.map((text: string, position: number) => ({ text, position })) } }, include: { options: { orderBy: { position: "asc" }, include: { _count: { select: { votes: true } } } }, _count: { select: { votes: true } } } });
  res.status(201).json({ success: true, data: { ...poll, votedOptionIds: [] }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/polls/:id/vote", telegramAuth, async (req: Request, res: Response) => {
  const poll = await db.poll.findUnique({ where: { id: String(req.params.id) }, include: { options: true } }); if (!poll || !poll.active || (poll.closesAt && poll.closesAt <= new Date())) return res.status(400).json({ success: false, data: null, error: "ይህ ምርጫ ተዘግቷል።", timestamp: new Date().toISOString() });
  const ids = Array.isArray(req.body?.optionIds) ? req.body.optionIds.filter((x: unknown): x is string => typeof x === "string") : []; const valid = ids.filter((id: string) => poll.options.some((o: { id: string }) => o.id === id)); if (valid.length < 1 || (!poll.multiple && valid.length !== 1)) return res.status(400).json({ success: false, data: null, error: "ትክክለኛ ምርጫ ይምረጡ።", timestamp: new Date().toISOString() });
  const userId = res.locals.telegramUser.id; await db.$transaction(async tx => { await tx.pollVote.deleteMany({ where: { pollId: poll.id, userId } }); for (const optionId of valid) await tx.pollVote.create({ data: { pollId: poll.id, optionId, userId } }) });
  const updated = await db.poll.findUnique({ where: { id: poll.id }, include: { options: { orderBy: { position: "asc" }, include: { _count: { select: { votes: true } } } }, _count: { select: { votes: true } } } });
  await awardXp(userId, "POLL_VOTE");
  res.json({ success: true, data: { ...updated, votedOptionIds: valid }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/quizzes", telegramAuth, async (_req: Request, res: Response) => { const rows = await db.quiz.findMany({ where: { active: true }, orderBy: { createdAt: "desc" }, take: 20, include: { questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } } } }); res.json({ success: true, data: rows, error: null, timestamp: new Date().toISOString() }); });

app.post("/api/quizzes", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser; const title = typeof req.body?.title === "string" ? req.body.title.trim().slice(0, 120) : ""; const raw = Array.isArray(req.body?.questions) ? req.body.questions : []; if (!title || raw.length < 1 || raw.length > 10) return res.status(400).json({ success: false, data: null, error: "የክዊዝ ርዕስ እና 1-10 ጥያቄዎች ያስፈልጋሉ።", timestamp: new Date().toISOString() });
  const questions = raw.map((q: unknown) => { const x = q as { question?: unknown; options?: unknown }; const opts = Array.isArray(x.options) ? x.options.filter((o: unknown): o is { text: string; isCorrect?: boolean } => typeof o === "object" && o !== null && typeof (o as { text?: unknown }).text === "string").slice(0, 6) : []; return { question: typeof x.question === "string" ? x.question.trim().slice(0, 240) : "", options: opts } });
  if (questions.some((q: { question: string; options: { isCorrect?: boolean }[] }) => !q.question || q.options.length < 2 || !q.options.some((o: { isCorrect?: boolean }) => o.isCorrect))) return res.status(400).json({ success: false, data: null, error: "እያንዳንዱ ጥያቄ ቢያንስ 2 ምርጫዎችና አንድ ትክክለኛ መልስ ይፈልጋል።", timestamp: new Date().toISOString() });
  const quizModeration = await enforceContentModeration(user.id, user.role !== "USER", [title, ...collectTextValues(questions)]); if (!quizModeration.ok) return res.status(quizModeration.status).json({ success: false, data: null, error: quizModeration.error, timestamp: new Date().toISOString() });
  const quiz = await db.quiz.create({ data: { title, ownerId: user.id, questions: { create: questions.map((q: { question: string; options: { text: string; isCorrect?: boolean }[] }, position: number) => ({ question: q.question, position, options: { create: q.options.map((o: { text: string; isCorrect?: boolean }, i: number) => ({ text: o.text.trim().slice(0, 120), position: i, isCorrect: Boolean(o.isCorrect) })) } })) } }, include: { questions: { orderBy: { position: "asc" }, include: { options: { orderBy: { position: "asc" } } } } } });
  res.status(201).json({ success: true, data: quiz, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/quizzes/:id/answers", telegramAuth, async (req: Request, res: Response) => {
  const quiz = await db.quiz.findUnique({ where: { id: String(req.params.id) }, include: { questions: { include: { options: true } } } }); if (!quiz || !quiz.active) return res.status(404).json({ success: false, data: null, error: "ክዊዙ አልተገኘም።", timestamp: new Date().toISOString() });
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : []; const userId = res.locals.telegramUser.id; const valid = answers.filter((a: unknown) => typeof a === "object" && a !== null && typeof (a as { questionId?: unknown }).questionId === "string" && typeof (a as { optionId?: unknown }).optionId === "string") as Array<{ questionId: string; optionId: string }>;
  await db.$transaction(async tx => { for (const a of valid) { const q = quiz.questions.find(x => x.id === a.questionId); if (!q || !q.options.some(o => o.id === a.optionId)) continue; await tx.quizAnswer.upsert({ where: { quizId_questionId_userId: { quizId: quiz.id, questionId: q.id, userId } }, update: { optionId: a.optionId }, create: { quizId: quiz.id, questionId: q.id, optionId: a.optionId, userId } }) } });
  const stored = await db.quizAnswer.findMany({ where: { quizId: quiz.id, userId }, include: { option: true } }); const score = stored.reduce((n, a) => n + (a.option.isCorrect ? 1 : 0), 0); await awardXp(userId, "QUIZ_SUBMIT");
  res.json({ success: true, data: { answered: stored.length, total: quiz.questions.length, score }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/gamification", telegramAuth, async (_req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  await awardXp(user.id, "DAILY_CHECKIN");
  // Fix: coins previously had no earnable source — the daily check-in now credits the wallet too.
  await earnCoins(user.id, "DAILY_CHECKIN");
  const me = await db.user.findUnique({ where: { id: user.id }, select: { id: true, xp: true, level: true, currentStreak: true, longestStreak: true, lastActiveDate: true, badges: { orderBy: { awardedAt: "desc" }, include: { badge: true } } } });
  const leaderboard = await db.user.findMany({ where: { blocked: false }, orderBy: [{ xp: "desc" }, { level: "desc" }, { createdAt: "asc" }], take: 20, select: { id: true, firstName: true, username: true, xp: true, level: true } });
  const rank = await db.user.count({ where: { blocked: false, xp: { gt: me?.xp ?? 0 } } }) + 1;
  res.json({ success: true, data: { profile: me, rank, leaderboard, badges: BADGES }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/xp-history", telegramAuth, async (req: Request, res: Response) => {
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "30"), 10) || 30));
  const rows = await db.xpEvent.findMany({ where: { userId: res.locals.telegramUser.id }, orderBy: { createdAt: "desc" }, take: limit });
  res.json({ success: true, data: rows, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/posts/:id/comments", async (req: Request, res: Response) => {
  const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const comments = await db.postComment.findMany({
    where: { postId: post.id, status: "VISIBLE" },
    orderBy: { createdAt: "asc" }, take: 100,
    include: { user: { select: { id: true, firstName: true, username: true } } }
  });
  // Blocking/muting privacy: a viewer never sees comments from users they blocked, who
  // blocked them, or whom they muted. Anonymous visitors see everything public.
  const viewer = await resolveOptionalViewer(req);
  let visible = comments;
  if (viewer) {
    const blockedRows = await db.block.findMany({ where: { OR: [{ blockerId: viewer.id }, { blockedId: viewer.id }] }, select: { blockerId: true, blockedId: true } });
    const hidden = new Set(blockedRows.flatMap(r => [r.blockerId, r.blockedId]));
    const mutedRows = await db.userMute.findMany({ where: { muterId: viewer.id, OR: [{ untilAt: null }, { untilAt: { gt: new Date() } }] }, select: { mutedId: true } });
    for (const m of mutedRows) hidden.add(m.mutedId);
    visible = comments.filter(c => !hidden.has(c.user.id));
  }
  res.json({ success: true, data: visible, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/posts/:id/comments", telegramAuth, async (req: Request, res: Response) => {
  const body = typeof req.body?.body === "string" ? req.body.body.normalize("NFKC").trim().slice(0, COMMENT_MAX) : "";
  if (!body) return res.status(400).json({ success: false, data: null, error: "Comment cannot be empty", timestamp: new Date().toISOString() });
  const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const user = res.locals.telegramUser;
  if (user.blocked) return res.status(403).json({ success: false, data: null, error: "Account blocked", timestamp: new Date().toISOString() });
  const moderation = (await import("./moderation.js")).moderateText(body, { isAdmin: user.role === "OWNER" || user.role === "MODERATOR", isForwarded: false });
  if (moderation.decision === "BAN" || moderation.decision === "REJECT") {
    const action = moderation.decision === "BAN" ? "BAN" : "REJECT";
    await db.moderationEvent.create({ data: { targetUserId: user.id, category: moderation.category, action, reason: moderation.reason, evidence: body } });
    if (action === "BAN") {
      await db.user.update({ where: { id: user.id }, data: { blocked: true } });
    } else {
      const recent = await db.moderationEvent.count({ where: { targetUserId: user.id, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, action: { in: ["REJECT", "BAN"] } } });
      if (recent >= 3) await db.user.update({ where: { id: user.id }, data: { restrictedUntil: new Date(Date.now() + 60 * 60 * 1000) } });
    }
    return res.status(400).json({ success: false, data: null, error: "ይህ አስተያየት በደህንነት ምክንያት አልተቀበለም።", timestamp: new Date().toISOString() });
  }
  if (moderation.category === "MONITORED_SAFETY_CATEGORY") {
    await db.moderationEvent.create({ data: { targetUserId: user.id, category: moderation.category, action: "ALLOW", reason: moderation.reason, evidence: body } });
  }
  const postAuthorRow = await db.post.findUnique({ where: { id: post.id }, select: { authorId: true } });
  if (postAuthorRow && await isBlockedBetween(user.id, postAuthorRow.authorId)) {
    return res.status(403).json({ success: false, data: null, error: "ይህ ተጠቃሚ እርስዎን ዘፍቷል።", timestamp: new Date().toISOString() });
  }
  const comment = await db.postComment.create({ data: { postId: post.id, userId: user.id, body } });
  await awardXp(user.id, "COMMENT");
  const postOwner = await db.post.findUnique({ where: { id: post.id }, select: { authorId: true, title: true } });
  if (postOwner && postOwner.authorId !== user.id) {
    await db.notification.create({ data: { userId: postOwner.authorId, actorId: user.id, postId: post.id, type: "COMMENT", title: "አዲስ አስተያየት", body: `${user.firstName ?? user.username ?? "GENZI ተጠቃሚ"} በፖስትዎ ላይ አስተያየት ሰጠ።` } });
    // Fix: engagement now earns coins for the content author (was a dead economy before).
    await earnCoins(postOwner.authorId, "COMMENT_RECEIVED");
    // Telegram push (mutes respected on the recipient side, best-effort).
    if (await shouldDeliverNotification(postOwner.authorId, user.id)) void notifier.comment(postOwner.authorId, user.firstName ?? user.username, postOwner.title);
  }
  res.status(201).json({ success: true, data: comment, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/posts/:id/reactions", async (req: Request, res: Response) => {
  const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const grouped = await db.postReaction.groupBy({ by: ["type"], where: { postId: post.id }, _count: { id: true } });
  const counts = Object.fromEntries(REACTION_TYPES.map(type => [type, grouped.find(x => x.type === type)?._count?.id ?? 0]));
  res.json({ success: true, data: counts, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/posts/:id/reactions", telegramAuth, async (req: Request, res: Response) => {
  const type = typeof req.body?.type === "string" ? req.body.type.toUpperCase() : "LIKE";
  if (!REACTION_TYPES.includes(type as typeof REACTION_TYPES[number])) return res.status(400).json({ success: false, data: null, error: "Invalid reaction", timestamp: new Date().toISOString() });
  const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const userId = res.locals.telegramUser.id;
  const existing = await db.postReaction.findUnique({ where: { postId_userId: { postId: post.id, userId } } });
  if (existing) {
    if (existing.type === type) await db.postReaction.delete({ where: { id: existing.id } });
    else await db.postReaction.update({ where: { id: existing.id }, data: { type } });
  } else {
    await db.postReaction.create({ data: { postId: post.id, userId, type } });
  }
  const grouped = await db.postReaction.groupBy({ by: ["type"], where: { postId: post.id }, _count: { id: true } });
  const counts = Object.fromEntries(REACTION_TYPES.map(t => [t, grouped.find(x => x.type === t)?._count?.id ?? 0]));
  const owner = await db.post.findUnique({ where: { id: post.id }, select: { authorId: true, title: true } });
  if (owner && owner.authorId !== userId && !existing) {
    await db.notification.create({ data: { userId: owner.authorId, actorId: userId, postId: post.id, type: "REACTION", title: "አዲስ ምላሽ", body: "አንድ ሰው በፖስትዎ ላይ ምላሽ ሰጠ።" } });
    // Fix: engagement rewards flow into the coin economy (author earns per reaction, capped).
    await earnCoins(owner.authorId, "REACTION_RECEIVED");
  }
  res.json({ success: true, data: { active: existing?.type === type ? null : type, counts }, error: null, timestamp: new Date().toISOString() });
});

const REPORT_REASONS = ["SPAM", "SCAM", "HARASSMENT", "SEXUAL_CONTENT", "NON_CONSENSUAL_INTIMATE_CONTENT", "DOXXING", "THREATS", "HATE", "DANGEROUS_CONTENT", "OTHER"] as const;

app.post("/api/posts/:id/report", telegramAuth, async (req: Request, res: Response) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason : "OTHER";
  const details = typeof req.body?.details === "string" ? req.body.details.trim().slice(0, 500) : undefined;
  if (!REPORT_REASONS.includes(reason as typeof REPORT_REASONS[number])) return res.status(400).json({ success: false, data: null, error: "Invalid report reason", timestamp: new Date().toISOString() });
  const post = await db.post.findUnique({ where: { id: String(req.params.id) } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const existing = await db.postReport.findFirst({ where: { postId: post.id, reporterId: res.locals.telegramUser.id, status: "OPEN" } });
  if (existing) return res.json({ success: true, data: { id: existing.id, status: existing.status }, error: null, timestamp: new Date().toISOString() });
  const report = await db.postReport.create({ data: { postId: post.id, reporterId: res.locals.telegramUser.id, reason, ...(details ? { details } : {}) } });
  res.status(201).json({ success: true, data: { id: report.id, status: report.status }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/reports", adminAuth, async (_req: Request, res: Response) => {
  const reports = await db.postReport.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" }, take: 100, include: { post: true, reporter: true } });
  res.json({ success: true, data: reports, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/moderator-session", adminAuth, async (req: Request, res: Response) => {
  const code = String(req.body?.code ?? "");
  if (!code) return res.status(400).json({ success: false, data: null, error: "Code is required", timestamp: new Date().toISOString() });
  const userId = consumeModeratorLoginCode(code);
  if (!userId) return res.status(400).json({ success: false, data: null, error: "Invalid or expired code. Send /moderatorlogin to the bot again.", timestamp: new Date().toISOString() });
  const moderator = await db.user.findUnique({ where: { id: userId } });
  if (!moderator || (moderator.role !== "OWNER" && moderator.role !== "MODERATOR")) return res.status(403).json({ success: false, data: null, error: "Moderator account required", timestamp: new Date().toISOString() });
  const session = createModeratorSession(moderator.id);
  res.json({ success: true, data: { token: session.token, expiresAt: session.expiresAt, moderator: { id: moderator.id, firstName: moderator.firstName, username: moderator.username, role: moderator.role } }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/reports/:id/resolve", adminAuth, moderatorSessionAuth, async (req: Request, res: Response) => {
  const action = req.body?.action === "DISMISS" ? "DISMISSED" : req.body?.action === "REMOVE" ? "REMOVED" : null;
  const moderator = res.locals.moderator;
  if (!action) return res.status(400).json({ success: false, data: null, error: "Invalid action", timestamp: new Date().toISOString() });
  const report = await db.postReport.findUnique({ where: { id: String(req.params.id) }, include: { post: true } });
  if (!report) return res.status(404).json({ success: false, data: null, error: "Report not found", timestamp: new Date().toISOString() });
  if (action === "REMOVED") await db.post.delete({ where: { id: report.postId } });
  await db.postReport.update({ where: { id: report.id }, data: { status: action, resolvedBy: moderator.id, resolvedAt: new Date() } });
  res.json({ success: true, data: { status: action }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/safety/events", adminAuth, async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const rows = await db.moderationEvent.findMany({ orderBy: { createdAt: "desc" }, take: limit, include: { targetUser: { select: { id: true, telegramId: true, username: true, firstName: true, blocked: true, restrictedUntil: true } }, moderator: { select: { id: true, username: true, firstName: true } } } });
  res.json({ success: true, data: rows, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/safety/users/:id/restrict", adminAuth, async (req: Request, res: Response) => {
  const hours = Math.min(168, Math.max(1, Number(req.body?.hours) || 1));
  const user = await db.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  const updated = await db.user.update({ where: { id: user.id }, data: { restrictedUntil: new Date(Date.now() + hours * 60 * 60 * 1000) } });
  res.json({ success: true, data: { id: updated.id, restrictedUntil: updated.restrictedUntil }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/safety/users/:id/unrestrict", adminAuth, async (req: Request, res: Response) => {
  const user = await db.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  const updated = await db.user.update({ where: { id: user.id }, data: { restrictedUntil: null } });
  res.json({ success: true, data: { id: updated.id, restrictedUntil: updated.restrictedUntil }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/safety/users/:id/unban", adminAuth, async (req: Request, res: Response) => {
  const user = await db.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  const updated = await db.user.update({ where: { id: user.id }, data: { blocked: false, restrictedUntil: null } });
  res.json({ success: true, data: { id: updated.id, blocked: updated.blocked, restrictedUntil: updated.restrictedUntil }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/stats", adminAuth, async (_req: Request, res: Response) => {
  const [users, posts, pending, moderation] = await Promise.all([
    db.user.count(),
    db.post.count(),
    db.submission.count({ where: { state: "QUARANTINED" } }),
    db.moderationEvent.count()
  ]);
  res.json({ success: true, data: { users, posts, pending, moderation }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/analytics", adminAuth, async (req: Request, res: Response) => {
  const days = Math.min(30, Math.max(7, Number.parseInt(String(req.query.days ?? "14"), 10) || 14));
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const [users, posts, communities, communityMembers, opportunities, events, eventRsvps, polls, pollVotes, quizzes, quizAnswers, views, reactions, comments, reports, moderation, xpEvents] = await Promise.all([
    db.user.count(), db.post.count({ where: { publishedAt: { not: null } } }), db.community.count(), db.communityMember.count(),
    db.opportunity.count({ where: { active: true } }), db.event.count({ where: { active: true } }), db.eventRSVP.count(), db.poll.count({ where: { active: true } }),
    db.pollVote.count(), db.quiz.count({ where: { active: true } }), db.quizAnswer.count(), db.feedEvent.count({ where: { event: "VIEW" } }),
    db.postReaction.count(), db.postComment.count({ where: { status: "VISIBLE" } }), db.postReport.count({ where: { status: "OPEN" } }),
    db.moderationEvent.count(), db.xpEvent.count()
  ]);
  const [newUsers, newPosts, dayViews, dayReactions, dayComments, dayReports, dayModeration, dayXp] = await Promise.all([
    db.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    db.post.findMany({ where: { createdAt: { gte: since }, publishedAt: { not: null } }, select: { createdAt: true } }),
    db.feedEvent.findMany({ where: { event: "VIEW", createdAt: { gte: since } }, select: { createdAt: true } }),
    db.postReaction.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    db.postComment.findMany({ where: { status: "VISIBLE", createdAt: { gte: since } }, select: { createdAt: true } }),
    db.postReport.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    db.moderationEvent.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, action: true, category: true } }),
    db.xpEvent.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, points: true } })
  ]);
  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const series = Array.from({ length: days }, (_, i) => { const d = new Date(since.getTime() + i * 86400000); return { date: dayKey(d), users: 0, posts: 0, views: 0, reactions: 0, comments: 0, reports: 0, moderation: 0, xp: 0 }; });
  const map = new Map(series.map(x => [x.date, x]));
  for (const x of newUsers) { const r = map.get(dayKey(x.createdAt)); if (r) r.users++; }
  for (const x of newPosts) { const r = map.get(dayKey(x.createdAt)); if (r) r.posts++; }
  for (const x of dayViews) { const r = map.get(dayKey(x.createdAt)); if (r) r.views++; }
  for (const x of dayReactions) { const r = map.get(dayKey(x.createdAt)); if (r) r.reactions++; }
  for (const x of dayComments) { const r = map.get(dayKey(x.createdAt)); if (r) r.comments++; }
  for (const x of dayReports) { const r = map.get(dayKey(x.createdAt)); if (r) r.reports++; }
  for (const x of dayModeration) { const r = map.get(dayKey(x.createdAt)); if (r) r.moderation++; }
  for (const x of dayXp) { const r = map.get(dayKey(x.createdAt)); if (r) r.xp += x.points; }
  
  const categoryRows = await db.post.groupBy({ by: ["category"], where: { publishedAt: { not: null } }, _count: { id: true }, orderBy: { _count: { id: "desc" } }, take: 10 });
  const moderationRows = await db.moderationEvent.groupBy({ by: ["action"], _count: { id: true }, orderBy: { _count: { id: "desc" } } });
  const reportRows = await db.postReport.groupBy({ by: ["reason"], _count: { id: true }, orderBy: { _count: { id: "desc" } } });
  const topCreators = await db.user.findMany({ orderBy: { posts: { _count: "desc" } }, take: 10, select: { id: true, firstName: true, username: true, _count: { select: { posts: true, followers: true } } } });
  
  res.json({
    success: true,
    data: {
      period: { days, since },
      overview: { users, posts, communities, communityMembers, opportunities, events, eventRsvps, polls, pollVotes, quizzes, quizAnswers, views, reactions, comments, openReports: reports, moderationEvents: moderation, xpEvents },
      series,
      content: { 
        categories: categoryRows.map((x: { category: string; _count: { id: number } }) => ({ category: x.category, count: x._count?.id ?? 0 })), 
        topCreators 
      },
      safety: { 
        moderationByAction: moderationRows.map((x: { action: string; _count: { id: number } }) => ({ action: x.action, count: x._count?.id ?? 0 })), 
        reportsByReason: reportRows.map((x: { reason: string; _count: { id: number } }) => ({ reason: x.reason, count: x._count?.id ?? 0 })) 
      }
    },
    error: null,
    timestamp: new Date().toISOString()
  });
});

// Audit fix: direct ban (previously only restrict/unban existed — admins could not ban a
// user without going through a report resolution).
app.post("/api/admin/safety/users/:id/ban", adminAuth, async (req: Request, res: Response) => {
  const user = await db.user.findUnique({ where: { id: String(req.params.id) } });
  if (!user) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  const updated = await db.user.update({ where: { id: user.id }, data: { blocked: true } });
  res.json({ success: true, data: { id: updated.id, blocked: updated.blocked }, error: null, timestamp: new Date().toISOString() });
});

// Audit fix: the panel could only remove content indirectly via reports. These give staff a
// direct removal path for posts, communities and confessions (moderator-attributed).
app.get("/api/admin/posts", adminAuth, async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const posts = await db.post.findMany({
    where: q ? { OR: [{ title: { contains: q } }, { body: { contains: q } }] } : { publishedAt: { not: null } },
    orderBy: { createdAt: "desc" }, take: limit,
    select: { id: true, title: true, category: true, visibility: true, publishedAt: true, createdAt: true, authorName: true, _count: { select: { comments: true } } }
  });
  res.json({ success: true, data: posts, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/posts/:id/remove", adminAuth, moderatorSessionAuth, async (req: Request, res: Response) => {
  const moderator = res.locals.moderator;
  const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true, title: true, authorId: true, telegramChatId: true, telegramMessageId: true } });
  if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  const reason = typeof req.body?.reason === "string" ? req.body.reason.normalize("NFKC").trim().slice(0, 300) : "admin removal";
  await db.$transaction(async tx => {
    // Same soft-hide convention as the owner DELETE route: unpublish + visibility DRAFT.
    await tx.post.update({ where: { id: post.id }, data: { publishedAt: null, visibility: "DRAFT" } });
    await tx.moderationEvent.create({ data: { targetUserId: post.authorId, moderatorId: moderator.id, category: "ADMIN_REVIEW", action: "REJECT", reason } });
  });
  void deleteChannelMessage(bot, post.telegramChatId, post.telegramMessageId);
  void notifier.notifyUser(post.authorId, { title: "⚠️ ይዘት ተስወግዷል", body: `“${post.title}” በአስተዳደር ተወግዷል። ምክንያት: ${reason}` });
  res.json({ success: true, data: { removed: true }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/communities", adminAuth, async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 80) : "";
  const communities = await db.community.findMany({
    where: q ? { OR: [{ name: { contains: q } }, { description: { contains: q } }] } : {},
    orderBy: { createdAt: "desc" }, take: limit,
    select: { id: true, slug: true, name: true, category: true, coverEmoji: true, isPublic: true, ownerId: true, _count: { select: { members: true, posts: true } } }
  });
  res.json({ success: true, data: communities, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/communities/:id/remove", adminAuth, moderatorSessionAuth, async (req: Request, res: Response) => {
  const moderator = res.locals.moderator;
  const community = await db.community.findUnique({ where: { id: String(req.params.id) }, select: { id: true, name: true, ownerId: true } });
  if (!community) return res.status(404).json({ success: false, data: null, error: "Community not found", timestamp: new Date().toISOString() });
  await db.$transaction(async tx => {
    await tx.communityMember.deleteMany({ where: { communityId: community.id } });
    await tx.post.updateMany({ where: { communityId: community.id }, data: { communityId: null } });
    await tx.community.delete({ where: { id: community.id } });
    await tx.moderationEvent.create({ data: { targetUserId: community.ownerId, moderatorId: moderator.id, category: "ADMIN_REVIEW", action: "REJECT", reason: `community removed: ${community.name}` } });
  });
  void notifier.notifyUser(community.ownerId, { title: "⚠️ ማህበረሰብ ተወግዷል", body: `“${community.name}” በአስተዳደር ተወግዷል።` });
  res.json({ success: true, data: { removed: true }, error: null, timestamp: new Date().toISOString() });
});

// Audit fix: moderators previously had no view or removal path for confessions at all.
app.get("/api/admin/confessions", adminAuth, async (_req: Request, res: Response) => {
  const rows = await db.confession.findMany({
    where: { state: { in: ["PUBLISHED", "QUARANTINED", "PENDING"] } },
    orderBy: { createdAt: "desc" }, take: 100,
    select: { id: true, number: true, body: true, state: true, createdAt: true }
  });
  res.json({ success: true, data: rows, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/confessions/:id/approve", adminAuth, moderatorSessionAuth, async (req: Request, res: Response) => {
  const moderator = res.locals.moderator;
  const confession = await db.confession.findUnique({ where: { id: String(req.params.id) }, select: { id: true, userId: true } });
  if (!confession) return res.status(404).json({ success: false, data: null, error: "Confession not found", timestamp: new Date().toISOString() });
  try {
    // PENDING = held confessions created by the old bot flow (kept approvable).
    const published = await publishConfessionNow(bot, confession.id, ["QUARANTINED", "PENDING"]);
    await db.moderationEvent.create({ data: { targetUserId: confession.userId, moderatorId: moderator.id, category: "ADMIN_REVIEW", action: "ALLOW", reason: `confession approved: ${confession.id}` } });
    void notifier.notifyUser(confession.userId, { title: "✅ መናዘዣዎ ጸድቋል", body: "መናዘዣዎ በአስተዳዳሪ ጸድቆ በማንነት ስውር ታትሟል።" });
    res.json({ success: true, data: { approved: true, number: published.number }, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    if (error instanceof ConfessionNotReadyError) return res.status(400).json({ success: false, data: null, error: "Confession is not awaiting review", timestamp: new Date().toISOString() });
    logger.warn("confession approve failed", { confessionId: confession.id, error: String(error) });
    res.status(502).json({ success: false, data: null, error: "Publishing failed", timestamp: new Date().toISOString() });
  }
});

app.post("/api/admin/confessions/:id/remove", adminAuth, moderatorSessionAuth, async (req: Request, res: Response) => {
  const moderator = res.locals.moderator;
  const confession = await db.confession.findUnique({ where: { id: String(req.params.id) }, select: { id: true, state: true, userId: true, telegramChatId: true, telegramMessageId: true } });
  if (!confession) return res.status(404).json({ success: false, data: null, error: "Confession not found", timestamp: new Date().toISOString() });
  await db.$transaction(async tx => {
    await tx.confession.update({ where: { id: confession.id }, data: { state: "REMOVED" } });
    // Event is attributed to the confession's author (it used to be logged against the moderator).
    await tx.moderationEvent.create({ data: { targetUserId: confession.userId, moderatorId: moderator.id, category: "ADMIN_REVIEW", action: "REJECT", reason: `confession removed: ${confession.id}` } });
  });
  // Also take it down from the public channel (the DB-only removal left it visible).
  const deletedFromChannel = await deleteChannelMessage(bot, confession.telegramChatId, confession.telegramMessageId);
  res.json({ success: true, data: { removed: true, deletedFromChannel }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/users", adminAuth, async (req: Request, res: Response) => {
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? "50"), 10) || 50));
  // Audit fix: admin panel could not search users at all — optional q filter now.
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 64) : "";
  const where = q
    ? { OR: [
        { username: { contains: q } },
        { firstName: { contains: q } },
        { lastName: { contains: q } },
        { telegramId: q.replace(/[^0-9]/g, "") || "-none-" }
      ] }
    : {};
  const users = await db.user.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, telegramId: true, username: true, firstName: true, role: true, blocked: true, restrictedUntil: true, createdAt: true, xp: true, level: true, _count: { select: { posts: true, followers: true, following: true, comments: true } } } });
  res.json({ success: true, data: users, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/moderation", adminAuth, async (_req: Request, res: Response) => {
  const events = await db.moderationEvent.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { targetUser: true } });
  res.json({ success: true, data: events, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/admin/queue", adminAuth, async (_req: Request, res: Response) => {
  const queue = await db.submission.findMany({ where: { state: "QUARANTINED" }, orderBy: { createdAt: "asc" }, take: 100, include: { user: true } });
  res.json({ success: true, data: queue, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/submissions/:id/action", adminAuth, moderatorSessionAuth, async (req: Request, res: Response) => {
  const decision = req.body?.decision as AdminDecision;
  if (!["APPROVE", "REJECT", "BAN", "RESTRICT"].includes(decision)) return res.status(400).json({ success: false, data: null, error: "Invalid decision", timestamp: new Date().toISOString() });
  try {
    const result = await performModerationAction(bot, String(req.params.id), res.locals.moderator, decision);
    res.json({ success: true, data: { decision, post: result }, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Action failed";
    res.status(400).json({ success: false, data: null, error: message, timestamp: new Date().toISOString() });
  }
});

app.get("/api/media/:fileId", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  if (!await canViewerSeePostMedia(userId, String(req.params.fileId))) return res.sendStatus(403);
  try {
    await deliverTelegramFile(String(req.params.fileId), res);
  } catch (error) { console.error("Media proxy failed", error); res.sendStatus(404); }
});

// Audit fix #1: <img>/<video> tags cannot attach the X-Telegram-Init-Data header,
// so the Mini App first requests a short-lived single-use tokenized URL.
app.get("/api/media/:fileId/signed", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const fileId = String(req.params.fileId);
  if (!await canViewerSeePostMedia(user.id, fileId)) return res.status(403).json({ success: false, data: null, error: "Content locked", timestamp: new Date().toISOString() });
  const token = createMediaToken(fileId, user.id);
  // Audit fix: PUBLIC_API_URL was defined in config but never read. When set (e.g. behind a
  // reverse proxy or on Render), signed media URLs are returned absolute against it; otherwise
  // the Mini App resolves this relative path against its configured API origin.
  const rel = `/api/media-token/${encodeURIComponent(token)}`;
  const url = env.PUBLIC_API_URL && env.PUBLIC_API_URL !== "http://localhost:3000" ? `${env.PUBLIC_API_URL.replace(/\/+$/, "")}${rel}` : rel;
  res.json({ success: true, data: { url, expiresInMs: MEDIA_TOKEN_TTL_MS }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/media-token/:token", async (req: Request, res: Response) => {
  const entry = consumeMediaToken(String(req.params.token));
  if (!entry) return res.status(401).send("Invalid or expired media link");
  if (!await canViewerSeePostMedia(entry.userId, entry.fileId)) return res.sendStatus(403);
  try {
    await deliverTelegramFile(entry.fileId, res);
  } catch (error) { console.error("Signed media delivery failed", error); res.sendStatus(404); }
});

app.get("/api/me/growth", telegramAuth, async (_req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const profile = await ensureReferralProfile(userId);
  const [wallet, referrals, shares, events, rankRows] = await Promise.all([
    ensureWallet(userId),
    db.referral.count({ where: { inviterId: userId } }),
    db.growthEvent.count({ where: { userId, type: "SHARE" } }),
    db.growthEvent.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 }),
    db.referral.groupBy({ by: ["inviterId"], _count: { inviterId: true }, orderBy: { _count: { inviterId: "desc" } }, take: 20 })
  ]);
  const rank = rankRows.findIndex((row) => row.inviterId === userId) + 1;
  res.json({ success: true, data: { code: profile.code, shareLink: env.TELEGRAM_BOT_USERNAME ? `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=ref_${profile.code}` : null, shareCount: shares, referrals, rewardCoins: referrals * 50, balanceCoins: wallet.balance, rank: rank || null, recentEvents: events }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/me/growth/share", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const type = typeof req.body?.type === "string" ? req.body.type.trim().slice(0, 32) : "APP";
  const targetId = typeof req.body?.targetId === "string" ? req.body.targetId.trim().slice(0, 120) : undefined;
  const recent = await db.growthEvent.findFirst({ where: { userId, type: "SHARE", targetId }, orderBy: { createdAt: "desc" } });
  if (recent && Date.now() - recent.createdAt.getTime() < 10_000) return res.json({ success: true, data: { recorded: false, reason: "duplicate" }, error: null, timestamp: new Date().toISOString() });
  await db.growthEvent.create({ data: { userId, type: "SHARE", targetId, metadata: type } });
  res.json({ success: true, data: { recorded: true }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/me/growth/claim", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!code) return res.status(400).json({ success: false, data: null, error: "Referral code is required", timestamp: new Date().toISOString() });
  const profile = await db.referralProfile.findUnique({ where: { code } });
  if (!profile) return res.status(404).json({ success: false, data: null, error: "Referral code not found", timestamp: new Date().toISOString() });
  const completed = await completeReferral(profile.userId, userId, code);
  res.json({ success: true, data: { completed }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/growth/leaderboard", telegramAuth, async (_req: Request, res: Response) => {
  const rows = await db.referral.groupBy({ by: ["inviterId"], _count: { inviterId: true }, orderBy: { _count: { inviterId: "desc" } }, take: 20 });
  const users = await db.user.findMany({ where: { id: { in: rows.map((row) => row.inviterId) } }, select: { id: true, firstName: true, username: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  res.json({ success: true, data: rows.map((row, index) => ({ rank: index + 1, referrals: row._count.inviterId, user: byId.get(row.inviterId) ?? null })), error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/notifications", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const unreadOnly = req.query.unread === "1";
  const rows = await db.notification.findMany({
    where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
    orderBy: { createdAt: "desc" }, take: 50,
    include: { actor: { select: { firstName: true, username: true } }, post: { select: { id: true, title: true } } }
  });
  const unread = await db.notification.count({ where: { userId, readAt: null } });
  res.json({ success: true, data: { items: rows, unread }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/me/notifications/read", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const id = typeof req.body?.id === "string" ? req.body.id : "";
  if (id) await db.notification.updateMany({ where: { id, userId }, data: { readAt: new Date() } });
  else await db.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  res.json({ success: true, data: { read: true }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/users/:id/profile", telegramAuth, async (req: Request, res: Response) => {
  const user = await db.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, firstName: true, lastName: true, username: true, bio: true, role: true, createdAt: true, _count: { select: { followers: true, posts: true } } } });
  if (!user) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  const following = !!await db.follow.findUnique({ where: { followerId_followingId: { followerId: res.locals.telegramUser.id, followingId: user.id } } });
  res.json({ success: true, data: { ...user, following }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/following", telegramAuth, async (req: Request, res: Response) => {
  const rows = await db.follow.findMany({ where: { followerId: res.locals.telegramUser.id }, orderBy: { createdAt: "desc" }, include: { following: { select: { id: true, firstName: true, username: true, bio: true } } } });
  res.json({ success: true, data: rows.map(r => r.following), error: null, timestamp: new Date().toISOString() });
});

app.post("/api/users/:id/follow", telegramAuth, async (req: Request, res: Response) => {
  const me = res.locals.telegramUser; const targetId = String(req.params.id);
  if (me.id === targetId) return res.status(400).json({ success: false, data: null, error: "Cannot follow yourself", timestamp: new Date().toISOString() });
  const target = await db.user.findUnique({ where: { id: targetId }, select: { id: true, firstName: true, username: true } });
  if (!target) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  if (await isBlockedBetween(me.id, targetId)) return res.status(403).json({ success: false, data: null, error: "ይህ ተጠቃሚ ለእርስዎ አይገኝም።", timestamp: new Date().toISOString() });
  const existing = await db.follow.findUnique({ where: { followerId_followingId: { followerId: me.id, followingId: targetId } } });
  if (existing) { await db.follow.delete({ where: { id: existing.id } }); }
  else {
    await db.follow.create({ data: { followerId: me.id, followingId: targetId } });
    await db.notification.create({ data: { userId: targetId, actorId: me.id, type: "FOLLOW", title: "አዲስ ተከታይ", body: `${me.firstName ?? me.username ?? "GENZI ተጠቃሚ"} እርስዎን ተከተለ።` } });
    // Fix: creators earn coins for gaining followers (capped daily).
    await earnCoins(targetId, "NEW_FOLLOWER");
    if (await shouldDeliverNotification(targetId, me.id)) void notifier.follow(targetId, me.firstName ?? me.username);
  }
  if (!existing) await awardXp(me.id, "FOLLOW");
  res.json({ success: true, data: { following: !existing }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/users/:id/following-status", telegramAuth, async (req: Request, res: Response) => {
  const following = !!await db.follow.findUnique({ where: { followerId_followingId: { followerId: res.locals.telegramUser.id, followingId: String(req.params.id) } } });
  const followers = await db.follow.count({ where: { followingId: String(req.params.id) } });
  res.json({ success: true, data: { following, followers }, error: null, timestamp: new Date().toISOString() });
});

const MONETIZATION_MAX_COIN_TRANSFER = 10000;
const DEFAULT_SUBSCRIPTION_PRICE = 100;
const SUBSCRIPTION_PERIOD_DAYS = 30;

async function ensureWallet(userId: string) {
  return db.wallet.upsert({ where: { userId }, update: {}, create: { userId, balance: 0 } });
}

async function transferCoins(senderId: string, recipientId: string, amount: number, type: string, reference?: string, note?: string) {
  if (!Number.isInteger(amount) || amount <= 0 || amount > MONETIZATION_MAX_COIN_TRANSFER) throw new Error("Invalid coin amount");
  if (senderId === recipientId) throw new Error("Self transfer is not allowed");
  await db.$transaction(async tx => {
    await tx.wallet.upsert({ where: { userId: senderId }, update: {}, create: { userId: senderId, balance: 0 } });
    await tx.wallet.upsert({ where: { userId: recipientId }, update: {}, create: { userId: recipientId, balance: 0 } });
    const sender = await tx.wallet.findUnique({ where: { userId: senderId } });
    if (!sender || sender.balance < amount) throw new Error("Insufficient coin balance");
    await tx.wallet.update({ where: { userId: senderId }, data: { balance: { decrement: amount } } });
    await tx.wallet.update({ where: { userId: recipientId }, data: { balance: { increment: amount } } });
    await tx.walletTransaction.create({ data: { userId: senderId, type: `${type}_DEBIT`, amount: -amount, reference: reference ?? null, note: note ?? null } });
    await tx.walletTransaction.create({ data: { userId: recipientId, type: `${type}_CREDIT`, amount, reference: reference ?? null, note: note ?? null } });
  });
}

// Audit fix: brand-new users had wallet balance 0 and no way to earn anything on day one,
// so tips / paid unlocks / subscriptions were untestable ("everything coin-related looks
// broken"). Every account gets a one-time welcome grant; the ledger row doubles as the
// idempotency guard. Daily check-in gives ongoing users a recurring trickle.
const WELCOME_GRANT_COINS = 100;

async function ensureWelcomeGrant(userId: string): Promise<void> {
  try {
    const already = await db.walletTransaction.findFirst({ where: { userId, type: "WELCOME_GRANT" }, select: { id: true } });
    if (already) return;
    await ensureWallet(userId);
    await db.$transaction(async tx => {
      await tx.wallet.update({ where: { userId }, data: { balance: { increment: WELCOME_GRANT_COINS } } });
      await tx.walletTransaction.create({ data: { userId, type: "WELCOME_GRANT", amount: WELCOME_GRANT_COINS, note: "One-time GENZI welcome coins" } });
    });
  } catch (error) { logger.error("welcome grant failed", { userId, error: String(error) }); }
}

app.post("/api/me/checkin", telegramAuth, async (_req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  await ensureWelcomeGrant(user.id);
  await earnCoins(user.id, "DAILY_CHECKIN");
  const wallet = await ensureWallet(user.id);
  res.json({ success: true, data: { balanceCoins: wallet.balance, credited: EARN_RULES.DAILY_CHECKIN!.coins }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/monetization", telegramAuth, async (_req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  await ensureWelcomeGrant(user.id);
  const wallet = await ensureWallet(user.id);
  const [sent, received, subscriptions, purchases] = await Promise.all([
    db.tip.aggregate({ where: { senderId: user.id }, _sum: { amountCoins: true } }),
    db.tip.aggregate({ where: { recipientId: user.id }, _sum: { amountCoins: true } }),
    db.creatorSubscription.count({ where: { subscriberId: user.id, status: "ACTIVE" } }),
    db.contentPurchase.count({ where: { buyerId: user.id } })
  ]);
  const earnDailyLimit = Math.max(1, Number.parseInt(await getSetting("earn_daily_limit", DEFAULT_SETTINGS.earn_daily_limit ?? "200"), 10) || 200);
  res.json({ success: true, data: { balanceCoins: wallet.balance, sentTips: sent._sum.amountCoins ?? 0, receivedTips: received._sum.amountCoins ?? 0, activeSubscriptions: subscriptions, purchases, earnRules: EARN_RULES, earnDailyLimit }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/me/monetization/seed", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const amount = Number(req.body?.amountCoins);
  if (!Number.isInteger(amount) || amount < 1 || amount > 10000) return res.status(400).json({ success: false, data: null, error: "Invalid amount", timestamp: new Date().toISOString() });
  if (user.role !== "OWNER") return res.status(403).json({ success: false, data: null, error: "Only owner can issue promotional coins", timestamp: new Date().toISOString() });
  const target = typeof req.body?.userId === "string" ? req.body.userId : user.id;
  await ensureWallet(target);
  await db.$transaction(async tx => { await tx.wallet.update({ where: { userId: target }, data: { balance: { increment: amount } } }); await tx.walletTransaction.create({ data: { userId: target, type: "PROMO_GRANT", amount, note: "GENZI promotional coins" } }) });
  res.json({ success: true, data: { balanceCoins: (await ensureWallet(target)).balance }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/users/:id/tip", telegramAuth, async (req: Request, res: Response) => {
  const sender = res.locals.telegramUser;
  const recipient = await db.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, firstName: true, username: true } });
  const amount = Number(req.body?.amountCoins); const message = typeof req.body?.message === "string" ? req.body.message.normalize("NFKC").trim().slice(0, 240) : null;
  if (!recipient) return res.status(404).json({ success: false, data: null, error: "Creator not found", timestamp: new Date().toISOString() });
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000) return res.status(400).json({ success: false, data: null, error: "Tip must be 1-1000 coins", timestamp: new Date().toISOString() });
  try { await transferCoins(sender.id, recipient.id, amount, "TIP", undefined, message ?? undefined); await db.tip.create({ data: { senderId: sender.id, recipientId: recipient.id, amountCoins: amount, message } }); await awardXp(sender.id, "TIP_SENT"); res.json({ success: true, data: { sent: true, amountCoins: amount }, error: null, timestamp: new Date().toISOString() }) } catch (e) { res.status(400).json({ success: false, data: null, error: e instanceof Error ? e.message : "Tip failed", timestamp: new Date().toISOString() }) }
});

app.post("/api/users/:id/subscribe", telegramAuth, async (req: Request, res: Response) => {
  const subscriber = res.locals.telegramUser; const creator = await db.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true } });
  if (!creator) return res.status(404).json({ success: false, data: null, error: "Creator not found", timestamp: new Date().toISOString() });
  if (creator.id === subscriber.id) return res.status(400).json({ success: false, data: null, error: "Cannot subscribe to yourself", timestamp: new Date().toISOString() });
  const price = Math.max(1, Math.min(10000, Number(req.body?.priceCoins) || DEFAULT_SUBSCRIPTION_PRICE));
  const autoRenew = req.body?.autoRenew === undefined ? true : Boolean(req.body.autoRenew);
  await expireDueSubscriptions(subscriber.id, creator.id);
  const existing = await db.creatorSubscription.findUnique({ where: { subscriberId_creatorId: { subscriberId: subscriber.id, creatorId: creator.id } } });
  if (existing?.status === "ACTIVE") return res.json({ success: true, data: { active: true, priceCoins: existing.priceCoins, expiresAt: existing.expiresAt, cancelAtPeriodEnd: existing.cancelAtPeriodEnd, autoRenew: existing.autoRenew }, error: null, timestamp: new Date().toISOString() });
  // Fix: subscriptions now have a real lifecycle — expiresAt is set, renewal/cancel are supported,
  // and SUBSCRIBERS-only posts actually gate on an ACTIVE subscription.
  try {
    await transferCoins(subscriber.id, creator.id, price, "SUBSCRIPTION");
    const sub = await db.creatorSubscription.upsert({
      where: { subscriberId_creatorId: { subscriberId: subscriber.id, creatorId: creator.id } },
      update: { priceCoins: price, status: "ACTIVE", startedAt: new Date(), expiresAt: new Date(Date.now() + SUBSCRIPTION_PERIOD_DAYS * 86_400_000), cancelAtPeriodEnd: false, autoRenew },
      create: { subscriberId: subscriber.id, creatorId: creator.id, priceCoins: price, status: "ACTIVE", expiresAt: new Date(Date.now() + SUBSCRIPTION_PERIOD_DAYS * 86_400_000), autoRenew }
    });
    await db.notification.create({ data: { userId: creator.id, actorId: subscriber.id, type: "SUBSCRIPTION", title: "⭐ አዲስ አባል", body: `${subscriber.firstName ?? subscriber.username ?? "GENZI ተጠቃሚ"} አባል ሆነው።` } }).catch(() => undefined);
    await awardXp(subscriber.id, "CREATOR_SUBSCRIBE");
    res.json({ success: true, data: { active: true, priceCoins: sub.priceCoins, expiresAt: sub.expiresAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, autoRenew: sub.autoRenew }, error: null, timestamp: new Date().toISOString() });
  } catch (e) { res.status(400).json({ success: false, data: null, error: e instanceof Error ? e.message : "Subscription failed", timestamp: new Date().toISOString() }) }
});

// Cancel at period end / toggle auto-renew / immediate cancel with prorated refund.
app.post("/api/users/:id/subscription/cancel", telegramAuth, async (req: Request, res: Response) => {
  const subscriberId = res.locals.telegramUser.id;
  const sub = await db.creatorSubscription.findUnique({ where: { subscriberId_creatorId: { subscriberId, creatorId: String(req.params.id) } } });
  if (!sub) return res.status(404).json({ success: false, data: null, error: "Subscription not found", timestamp: new Date().toISOString() });
  const mode = req.body?.mode === "immediate" ? "immediate" : "period_end";
  if (mode === "period_end") {
    const updated = await db.creatorSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true, autoRenew: false } });
    return res.json({ success: true, data: { active: sub.status === "ACTIVE", cancelAtPeriodEnd: true, autoRenew: false, expiresAt: updated.expiresAt }, error: null, timestamp: new Date().toISOString() });
  }
  // Immediate: mark EXPIRED now and refund the unused portion of the period to the wallet.
  const totalDays = Math.max(1, sub.periodDays);
  const elapsedMs = Date.now() - sub.startedAt.getTime();
  const remainingRatio = Math.max(0, Math.min(1, 1 - elapsedMs / (totalDays * 86_400_000)));
  const refund = Math.floor(sub.priceCoins * remainingRatio);
  if (refund > 0 && sub.status === "ACTIVE") {
    await ensureWallet(subscriberId);
    await db.$transaction(async tx => {
      await tx.wallet.update({ where: { userId: subscriberId }, data: { balance: { increment: refund } } });
      await tx.walletTransaction.create({ data: { userId: subscriberId, type: "SUBSCRIPTION_REFUND", amount: refund, reference: sub.id, note: "Partial refund on cancellation" } });
    });
  }
  await db.creatorSubscription.update({ where: { id: sub.id }, data: { status: "CANCELLED", cancelAtPeriodEnd: false, autoRenew: false } });
  res.json({ success: true, data: { active: false, cancelled: true, refundedCoins: refund }, error: null, timestamp: new Date().toISOString() });
});

app.patch("/api/users/:id/subscription", telegramAuth, async (req: Request, res: Response) => {
  const subscriberId = res.locals.telegramUser.id;
  const sub = await db.creatorSubscription.findUnique({ where: { subscriberId_creatorId: { subscriberId, creatorId: String(req.params.id) } } });
  if (!sub) return res.status(404).json({ success: false, data: null, error: "Subscription not found", timestamp: new Date().toISOString() });
  const data: Record<string, boolean> = {};
  if (typeof req.body?.autoRenew === "boolean") { data.autoRenew = req.body.autoRenew; data.cancelAtPeriodEnd = !req.body.autoRenew; }
  if (Object.keys(data).length === 0) return res.status(400).json({ success: false, data: null, error: "Nothing to update", timestamp: new Date().toISOString() });
  const updated = await db.creatorSubscription.update({ where: { id: sub.id }, data });
  res.json({ success: true, data: { autoRenew: updated.autoRenew, cancelAtPeriodEnd: updated.cancelAtPeriodEnd, expiresAt: updated.expiresAt }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/posts/:id/purchase", telegramAuth, async (req: Request, res: Response) => {
  const buyer = res.locals.telegramUser; const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true, authorId: true, monetizationType: true, priceCoins: true, publishedAt: true } });
  if (!post || !post.publishedAt) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  if (post.monetizationType === "SUBSCRIBERS") return res.status(400).json({ success: false, data: null, error: "ይህ ለአባልነት ብቻ የተዘጋ ነው — አባል ይሁኑ።", timestamp: new Date().toISOString() });
  if (post.monetizationType !== "PAID" || post.priceCoins < 1) return res.status(400).json({ success: false, data: null, error: "This post is free", timestamp: new Date().toISOString() });
  if (post.authorId === buyer.id) return res.json({ success: true, data: { purchased: true, priceCoins: 0 }, error: null, timestamp: new Date().toISOString() });
  const existing = await db.contentPurchase.findUnique({ where: { postId_buyerId: { postId: post.id, buyerId: buyer.id } } });
  if (existing) return res.json({ success: true, data: { purchased: true, priceCoins: existing.priceCoins }, error: null, timestamp: new Date().toISOString() });
  try { await transferCoins(buyer.id, post.authorId, post.priceCoins, "CONTENT_PURCHASE", post.id); const purchase = await db.contentPurchase.create({ data: { postId: post.id, buyerId: buyer.id, priceCoins: post.priceCoins } }); await awardXp(buyer.id, "CONTENT_PURCHASE"); res.json({ success: true, data: { purchased: true, priceCoins: purchase.priceCoins }, error: null, timestamp: new Date().toISOString() }) } catch (e) { res.status(400).json({ success: false, data: null, error: e instanceof Error ? e.message : "Purchase failed", timestamp: new Date().toISOString() }) }
});

app.post("/api/me/creator-content", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser; const postId = typeof req.body?.postId === "string" ? req.body.postId : "";
  // Fix: the Mini App can now mark posts PAID or SUBSCRIBERS-ONLY — previously only "PAID" was
  // accepted here and no UI ever called this route, so paid/unlock content could never exist.
  const rawType = typeof req.body?.monetizationType === "string" ? req.body.monetizationType.toUpperCase() : "FREE";
  if (!["FREE", "PAID", "SUBSCRIBERS"].includes(rawType)) return res.status(400).json({ success: false, data: null, error: "Invalid monetization type", timestamp: new Date().toISOString() });
  const price = Math.max(0, Math.min(10000, Number(req.body?.priceCoins) || 0));
  const post = await db.post.findFirst({ where: { id: postId, authorId: user.id } }); if (!post) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  if (rawType === "PAID" && price < 1) return res.status(400).json({ success: false, data: null, error: "Paid content needs a price", timestamp: new Date().toISOString() });
  const updated = await db.post.update({ where: { id: post.id }, data: { monetizationType: rawType, priceCoins: rawType === "PAID" ? price : 0 } });
  res.json({ success: true, data: { id: updated.id, monetizationType: updated.monetizationType, priceCoins: updated.priceCoins }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/creator-earnings", telegramAuth, async (_req: Request, res: Response) => {
  const user = res.locals.telegramUser; const wallet = await ensureWallet(user.id);
  const [tips, purchases, subs] = await Promise.all([db.tip.aggregate({ where: { recipientId: user.id }, _sum: { amountCoins: true }, _count: true }), db.contentPurchase.aggregate({ where: { post: { authorId: user.id } }, _sum: { priceCoins: true }, _count: true }), db.creatorSubscription.aggregate({ where: { creatorId: user.id, status: "ACTIVE" }, _sum: { priceCoins: true }, _count: true })]);
  res.json({ success: true, data: { balanceCoins: wallet.balance, tipRevenue: tips._sum.amountCoins ?? 0, tipCount: tips._count, contentRevenue: purchases._sum.priceCoins ?? 0, contentSales: purchases._count, subscriptionRevenue: subs._sum.priceCoins ?? 0, activeSubscribers: subs._count }, error: null, timestamp: new Date().toISOString() });
});

// Audit fix #6: wallet transaction history for the monetization screen.
// Audit fix #16: Mini App post composer publishes through the API (instant publish,
// same fields the bot flow writes) so in-app posting works without the bot round-trip.
// Fix: these posts now also reach the Telegram channel via publishToChannel (previously they
// only landed in the DB and never appeared on the channel), support media + community + location,
// and honor QUARANTINE outcomes by holding the post out of public visibility for review.
app.post("/api/posts", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const title = typeof req.body?.title === "string" ? req.body.title.normalize("NFKC").trim().slice(0, 100) : "";
  const body = typeof req.body?.body === "string" ? req.body.body.normalize("NFKC").trim().slice(0, POST_BODY_MAX) : "";
  const category = typeof req.body?.category === "string" && req.body.category.trim() ? req.body.category.trim().slice(0, 40) : "community";
  const tags = Array.isArray(req.body?.tags) ? (req.body.tags as unknown[]).map(x => String(x).normalize("NFKC").trim()).filter(Boolean).slice(0, 8) : [];
  const location = typeof req.body?.location === "string" ? req.body.location.normalize("NFKC").trim().slice(0, 120) : "";
  const monetizationType = ["FREE", "PAID", "SUBSCRIBERS"].includes(String(req.body?.monetizationType ?? "").toUpperCase()) ? String(req.body.monetizationType).toUpperCase() : "FREE";
  const priceCoins = Math.max(0, Math.min(10000, Number(req.body?.priceCoins) || 0));
  if (monetizationType === "PAID" && priceCoins < 1) return res.status(400).json({ success: false, data: null, error: "ለተከፈለ ይዘት ዋጋ ያስፈልጋል።", timestamp: new Date().toISOString() });
  // Media: Mini App uploads a file directly (bot api.sendDocument) and passes the telegram fileId.
  const mediaType = req.body?.mediaType === "image" || req.body?.mediaType === "video" ? String(req.body.mediaType) : null;
  const mediaFileId = typeof req.body?.mediaFileId === "string" && /^[A-Za-z0-9_-]{20,200}$/.test(req.body.mediaFileId) ? req.body.mediaFileId : null;
  // Community: optional — must be a community the user belongs to.
  let communityId: string | null = null;
  if (typeof req.body?.communityId === "string" && req.body.communityId) {
    const member = await db.communityMember.findFirst({ where: { communityId: req.body.communityId, userId: user.id }, select: { communityId: true } });
    if (!member) return res.status(400).json({ success: false, data: null, error: "በማህበረሰቡ ውስጥ ስለማይገኙ ማህበረሰብ ልጥፍ መደረግ አይችልም።", timestamp: new Date().toISOString() });
    communityId = member.communityId;
  }
  if (!title || !body) return res.status(400).json({ success: false, data: null, error: "ርዕስ እና ይዘት ያስፈልጋል።", timestamp: new Date().toISOString() });
  // Optional link button: only the six official platforms are accepted (same strict allowlist
  // as the wizard's Link step), and the raw URL string goes through normal text moderation so
  // scam keywords embedded inside a URL are caught before it ever becomes a channel button.
  let linkUrl: string | null = null;
  let linkPlatform: string | null = null;
  const linkRaw = typeof req.body?.linkUrl === "string" ? req.body.linkUrl.trim() : "";
  if (linkRaw) {
    const parsed = parsePlatformLink(linkRaw);
    if (!parsed) return res.status(400).json({ success: false, data: null, error: "ይህ አገናኝ ተቀባይነት የለውም። የዩቱብ፣ ቲክቶክ፣ ንስታግራም፣ ኤክስ፣ ፌስቡክ ወይም ሊንክድኢን አገናኝ ብቻ።", timestamp: new Date().toISOString() });
    const urlCheck = moderateText(parsed.url, { isAdmin: STAFF_ROLES.includes(user.role), isForwarded: false });
    if (urlCheck.decision === "BAN" || urlCheck.decision === "REJECT") {
      return res.status(400).json({ success: false, data: null, error: "አገናኙ በማረጋገጫ ሰውነት ተከልክሏል።", timestamp: new Date().toISOString() });
    }
    linkUrl = parsed.url;
    linkPlatform = parsed.platform;
  }
  const safety = await enforceContentModeration(user.id, STAFF_ROLES.includes(user.role), [title, body, ...tags]);
  if (!safety.ok) return res.status(safety.status).json({ success: false, data: null, error: safety.error, timestamp: new Date().toISOString() });
  const quarantineInfo = safety.ok === true && "quarantined" in safety ? { category: safety.category, reason: safety.reason } : { category: "NONE", reason: "" };
  const quarantined = quarantineInfo.category !== "NONE";
  const excerpt = body.slice(0, 180).replace(/\s+\S*$/, "").trim();
  const readingMinutes = Math.max(1, Math.ceil(body.split(/\s+/).filter(Boolean).length / 180));
  const baseSlug = title.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 60) || `genzi-${Date.now()}`;
  const post = await db.post.create({
    data: {
      slug: `${baseSlug}-${randomBytes(3).toString("hex")}`, title, body, excerpt, category,
      tagsJson: JSON.stringify(tags), authorName: user.firstName ?? "GENZI", readingMinutes,
      publishedAt: new Date(), authorId: user.id,
      visibility: quarantined ? "QUARANTINED" : "PUBLIC",
      ...(mediaType && mediaFileId ? { mediaType, mediaFileId } : {}),
      ...(location ? { location } : {}),
      ...(communityId ? { communityId } : {}),
      ...(linkUrl && linkPlatform ? { linkUrl, linkPlatform } : {}),
      monetizationType, priceCoins: monetizationType === "PAID" ? priceCoins : 0
    }
  });
  if (quarantined) {
    // Feed the admin approval queue: create a Submission in QUARANTINED state carrying the
    // normalized payload so APPROVE can publish it later (admin-actions.performModerationAction).
    const normalized = {
      title, body, tags, category,
      media: { type: mediaType ?? undefined, fileId: mediaFileId ?? undefined },
      metadata: { slug: post.slug, location: location || undefined, excerpt, readingMinutes, linkPlatform: linkPlatform ?? undefined }
    };
    await db.submission.create({
      data: {
        telegramChatId: String(user.telegramId), telegramUserId: String(user.telegramId),
        state: "QUARANTINED", title, body, category, tagsJson: JSON.stringify(tags),
        ...(mediaType ? { mediaType } : {}), ...(mediaFileId ? { mediaFileId } : {}),
        ...(location ? { location } : {}),
        ...(linkUrl ? { linkUrl } : {}), ...(linkPlatform ? { linkPlatform } : {}),
        normalizedJson: JSON.stringify(normalized),
        moderationJson: JSON.stringify(quarantineInfo),
        userId: user.id
      }
    });
    await db.notification.create({ data: { userId: user.id, postId: post.id, type: "MODERATION", title: "⏳ ለግምገማ ተቆይቷል", body: "ልጥፍዎ ለአስተዳዳሪ ግምገማ ቀርቧል፤ ከጊዜ በኋላ ይታያል።" } }).catch(() => undefined);
    res.status(201).json({ success: true, data: { ...post, purchased: true, quarantined: true }, error: null, timestamp: new Date().toISOString() });
    return;
  }
  // Publish to the GENZI Telegram channel (best-effort: DB write stays authoritative).
  let telegramMessageId: number | null = null;
  let telegramChatId: string | null = null;
  try {
    const publication = await publishToChannel(bot, {
      title, body, tags, author: user.firstName ?? "GENZI", readingMinutes,
      ...(mediaType && mediaFileId ? { mediaType, mediaFileId } : {}),
      ...(location ? { location } : {})
    });
    telegramMessageId = publication.messageId; telegramChatId = publication.chatId;
    await db.post.update({ where: { id: post.id }, data: { telegramMessageId, telegramChatId } });
    // Buttons land after publish so Share can point at the real message link. Best-effort.
    await attachChannelButtons(bot, publication.chatId, publication.messageId, {
      slug: post.slug, messageId: publication.messageId, chatId: publication.chatId,
      linkUrl, linkPlatform, locale: user.locale === "AMHARIC" ? "am" : "en"
    });
  } catch (error) { logger.warn("channel publish failed for API post", { postId: post.id, error: String(error) }); }
  await awardXp(user.id, "CREATE_POST");
  await earnCoins(user.id, "POST_PUBLISHED");
  res.status(201).json({ success: true, data: { ...post, telegramMessageId, telegramChatId, purchased: true, quarantined: false }, error: null, timestamp: new Date().toISOString() });
});

// Upload media from the Mini App composer: accepts multipart/form-data with a photo/video
// buffer, forwards it to Telegram via bot.api.sendDocument (document keeps original bytes and
// returns a reusable fileId), and returns { mediaType, mediaFileId } for POST /api/posts.
app.post("/api/me/upload-media", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const raw = req.body?.file;
  if (typeof raw !== "string" || !raw) return res.status(400).json({ success: false, data: null, error: "No file provided", timestamp: new Date().toISOString() });
  const mime = typeof req.body?.mime === "string" ? req.body.mime : "application/octet-stream";
  const kind = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : null;
  if (!kind) return res.status(400).json({ success: false, data: null, error: "Only image or video files are supported", timestamp: new Date().toISOString() });
  const buf = Buffer.from(raw, "base64");
  if (buf.byteLength > 8 * 1024 * 1024) return res.status(400).json({ success: false, data: null, error: "File too large (max 8 MB)", timestamp: new Date().toISOString() });
  try {
    // Send as a real photo/video: a document's file_id cannot be re-used with sendPhoto/sendVideo
    // when the post is published to the channel.
    let fileId: string | undefined;
    if (kind === "image") {
      const msg = await bot.api.sendPhoto(user.telegramId, new InputFile(buf, "photo.jpg"), { caption: "📷" });
      fileId = msg.photo.at(-1)?.file_id;
    } else {
      const msg = await bot.api.sendVideo(user.telegramId, new InputFile(buf, "video.mp4"), { caption: "🎬" });
      fileId = msg.video.file_id;
    }
    if (!fileId) throw new Error("Telegram did not return a file id");
    res.json({ success: true, data: { mediaType: kind, mediaFileId: fileId }, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error("Mini App media upload failed", { userId: user.id, error: String(error) });
    res.status(502).json({ success: false, data: null, error: "Media upload failed", timestamp: new Date().toISOString() });
  }
});

// Audit fix #11: the current user's own published posts (profile hub).
app.get("/api/me/posts", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit ?? "10"), 10) || 10));
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const where = { authorId: userId, publishedAt: { not: null }, ...(q ? { OR: [{ title: { contains: q } }, { body: { contains: q } }] } : {}) };
  const [items, total] = await Promise.all([
    db.post.findMany({ where, orderBy: { publishedAt: "desc" }, skip: (page - 1) * limit, take: limit }),
    db.post.count({ where })
  ]);
  res.json({ success: true, data: { items, page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/me/wallet/transactions", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "25"), 10) || 25));
  const items = await db.walletTransaction.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, type: true, amount: true, reference: true, note: true, createdAt: true } });
  res.json({ success: true, data: items, error: null, timestamp: new Date().toISOString() });
});

// Audit fix #6: lets the Mini App show Subscribe vs Active on public profiles.
app.get("/api/users/:id/subscription", telegramAuth, async (req: Request, res: Response) => {
  const subscriberId = res.locals.telegramUser.id;
  await expireDueSubscriptions(subscriberId, String(req.params.id));
  const sub = await db.creatorSubscription.findUnique({ where: { subscriberId_creatorId: { subscriberId, creatorId: String(req.params.id) } } });
  // Fix: expose the full subscription lifecycle (expiry / renewal / cancel state) to the Mini App.
  res.json({ success: true, data: {
    active: sub?.status === "ACTIVE",
    status: sub?.status ?? null,
    priceCoins: sub?.priceCoins ?? DEFAULT_SUBSCRIPTION_PRICE,
    startedAt: sub?.startedAt ?? null,
    expiresAt: sub?.expiresAt ?? null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    autoRenew: sub?.autoRenew ?? true,
    periodDays: sub?.periodDays ?? SUBSCRIPTION_PERIOD_DAYS
  }, error: null, timestamp: new Date().toISOString() });
});

function pairIds(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

app.get("/api/me/messages", telegramAuth, async (_req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const rows = await db.directConversation.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    include: { userA: { select: { id: true, firstName: true, lastName: true, username: true } }, userB: { select: { id: true, firstName: true, lastName: true, username: true } }, messages: { orderBy: { createdAt: "desc" }, take: 1, select: { body: true, createdAt: true, senderId: true, recipientId: true, readAt: true } } }
  });
  const items = rows.map(c => { const other = c.userAId === userId ? c.userB : c.userA; const last = c.messages[0] ?? null; return { id: c.id, other, lastMessage: last, unread: last && last.recipientId === userId && !last.readAt ? 1 : 0 }; });
  const unread = await db.directMessage.count({ where: { recipientId: userId, readAt: null } });
  res.json({ success: true, data: { items, unread }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/messages/:userId", telegramAuth, async (req: Request, res: Response) => {
  const me = res.locals.telegramUser.id; const otherId = String(req.params.userId);
  if (me === otherId) return res.status(400).json({ success: false, data: null, error: "Cannot message yourself", timestamp: new Date().toISOString() });
  const other = await db.user.findUnique({ where: { id: otherId }, select: { id: true, firstName: true, lastName: true, username: true, blocked: true } });
  if (!other || other.blocked) return res.status(404).json({ success: false, data: null, error: "User not available", timestamp: new Date().toISOString() });
  const [a, b] = pairIds(me, otherId);
  const conversation = await db.directConversation.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } });
  if (!conversation) return res.json({ success: true, data: { conversation: null, other, messages: [] }, error: null, timestamp: new Date().toISOString() });
  const messages = await db.directMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" }, take: 200, select: { id: true, senderId: true, recipientId: true, body: true, readAt: true, createdAt: true } });
  const marked = await db.directMessage.updateMany({ where: { conversationId: conversation.id, recipientId: me, readAt: null }, data: { readAt: new Date() } });
  if (marked.count > 0) publishRealtime(otherId, { type: "message_read", data: { conversationId: conversation.id, readerId: me } });
  res.json({ success: true, data: { conversation: { id: conversation.id }, other, messages }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/messages/:userId", telegramAuth, async (req: Request, res: Response) => {
  const me = res.locals.telegramUser.id; const otherId = String(req.params.userId);
  const body = typeof req.body?.body === "string" ? req.body.body.normalize("NFKC").trim().slice(0, 1000) : "";
  if (!body) return res.status(400).json({ success: false, data: null, error: "Message is empty", timestamp: new Date().toISOString() });
  if (me === otherId) return res.status(400).json({ success: false, data: null, error: "Cannot message yourself", timestamp: new Date().toISOString() });
  const other = await db.user.findUnique({ where: { id: otherId }, select: { id: true, firstName: true, lastName: true, username: true, blocked: true, restrictedUntil: true } });
  if (!other || other.blocked || (other.restrictedUntil && other.restrictedUntil > new Date())) return res.status(404).json({ success: false, data: null, error: "User not available", timestamp: new Date().toISOString() });
  const sender = res.locals.telegramUser;
  const safety = moderateRequestText(body, sender.role !== "USER");
  if (safety.decision === "BAN" || safety.decision === "REJECT") {
    const action = safety.decision === "BAN" ? "BAN" : "REJECT";
    await db.moderationEvent.create({ data: { targetUserId: sender.id, category: safety.category, action, reason: safety.reason, evidence: body } });
    if (action === "BAN") {
      await db.user.update({ where: { id: sender.id }, data: { blocked: true } });
    } else {
      const recent = await db.moderationEvent.count({ where: { targetUserId: sender.id, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }, action: { in: ["REJECT", "BAN"] } } });
      if (recent >= 3) await db.user.update({ where: { id: sender.id }, data: { restrictedUntil: new Date(Date.now() + 60 * 60 * 1000) } });
    }
    return res.status(400).json({ success: false, data: null, error: "ይህ መልዕክት ለደህንነት ምክንያት አልተላከም።", timestamp: new Date().toISOString() });
  }
  if (safety.category === "MONITORED_SAFETY_CATEGORY") {
    await db.moderationEvent.create({ data: { targetUserId: sender.id, category: safety.category, action: "ALLOW", reason: safety.reason, evidence: body } });
  }
  const [a, b] = pairIds(me, otherId);
  const conversation = await db.directConversation.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: { lastMessageAt: new Date() }, create: { userAId: a, userBId: b, lastMessageAt: new Date() } });
  if (await isBlockedBetween(me, otherId)) return res.status(403).json({ success: false, data: null, error: "ይህ ተጠቃሚ እርስዎን ዘፍቷል።", timestamp: new Date().toISOString() });
  const message = await db.directMessage.create({ data: { conversationId: conversation.id, senderId: me, recipientId: otherId, body } });
  await db.notification.create({ data: { userId: otherId, type: "MESSAGE", title: "💬 አዲስ መልዕክት", body: "አዲስ የግል መልዕክት ደርሶዎታል።", actorId: me } });
  // Telegram push for incoming DMs (mutes respected on the recipient side, best-effort).
  if (await shouldDeliverNotification(otherId, me)) void notifier.directMessage(otherId, res.locals.telegramUser.firstName ?? res.locals.telegramUser.username);
  // Fix: docs/SOCIAL.md promises direct messages are pushed live over SSE. Previously only the
  // typing indicator was ever published, so new messages required a manual refresh/poll.
  publishRealtime(otherId, { type: "message_new", data: { ...message, senderName: res.locals.telegramUser.firstName ?? null } });
  publishRealtime(me, { type: "message_new", data: message });
  res.status(201).json({ success: true, data: message, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/messages/:userId/read", telegramAuth, async (req: Request, res: Response) => {
  const me = res.locals.telegramUser.id; const otherId = String(req.params.userId); const [a, b] = pairIds(me, otherId);
  const c = await db.directConversation.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } }, select: { id: true } });
  if (c) {
    await db.directMessage.updateMany({ where: { conversationId: c.id, recipientId: me, readAt: null }, data: { readAt: new Date() } });
    publishRealtime(otherId, { type: "message_read", data: { conversationId: c.id, readerId: me } });
  }
  res.json({ success: true, data: { read: true }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/users/:id/message-status", telegramAuth, async (req: Request, res: Response) => {
  const user = await db.user.findUnique({ where: { id: String(req.params.id) }, select: { id: true, firstName: true, lastName: true, username: true, blocked: true } });
  if (!user || user.blocked) return res.status(404).json({ success: false, data: null, error: "User not available", timestamp: new Date().toISOString() });
  res.json({ success: true, data: { user }, error: null, timestamp: new Date().toISOString() });
});

// --- Post editing & deletion (feature commit: users could publish but never fix or remove a post) --
// PATCH /api/posts/:id lets the author re-edit title/body/tags/location/media/monetization;
// DELETE /api/posts/:id soft-unpublishes (publishedAt = null) so tips, purchases and
// subscriptions keep referring to an intact ledger row instead of cascading away.
async function loadEditablePost(req: Request, res: Response): Promise<{ id: string; authorId: string; visibility: string } | null> {
  const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true, authorId: true, visibility: true } });
  if (!post) { res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() }); return null; }
  const user = res.locals.telegramUser;
  if (post.authorId !== user.id && !STAFF_ROLES.includes(user.role)) {
    res.status(403).json({ success: false, data: null, error: "የራስዎን ልጥፍ ብቻ መቀየር ይችላሉ።", timestamp: new Date().toISOString() });
    return null;
  }
  return post;
}

app.patch("/api/posts/:id", telegramAuth, async (req: Request, res: Response) => {
  const post = await loadEditablePost(req, res);
  if (!post) return;
  const title = typeof req.body?.title === "string" ? req.body.title.normalize("NFKC").trim().slice(0, 100) : undefined;
  const body = typeof req.body?.body === "string" ? req.body.body.normalize("NFKC").trim().slice(0, POST_BODY_MAX) : undefined;
  const tags = Array.isArray(req.body?.tags) ? (req.body.tags as unknown[]).map(x => String(x).normalize("NFKC").trim()).filter(Boolean).slice(0, 8) : undefined;
  const location = typeof req.body?.location === "string" ? req.body.location.normalize("NFKC").trim().slice(0, 120) : undefined;
  const mediaType = req.body?.mediaType === "image" || req.body?.mediaType === "video" ? String(req.body.mediaType) : undefined;
  const mediaFileId = typeof req.body?.mediaFileId === "string" && /^[A-Za-z0-9_-]{20,200}$/.test(req.body.mediaFileId) ? req.body.mediaFileId : undefined;
  const monetizationType = ["FREE", "PAID", "SUBSCRIBERS"].includes(String(req.body?.monetizationType ?? "").toUpperCase()) ? String(req.body.monetizationType).toUpperCase() : undefined;
  const priceCoins = req.body?.priceCoins !== undefined ? Math.max(0, Math.min(10000, Number(req.body.priceCoins) || 0)) : undefined;
  if (title === undefined && body === undefined && tags === undefined && location === undefined && mediaFileId === undefined && monetizationType === undefined && priceCoins === undefined) {
    return res.status(400).json({ success: false, data: null, error: "ምን ለመቀየር እንደሆነ አልተገለጸም።", timestamp: new Date().toISOString() });
  }
  if (body !== undefined && !body) return res.status(400).json({ success: false, data: null, error: "የልጥፍ ይዘት ባዶ ሊሆን አይችልም።", timestamp: new Date().toISOString() });
  // Re-run safety on every user-supplied text that changes (staff bypass, same rules as create).
  const editor = res.locals.telegramUser;
  const texts = [title, body, location].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (tags) texts.push(...tags);
  if (texts.length) {
    const safety = await enforceContentModeration(editor.id, STAFF_ROLES.includes(editor.role), texts);
    if (!safety.ok) return res.status(safety.status).json({ success: false, data: null, error: safety.error, timestamp: new Date().toISOString() });
  }
  const nextMonetization = monetizationType ?? undefined;
  if (nextMonetization === "PAID" && (priceCoins ?? 0) < 1) {
    return res.status(400).json({ success: false, data: null, error: "ለተከፈለ ይዘት ዋጋ ያስፈልጋል።", timestamp: new Date().toISOString() });
  }
  const updated = await db.post.update({
    where: { id: post.id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body, excerpt: body.slice(0, 180).replace(/\s+\S*$/, "").trim(), readingMinutes: Math.max(1, Math.ceil(body.split(/\s+/).filter(Boolean).length / 180)) } : {}),
      ...(tags !== undefined ? { tagsJson: JSON.stringify(tags) } : {}),
      ...(location !== undefined ? { location: location || null } : {}),
      ...(mediaFileId !== undefined ? { mediaFileId, mediaType: mediaType ?? null } : {}),
      ...(nextMonetization !== undefined ? { monetizationType: nextMonetization, priceCoins: nextMonetization === "PAID" ? (priceCoins ?? 0) : 0 } : {})
    }
  });
  const [decorated] = await decoratePostsForViewer([updated], { id: editor.id, role: editor.role });
  res.json({ success: true, data: decorated, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/posts/:id", telegramAuth, async (req: Request, res: Response) => {
  const post = await loadEditablePost(req, res);
  if (!post) return;
  // Soft delete: unpublish + hide. Engagement/purchase history stays queryable for the ledger.
  await db.post.update({ where: { id: post.id }, data: { publishedAt: null, visibility: "DRAFT" } });
  res.json({ success: true, data: { deleted: true }, error: null, timestamp: new Date().toISOString() });
});

// --- Anonymous confessions over the API (schema models Confession/ConfessionReaction were
// only reachable from the bot chat flow; the Mini App gets parity here).
const CONFESSION_BODY_MAX = 800;
const CONFESSION_REACTIONS = ["approach", "forget", "ask_friend", "stay_single"] as const;
const CONFESSION_REACTION_EMOJI: Record<string, string> = { approach: "❤️", forget: "😂", ask_friend: "👀", stay_single: "💀" };

app.get("/api/confessions", telegramAuth, async (req: Request, res: Response) => {
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const where = { state: "PUBLISHED" };
  const [rows, total] = await Promise.all([
    db.confession.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit, select: { id: true, number: true, body: true, createdAt: true, reactions: { select: { choice: true } } } }),
    db.confession.count({ where })
  ]);
  res.json({ success: true, data: { items: rows.map(r => ({ id: r.id, number: r.number, body: r.body, createdAt: r.createdAt, reactionCounts: CONFESSION_REACTIONS.map(choice => ({ choice, count: r.reactions.filter(x => x.choice === choice).length })) })), page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/confessions", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const body = typeof req.body?.body === "string" ? req.body.body.normalize("NFKC").trim().slice(0, CONFESSION_BODY_MAX) : "";
  if (!body) return res.status(400).json({ success: false, data: null, error: "መናዘዣው ባዶ ሊሆን አይችልም።", timestamp: new Date().toISOString() });
  const safety = await enforceContentModeration(user.id, STAFF_ROLES.includes(user.role), [body]);
  if (!safety.ok) return res.status(safety.status).json({ success: false, data: null, error: safety.error, timestamp: new Date().toISOString() });
  const quarantined = "quarantined" in safety && safety.quarantined === true;
  const confession = await db.confession.create({ data: { telegramUserId: String(user.telegramId), userId: user.id, body, state: quarantined ? "QUARANTINED" : "INPUT" } });
  res.status(201).json({ success: true, data: { id: confession.id, state: confession.state }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/confessions/:id/publish", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const confession = await db.confession.findUnique({ where: { id: String(req.params.id) }, select: { id: true, userId: true } });
  if (!confession || confession.userId !== user.id) return res.status(404).json({ success: false, data: null, error: "መናዘዣው አልተገኘም።", timestamp: new Date().toISOString() });
  try {
    // Shared with the bot flow: atomic claim, collision-free numbering, and a real failure
    // response (this route used to swallow channel errors and still report success).
    const published = await publishConfessionNow(bot, confession.id, ["INPUT"]);
    res.json({ success: true, data: { id: confession.id, number: published.number, state: "PUBLISHED", anonymous: true }, error: null, timestamp: new Date().toISOString() });
  } catch (error) {
    if (error instanceof ConfessionNotReadyError) return res.status(400).json({ success: false, data: null, error: "ይህ መናዘዣ ለአሁን የማተም ደረጃ ላይ አይደለም።", timestamp: new Date().toISOString() });
    logger.warn("confession publish failed (API)", { confessionId: confession.id, error: String(error) });
    res.status(502).json({ success: false, data: null, error: "ማተም አልተሳካም። ቆይተው እንደገና ይሞክሩ።", timestamp: new Date().toISOString() });
  }
});

app.post("/api/confessions/:id/react", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const choiceRaw = typeof req.body?.choice === "string" ? req.body.choice : "";
  if (!CONFESSION_REACTIONS.includes(choiceRaw as typeof CONFESSION_REACTIONS[number])) return res.status(400).json({ success: false, data: null, error: "Invalid reaction", timestamp: new Date().toISOString() });
  const confession = await db.confession.findUnique({ where: { id: String(req.params.id) }, select: { id: true, state: true } });
  if (!confession || confession.state !== "PUBLISHED") return res.status(404).json({ success: false, data: null, error: "መናዘዣው አልተገኘም።", timestamp: new Date().toISOString() });
  const existing = await db.confessionReaction.findUnique({ where: { confessionId_userId: { confessionId: confession.id, userId } } });
  const sameChoice = existing?.choice === choiceRaw;
  if (existing && sameChoice) await db.confessionReaction.delete({ where: { id: existing.id } });
  else if (existing) await db.confessionReaction.update({ where: { id: existing.id }, data: { choice: choiceRaw } });
  else await db.confessionReaction.create({ data: { confessionId: confession.id, userId, choice: choiceRaw } });
  void refreshConfessionKeyboard(bot, confession.id);
  const grouped = await db.confessionReaction.groupBy({ by: ["choice"], where: { confessionId: confession.id }, _count: { id: true } });
  res.json({ success: true, data: { active: sameChoice ? null : choiceRaw, counts: CONFESSION_REACTIONS.map(choice => ({ choice, count: grouped.find(x => x.choice === choice)?._count.id ?? 0 })) }, error: null, timestamp: new Date().toISOString() });
});

// --- Ask Me Anything (AskQuestion/AskReaction models existed with zero routes) --------------
app.get("/api/ask/questions", telegramAuth, async (req: Request, res: Response) => {
  const status = req.query.status === "ANSWERED" || req.query.status === "PENDING" ? String(req.query.status) : "ANSWERED";
  const page = Math.max(1, Number.parseInt(String(req.query.page ?? "1"), 10) || 1);
  const limit = Math.min(30, Math.max(1, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20));
  const where = { status };
  const [rows, total] = await Promise.all([
    db.askQuestion.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * limit, take: limit, include: { reactions: { select: { choice: true } }, author: { select: { id: true, firstName: true, username: true } } } }),
    db.askQuestion.count({ where })
  ]);
  res.json({ success: true, data: { items: rows.map(q => ({ id: q.id, body: q.body, answerBody: q.answerBody, answeredAt: q.answeredAt, status: q.status, createdAt: q.createdAt, author: q.status === "PENDING" ? null : q.author, agree: q.reactions.filter(r => r.choice === "AGREE").length, insightful: q.reactions.filter(r => r.choice === "INSIGHTFUL").length })), page, limit, total, hasMore: page * limit < total }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/ask/questions", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const body = typeof req.body?.body === "string" ? req.body.body.normalize("NFKC").trim().slice(0, 500) : "";
  if (!body) return res.status(400).json({ success: false, data: null, error: "ጥያቄዎ ባዶ ነው።", timestamp: new Date().toISOString() });
  const safety = await enforceContentModeration(user.id, STAFF_ROLES.includes(user.role), [body]);
  if (!safety.ok) return res.status(safety.status).json({ success: false, data: null, error: safety.error, timestamp: new Date().toISOString() });
  const question = await db.askQuestion.create({ data: { body, authorId: user.id, status: "PENDING" }, select: { id: true, body: true, status: true, createdAt: true } });
  res.status(201).json({ success: true, data: question, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/ask/questions/:id/react", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const choiceRaw = typeof req.body?.choice === "string" ? req.body.choice.toUpperCase() : "";
  if (!["AGREE", "INSIGHTFUL"].includes(choiceRaw)) return res.status(400).json({ success: false, data: null, error: "Invalid reaction", timestamp: new Date().toISOString() });
  const question = await db.askQuestion.findUnique({ where: { id: String(req.params.id) }, select: { id: true, status: true } });
  if (!question || question.status !== "ANSWERED") return res.status(404).json({ success: false, data: null, error: "ጥያቄው አልተገኘም።", timestamp: new Date().toISOString() });
  const existing = await db.askReaction.findUnique({ where: { questionId_userId: { questionId: question.id, userId } } });
  if (existing) await db.askReaction.delete({ where: { id: existing.id } });
  else await db.askReaction.create({ data: { questionId: question.id, userId, choice: choiceRaw } });
  const grouped = await db.askReaction.groupBy({ by: ["choice"], where: { questionId: question.id }, _count: { id: true } });
  res.json({ success: true, data: { active: existing ? null : choiceRaw, counts: Object.fromEntries(grouped.map(g => [g.choice, g._count.id])) }, error: null, timestamp: new Date().toISOString() });
});

// Staff-only AMA answering queue (mirrors the moderation approval pattern).
app.get("/api/admin/ask", adminAuth, async (_req: Request, res: Response) => {
  const rows = await db.askQuestion.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "asc" }, take: 100, include: { author: { select: { id: true, firstName: true, username: true } } } });
  res.json({ success: true, data: rows, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/ask/:id/answer", adminAuth, moderatorSessionAuth, async (req: Request, res: Response) => {
  const moderator = res.locals.moderator;
  const action = req.body?.action === "REJECT" ? "REJECTED" : "ANSWERED";
  const answerBody = typeof req.body?.answerBody === "string" ? req.body.answerBody.normalize("NFKC").trim().slice(0, 1000) : "";
  if (action === "ANSWERED" && !answerBody) return res.status(400).json({ success: false, data: null, error: "መልሱ ሊዛምድ አይችልም።", timestamp: new Date().toISOString() });
  const question = await db.askQuestion.findUnique({ where: { id: String(req.params.id) }, select: { id: true, authorId: true, status: true } });
  if (!question || question.status !== "PENDING") return res.status(404).json({ success: false, data: null, error: "ጥያቄው አልተገኘም ወይም ወሳኝ ተሰጥቷል።", timestamp: new Date().toISOString() });
  const updated = await db.askQuestion.update({ where: { id: question.id }, data: { status: action, ...(action === "ANSWERED" ? { answerBody, answeredBy: moderator.id, answeredAt: new Date() } : {}) }, select: { id: true, status: true, answerBody: true } });
  await db.notification.create({ data: { userId: question.authorId, actorId: moderator.id, type: "ASK", title: action === "ANSWERED" ? "💬 ጥያቄዎ ተመልሷል" : "🚫 ጥያቄዎ ተቀብልቷል", body: action === "ANSWERED" ? "ጥያቄዎ በGENZI ቡድን ተምላ ለሁሉም ታትሟል።" : "ጥያቄዎ በደህንነት መመሪያ መሠረት ለትርፕ ዕትም ተቀብልቷል።" } }).catch(() => undefined);
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

// --- Poll & quiz lifecycle ----------------------------------------------------------------
// Creators need to close their own polls/quizzes (active flag was previously admin-only path).
app.post("/api/polls/:id/close", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const poll = await db.poll.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true } });
  if (!poll) return res.status(404).json({ success: false, data: null, error: "Poll not found", timestamp: new Date().toISOString() });
  if (poll.ownerId !== user.id && !STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "የራስዎን ምርጫ ብቻ መዝጋት ይችላሉ።", timestamp: new Date().toISOString() });
  const updated = await db.poll.update({ where: { id: poll.id }, data: { active: false, closesAt: new Date() }, select: { id: true, active: true, closesAt: true } });
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/quizzes/:id/close", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const quiz = await db.quiz.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true } });
  if (!quiz) return res.status(404).json({ success: false, data: null, error: "Quiz not found", timestamp: new Date().toISOString() });
  if (quiz.ownerId !== user.id && !STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "የራስዎን ክዊዝ ብቻ መዝጋት ይችላሉ።", timestamp: new Date().toISOString() });
  const updated = await db.quiz.update({ where: { id: quiz.id }, data: { active: false }, select: { id: true, active: true } });
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

// --- Event updates & cancellation (events were create-once, never editable) ---------------
app.patch("/api/events/:id", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const event = await db.event.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true, active: true, startsAt: true } });
  if (!event || !event.active) return res.status(404).json({ success: false, data: null, error: "ዝግጅቱ አልተገኘም።", timestamp: new Date().toISOString() });
  if (event.ownerId !== user.id && !STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "የራስዎን ዝግጅት ብቻ መቀየር ይችላሉ።", timestamp: new Date().toISOString() });
  const title = typeof req.body?.title === "string" ? req.body.title.normalize("NFKC").trim().slice(0, 120) : undefined;
  const description = typeof req.body?.description === "string" ? req.body.description.normalize("NFKC").trim().slice(0, 1500) : undefined;
  const location = typeof req.body?.location === "string" ? req.body.location.normalize("NFKC").trim().slice(0, 160) : undefined;
  const meetingText = typeof req.body?.meetingText === "string" ? req.body.meetingText.normalize("NFKC").trim().slice(0, 300) : undefined;
  const startsAt = typeof req.body?.startsAt === "string" && req.body.startsAt ? new Date(req.body.startsAt) : undefined;
  const endsAt = typeof req.body?.endsAt === "string" && req.body.endsAt ? new Date(req.body.endsAt) : undefined;
  if (startsAt !== undefined && (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now())) return res.status(400).json({ success: false, data: null, error: "የመጀመሪያ ጊዜው ወደፊት መሆን አለበት።", timestamp: new Date().toISOString() });
  if (endsAt !== undefined && (Number.isNaN(endsAt.getTime()) || (startsAt ?? event.startsAt) >= endsAt)) return res.status(400).json({ success: false, data: null, error: "የመጨረሻ ጊዜው ከመጀመሪያው በኋላ መሆን አለበት።", timestamp: new Date().toISOString() });
  const texts = [title, description, location, meetingText].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (texts.length) {
    const safety = await enforceContentModeration(user.id, STAFF_ROLES.includes(user.role), texts);
    if (!safety.ok) return res.status(safety.status).json({ success: false, data: null, error: safety.error, timestamp: new Date().toISOString() });
  }
  const updated = await db.event.update({ where: { id: event.id }, data: { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), ...(location !== undefined ? { location: location || null } : {}), ...(meetingText !== undefined ? { meetingText: meetingText || null } : {}), ...(startsAt !== undefined ? { startsAt } : {}), ...(endsAt !== undefined ? { endsAt } : {}) }, include: { _count: { select: { rsvps: true } } } });
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/events/:id", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const event = await db.event.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true, active: true, title: true } });
  if (!event || !event.active) return res.status(404).json({ success: false, data: null, error: "ዝግጅቱ አልተገኘም።", timestamp: new Date().toISOString() });
  if (event.ownerId !== user.id && !STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "የራስዎን ዝግጅት ብቻ ማቆም ይችላሉ።", timestamp: new Date().toISOString() });
  await db.event.update({ where: { id: event.id }, data: { active: false } });
  // Tell everyone who had signed up, then drop their pending reminders.
  const attendees = await db.eventRSVP.findMany({ where: { eventId: event.id }, select: { userId: true } });
  if (attendees.length) await db.notification.createMany({ data: attendees.filter(a => a.userId !== user.id).map(a => ({ userId: a.userId, actorId: user.id, type: "EVENT_CANCELLED", title: "⛔ ዝግጅት ተሰርዟል", body: `"${event.title}" ዝግጅት በአዘጋጁ ተሰርዟል።` })) }).catch(() => undefined);
  await db.eventReminder.deleteMany({ where: { eventId: event.id } }).catch(() => undefined);
  res.json({ success: true, data: { cancelled: true }, error: null, timestamp: new Date().toISOString() });
});

// --- Community management (create-once communities had no owner controls) -----------------
app.patch("/api/communities/:id", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const community = await db.community.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true, slug: true } });
  if (!community) return res.status(404).json({ success: false, data: null, error: "Community not found", timestamp: new Date().toISOString() });
  if (community.ownerId !== user.id && !STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "የማህበረሰብ ባለቤት ብቻ መረጃውን መቀየር ይችላል።", timestamp: new Date().toISOString() });
  const name = typeof req.body?.name === "string" ? req.body.name.normalize("NFKC").trim().slice(0, COMMUNITY_NAME_MAX) : undefined;
  const description = typeof req.body?.description === "string" ? req.body.description.normalize("NFKC").trim().slice(0, COMMUNITY_DESC_MAX) : undefined;
  const category = typeof req.body?.category === "string" && COMMUNITY_CATEGORIES.includes(req.body.category as typeof COMMUNITY_CATEGORIES[number]) ? req.body.category : undefined;
  const city = typeof req.body?.city === "string" ? req.body.city.normalize("NFKC").trim().slice(0, 80) : undefined;
  const coverEmoji = typeof req.body?.coverEmoji === "string" ? req.body.coverEmoji.trim().slice(0, 8) : undefined;
  const isPublic = typeof req.body?.isPublic === "boolean" ? req.body.isPublic : undefined;
  if (name === undefined && description === undefined && category === undefined && city === undefined && coverEmoji === undefined && isPublic === undefined) return res.status(400).json({ success: false, data: null, error: "ምን ለመቀየር እንደሆነ አልተገለጸም።", timestamp: new Date().toISOString() });
  const texts = [name, description, city].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (texts.length) {
    const safety = await enforceContentModeration(user.id, STAFF_ROLES.includes(user.role), texts);
    if (!safety.ok) return res.status(safety.status).json({ success: false, data: null, error: safety.error, timestamp: new Date().toISOString() });
  }
  const updated = await db.community.update({ where: { id: community.id }, data: { ...(name !== undefined ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(category !== undefined ? { category } : {}), ...(city !== undefined ? { city: city || null } : {}), ...(coverEmoji !== undefined ? { coverEmoji } : {}), ...(isPublic !== undefined ? { isPublic } : {}) }, include: { _count: { select: { members: true, posts: true } } } });
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/communities/:id/transfer-owner", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const community = await db.community.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true } });
  if (!community) return res.status(404).json({ success: false, data: null, error: "Community not found", timestamp: new Date().toISOString() });
  if (community.ownerId !== user.id && !STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "የሚያስተላልፈው ባለቤት ብቻ ነው።", timestamp: new Date().toISOString() });
  const newOwnerId = typeof req.body?.userId === "string" ? req.body.userId : "";
  if (!newOwnerId || newOwnerId === community.ownerId) return res.status(400).json({ success: false, data: null, error: "አዲስ ባለቤት ይምረጡ።", timestamp: new Date().toISOString() });
  const target = await db.communityMember.findUnique({ where: { communityId_userId: { communityId: community.id, userId: newOwnerId } }, select: { id: true, userId: true } });
  if (!target) return res.status(404).json({ success: false, data: null, error: "አዲሱ ባለቤት መቀላቀል አለበት።", timestamp: new Date().toISOString() });
  await db.$transaction(async tx => {
    await tx.communityMember.updateMany({ where: { communityId: community.id, userId: community.ownerId }, data: { role: "MEMBER" } });
    await tx.communityMember.update({ where: { id: target.id }, data: { role: "OWNER" } });
    await tx.community.update({ where: { id: community.id }, data: { ownerId: newOwnerId } });
  });
  await db.notification.create({ data: { userId: newOwnerId, actorId: user.id, type: "COMMUNITY_OWNER", title: "👑 አዲስ ማህበረሰብ ባለቤት", body: "የማህበረሰብ ባለቤትነት ለእርስዎ ተላልፏል።" } }).catch(() => undefined);
  res.json({ success: true, data: { ownerId: newOwnerId }, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/communities/:id/members/:userId", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const communityId = String(req.params.id);
  const removedUserId = String(req.params.userId);
  const community = await db.community.findUnique({ where: { id: communityId }, select: { id: true, ownerId: true } });
  if (!community) return res.status(404).json({ success: false, data: null, error: "Community not found", timestamp: new Date().toISOString() });
  const actorMembership = await db.communityMember.findUnique({ where: { communityId_userId: { communityId, userId: user.id } }, select: { role: true } });
  const canRemove = community.ownerId === user.id || actorMembership?.role === "MODERATOR" || STAFF_ROLES.includes(user.role);
  if (!canRemove) return res.status(403).json({ success: false, data: null, error: "የማህበረሰብ አስተዳደር ፈቃድ ያስፈልጋል።", timestamp: new Date().toISOString() });
  if (removedUserId === community.ownerId) return res.status(400).json({ success: false, data: null, error: "ባለቤትን ማስወገድ አይቻልም — ባለቤትነትን ያስተላልፉ።", timestamp: new Date().toISOString() });
  const membership = await db.communityMember.findUnique({ where: { communityId_userId: { communityId, userId: removedUserId } }, select: { id: true } });
  if (!membership) return res.status(404).json({ success: false, data: null, error: "አባሉ አልተገኘም።", timestamp: new Date().toISOString() });
  await db.communityMember.delete({ where: { id: membership.id } });
  res.json({ success: true, data: { removed: true }, error: null, timestamp: new Date().toISOString() });
});

// --- Opportunity lifecycle (listings could be created but never edited/closed by owners) ---
app.patch("/api/opportunities/:id", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const item = await db.opportunity.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true } });
  if (!item) return res.status(404).json({ success: false, data: null, error: "Opportunity not found", timestamp: new Date().toISOString() });
  if (item.ownerId !== user.id && !STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "የራስዎን እድል ብቻ መቀየር ይችላሉ።", timestamp: new Date().toISOString() });
  const title = typeof req.body?.title === "string" ? req.body.title.normalize("NFKC").trim().slice(0, 120) : undefined;
  const description = typeof req.body?.description === "string" ? req.body.description.normalize("NFKC").trim().slice(0, 1200) : undefined;
  const organization = typeof req.body?.organization === "string" ? req.body.organization.normalize("NFKC").trim().slice(0, 120) : undefined;
  const type = typeof req.body?.type === "string" && OPPORTUNITY_TYPES.includes(req.body.type as typeof OPPORTUNITY_TYPES[number]) ? req.body.type : undefined;
  const category = typeof req.body?.category === "string" && OPPORTUNITY_CATEGORIES.includes(req.body.category as typeof OPPORTUNITY_CATEGORIES[number]) ? req.body.category : undefined;
  const location = typeof req.body?.location === "string" ? req.body.location.normalize("NFKC").trim().slice(0, 100) : undefined;
  const contactText = typeof req.body?.contactText === "string" ? req.body.contactText.normalize("NFKC").trim().slice(0, 300) : undefined;
  const applicationUrl = typeof req.body?.applicationUrl === "string" ? req.body.applicationUrl.normalize("NFKC").trim().slice(0, 300) : undefined;
  if (applicationUrl && !/^https?:\/\/\S+$/i.test(applicationUrl)) return res.status(400).json({ success: false, data: null, error: "የማመልከቻ አድናሺ ትክክለኛ URL መሆን አለበት።", timestamp: new Date().toISOString() });
  const deadline = typeof req.body?.deadline === "string" && req.body.deadline ? new Date(req.body.deadline) : undefined;
  if (deadline && Number.isNaN(deadline.getTime())) return res.status(400).json({ success: false, data: null, error: "የመጨረሻ ቀን ትክክል አይደለም።", timestamp: new Date().toISOString() });
  const active = typeof req.body?.active === "boolean" ? req.body.active : undefined;
  if (title === undefined && description === undefined && organization === undefined && type === undefined && category === undefined && location === undefined && contactText === undefined && applicationUrl === undefined && deadline === undefined && active === undefined) {
    return res.status(400).json({ success: false, data: null, error: "ምን ለመቀየር እንደሆነ አልተገለጸም።", timestamp: new Date().toISOString() });
  }
  const texts = [title, description, organization, location, contactText, applicationUrl].filter((x): x is string => typeof x === "string" && x.length > 0);
  if (texts.length) {
    const safety = await enforceContentModeration(user.id, STAFF_ROLES.includes(user.role), texts);
    if (!safety.ok) return res.status(safety.status).json({ success: false, data: null, error: safety.error, timestamp: new Date().toISOString() });
  }
  const updated = await db.opportunity.update({ where: { id: item.id }, data: { ...(title !== undefined ? { title } : {}), ...(description !== undefined ? { description } : {}), ...(organization !== undefined ? { organization } : {}), ...(type !== undefined ? { type } : {}), ...(category !== undefined ? { category } : {}), ...(location !== undefined ? { location: location || null } : {}), ...(contactText !== undefined ? { contactText: contactText || null } : {}), ...(applicationUrl !== undefined ? { applicationUrl: applicationUrl || null } : {}), ...(deadline !== undefined ? { deadline } : {}), ...(active !== undefined ? { active } : {}) } });
  res.json({ success: true, data: updated, error: null, timestamp: new Date().toISOString() });
});

app.delete("/api/opportunities/:id", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  const item = await db.opportunity.findUnique({ where: { id: String(req.params.id) }, select: { id: true, ownerId: true } });
  if (!item) return res.status(404).json({ success: false, data: null, error: "Opportunity not found", timestamp: new Date().toISOString() });
  if (item.ownerId !== user.id && !STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "የራስዎን እድል ብቻ ማስወገድ ይችላሉ።", timestamp: new Date().toISOString() });
  await db.opportunity.update({ where: { id: item.id }, data: { active: false } });
  res.json({ success: true, data: { closed: true }, error: null, timestamp: new Date().toISOString() });
});

// --- Direct message recall + reporting (DirectMessageReport model had no entry point) ------
app.delete("/api/messages/:messageId", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const message = await db.directMessage.findUnique({ where: { id: String(req.params.messageId) }, select: { id: true, senderId: true, conversationId: true } });
  if (!message) return res.status(404).json({ success: false, data: null, error: "Message not found", timestamp: new Date().toISOString() });
  if (message.senderId !== userId) return res.status(403).json({ success: false, data: null, error: "የራስዎን መልዕክት ብቻ ማስወገድ ይችላሉ።", timestamp: new Date().toISOString() });
  const windowHours = Number(await getSetting("dm_recall_window_hours", "24"));
  const createdAt = await db.directMessage.findUnique({ where: { id: message.id }, select: { createdAt: true } });
  if (createdAt && Number.isFinite(windowHours) && windowHours > 0 && Date.now() - createdAt.createdAt.getTime() > windowHours * 3_600_000) {
    return res.status(400).json({ success: false, data: null, error: "የማስወገጃ ጊዜው አልፏል።", timestamp: new Date().toISOString() });
  }
  await db.directMessage.delete({ where: { id: message.id } });
  publishRealtime(userId, { type: "message_deleted", data: { messageId: message.id, conversationId: message.conversationId } });
  res.json({ success: true, data: { deleted: true }, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/messages/:messageId/report", telegramAuth, async (req: Request, res: Response) => {
  const reporterId = res.locals.telegramUser.id;
  const reason = typeof req.body?.reason === "string" && REPORT_REASONS.includes(req.body.reason as typeof REPORT_REASONS[number]) ? req.body.reason : "OTHER";
  const details = typeof req.body?.details === "string" ? req.body.details.normalize("NFKC").trim().slice(0, 500) : undefined;
  const message = await db.directMessage.findUnique({ where: { id: String(req.params.messageId) }, select: { id: true, recipientId: true, body: true } });
  if (!message) return res.status(404).json({ success: false, data: null, error: "Message not found", timestamp: new Date().toISOString() });
  if (message.recipientId !== reporterId) return res.status(403).json({ success: false, data: null, error: "የተላከልዎ መልዕክት ብቻ ሪፖርት ማድረግ ይችላሉ።", timestamp: new Date().toISOString() });
  const existing = await db.directMessageReport.findFirst({ where: { messageId: message.id, reporterId, status: "OPEN" }, select: { id: true, status: true } });
  if (existing) return res.json({ success: true, data: { id: existing.id, status: existing.status }, error: null, timestamp: new Date().toISOString() });
  const report = await db.directMessageReport.create({ data: { messageId: message.id, reporterId, reportedId: message.recipientId === reporterId ? await otherPartyOf(message.id, reporterId) : reporterId, reason, ...(details ? { details } : {}) } });
  res.status(201).json({ success: true, data: { id: report.id, status: report.status }, error: null, timestamp: new Date().toISOString() });
});

async function otherPartyOf(messageId: string, reporterId: string): Promise<string> {
  const msg = await db.directMessage.findUnique({ where: { id: messageId }, select: { senderId: true } });
  return msg?.senderId ?? reporterId;
}

app.get("/api/admin/dm-reports", adminAuth, async (_req: Request, res: Response) => {
  const reports = await db.directMessageReport.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" }, take: 100, include: { message: { select: { body: true, createdAt: true } }, reporter: { select: { id: true, firstName: true, username: true } }, reported: { select: { id: true, firstName: true, username: true } } } });
  res.json({ success: true, data: reports, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/admin/dm-reports/:id/resolve", adminAuth, moderatorSessionAuth, async (req: Request, res: Response) => {
  const moderator = res.locals.moderator;
  const action = req.body?.action === "DISMISS" ? "DISMISSED" : req.body?.action === "BAN" ? "BAN" : null;
  if (!action) return res.status(400).json({ success: false, data: null, error: "Invalid action", timestamp: new Date().toISOString() });
  const report = await db.directMessageReport.findUnique({ where: { id: String(req.params.id) }, select: { id: true, reportedId: true, status: true } });
  if (!report || report.status !== "OPEN") return res.status(404).json({ success: false, data: null, error: "Report not found", timestamp: new Date().toISOString() });
  if (action === "BAN") await db.user.update({ where: { id: report.reportedId }, data: { blocked: true } });
  await db.directMessageReport.update({ where: { id: report.id }, data: { status: action, resolvedBy: moderator.id, resolvedAt: new Date() } });
  res.json({ success: true, data: { status: action }, error: null, timestamp: new Date().toISOString() });
});

// --- Comment moderation (moderators could not remove a single comment) ---------------------
app.delete("/api/comments/:id", telegramAuth, async (req: Request, res: Response) => {
  const user = res.locals.telegramUser;
  if (!STAFF_ROLES.includes(user.role)) return res.status(403).json({ success: false, data: null, error: "Administrator access required", timestamp: new Date().toISOString() });
  const comment = await db.postComment.findUnique({ where: { id: String(req.params.id) }, select: { id: true, userId: true, postId: true } });
  if (!comment) return res.status(404).json({ success: false, data: null, error: "Comment not found", timestamp: new Date().toISOString() });
  await db.postComment.update({ where: { id: comment.id }, data: { status: "REMOVED" } });
  await db.moderationEvent.create({ data: { targetUserId: comment.userId, moderatorId: user.id, category: "COMMENT_REMOVED", action: "REJECT", reason: "Moderator removed comment", evidence: comment.postId } }).catch(() => undefined);
  res.json({ success: true, data: { removed: true }, error: null, timestamp: new Date().toISOString() });
});

// --- User reporting (users could report posts, never each other) ---------------------------
app.post("/api/users/:id/report", telegramAuth, async (req: Request, res: Response) => {
  const reporterId = res.locals.telegramUser.id;
  const reportedId = String(req.params.id);
  if (reporterId === reportedId) return res.status(400).json({ success: false, data: null, error: "Cannot report yourself", timestamp: new Date().toISOString() });
  const reason = typeof req.body?.reason === "string" && REPORT_REASONS.includes(req.body.reason as typeof REPORT_REASONS[number]) ? req.body.reason : "OTHER";
  const details = typeof req.body?.details === "string" ? req.body.details.normalize("NFKC").trim().slice(0, 500) : undefined;
  const target = await db.user.findUnique({ where: { id: reportedId }, select: { id: true } });
  if (!target) return res.status(404).json({ success: false, data: null, error: "User not found", timestamp: new Date().toISOString() });
  const event = await db.moderationEvent.create({ data: { targetUserId: reportedId, moderatorId: reporterId, category: `USER_REPORT_${reason}`, action: "QUARANTINE", reason: details ?? reason, evidence: details ?? null } });
  res.status(201).json({ success: true, data: { id: event.id }, error: null, timestamp: new Date().toISOString() });
});

// --- Wallet statement filters (the ledger grew fast; clients needed scoping) ---------------
app.get("/api/me/wallet", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const wallet = await ensureWallet(userId);
  const scope = req.query.scope === "spend" || req.query.scope === "earn" ? String(req.query.scope) : "all";
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "25"), 10) || 25));
  const where = { userId, ...(scope === "earn" ? { amount: { gt: 0 } } : scope === "spend" ? { amount: { lt: 0 } } : {}) };
  const [items, earned, spent] = await Promise.all([
    db.walletTransaction.findMany({ where, orderBy: { createdAt: "desc" }, take: limit }),
    db.walletTransaction.aggregate({ where: { userId, amount: { gt: 0 } }, _sum: { amount: true } }),
    db.walletTransaction.aggregate({ where: { userId, amount: { lt: 0 } }, _sum: { amount: true } })
  ]);
  res.json({ success: true, data: { balance: wallet.balance, scope, earned: earned._sum.amount ?? 0, spent: Math.abs(spent._sum.amount ?? 0), items }, error: null, timestamp: new Date().toISOString() });
});

// --- Referral roster (growth tab showed counts only, never who) -----------------------------
app.get("/api/me/referrals", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id;
  const limit = Math.min(50, Math.max(1, Number.parseInt(String(req.query.limit ?? "25"), 10) || 25));
  const rows = await db.referral.findMany({ where: { inviterId: userId }, orderBy: { createdAt: "desc" }, take: limit, include: { invitee: { select: { id: true, firstName: true, username: true, xp: true, level: true } } } });
  const total = await db.referral.count({ where: { inviterId: userId } });
  res.json({ success: true, data: { items: rows.map(r => ({ id: r.id, invitedAt: r.createdAt, rewardCoins: r.inviterReward, invitee: r.invitee })), total, lifetimeRewardCoins: rows.reduce((n, r) => n + r.inviterReward, 0) }, error: null, timestamp: new Date().toISOString() });
});

// --- Runtime settings (Setting table was dead schema; admins now tune the economy live) ----
const SETTING_KEYS = ["dm_recall_window_hours", "earn_daily_limit", "referral_reward_coins", "subscription_grace_hours"] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

async function getSettingsSnapshot(): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const key of SETTING_KEYS) values[key] = await getSetting(key, DEFAULT_SETTINGS[key] ?? "");
  return values;
}

app.get("/api/admin/settings", adminAuth, async (_req: Request, res: Response) => {
  res.json({ success: true, data: await getSettingsSnapshot(), error: null, timestamp: new Date().toISOString() });
});

app.put("/api/admin/settings", adminAuth, async (req: Request, res: Response) => {
  const updates: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const raw = req.body?.[key];
    if (raw === undefined) continue;
    const value = String(raw).trim();
    if (!/^\d{1,6}$/.test(value)) return res.status(400).json({ success: false, data: null, error: `Settings must be positive integers (${key})`, timestamp: new Date().toISOString() });
    updates[key] = value;
  }
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, data: null, error: "Nothing to update", timestamp: new Date().toISOString() });
  for (const [key, value] of Object.entries(updates)) await setSetting(key, value);
  const values: Record<string, string> = {};
  for (const key of SETTING_KEYS) values[key] = await getSetting(key, DEFAULT_SETTINGS[key as SettingKey] ?? "");
  res.json({ success: true, data: values, error: null, timestamp: new Date().toISOString() });
});

app.post("/api/posts/:id/repost", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id; const post = await db.post.findUnique({ where: { id: String(req.params.id) }, select: { id: true, authorId: true, publishedAt: true, title: true } });
  if (!post || !post.publishedAt) return res.status(404).json({ success: false, data: null, error: "Post not found", timestamp: new Date().toISOString() });
  if (post.authorId === userId) return res.status(400).json({ success: false, data: null, error: "Cannot repost your own post", timestamp: new Date().toISOString() });
  const existing = await db.postRepost.findUnique({ where: { postId_userId: { postId: post.id, userId } } });
  if (existing) { await db.postRepost.delete({ where: { id: existing.id } }); res.json({ success: true, data: { reposted: false, count: await db.postRepost.count({ where: { postId: post.id } }) }, error: null, timestamp: new Date().toISOString() }); return; }
  await db.postRepost.create({ data: { postId: post.id, userId } });
  await db.notification.create({ data: { userId: post.authorId, type: "REPOST", title: "🔁 ልጥፍዎ ተደግሟል", body: "አንድ ተጠቃሚ ልጥፍዎን አጋርቷል።", postId: post.id, actorId: userId } });
  res.json({ success: true, data: { reposted: true, count: await db.postRepost.count({ where: { postId: post.id } }) }, error: null, timestamp: new Date().toISOString() });
});

app.get("/api/posts/:id/repost", telegramAuth, async (req: Request, res: Response) => {
  const userId = res.locals.telegramUser.id; const [reposted, count] = await Promise.all([db.postRepost.findUnique({ where: { postId_userId: { postId: String(req.params.id), userId } } }), db.postRepost.count({ where: { postId: String(req.params.id) } })]);
  res.json({ success: true, data: { reposted: !!reposted, count }, error: null, timestamp: new Date().toISOString() });
});

const server = app.listen(env.PORT, () => logger.info("GENZI API listening", { port: env.PORT, mode: env.BOT_MODE, environment: env.NODE_ENV }));

async function startTelegram(): Promise<void> {
  if (env.BOT_MODE === "webhook") {
    if (!env.BOT_WEBHOOK_URL || !env.BOT_WEBHOOK_SECRET) throw new Error("Webhook configuration is incomplete");
    app.post(env.BOT_WEBHOOK_PATH, webhookCallback(bot, "express", { secretToken: env.BOT_WEBHOOK_SECRET }));
    await bot.api.setWebhook(`${env.BOT_WEBHOOK_URL.replace(/\/$/, "")}${env.BOT_WEBHOOK_PATH}`, { secret_token: env.BOT_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query", "chat_member", "my_chat_member"] });
    logger.info("GENZI Telegram bot webhook configured", { path: env.BOT_WEBHOOK_PATH });
    return;
  }
  await bot.start({ onStart: () => logger.info("GENZI Telegram bot started", { mode: "polling" }) });
}

void startTelegram().catch((error: unknown) => {
  logger.error("Telegram bot startup failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Shutdown requested", { signal });
  const forceTimer = setTimeout(() => process.exit(1), env.SHUTDOWN_TIMEOUT_MS);
  forceTimer.unref();
  try {
    if (env.BOT_MODE === "polling") bot.stop();
    else await bot.api.deleteWebhook({ drop_pending_updates: false });
    await db.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    logger.info("Shutdown complete");
    process.exit(0);
  } catch (error) {
    logger.error("Shutdown failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));