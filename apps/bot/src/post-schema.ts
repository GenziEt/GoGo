import type { NormalizedPost } from "./normalizer.js";

export const POST_SCHEMA_VERSION = "1.0";

export interface LockedPost {
  schemaVersion: string;
  media: { type: string | null; fileId: string | null; aspectRatio: "16:9" };
  title: string;
  body: string;
  tags: string[];
  author: { name: string };
  timestamp: string;
  metadata: {
    slug: string;
    excerpt: string;
    readingMinutes: number;
    altText: string;
    category: string;
    location?: string;
    link?: string;
    linkPlatform?: string;
  };
}

export function lockPost(post: NormalizedPost, authorName: string): LockedPost {
  return {
    schemaVersion: POST_SCHEMA_VERSION,
    media: { type: post.mediaType ?? null, fileId: post.mediaFileId ?? null, aspectRatio: "16:9" },
    title: post.title,
    body: post.body,
    tags: post.tags,
    author: { name: authorName },
    timestamp: post.timestamp,
    metadata: {
      slug: post.slug,
      excerpt: post.excerpt,
      readingMinutes: post.readingMinutes,
      altText: post.altText,
      category: post.category,
      ...(post.location ? { location: post.location } : {}),
      ...(post.link ? { link: post.link } : {}),
      ...(post.linkPlatform ? { linkPlatform: post.linkPlatform } : {})
    }
  };
}
