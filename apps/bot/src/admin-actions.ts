import type { Bot } from "grammy";
import type { User } from "@prisma/client";
import { db } from "./db.js";
import { publishToChannel } from "./telegram-publisher.js";
import { lockPost } from "./post-schema.js";
import { attachChannelButtons } from "./post-buttons.js";
import { env } from "./config.js";

export type AdminDecision = "APPROVE" | "REJECT" | "BAN" | "RESTRICT";

function parseTags(raw: string | null | undefined): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

// Structured fact-block values persisted by the wizard (Submission/Post.factsJson).
// Corrupted JSON is treated as empty — the publish gate in telegram-publisher.ts then
// names the missing fields, exactly like it does for a post that never went through
// the facts step.
function parseFacts(raw: string | null | undefined): Record<string, string> {
  try {
    const value: unknown = JSON.parse(raw ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export async function performModerationAction(bot: Bot, submissionId: string, moderator: User, decision: AdminDecision) {
  const submission = await db.submission.findUnique({ where: { id: submissionId }, include: { user: true } });
  if (!submission) throw new Error("Submission not found");

  const notifyAuthor = async (am: string, en: string) => {
    try {
      await bot.api.sendMessage(Number(submission.user.telegramId), submission.user.locale === "ENGLISH" ? en : am);
    } catch { /* author may have blocked the bot */ }
  };

  if (decision === "APPROVE" || decision === "REJECT") {
    // Only items actually waiting in the queue can be approved/rejected; before this, a double
    // click (or a stale tab) published the same submission to the channel twice.
    const claim = await db.submission.updateMany({ where: { id: submissionId, state: "QUARANTINED" }, data: { state: "PREPARING" } });
    if (claim.count === 0) throw new Error("Submission is not awaiting review");
  }
  const release = () => db.submission.updateMany({ where: { id: submissionId, state: "PREPARING" }, data: { state: "QUARANTINED" } });

  if (decision === "APPROVE") {
    try {
      if (!submission.normalizedJson) throw new Error("Submission has no normalized content");
      const normalized = JSON.parse(submission.normalizedJson) as Parameters<typeof lockPost>[0];
      const authorName = submission.user.firstName ?? "GENZI";

      // Mini App posts are saved as hidden Post rows when quarantined, and their queue entry
      // carries a different payload shape (metadata.slug, media{}). Publish THAT row instead of
      // creating a duplicate Post with a broken slug and no media.
      const apiSlug = (normalized as unknown as { metadata?: { slug?: string } }).metadata?.slug;
      const hidden = apiSlug ? await db.post.findUnique({ where: { slug: apiSlug } }) : null;
      let post;
      if (hidden) {
        const publication = await publishToChannel(bot, {
          title: hidden.title,
          body: hidden.body,
          tags: parseTags(hidden.tagsJson),
          author: hidden.authorName ?? authorName,
          ...(hidden.mediaType && hidden.mediaFileId ? { mediaType: hidden.mediaType, mediaFileId: hidden.mediaFileId } : {}),
          ...(hidden.location ? { location: hidden.location } : {}),
          category: hidden.category,
          readingMinutes: hidden.readingMinutes,
          // Same gate + defaults as the wizard path; a quarantined API post with a link
          // satisfies its How/Tickets/Source anchor through factDefaults.
          factValues: parseFacts(hidden.factsJson),
          linkUrl: hidden.linkUrl,
          // Phase 3 stored choices survive the quarantine round-trip (wizard →
          // submission row → approval here), so approving publishes exactly what
          // the author previewed.
          ...(hidden.seriesKey ? { seriesKey: hidden.seriesKey } : {}),
          captionAbove: hidden.captionAbove === true,
        });
        post = await db.post.update({
          where: { id: hidden.id },
          data: { visibility: "PUBLIC", publishedAt: new Date(), telegramMessageId: publication.messageId, telegramChatId: publication.chatId }
        });
        // Same premium button rows as the wizard path (link hero + Read More/Share/Discuss).
        await attachChannelButtons(bot, publication.chatId, publication.messageId, {
          slug: post.slug,
          messageId: publication.messageId,
          chatId: publication.chatId,
          linkUrl: post.linkUrl,
          linkPlatform: post.linkPlatform,
          // Phase 4: published channel buttons carry the tracked _c source suffix.
          buttonSource: "channel"
        });
      } else {
        const locked = lockPost(normalized, authorName);
        const linkUrl = submission.linkUrl ?? locked.metadata.link ?? null;
        const linkPlatform = submission.linkPlatform ?? locked.metadata.linkPlatform ?? null;
        const publication = await publishToChannel(bot, {
          title: locked.title,
          body: locked.body,
          tags: locked.tags,
          author: authorName,
          ...(locked.media.type ? { mediaType: locked.media.type } : {}),
          ...(locked.media.fileId ? { mediaFileId: locked.media.fileId } : {}),
          ...(locked.metadata.location ? { location: locked.metadata.location } : {}),
          category: locked.metadata.category,
          readingMinutes: locked.metadata.readingMinutes,
          // Wizard-collected fact fields ride along so the gate sees the same values the
          // author filled (and the preview showed) before quarantine.
          factValues: parseFacts(submission.factsJson),
          linkUrl,
          ...(submission.seriesKey ? { seriesKey: submission.seriesKey } : {}),
          captionAbove: submission.captionAbove === true,
        });
        post = await db.post.create({
          data: {
            slug: `${locked.metadata.slug}-${Date.now()}`,
            title: locked.title,
            body: locked.body,
            excerpt: locked.metadata.excerpt,
            category: locked.metadata.category,
            tagsJson: JSON.stringify(locked.tags),
            mediaType: locked.media.type ?? null,
            mediaFileId: locked.media.fileId ?? null,
            mediaAspect: locked.media.aspectRatio ?? null,
            altText: locked.metadata.altText ?? null,
            location: locked.metadata.location ?? null,
            // Persist the wizard-collected fact fields on the published row too, so a later
            // re-publish (or Phase 2 card render) sees exactly what gated this post.
            factsJson: submission.factsJson ?? null,
            linkUrl,
            linkPlatform,
            readingMinutes: locked.metadata.readingMinutes,
            publishedAt: new Date(),
            telegramMessageId: publication.messageId,
            telegramChatId: publication.chatId,
            authorId: submission.userId,
            authorName
          }
        });
        await attachChannelButtons(bot, publication.chatId, publication.messageId, {
          slug: post.slug,
          messageId: publication.messageId,
          chatId: publication.chatId,
          linkUrl,
          linkPlatform,
          // Phase 4: published channel buttons carry the tracked _c source suffix.
          buttonSource: "channel"
        });
      }
      await db.submission.update({ where: { id: submissionId }, data: { state: "PUBLISHED" } });
      await db.moderationEvent.create({ data: { submissionId, targetUserId: submission.userId, moderatorId: moderator.id, category: "ADMIN_REVIEW", action: "ALLOW", reason: "Approved by moderator" } });
      await notifyAuthor("✅ ልጥፍዎ በአስተዳዳሪ ጸድቆ ታትሟል።", "✅ Your post was approved by a moderator and published.");
      return post;
    } catch (error) {
      await release();
      throw error;
    }
  }

  if (decision === "REJECT") {
    await db.submission.update({ where: { id: submissionId }, data: { state: "REJECTED" } });
    await db.moderationEvent.create({ data: { submissionId, targetUserId: submission.userId, moderatorId: moderator.id, category: "ADMIN_REVIEW", action: "REJECT", reason: "Rejected by moderator" } });
    await notifyAuthor("❌ ልጥፍዎ በአስተዳዳሪ ግምገማ አልጸደቀም።", "❌ Your post was not approved by a moderator.");
    return null;
  }

  if (decision === "BAN") {
    await db.user.update({ where: { id: submission.userId }, data: { blocked: true } });
    await db.submission.update({ where: { id: submissionId }, data: { state: "REJECTED" } });
    await db.moderationEvent.create({ data: { submissionId, targetUserId: submission.userId, moderatorId: moderator.id, category: "ADMIN_REVIEW", action: "BAN", reason: "User banned by moderator" } });
    if (env.GENZI_GROUP_ID) {
      try { await bot.api.banChatMember(env.GENZI_GROUP_ID, Number(submission.user.telegramId)); } catch (error) { console.error("Telegram ban failed", error); }
    }
    return null;
  }

  await db.user.update({ where: { id: submission.userId }, data: { restrictedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
  // Close the queue entry too (it used to stay QUARANTINED forever after a RESTRICT).
  await db.submission.update({ where: { id: submissionId }, data: { state: "REJECTED" } });
  await db.moderationEvent.create({ data: { submissionId, targetUserId: submission.userId, moderatorId: moderator.id, category: "ADMIN_REVIEW", action: "RESTRICT", reason: "User restricted for 24 hours" } });
  return null;
}
