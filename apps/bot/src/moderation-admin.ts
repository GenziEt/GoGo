import type { Bot } from "grammy";
import { db } from "./db.js";
import { env } from "./config.js";
import { createModeratorLoginCode } from "./api-auth.js";

async function resolveTarget(arg: string) {
  const clean = arg.trim().replace(/^@/, "");
  if (!clean) return null;
  if (/^\d+$/.test(clean)) return db.user.findUnique({ where: { telegramId: clean } });
  return db.user.findFirst({ where: { username: clean } });
}

export function registerAdmin(bot: Bot): void {
  bot.command("admin", async (ctx) => {
    if (!ctx.from) return;
    const user = await db.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!user || (user.role !== "OWNER" && user.role !== "MODERATOR")) {
      await ctx.reply("⛔ ፍቃድ የለዎትም።");
      return;
    }

    const pending = await db.submission.count({ where: { state: "QUARANTINED" } });
    const users = await db.user.count();
    const posts = await db.post.count();
    await ctx.reply([
      "🛡️ GENZI አስተዳደር",
      "",
      `👥 ተጠቃሚዎች: ${users}`,
      `📝 የታተሙ ፖስቶች: ${posts}`,
      `⚠️ በግምገማ ላይ: ${pending}`,
      "",
      `👑 ባለቤት: ${env.TELEGRAM_OWNER_ID}`,
      "",
      "🔐 ወደ አድሚን ፓነል ለመግባት /moderatorlogin ይላኩ።"
    ].join("\n"));
  });

  bot.command("moderators", async (ctx) => {
    if (!ctx.from) return;
    const user = await db.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!user || user.role !== "OWNER") {
      await ctx.reply("⛔ የባለቤት ፍቃድ ብቻ።");
      return;
    }
    const mods = await db.user.findMany({ where: { role: "MODERATOR" }, take: 30 });
    await ctx.reply(mods.length
      ? mods.map((m) => `🛡️ ${m.firstName ?? ""} — ${m.telegramId}${m.username ? " (@" + m.username + ")" : ""}`).join("\n")
      : "ምንም moderator የለም። /promote <telegram_id ወይም @username> ይጠቀሙ።");
  });

  bot.command("promote", async (ctx) => {
    if (!ctx.from) return;
    const actor = await db.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!actor || actor.role !== "OWNER") {
      await ctx.reply("⛔ የባለቤት ፍቃድ ብቻ።");
      return;
    }
    const arg = (ctx.match as string | undefined)?.toString() ?? "";
    const target = await resolveTarget(arg);
    if (!target) {
      await ctx.reply("Usage: /promote <telegram_id ወይም @username>\n\nተጠቃሚው ቦቱን አስቀድሞ መጀመር አለበት (/start)።");
      return;
    }
    if (target.role === "OWNER") {
      await ctx.reply("⛔ የባለቤት ሚና ሊቀየር አይችልም።");
      return;
    }
    if (target.role === "MODERATOR") {
      await ctx.reply("ℹ️ ይህ ተጠቃሚ አስቀድሞ Moderator ነው።");
      return;
    }
    await db.user.update({ where: { id: target.id }, data: { role: "MODERATOR" } });
    await ctx.reply(`✅ ${target.firstName ?? target.username ?? target.telegramId} አሁን GENZI Moderator ናቸው። /moderatorlogin ልከው ወደ አድሚን ፓነል መግባት ይችላሉ።`);
    try { await bot.api.sendMessage(Number(target.telegramId), "🛡️ እንኳን ደስ አለዎት! አሁን የGENZI Moderator ሆነዋል። ወደ አድሚን ፓነል ለመግባት /moderatorlogin ይላኩ።"); } catch { /* user may have blocked the bot */ }
  });

  bot.command("demote", async (ctx) => {
    if (!ctx.from) return;
    const actor = await db.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!actor || actor.role !== "OWNER") {
      await ctx.reply("⛔ የባለቤት ፍቃድ ብቻ።");
      return;
    }
    const arg = (ctx.match as string | undefined)?.toString() ?? "";
    const target = await resolveTarget(arg);
    if (!target) {
      await ctx.reply("Usage: /demote <telegram_id ወይም @username>");
      return;
    }
    if (target.role === "OWNER") {
      await ctx.reply("⛔ የባለቤት ሚና ሊቀየር አይችልም።");
      return;
    }
    if (target.role === "USER") {
      await ctx.reply("ℹ️ ይህ ተጠቃሚ Moderator አይደለም።");
      return;
    }
    await db.user.update({ where: { id: target.id }, data: { role: "USER" } });
    await ctx.reply(`✅ ${target.firstName ?? target.username ?? target.telegramId} ከMderator ሚና ተነስተዋል።`);
  });

  bot.command("moderatorlogin", async (ctx) => {
    if (!ctx.from) return;
    const user = await db.user.findUnique({ where: { telegramId: String(ctx.from.id) } });
    if (!user || (user.role !== "OWNER" && user.role !== "MODERATOR")) {
      await ctx.reply("⛔ ፍቃድ የለዎትም።");
      return;
    }
    const { code, expiresAt } = createModeratorLoginCode(user.id);
    const minutes = Math.round((expiresAt.getTime() - Date.now()) / 60000);
    await ctx.reply([
      "🔐 የአድሚን ፓነል መግቢያ ኮድ፦",
      "",
      `\`${code}\``,
      "",
      `ይህ ኮድ ${minutes} ደቂቃ ውስጥ ያበቃል እና አንድ ጊዜ ብቻ ይሰራል።`,
      "በአድሚን ፓነል ውስጥ ከAdmin API Key ጎን ያስገቡት።"
    ].join("\n"), { parse_mode: "Markdown" });
  });
}