export interface RawPost {
  title: string;
  body: string;
  category: string;
  tags: string[];
  location?: string;
  link?: string;
  // Platform of `link` ("youtube" | "tiktok" | "instagram" | "x" | "facebook" | "linkedin"),
  // captured by the wizard's Link step. Carried through LockedPost.metadata so the publisher
  // can build the "▶️ Watch on <Platform>" hero button label.
  linkPlatform?: string;
  mediaType?: string;
  mediaFileId?: string;
}

export interface NormalizedPost extends RawPost {
  slug: string;
  excerpt: string;
  timestamp: string;
  readingMinutes: number;
  altText: string;
}

function slugify(input: string): string {
  return input
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80) || `genzi-${Date.now()}`;
}

function cleanText(input: string): string {
  return input.normalize("NFKC").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

export function normalizePost(raw: RawPost): NormalizedPost {
  const title = cleanText(raw.title).slice(0, 100);
  const body = cleanText(raw.body).slice(0, 6000);
  const words = body.split(/\s+/).filter(Boolean).length;
  const readingMinutes = Math.max(1, Math.ceil(words / 180));
  const excerpt = body.slice(0, 180).replace(/\s+\S*$/, "").trim();
  const timestamp = new Date().toISOString();

  return {
    ...raw,
    title,
    body,
    tags: raw.tags.slice(0, 8).map(cleanText).filter(Boolean),
    slug: slugify(title),
    excerpt,
    timestamp,
    readingMinutes,
    altText: `${title} — GENZI 🇪🇹`
  };
}
