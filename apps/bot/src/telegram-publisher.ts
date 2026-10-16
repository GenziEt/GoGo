import type { Bot, InlineKeyboard } from "grammy";
import { env } from "./config.js";
import { logger } from "./logger.js";
import { buildChannelCaption, buildChannelCaptionPlain, buildCaptionParts } from "./post-buttons.js";
import { factDefaults, missingFactFieldsAfterDefaults, themeFor, type FactFieldSpec } from "./post-theme.js";
import { renderCard } from "./card-renderer.js";

// Every channel post is built with the shared premium caption (brand header, spaced body,
// "👤 Author · 📅 8 Oct 2026" footer) so the private preview and the published post are
// byte-for-byte identical (WYSIWYG). Buttons are NOT sent here — the caller attaches them
// after the Post row exists (the Share button needs the real message id + slug), which also
// keeps multi-message posts anchored to the first message only.
type PublishInput = {
  title: string;
  body: string;
  tags: string[];
  author: string;
  mediaType?: string;
  mediaFileId?: string;
  location?: string;
  readingMinutes?: number;
  // Category key drives the header chip (Phase 1). Optional for legacy callers.
  category?: string;
  // Structured fact-block values keyed by post-theme FactFieldSpec.key (Phase 1.1).
  // Structural categories (money / events / ai-tech) cannot publish while a required
  // field is missing or blank — enforced below, never at render time.
  factValues?: Record<string, string | undefined>;
  // The post's own platform link. Feeds factDefaults (link → How/Tickets/Source
  // anchors) so the gate matches the wizard's question set exactly.
  linkUrl?: string | null;
  // Phase 2 branded-card controls:
  //   cardSlug    — cache key for the generated card (the post slug). When ABSENT,
  //                 no card is generated (legacy/API paths keep current behavior;
  //                 wiring slugs through those callers is a follow-up step).
  //   preferCard  — "use GENZI card" chosen by the author even though media exists.
  //   locale      — chip language on the card (en/am). Defaults to "en".
  cardSlug?: string;
  preferCard?: boolean;
  locale?: "en" | "am";
};

// Telegram hard limits: 4096 chars per text message, 1024 per media caption. The post wizard
// accepts up to 6000 chars, so long posts are split instead of failing at publish time.
const TEXT_CHUNK = 3400;
const CAPTION_LIMIT = 1000;

function escapeHtml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [""];
}

// Full premium caption for a single-message post (header + body + tags/location + dated footer).
function premiumCaption(input: PublishInput): string {
  return buildChannelCaption({
    title: input.title,
    body: input.body,
    tags: input.tags,
    author: input.author,
    readingMinutes: input.readingMinutes ?? Math.max(1, Math.ceil(input.body.split(/\s+/).filter(Boolean).length / 180)),
    publishedAt: new Date(),
    ...(input.location ? { location: input.location } : {}),
    ...(input.category ? { category: input.category } : {}),
    // Thread the collected fact values into the shared caption builder so the
    // published post renders the same anchored rows the author saw in preview.
    ...(input.factValues ? { factValues: input.factValues } : {}),
    escapeHtml,
  });
}

/**
 * Effective fact values for a publish path that does not run the wizard (admin
 * approve/edit-publish, API publish). Applies the theme's own defaults (link →
 * How/Tickets/Source anchors) and maps the legacy `location` column onto the
 * money "Where" anchor, so WYSIWYG previews match what the gate already allowed
 * through — the gate and the renderer stay the SAME computation from post-theme.ts.
 */
export function effectivePublishFacts(input: PublishInput): Record<string, string | undefined> {
  const category = input.category ?? "";
  const merged: Record<string, string | undefined> = { ...factDefaults(category, { linkUrl: input.linkUrl ?? null }), ...input.factValues };
  if (category === "money" && !merged.where?.trim() && input.location?.trim()) merged.where = input.location.trim();
  return merged;
}

/**
 * Required structured-fact fields for a category, straight from post-theme.ts —
 * the wizard's "facts" step iterates this list, so the question set and the
 * publish gate can never disagree about what a layout demands. Empty for free
 * layouts (media-first / short-story), which skip the step entirely.
 */
export function requiredFactFieldsFor(category: string): FactFieldSpec[] {
  const theme = themeFor(category);
  return [...theme.factFields];
}

export async function publishToChannel(bot: Bot, input: PublishInput): Promise<{ chatId: string; messageId: number }> {
  if (!env.GENZI_CHANNEL_ID) throw new Error("GENZI_CHANNEL_ID is not configured");
  // Enforcement gate (Phase 1.1 layout table + Phase 5 anti-drift rule): a
  // structural category with missing required fact fields CANNOT publish. This
  // throws BEFORE any Telegram call, so a half-filled fact block never reaches
  // the channel and no empty anchor can render. The wizard collects these fields
  // up front (facts step) and shows the author exactly which are missing; admins
  // see the same reason in the approval queue before approving. The money "Where"
  // anchor is satisfied by the existing `location` column, so legacy posts that
  // already carry location/deadline-style data keep working. Sensible defaults
  // (link → How/Tickets/Source anchors) come from post-theme.ts factDefaults,
  // so this gate and the wizard's question set are the SAME computation.
  const missingFacts = missingFactFieldsAfterDefaults(
    input.category ?? "",
    {
      ...(input.location ? { location: input.location } : {}),
      ...input.factValues,
    },
    { linkUrl: input.linkUrl ?? null },
  );
  if (missingFacts.length > 0) {
    throw new Error(`publish blocked: category "${input.category ?? "?"}" is missing required fact fields: ${missingFacts.join(", ")}`);
  }
  const channel = env.GENZI_CHANNEL_ID;
  // Blocked structural posts lose their media on purpose: a half-filled fact block
  // must never render, and the full premium caption (with the category chip header)
  // is the fallback surface. Complete posts keep their media untouched.
  let hasMedia = (input.mediaType === "image" || input.mediaType === "video") && Boolean(input.mediaFileId);
  // Effective facts (defaults + wizard answers + legacy location mapping) computed ONCE,
  // after the gate passed — every render path below consumes these so preview == channel.
  const publishInput: PublishInput = { ...input, factValues: effectivePublishFacts(input) };
  const caption = premiumCaption(publishInput);

  // ---- Phase 2: branded card ------------------------------------------------
  // Behavior contract (plan §2.3):
  //   • author attached NO image → generate the GENZI card and attach it
  //   • author attached an image → honor their explicit "use GENZI card" choice
  //     (preferCard); otherwise their media wins untouched
  //   • slug absent → feature not wired for this caller; behave exactly as before
  //   • generation FAILS → post publishes text-only; publishing is never blocked
  // The card replaces media only for IMAGE posts — a video is the content itself,
  // and a card standing in for it would misrepresent the post.
  let cardBuffer: Buffer | null = null;
  if (input.cardSlug?.trim() && (!hasMedia || (input.preferCard && input.mediaType === "image"))) {
    const card = await renderCard({
      slug: input.cardSlug,
      title: input.title,
      category: input.category ?? "",
      locale: input.locale ?? "en",
      factValues: publishInput.factValues,
      ...(input.body.trim() ? { subtitle: input.body.trim().split("\n\n")[0] } : {}),
    });
    if (card) {
      cardBuffer = card.png;
      hasMedia = true; // route through the existing sendPhoto paths below
    } else {
      logger.warn("card generation failed; publishing without card", { slug: input.cardSlug });
    }
  }
  const sendPhotoOrVideo = async (source: string | Buffer, cap: string, html: boolean) => {
    const opts = html ? { caption: cap, parse_mode: "HTML" as const } : { caption: cap };
    return hasVideo
      ? bot.api.sendVideo(channel, source as string, opts)
      : bot.api.sendPhoto(channel, source, opts);
  };
  const hasVideo = input.mediaType === "video" && !cardBuffer;

  // 1) Everything fits in one message / one caption — the common case.
  if (hasMedia && caption.length <= CAPTION_LIMIT) {
    const source = cardBuffer ?? (input.mediaFileId as string);
    try {
      const msg = await sendPhotoOrVideo(source, caption, true);
      return { chatId: String(channel), messageId: msg.message_id };
    } catch (error) {
      // HTML parse failure on user content: retry once with the plain-text twin.
      logger.warn("channel caption HTML rejected, falling back to plain text", { error: String(error) });
      const plain = buildChannelCaptionPlain({ ...publishInput, readingMinutes: publishInput.readingMinutes ?? 1, publishedAt: new Date() }).slice(0, CAPTION_LIMIT);
      const msg = await sendPhotoOrVideo(source, plain, false);
      return { chatId: String(channel), messageId: msg.message_id };
    }
  }
  if (!hasMedia && caption.length <= 4000) {
    try {
      const msg = await bot.api.sendMessage(channel, caption, { parse_mode: "HTML" });
      return { chatId: String(channel), messageId: msg.message_id };
    } catch (error) {
      logger.warn("channel message HTML rejected, falling back to plain text", { error: String(error) });
      const plain = buildChannelCaptionPlain({ ...publishInput, readingMinutes: publishInput.readingMinutes ?? 1, publishedAt: new Date() }).slice(0, 4000);
      const msg = await bot.api.sendMessage(channel, plain);
      return { chatId: String(channel), messageId: msg.message_id };
    }
  }

  // 2) Long post: head (brand + title + TL;DR) + as much body as fits + tags/footer go in the
  //    first message; the rest of the body follows as threaded replies. The keyboard (attached
  //    by the caller) lands on THIS first message, so readers see buttons without scrolling.
  //    Splitting happens on the RAW body and each piece is escaped separately, so HTML tags and
  //    entities are never cut in half (the old code sliced finished HTML and then re-sent the
  //    whole body again, duplicating text).
  const parts = buildCaptionParts({
    title: publishInput.title,
    body: publishInput.body,
    tags: publishInput.tags,
    author: publishInput.author,
    readingMinutes: publishInput.readingMinutes ?? Math.max(1, Math.ceil(publishInput.body.split(/\s+/).filter(Boolean).length / 180)),
    publishedAt: new Date(),
    ...(publishInput.location ? { location: publishInput.location } : {}),
    ...(publishInput.category ? { category: publishInput.category } : {}),
    ...(publishInput.factValues ? { factValues: publishInput.factValues } : {}),
    escapeHtml,
  });
  const budget = hasMedia ? CAPTION_LIMIT : TEXT_CHUNK;
  const room = Math.max(200, Math.floor((budget - parts.head.length - parts.tail.length - 40) * 0.8));
  const [firstBody = "", ...restChunks] = splitText(input.body, room);
  const rest = restChunks.join("\n\n");
  const more = rest ? "\n\n<i>…continued below ↓</i>" : "";
  const firstChunk = `${parts.head}\n\n${escapeHtml(firstBody)}${more}${parts.tail}`;
  let firstId: number;
  if (hasMedia) {
    const msg = await sendPhotoOrVideo(cardBuffer ?? (input.mediaFileId as string), firstChunk.slice(0, CAPTION_LIMIT), true);
    firstId = msg.message_id;
  } else {
    const msg = await bot.api.sendMessage(channel, firstChunk, { parse_mode: "HTML" });
    firstId = msg.message_id;
  }
  for (const chunk of splitText(rest, TEXT_CHUNK)) {
    if (!chunk) continue;
    await bot.api.sendMessage(channel, escapeHtml(chunk), {
      parse_mode: "HTML",
      reply_parameters: { message_id: firstId, allow_sending_without_reply: true },
    });
  }
  return { chatId: String(channel), messageId: firstId };
}

export async function publishConfession(bot: Bot, body: string, number: number, keyboard: InlineKeyboard): Promise<{ chatId: string; messageId: number }> {
  if (!env.GENZI_CHANNEL_ID) throw new Error("GENZI_CHANNEL_ID is not configured");
  const caption = `🗣️ <b>GENZI CONFESSION #${String(number).padStart(5, "0")}</b>\n\n${escapeHtml(body)}\n\nምን ማድረግ አለበት? 👇`;
  const msg = await bot.api.sendMessage(env.GENZI_CHANNEL_ID, caption, { parse_mode: "HTML", reply_markup: keyboard });
  return { chatId: String(env.GENZI_CHANNEL_ID), messageId: msg.message_id };
}

// Best-effort removal of a message from the public channel. Moderator removals previously only
// changed the DB row, leaving the content visible in Telegram.
export async function deleteChannelMessage(bot: Bot, chatId: string | null | undefined, messageId: number | null | undefined): Promise<boolean> {
  if (!chatId || messageId === null || messageId === undefined) return false;
  try {
    await bot.api.deleteMessage(chatId, messageId);
    return true;
  } catch (error) {
    logger.warn("channel message delete failed", { chatId, messageId, error: String(error) });
    return false;
  }
}
