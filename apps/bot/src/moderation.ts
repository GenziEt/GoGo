export type ModerationDecision = "ALLOW" | "QUARANTINE" | "REJECT" | "BAN";
export interface ModerationResult { decision: ModerationDecision; category: string; reason: string; score: number; }

const sexualExploitation = ["ልጅ ወሲብ", "የህጻናት ወሲብ", "child sex", "child sexual", "minor sex", "child porn", "የልጆች ወሲብ", "የወሲብ ብዝበዛ"];
const intimateNonConsent = ["revenge porn", "non consensual nude", "non-consensual nude", "nonconsensual nude", "ያለፈቃድ እርቃን", "ያለፈቃድ የወሲብ", "የግል ምስል አሰራጭ"];
const scams = ["send money", "pay first", "double your money", "guaranteed profit", "ብር ላክ", "ገንዘብ ላክ", "ገንዘብህን እጥፍ", "100% ትርፍ", "ማረጋገጫ ክፍያ", "registration fee", "investment guaranteed", "give me your otp", "send otp", "ኮድ ላክ"];
const fraud = ["fake id", "fake certificate", "counterfeit", "ሐሰተኛ መታወቂያ", "ሐሰተኛ ሰነድ"];
// Soft-violation list: these used to be silently ALLOWed (only logged), which meant the
// QUARANTINED admin approval queue could never receive anything. Now they are held for
// human review instead of published automatically.
const quarantineTerms = ["kill you", "i will kill", "i'll kill", "death threat", "እገድልሃለሁ", "እገድልሻለሁ", "terrorist", "bomb", "ቦምብ", "እሳት አቃጥል", "cp"];
// Spam/flood patterns: quarantined (reviewed) rather than hard-rejected, so repeated
// low-quality posts reach the moderation queue instead of vanishing.
const spamTerms = ["click here now", "free followers", "buy followers", "get rich quick", "follow back instantly", "ተከታይ ርቢህ", "ወዲያውኑ ተከተል"];
const zeroWidth = /[\u200B-\u200D\u2060\uFEFF]/gu;
const punctuation = /[\p{P}\p{S}\s_]+/gu;

// Allowed external domains for non-admin links. t.me/telegram.me bot & channel deep links are
// always allowed; everything else must appear on this allow-list (docs/TRUST_SAFETY.md).
const LINK_ALLOW_HOSTS = [
  "youtube.com", "youtu.be", "instagram.com", "x.com", "twitter.com", "tiktok.com", "facebook.com",
  "linkedin.com", "github.com", "gitlab.com", "google.com", "docs.google.com", "drive.google.com",
  "forms.gle", "medium.com", "spotify.com", "soundcloud.com", "apple.com", "android.com",
  "play.google.com", "discord.com", "discord.gg", "reddit.com", "telegram.org", "wa.me",
  "amharicportal.com", "ebs.com.et", "fana.com",
  "addisstandard.com", "capitalfm.net", "ena.et", "corriere.it"
];
const urlPattern = /((?:https?:\/\/|www\.)[^\s<>"'()\[\]]+|t\.me\/[A-Za-z0-9_./+-]+)/giu;

// t.me / telegram.me links are NOT blanket-allowed (they were a spam/scam-channel vector).
// Only handles listed in ALLOWED_TELEGRAM_HANDLES (comma separated, no @) plus the bot's own
// username may be linked by regular users. Staff are exempt from all link checks.
function allowedTelegramHandles(): Set<string> {
  const raw = `${process.env.ALLOWED_TELEGRAM_HANDLES ?? ""},${process.env.TELEGRAM_BOT_USERNAME ?? ""}`;
  return new Set(raw.split(",").map((x) => x.trim().replace(/^@/, "").toLowerCase()).filter(Boolean));
}

function linkAllowed(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "t.me" || host === "telegram.me") {
    const handle = (url.pathname.split("/").filter(Boolean)[0] ?? "").toLowerCase();
    return handle !== "" && allowedTelegramHandles().has(handle);
  }
  return LINK_ALLOW_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function normalizeForSafety(input: string): string {
  return input.normalize("NFKC").replace(zeroWidth, "").toLowerCase().replace(/[\u0430\u0410]/g, "a").replace(/[\u0435\u0415]/g, "e").replace(/[\u043E\u041E]/g, "o").trim();
}
function compact(input: string): string { return normalizeForSafety(input).replace(punctuation, ""); }
function termHit(item: string, normalized: string, compacted: string): boolean {
  const compactItem = compact(item);
  if (/^[a-z0-9' ]+$/.test(item)) {
    // Latin terms: whole word / phrase match, so "cp" no longer fires on "epic party".
    const pattern = new RegExp(`(?:^|[^a-z0-9])${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}(?:$|[^a-z0-9])`, "u");
    if (pattern.test(normalized)) return true;
    // Spaced/punctuated evasion ("c h i l d s e x") only for long terms, never for short tokens.
    return compactItem.length >= 9 && compacted.includes(compactItem);
  }
  if (normalized.includes(item)) return true;
  return compactItem.length >= 5 && compacted.includes(compactItem);
}
function matches(list: string[], normalized: string, compacted: string): boolean { return list.some((item) => termHit(item, normalized, compacted)); }

export function moderateText(text: string, options: { isAdmin: boolean; isForwarded: boolean }): ModerationResult {
  const normalized = normalizeForSafety(text);
  const compacted = compact(text);
  if (options.isForwarded) return { decision: "REJECT", category: "FORWARDED_CONTENT", reason: "Forwarded content is disabled.", score: 1 };
  // Non-admin links are only rejected when they point outside the allow-list. This keeps spam
  // domains blocked while letting users share YouTube/Instagram links and paste meeting or
  // application URLs (previously EVERY link was rejected, which made online-event meeting links
  // and user-posted opportunity application links impossible).
  if (!options.isAdmin) {
    for (const raw of text.match(urlPattern) ?? []) {
      const candidate = raw.replace(/[.,;:!?)\]]+$/u, "");
      if (!linkAllowed(candidate)) {
        return { decision: "REJECT", category: "LINK", reason: "This link's domain is not on the GENZI allow-list.", score: 1 };
      }
    }
  }
  if (matches(sexualExploitation, normalized, compacted)) return { decision: "BAN", category: "SEXUAL_EXPLOITATION", reason: "Potential sexual exploitation detected.", score: 1 };
  if (matches(intimateNonConsent, normalized, compacted)) return { decision: "BAN", category: "NON_CONSENSUAL_INTIMATE_CONTENT", reason: "Potential non-consensual intimate content detected.", score: 1 };
  if (matches(scams, normalized, compacted)) return { decision: "REJECT", category: "SCAM", reason: "Potential scam pattern detected.", score: 1 };
  if (matches(fraud, normalized, compacted)) return { decision: "REJECT", category: "FRAUD", reason: "Potential fraud pattern detected.", score: 1 };
  if (matches(quarantineTerms, normalized, compacted)) return { decision: "QUARANTINE", category: "SAFETY_THREAT", reason: "Possible threat/hate content — held for moderator review.", score: 0.6 };
  if (matches(spamTerms, normalized, compacted)) return { decision: "QUARANTINE", category: "SPAM", reason: "Possible spam — held for moderator review.", score: 0.4 };
  return { decision: "ALLOW", category: "NONE", reason: "No blocking rule matched.", score: 0 };
}
