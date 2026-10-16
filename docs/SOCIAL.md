# GENZI Advanced Social Layer

v0.3.0 adds a zero-cost social layer built on the existing Prisma database and Telegram Mini App authentication.

## Direct messages
- One-to-one conversations only.
- Deterministic user-pair uniqueness prevents duplicate conversations.
- Messages are capped at 1,000 characters.
- NFKC normalization and existing local safety moderation are applied before delivery.
- Read receipts are stored with `readAt`.
- Inbox exposes unread state and latest message.
- Blocked users cannot be messaged.

## Reposts
- A user can repost another user's published post once.
- Reposting the same post toggles the repost off.
- Original authors receive an in-app notification.
- Repost counts are persistent.

## Privacy and operations
- No external messaging provider is required.
- No paid API/service was introduced.
- Telegram Mini App `initData` remains the authentication mechanism.
- Production deployments should use PostgreSQL and HTTPS as covered by `docs/PRODUCTION.md`.


## v0.3.2 realtime
GENZI uses Server-Sent Events (SSE) for zero-cost server-to-browser realtime updates. A short-lived authenticated token is issued through the normal Telegram Mini App session, then consumed once by the SSE stream. Direct messages, typing indicators, presence heartbeats, and selected social events are pushed immediately without requiring a paid realtime provider. Presence/event fan-out is intentionally in-memory for the single-node zero-cost deployment; multi-instance deployments should move that state to Redis.
