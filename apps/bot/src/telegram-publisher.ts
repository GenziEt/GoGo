import type { Bot, InlineKeyboard } from "grammy";
import { env } from "./config.js";
import { logger } from "./logger.js";
import { buildChannelCaption, buildChannelCaptionPlain, buildCaptionParts } from "./post-buttons.js";
import { missingFactFieldsAfterDefaults, themeFor, type FactFieldSpec } from "./post-theme.js";

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
    escapeHtml,
  });
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
  const hasMedia = (input.mediaType === "image" || input.mediaType === "video") && Boolean(input.mediaFileId);
  const caption = premiumCaption(input);

  // 1) Everything fits in one message / one caption — the common case.
  if (hasMedia && caption.length <= CAPTION_LIMIT) {
    try {
      const msg = input.mediaType === "image"
        ? await bot.api.sendPhoto(channel, input.mediaFileId as string, { caption, parse_mode: "HTML" })
        : await bot.api.sendVideo(channel, input.mediaFileId as string, { caption, parse_mode: "HTML" });
      return { chatId: String(channel), messageId: msg.message_id };
    } catch (error) {
      // HTML parse failure on user content: retry once with the plain-text twin.
      logger.warn("channel caption HTML rejected, falling back to plain text", { error: String(error) });
      const plain = buildChannelCaptionPlain({ ...input, readingMinutes: input.readingMinutes ?? 1, publishedAt: new Date() }).slice(0, CAPTION_LIMIT);
      const msg = input.mediaType === "image"
        ? await bot.api.sendPhoto(channel, input.mediaFileId as string, { caption: plain })
        : await bot.api.sendVideo(channel, input.mediaFileId as string, { caption: plain });
      return { chatId: String(channel), messageId: msg.message_id };
    }
  }
  if (!hasMedia && caption.length <= 4000) {
    try {
      const msg = await bot.api.sendMessage(channel, caption, { parse_mode: "HTML" });
      return { chatId: String(channel), messageId: msg.message_id };
    } catch (error) {
      logger.warn("channel message HTML rejected, falling back to plain text", { error: String(error) });
      const plain = buildChannelCaptionPlain({ ...input, readingMinutes: input.readingMinutes ?? 1, publishedAt: new Date() }).slice(0, 4000);
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
    title: input.title,
    body: input.body,
    tags: input.tags,
    author: input.author,
    readingMinutes: input.readingMinutes ?? Math.max(1, Math.ceil(input.body.split(/\s+/).filter(Boolean).length / 180)),
    publishedAt: new Date(),
    ...(input.location ? { location: input.location } : {}),
    ...(input.category ? { category: input.category } : {}),
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
    const msg = input.mediaType === "image"
      ? await bot.api.sendPhoto(channel, input.mediaFileId as string, { caption: firstChunk.slice(0, CAPTION_LIMIT), parse_mode: "HTML" })
      : await bot.api.sendVideo(channel, input.mediaFileId as string, { caption: firstChunk.slice(0, CAPTION_LIMIT), parse_mode: "HTML" });
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
