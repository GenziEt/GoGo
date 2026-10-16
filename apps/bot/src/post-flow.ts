import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { db } from "./db.js";
import { normalizePost } from "./normalizer.js";
import { moderateText } from "./moderation.js";
import { moderateAndEnforce } from "./safety.js";
import { lockPost } from "./post-schema.js";
import { categoryKeyboard, previewKeyboard } from "./ui.js";
import { categories } from "./categories.js";
import { t, type Locale } from "./i18n.js";
import { getSession, setSession, clearSession, abandonOpenWork, isTextInputStep, isSkipAllowedStep, setPreferCard } from "./session-store.js";
import { publishToChannel, deleteChannelMessage, requiredFactFieldsFor } from "./telegram-publisher.js";
import { buildChannelCaption, buildChannelButtons, parsePlatformLink, attachChannelButtons, withButtonStyle } from "./post-buttons.js";
import { isStructuralLayout, themeFor, factDefaults, missingFactFieldsAfterDefaults, type FactFieldSpec } from "./post-theme.js";
import { renderCard } from "./card-renderer.js";
import { InputFile } from "grammy";
import { logger } from "./logger.js";

/**
 * Convert a Prisma `Locale` enum value ("AMHARIC" | "ENGLISH") into the
 * bot's i18n locale ("am" | "en").
 */
function toI18nLocale(prismaLocale: string | null | undefined): Locale {
  return prismaLocale === "ENGLISH" ? "en" : "am";
}

const isPrivate = (ctx: Context): boolean => ctx.chat?.type === "private";

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Hashtags typed in the body become the post's tags (the wizard has no separate tag step).
function extractTags(body: string): string[] {
  const found = body.match(/#[\p{L}\p{N}_]{2,30}/gu) ?? [];
  return [...new Set(found.map((x) => x.slice(1)))].slice(0, 8);
}

// --- Structured fact-block wizard steps (Phase 1.1 / Phase 5 enforcement) --------------
// Structural categories (money / events / ai-tech) collect their fact fields as explicit
// wizard answers instead of free-typed captions. The required-field set and the sensible
// defaults both come from post-theme.ts, so the questions asked here and the publish gate
// in telegram-publisher.ts can never disagree.

type FactValues = Record<string, string>;

// --- Phase 2: author's card choice ("use mine" vs "use GENZI card") ---------
// Persisted on the Session row (see session-store.ts setPreferCard) — NOT inside
// factsJson, which must stay pure fact values for the publish gate and renderer.
// "use mine" is the default when the author never taps the choice row.

/** Author-entered fact values only (no defaults merged). Corrupted JSON reads as empty. */
function parseFacts(raw: string | null | undefined): FactValues {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: FactValues = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    /* corrupted factsJson is treated as empty — the gate will simply re-ask */
  }
  return {};
}

function labelForField(field: FactFieldSpec, locale: Locale): string {
  return locale === "am" ? field.labelAm : field.labelEn;
}

/** Effective values = theme defaults (author's link fills How/Tickets/Source) + author answers. */
function effectiveFacts(category: string, submission: { factsJson: string | null; linkUrl: string | null }): FactValues {
  return { ...factDefaults(category, { linkUrl: submission.linkUrl }), ...parseFacts(submission.factsJson) };
}

/**
 * Render the "facts" review screen: one row per required field showing its current
 * value (or a Missing marker), plus a Done button that is enabled only when every
 * required field is filled. Tapping a field row opens its "fact:<key>" input sub-step.
 */
async function sendFactsReview(ctx: Context, category: string, submissionId: string, locale: Locale): Promise<void> {
  const submission = await db.submission.findUniqueOrThrow({ where: { id: submissionId } });
  const theme = themeFor(category);
  const fields = requiredFactFieldsFor(category);
  const merged = effectiveFacts(category, submission);
  const keyboard = new InlineKeyboard();
  for (const field of fields) {
    const value = merged[field.key]?.trim();
    const status = value ? `${t(locale, "factFilled")} · ${value.slice(0, 40)}` : t(locale, "factMissing");
    keyboard.text(`${field.anchor} ${labelForField(field, locale)}: ${status}`, `factedit:${category}:${field.key}`).row();
  }
  const stillMissing = missingFactFieldsAfterDefaults(category, merged, { linkUrl: submission.linkUrl });
  if (stillMissing.length === 0) keyboard.text(t(locale, "factDone"), `factsdone:${category}`);
  const lines = fields.map((f) => `${f.anchor} ${labelForField(f, locale)}`).join("\n");
  await ctx.reply(`${t(locale, "factsIntro")}\n\n${theme.emoji} ${lines}`, { reply_markup: keyboard });
}

/**
 * Moderate + persist one fact answer, then return to the facts review screen.
 * Shared by the "fact:<key>" text-input step and the /skip command on that step.
 */
async function saveFactAnswer(
  ctx: Context,
  user: Awaited<ReturnType<typeof getUser>>,
  submissionId: string,
  category: string,
  key: string,
  value: string | null,
  locale: Locale,
): Promise<void> {
  const staff = user.role !== "USER";
  if (value !== null) {
    const check = moderateText(value, { isAdmin: staff, isForwarded: false });
    if (check.decision === "BAN" || check.decision === "REJECT") {
      await moderateAndEnforce(user.id, staff, [value]);
      await ctx.reply(check.category === "LINK" ? t(locale, "linkDenied") : t(locale, "rejected"));
      return;
    }
  }
  const submission = await db.submission.findUnique({ where: { id: submissionId } });
  const facts = parseFacts(submission?.factsJson);
  if (value === null) delete facts[key];
  else facts[key] = value.trim();
  await db.submission.update({ where: { id: submissionId }, data: { factsJson: JSON.stringify(facts) } });
  await setSession(ctx.from!.id, submissionId, "facts", locale);
  await sendFactsReview(ctx, category, submissionId, locale);
}

/**
 * The single finalize path for a wizard post: normalize → moderate → either reject,
 * quarantine, or move to PREVIEW and show it. Structural categories reach here only
 * after their fact fields are complete (the facts step gates them); legacy callers
 * arrive directly from the category step.
 */
async function finalizeToPreview(
  ctx: Context,
  user: Awaited<ReturnType<typeof getUser>>,
  submission: { id: string; title: string; body: string; linkUrl: string | null; linkPlatform: string | null; mediaType: string | null; mediaFileId: string | null; factsJson: string | null },
  categoryKey: string,
  locale: Locale,
): Promise<void> {
  const facts = effectiveFacts(categoryKey, submission);
  const normalized = normalizePost({
    title: submission.title,
    body: submission.body,
    category: categoryKey,
    tags: extractTags(submission.body),
    ...(facts.location ? { location: facts.location } : {}),
    ...(submission.linkUrl ? { link: submission.linkUrl } : {}),
    ...(submission.linkPlatform ? { linkPlatform: submission.linkPlatform } : {}),
    ...(submission.mediaType ? { mediaType: submission.mediaType } : {}),
    ...(submission.mediaFileId ? { mediaFileId: submission.mediaFileId } : {}),
  });
  // One consolidated check on the final text; this also logs the event / applies ban or restriction.
  const moderation = await moderateAndEnforce(user.id, user.role !== "USER", [normalized.title, normalized.body]);
  const common = { category: categoryKey, normalizedJson: JSON.stringify(normalized), moderationJson: JSON.stringify(moderation) };

  if (moderation.decision === "BAN" || moderation.decision === "REJECT") {
    await db.submission.update({ where: { id: submission.id }, data: { ...common, state: "REJECTED" } });
    await clearSession(ctx.from!.id);
    await ctx.reply(moderation.category === "LINK" ? t(locale, "linkDenied") : t(locale, "rejected"));
    return;
  }
  if (moderation.decision === "QUARANTINE") {
    // Goes to the moderator queue; the user is told so (previously they were shown an Approve
    // button that answered "Not ready." with no explanation).
    await db.submission.update({ where: { id: submission.id }, data: { ...common, state: "QUARANTINED" } });
    await clearSession(ctx.from!.id);
    await ctx.reply(t(locale, "quarantined"));
    return;
  }
  await db.submission.update({ where: { id: submission.id }, data: { ...common, state: "PREVIEW" } });
  await setSession(ctx.from!.id, submission.id, "preview", locale);
  await sendPreview(ctx, normalized, locale, {
    slug: normalized.slug,
    author: user.firstName ?? "GENZI",
    linkUrl: submission.linkUrl,
    linkPlatform: submission.linkPlatform,
    factValues: facts,
  });
}

export async function getUser(ctx: Context) {
  const from = ctx.from;
  if (!from) throw new Error("Missing Telegram user");
  return db.user.upsert({
    where: { telegramId: String(from.id) },
    update: {
      ...(from.username !== undefined ? { username: from.username } : {}),
      firstName: from.first_name,
      ...(from.last_name !== undefined ? { lastName: from.last_name } : {}),
    },
    create: {
      telegramId: String(from.id),
      ...(from.username !== undefined ? { username: from.username } : {}),
      firstName: from.first_name,
      ...(from.last_name !== undefined ? { lastName: from.last_name } : {}),
    },
  });
}

type Normalized = ReturnType<typeof normalizePost>;

// Preview context carried from the category step to sendPreview so the private preview shows
// exactly what goes live (WYSIWYG): the premium caption with the dated footer AND the same
// button rows the published channel post will carry (link hero + Read More/Share/Discuss).
interface PreviewContext {
  slug: string;
  author: string;
  linkUrl?: string | null;
  linkPlatform?: string | null;
  // Structured fact values (effective = theme defaults + wizard answers) so the
  // private preview renders the exact anchored rows that will go live (WYSIWYG).
  factValues?: Record<string, string | undefined>;
  // Submission id — lets the preview attach the Phase 2 card-choice buttons
  // ("use mine" vs "use GENZI card") when the author supplied media.
  submissionId?: string;
}

// HTML preview (the old Markdown preview was rejected by Telegram whenever the user's text
// contained _ * [ or `, leaving them with no preview). The body is clipped so the FULL premium
// caption (header + tags/location + "👤 Author · 📅 date" footer) fits the limit of the message
// type that will carry it (1024 for a media caption, 4096 for text).
function buildPreview(post: Normalized, locale: Locale, ctxInfo: PreviewContext, limit: number): string {
  const render = (body: string) => buildChannelCaption({
    title: post.title,
    body,
    tags: post.tags,
    author: ctxInfo.author,
    readingMinutes: post.readingMinutes,
    publishedAt: new Date(),
    ...(post.location ? { location: post.location } : {}),
    category: post.category,
    locale,
    ...(ctxInfo.factValues ? { factValues: ctxInfo.factValues } : {}),
    escapeHtml,
  });
  let caption = render(post.body);
  if (caption.length > limit) {
    // Trim the body until the whole formatted caption (footer included) fits.
    const room = Math.max(0, post.body.length - (caption.length - limit) - 8);
    caption = render(post.body.slice(0, room).trimEnd() + "…");
  }
  return caption;
}

async function sendPreview(
  ctx: Context,
  post: Normalized,
  locale: Locale,
  ctxInfo: PreviewContext,
  preferCard = false,
): Promise<void> {
  // Channel-style buttons under the preview (messageId: null — Share falls back to the Mini App
  // deep link until the real channel message id exists after publishing). The approval actions
  // are callback buttons, so they live on their own rows BELOW the URL-type channel rows
  // (never mixed in the same row).
  const channelButtons = buildChannelButtons({
    slug: ctxInfo.slug,
    messageId: null,
    chatId: null,
    linkUrl: ctxInfo.linkUrl ?? null,
    linkPlatform: ctxInfo.linkPlatform ?? null,
    locale,
  });
  // Approve is green (success) and Cancel red (danger) — Bot API 9.4 button styles (private chat only).
  const keyboard = channelButtons
    ? withButtonStyle(
        withButtonStyle(channelButtons.text(t(locale, "approve"), "publish_preview"), "success").row()
          .text(t(locale, "edit"), "edit_preview")
          .text(t(locale, "saveDraft"), "save_draft").row()
          .text(t(locale, "cancel"), "cancel"),
        "danger",
      )
    : previewKeyboard(locale);
  // Phase 2 (plan §2.3): the author attached an IMAGE → they choose between their
  // own media and a generated GENZI card. The choice row sits directly above the
  // action rows; "use mine" is the default when untouched. Videos are never
  // offered for replacement — the video IS the content.
  const hasImage = post.mediaType === "image" && Boolean(post.mediaFileId) && Boolean(ctxInfo.submissionId);
  const useCard = hasImage && parseCardChoice(await peekFactsJson(ctxInfo.submissionId as string));
  if (hasImage) {
    const choiceRow = new InlineKeyboard()
      .text(useCard ? "🟢 🖼️ Use GENZI card" : "⚪ 🖼️ Use GENZI card", `cardchoice:${ctxInfo.submissionId}:genzi`)
      .text(!useCard ? "🟢 📷 Use mine" : "⚪ 📷 Use mine", `cardchoice:${ctxInfo.submissionId}:mine`);
    keyboard.insertBeforeRow?.(choiceRow.build());
  }
  try {
    if (post.mediaType === "image" && post.mediaFileId) {
      await ctx.replyWithPhoto(useCard ? (await cardPreviewBuffer(ctxInfo, post)) ?? post.mediaFileId : post.mediaFileId, { caption: buildPreview(post, locale, ctxInfo, 1000), parse_mode: "HTML", reply_markup: keyboard });
    } else if (post.mediaType === "video" && post.mediaFileId) {
      await ctx.replyWithVideo(post.mediaFileId, { caption: buildPreview(post, locale, ctxInfo, 1000), parse_mode: "HTML", reply_markup: keyboard });
    } else {
      await ctx.reply(buildPreview(post, locale, ctxInfo, 3800), { parse_mode: "HTML", reply_markup: keyboard });
    }
  } catch (error) {
    logger.warn("post preview send failed, falling back to plain text", { error: String(error) });
    // The fallback must not reuse the channel-style keyboard: if that keyboard is what Telegram
    // rejected, the fallback would fail too and the user would get no preview and no buttons.
    await ctx.reply(`${post.title}\n\n${post.body.slice(0, 3000)}`, { reply_markup: previewKeyboard(locale) });
  }
}

export function registerPostFlow(bot: Bot): void {
  bot.callbackQuery("create_post", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    await abandonOpenWork(user.id);
    const submission = await db.submission.create({
      data: {
        telegramChatId: String(ctx.chat?.id ?? ctx.from.id),
        telegramUserId: String(ctx.from.id),
        userId: user.id,
        state: "INPUT",
      },
    });
    await setSession(ctx.from.id, submission.id, "title", locale);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(locale, "titlePrompt"));
  });

  // /cancel works at any step of the post or confession wizard (it was advertised in /help but
  // never registered for posts, so "/cancel" was saved as the post title).
  bot.command("cancel", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const session = await getSession(ctx.from.id);
    if (session?.submissionId)
      await db.submission.updateMany({ where: { id: session.submissionId, state: { in: ["INPUT", "PREVIEW"] } }, data: { state: "REJECTED" } });
    if (session?.confessionId)
      await db.confession.updateMany({ where: { id: session.confessionId, state: { in: ["INPUT", "PREVIEW"] } }, data: { state: "REJECTED" } });
    await clearSession(ctx.from.id);
    await ctx.reply(t(locale, "cancelled"));
  });

  bot.command("drafts", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return;
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const drafts = await db.submission.findMany({
      where: { userId: user.id, state: "DRAFT", normalizedJson: { not: null } },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, title: true },
    });
    if (!drafts.length) {
      await ctx.reply(t(locale, "draftsEmpty"));
      return;
    }
    const keyboard = new InlineKeyboard();
    for (const draft of drafts) keyboard.text(`📝 ${(draft.title ?? "—").slice(0, 40)}`, `resume_draft:${draft.id}`).row();
    await ctx.reply(t(locale, "draftsTitle"), { reply_markup: keyboard });
  });

  bot.callbackQuery(/^resume_draft:(.+)$/, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const id = ctx.match[1];
    const draft = id ? await db.submission.findUnique({ where: { id } }) : null;
    if (!draft || draft.userId !== user.id || draft.state !== "DRAFT" || !draft.normalizedJson)
      return ctx.answerCallbackQuery(t(locale, "draftNotFound"));
    await abandonOpenWork(user.id);
    await db.submission.update({ where: { id: draft.id }, data: { state: "PREVIEW" } });
    await setSession(ctx.from.id, draft.id, "preview", locale);
    await ctx.answerCallbackQuery();
    const normalized = JSON.parse(draft.normalizedJson) as Normalized;
    await sendPreview(ctx, normalized, locale, {
      slug: normalized.slug,
      author: user.firstName ?? "GENZI",
      linkUrl: draft.linkUrl,
      linkPlatform: draft.linkPlatform,
      factValues: effectiveFacts(normalized.category, draft),
    });
  });

  bot.callbackQuery(/^cat:(.+)$/, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const session = await getSession(ctx.from.id);
    const submissionId = session?.submissionId;
    // Stale category buttons (from an old message) must not advance a flow that isn't at the category step.
    if (!session || !submissionId || session.step !== "category")
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    const key = ctx.match[1];
    if (!key || !categories.some((c) => c.key === key)) return ctx.answerCallbackQuery();
    const submission = await db.submission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.userId !== user.id || submission.state !== "INPUT" || !submission.title || !submission.body) {
      await clearSession(ctx.from.id);
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    }
    await ctx.answerCallbackQuery();

    // Narrow for the structural signature above (title/body checked non-null in the guard).
    const sub = submission as typeof submission & { title: string; body: string };
    // Structural categories (money / events / ai-tech) go through the facts step BEFORE the
    // preview — authors fill fields instead of free-typing, and a half-filled block can never
    // reach publish. Free-layout categories finalize straight away.
    if (isStructuralLayout(themeFor(key).layout)) {
      await db.submission.update({ where: { id: submission.id }, data: { category: key } });
      await setSession(ctx.from.id, submission.id, "facts", locale);
      await sendFactsReview(ctx, key, submission.id, locale);
      return;
    }
    await finalizeToPreview(ctx, user, sub, key, locale);
  });

  // Facts review screen: tap a field row → collect one answer as text ("fact:<key>" sub-step).
  bot.callbackQuery(/^factedit:([^:]+):([^:]+)$/, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const session = await getSession(ctx.from.id);
    const submissionId = session?.submissionId;
    if (!session || !submissionId || session.step !== "facts")
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    const [, category, key] = ctx.match as unknown as string[];
    const field = requiredFactFieldsFor(category!).find((f) => f.key === key);
    if (!field) return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    const submission = await db.submission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.userId !== user.id || submission.state !== "INPUT") {
      await clearSession(ctx.from.id);
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    }
    await ctx.answerCallbackQuery();
    // The step encodes BOTH field key and category so the text-input handler (which only
    // sees the session) can route the answer back to the right fact field.
    await setSession(ctx.from.id, submissionId, `fact:${category}:${key}`, locale);
    const current = effectiveFacts(category!, submission)[key!]?.trim();
    await ctx.reply(`${field.anchor} ${labelForField(field, locale)}${current ? `\n(${current.slice(0, 120)})` : ""}`);
  });

  // Facts review screen: Done is only rendered when every required field is filled, but a
  // stale button could still be tapped — re-check against the SAME theme computation here.
  bot.callbackQuery(/^factsdone:([^:]+)$/, async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const session = await getSession(ctx.from.id);
    const submissionId = session?.submissionId;
    if (!session || !submissionId || session.step !== "facts")
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    const category = ctx.match[1]!;
    const submission = await db.submission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.userId !== user.id || submission.state !== "INPUT" || !submission.title || !submission.body) {
      await clearSession(ctx.from.id);
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    }
    const missing = missingFactFieldsAfterDefaults(category, effectiveFacts(category, submission), { linkUrl: submission.linkUrl });
    if (missing.length > 0) {
      await ctx.answerCallbackQuery(`${t(locale, "factSkipNotice")} ${missing.join(", ")}`);
      return;
    }
    await ctx.answerCallbackQuery();
    const sub = submission as typeof submission & { title: string; body: string };
    await finalizeToPreview(ctx, user, sub, category, locale);
  });

  bot.callbackQuery("publish_preview", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const session = await getSession(ctx.from.id);
    const submissionId = session?.submissionId;
    if (!session || !submissionId || session.step !== "preview")
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));

    // Atomic claim: only one tap can move PREVIEW -> PREPARING, so a double-tap can no longer
    // publish the same post to the channel twice.
    const claim = await db.submission.updateMany({
      where: { id: submissionId, userId: user.id, state: "PREVIEW" },
      data: { state: "PREPARING" },
    });
    if (claim.count === 0) return ctx.answerCallbackQuery(t(locale, "notReady"));

    const revert = () => db.submission.updateMany({ where: { id: submissionId, state: "PREPARING" }, data: { state: "PREVIEW" } });
    const submission = await db.submission.findUniqueOrThrow({ where: { id: submissionId } });
    const normalized = JSON.parse(submission.normalizedJson ?? "{}") as Normalized;
    if (!normalized.title || !normalized.body) {
      await db.submission.update({ where: { id: submissionId }, data: { state: "REJECTED" } });
      await clearSession(ctx.from.id);
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    }
    const author = user.firstName ?? "GENZI";
    const locked = lockPost(normalized, author);
    const linkUrl = submission.linkUrl ?? locked.metadata.link ?? null;
    const linkPlatform = submission.linkPlatform ?? locked.metadata.linkPlatform ?? null;
    // Phase 2 card identity: the slug is deterministic BEFORE the Post row exists
    // (same formula as db.post.create below), so the branded card can be generated
    // and attached during publication itself. Cached by this exact slug.
    const cardSlug = `${locked.metadata.slug}-${Date.now()}`;
    let telegramPublication: { chatId: string; messageId: number };
    try {
      telegramPublication = await publishToChannel(bot, {
        title: locked.title,
        body: locked.body,
        tags: locked.tags,
        author,
        ...(locked.media.type ? { mediaType: locked.media.type } : {}),
        ...(locked.media.fileId ? { mediaFileId: locked.media.fileId } : {}),
        ...(locked.metadata.location ? { location: locked.metadata.location } : {}),
        category: locked.metadata.category,
        readingMinutes: locked.metadata.readingMinutes,
        // Same values the facts step collected — the gate in publishToChannel re-verifies
        // them against post-theme.ts before anything reaches the channel.
        factValues: parseFacts(submission.factsJson),
        linkUrl,
        // Branded card controls (plan §2.3): no media → card is generated and attached;
        // media present → author's stored choice decides ("use mine" wins unless preferCard).
        cardSlug,
        preferCard: session?.preferCard === true,
        locale: locale === "AMHARIC" ? "am" : "en",
      });
    } catch (error) {
      logger.error("GENZI channel publication failed", { error: String(error) });
      await revert();
      return ctx.answerCallbackQuery(t(locale, "publishFailed"));
    }
    let post;
    try {
      post = await db.post.create({
        data: {
          slug: `${locked.metadata.slug}-${Date.now()}`,
          title: locked.title,
          body: locked.body,
          excerpt: locked.metadata.excerpt,
          category: locked.metadata.category,
          tagsJson: JSON.stringify(locked.tags),
          ...(locked.media.type !== null && locked.media.type !== undefined ? { mediaType: locked.media.type } : {}),
          ...(locked.media.fileId !== null && locked.media.fileId !== undefined ? { mediaFileId: locked.media.fileId } : {}),
          ...(locked.media.aspectRatio !== undefined ? { mediaAspect: locked.media.aspectRatio } : {}),
          ...(locked.metadata.altText !== undefined ? { altText: locked.metadata.altText } : {}),
          ...(locked.metadata.location !== undefined ? { location: locked.metadata.location } : {}),
          // Persist the structured fact block so re-publishes, admin approvals, and the
          // Phase 2 card renderer can rebuild it without re-asking the author.
          factsJson: submission.factsJson,
          linkUrl,
          linkPlatform,
          readingMinutes: locked.metadata.readingMinutes,
          publishedAt: new Date(),
          telegramMessageId: telegramPublication.messageId,
          telegramChatId: telegramPublication.chatId,
          authorId: user.id,
          authorName: author,
        },
      });
    } catch (error) {
      // Don't leave an orphan in the channel that the app doesn't know about.
      logger.error("post saved failed after channel publish; rolling back channel message", { error: String(error) });
      await deleteChannelMessage(bot, telegramPublication.chatId, telegramPublication.messageId);
      await revert();
      return ctx.answerCallbackQuery(t(locale, "publishFailed"));
    }
    // Buttons are attached AFTER the Post row exists: the Share button needs the real channel
    // message id and Read More needs the final slug. Best-effort — never fails the publish.
    await attachChannelButtons(bot, telegramPublication.chatId, telegramPublication.messageId, {
      slug: post.slug,
      messageId: telegramPublication.messageId,
      chatId: telegramPublication.chatId,
      linkUrl,
      linkPlatform,
      locale,
    });
    await db.submission.update({ where: { id: submissionId }, data: { state: "PUBLISHED" } });
    await clearSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(`${t(locale, "published")}\n\n🆔 ${post.slug}`);
  });

  bot.callbackQuery("save_draft", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const session = await getSession(ctx.from.id);
    const submissionId = session?.submissionId;
    if (!session || !submissionId || session.step !== "preview")
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    // Only a moderation-clean PREVIEW can become a draft. Previously this overwrote QUARANTINED
    // submissions with DRAFT, silently removing them from the moderator queue.
    const saved = await db.submission.updateMany({
      where: { id: submissionId, userId: user.id, state: "PREVIEW" },
      data: { state: "DRAFT" },
    });
    if (saved.count === 0) return ctx.answerCallbackQuery(t(locale, "notReady"));
    await clearSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(`${t(locale, "draftSaved")}\n/drafts`);
  });

  bot.callbackQuery("edit_preview", async (ctx) => {
    if (!ctx.from || !isPrivate(ctx)) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const session = await getSession(ctx.from.id);
    const submissionId = session?.submissionId;
    if (!session || !submissionId || session.step !== "preview")
      return ctx.answerCallbackQuery(t(locale, "sessionExpired"));
    // Back to INPUT so an old preview's Publish button can't publish stale content mid-edit.
    // The link fields are cleared too — re-running the wizard must not silently reuse a stale
    // link (the Link step is optional, /skip resets it to null). factsJson is reset for the
    // same reason: fact defaults derive from the link, and a re-run may pick a different
    // category whose required fields differ; the facts step will re-ask everything fresh.
    const reopened = await db.submission.updateMany({
      where: { id: submissionId, userId: user.id, state: "PREVIEW" },
      data: { state: "INPUT", mediaType: null, mediaFileId: null, linkUrl: null, linkPlatform: null, factsJson: null },
    });
    if (reopened.count === 0) return ctx.answerCallbackQuery(t(locale, "notReady"));
    await setSession(ctx.from.id, submissionId, "title", locale);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(locale, "titlePrompt"));
  });

  bot.callbackQuery("cancel", async (ctx) => {
    if (!ctx.from) return ctx.answerCallbackQuery();
    const user = await getUser(ctx);
    const locale = toI18nLocale(user.locale);
    const session = await getSession(ctx.from.id);
    if (session?.submissionId)
      await db.submission.updateMany({ where: { id: session.submissionId, state: { in: ["INPUT", "PREVIEW"] } }, data: { state: "REJECTED" } });
    if (session?.confessionId)
      await db.confession.updateMany({ where: { id: session.confessionId, state: { in: ["INPUT", "PREVIEW"] } }, data: { state: "REJECTED" } });
    await clearSession(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(locale, "cancelled"));
  });

  bot.on("message", async (ctx, next) => {
    // The wizard only runs in private chats; in groups it used to swallow the user's messages
    // and bypass group moderation.
    if (!ctx.from || !isPrivate(ctx)) return next();
    const session = await getSession(ctx.from.id);
    const submissionId = session?.submissionId;
    if (!session || !submissionId) return next();
    // Only text-input steps consume the user's message here; "facts" (button-driven review
    // screen) and "preview" fall through to next(). isTextInputStep also covers the
    // "fact:<category>:<key>" sub-steps.
    if (!isTextInputStep(session.step)) return next();

    const text = ctx.message.text ?? ctx.message.caption ?? "";
    // Commands (/help, /language ...) pass through to their handlers instead of being saved as
    // the title/body. /skip is the one command this wizard owns (media + link steps, and
    // clearing an individual fact field).
    if (text.startsWith("/") && !(isSkipAllowedStep(session.step) && text === "/skip")) return next();

    const user = await getUser(ctx);
    const locale = session.locale === "ENGLISH" ? "en" : "am";
    const submission = await db.submission.findUnique({ where: { id: submissionId } });
    if (!submission || submission.userId !== user.id || submission.state !== "INPUT") {
      await clearSession(ctx.from.id);
      await ctx.reply(t(locale, "sessionExpired"));
      return;
    }
    const staff = user.role !== "USER";

    if (ctx.message.forward_origin) {
      await db.submission.update({ where: { id: submission.id }, data: { state: "REJECTED" } });
      await clearSession(ctx.from.id);
      await ctx.reply(t(locale, "forwardedDenied"));
      return;
    }

    // Hard violations are logged and escalated (ban / temporary restriction) exactly like the
    // confession flow and the API; soft ones (QUARANTINE) are decided once, at the category step.
    const hardReject = async (value: string): Promise<boolean> => {
      const check = moderateText(value, { isAdmin: staff, isForwarded: false });
      if (check.decision !== "BAN" && check.decision !== "REJECT") return false;
      await moderateAndEnforce(user.id, staff, [value]);
      await ctx.reply(check.category === "LINK" ? t(locale, "linkDenied") : t(locale, "rejected"));
      return true;
    };

    // step starts with "fact:" — one structured fact-block field is being answered.
    // Step format: "fact:<category>:<key>" (set by the factedit callback). /skip clears
    // the field back to Missing; saveFactAnswer re-moderates and returns to the review screen.
    if (session.step.startsWith("fact:")) {
      const parts = session.step.split(":");
      const category = parts[1]!;
      const key = parts[2]!;
      const fields = requiredFactFieldsFor(category);
      const field = fields.find((f) => f.key === key);
      if (!field || submission.category !== category) {
        // Stale sub-step (category changed underneath us): drop back to a safe state.
        await clearSession(ctx.from.id);
        await ctx.reply(t(locale, "sessionExpired"));
        return;
      }
      if (text === "/skip") {
        await saveFactAnswer(ctx, user, submissionId, category, key, null, locale);
        return;
      }
      if (!text.trim() || text.length > 300) {
        await ctx.reply(`${t(locale, "factInvalid")}\n${field.anchor} ${labelForField(field, locale)} — ${t(locale, "factEditLabel")}`);
        return;
      }
      await saveFactAnswer(ctx, user, submissionId, category, key, text, locale);
      return;
    }

    if (session.step === "title") {
      if (!text || text.length > 100) {
        await ctx.reply(t(locale, "titleInvalid"));
        return;
      }
      if (await hardReject(text)) return;
      await db.submission.update({ where: { id: submission.id }, data: { title: text } });
      await setSession(ctx.from.id, submissionId, "body", locale);
      await ctx.reply(t(locale, "bodyPrompt"));
      return;
    }

    if (session.step === "body") {
      if (!text || text.length > 6000) {
        await ctx.reply(t(locale, "bodyInvalid"));
        return;
      }
      if (await hardReject(text)) return;
      await db.submission.update({ where: { id: submission.id }, data: { body: text } });
      await setSession(ctx.from.id, submissionId, "media", locale);
      await ctx.reply(t(locale, "mediaPrompt"));
      return;
    }

    // step === "media"
    if (session.step === "media") {
      const askLink = async () => {
        await setSession(ctx.from!.id, submissionId, "link", locale);
        await ctx.reply(t(locale, "linkPrompt"));
      };
      if (text === "/skip") {
        await askLink();
        return;
      }
      const photo = ctx.message.photo?.at(-1);
      const video = ctx.message.video;
      if (photo || video) {
        // Captions are not published, but they are still user text: check them.
        if (text && (await hardReject(text))) return;
        await db.submission.update({
          where: { id: submission.id },
          data: photo ? { mediaType: "image", mediaFileId: photo.file_id } : { mediaType: "video", mediaFileId: video!.file_id },
        });
        await askLink();
        return;
      }
      await ctx.reply(t(locale, "mediaInvalid"));
      return;
    }

    // step === "link" — optional official-platform link (YouTube/TikTok/Instagram/X/Facebook/LinkedIn).
    if (session.step === "link") {
      const askCategory = async () => {
        await setSession(ctx.from!.id, submissionId, "category", locale);
        await ctx.reply(t(locale, "categoryPrompt"), { reply_markup: categoryKeyboard(locale) });
      };
      if (text === "/skip") {
        // Reset any stale link from a previous pass through the wizard.
        await db.submission.update({ where: { id: submission.id }, data: { linkUrl: null, linkPlatform: null } });
        await askCategory();
        return;
      }
      const parsed = parsePlatformLink(text);
      if (!parsed) {
        await ctx.reply(t(locale, "linkInvalid"));
        return;
      }
      // Defense in depth: run the normal text moderation on the raw URL string so scam keywords
      // embedded inside the path/query ("...pay-first-to-claim") are caught even though the host
      // is allowlisted. The platform allowlist above already restricts destinations to the six
      // official apps (subset of LINK_ALLOW_HOSTS in moderation.ts).
      const urlCheck = moderateText(parsed.url, { isAdmin: staff, isForwarded: false });
      if (urlCheck.decision === "BAN" || urlCheck.decision === "REJECT") {
        await moderateAndEnforce(user.id, staff, [parsed.url]);
        await ctx.reply(urlCheck.category === "LINK" ? t(locale, "linkDenied") : t(locale, "rejected"));
        return;
      }
      if (urlCheck.decision === "QUARANTINE") {
        await ctx.reply(t(locale, "linkInvalid"));
        return;
      }
      await db.submission.update({ where: { id: submission.id }, data: { linkUrl: parsed.url, linkPlatform: parsed.platform } });
      await askCategory();
      return;
    }

    // step === "category" — free text here is a category search (the buttons are handled by the
    // cat: callback). Matching exactly one category advances straight to the preview.
    if (session.step === "category") {
      const askCategoryAgain = async () => {
        await ctx.reply(t(locale, "categoryPrompt"), { reply_markup: categoryKeyboard(locale) });
      };
      const query = text.toLowerCase().trim();
      if (!query) return;
      const matches = categories.filter((c) => c.am.toLowerCase().includes(query) || c.en.toLowerCase().includes(query));
      if (matches.length === 1) {
        const normalized = normalizePost({
          title: submission.title ?? "",
          body: submission.body ?? "",
          category: matches[0]!.key,
          tags: extractTags(submission.body ?? ""),
          ...(submission.linkUrl ? { link: submission.linkUrl } : {}),
          ...(submission.linkPlatform ? { linkPlatform: submission.linkPlatform } : {}),
          ...(submission.mediaType ? { mediaType: submission.mediaType } : {}),
          ...(submission.mediaFileId ? { mediaFileId: submission.mediaFileId } : {}),
        });
        const moderation = await moderateAndEnforce(user.id, staff, [normalized.title, normalized.body]);
        const common = { category: matches[0]!.key, normalizedJson: JSON.stringify(normalized), moderationJson: JSON.stringify(moderation) };
        if (moderation.decision === "BAN" || moderation.decision === "REJECT") {
          await db.submission.update({ where: { id: submission.id }, data: { ...common, state: "REJECTED" } });
          await clearSession(ctx.from.id);
          await ctx.reply(moderation.category === "LINK" ? t(locale, "linkDenied") : t(locale, "rejected"));
          return;
        }
        if (moderation.decision === "QUARANTINE") {
          await db.submission.update({ where: { id: submission.id }, data: { ...common, state: "QUARANTINED" } });
          await clearSession(ctx.from.id);
          await ctx.reply(t(locale, "quarantined"));
          return;
        }
        await db.submission.update({ where: { id: submission.id }, data: { ...common, state: "PREVIEW" } });
        await setSession(ctx.from.id, submission.id, "preview", locale);
        await sendPreview(ctx, normalized, locale, {
          slug: normalized.slug,
          author: user.firstName ?? "GENZI",
          linkUrl: submission.linkUrl,
          linkPlatform: submission.linkPlatform,
          // Legacy category-by-text path is free-layout only (structural categories go
          // through the facts step), but pass effective facts anyway so a structural post
          // that somehow reaches here still previews exactly what the gate will allow.
          factValues: effectiveFacts(matches[0]!.key, submission),
        });
        return;
      }
      // Zero or several matches: show the keyboard again so the user can tap the right button.
      await askCategoryAgain();
      return;
    }
  });
}
