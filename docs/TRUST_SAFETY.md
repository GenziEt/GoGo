# GENZI Trust & Safety — v0.3.4

## Protection layers
- Telegram-authenticated account enforcement for blocked and temporarily restricted users.
- Per-method/per-route in-memory rate limiting to reduce spam and burst abuse; the limiter keys on `req.ip`, which only reflects `X-Forwarded-For` when `TRUST_PROXY=true` and Express's own trust-proxy parsing is enabled — the limiter never trusts a client-supplied header directly, so it can't be bypassed by spoofing that header.
- NFKC normalization plus zero-width-character removal and compact matching for common Unicode/spacing evasion.
- Existing hard blocks remain for sexual exploitation, non-consensual intimate content, scams, fraud, links from non-admins, and forwarded content.
- Content moderation is applied consistently across every user-generated-content surface — posts, comments, direct messages, confessions, and community/event/opportunity/poll/quiz creation — via one shared enforcement path (`enforceContentModeration`), so a new endpoint can't accidentally ship without it.
- Monitored safety categories are logged without blanket rejection.
- Repeated rejected/ban-level violations can trigger a temporary restriction; severe violations block the account.
- Moderator/owner audit events remain persistent in the database.
- Admin safety endpoints expose moderation events and allow explicit restrict/unrestrict/unban actions.

## Moderator identity
Moderation actions that need to be attributed to a specific staff member (resolving reports, approving/rejecting/banning submissions) require a verified per-moderator session, not just the shared admin API key. A moderator sends `/moderatorlogin` to the bot (Telegram itself proves who they are), gets a one-time code valid for 5 minutes, and exchanges it — together with the admin API key — for a session token via `POST /api/admin/moderator-session`. That token (`X-Moderator-Session`) is what the admin panel then sends; it's a 32-byte random value held in memory for up to 12 hours and is never derived from anything the client can supply on its own. The `X-Admin-Key` alone can no longer be used to impersonate an arbitrary moderator. `OWNER`s can grant/revoke the `MODERATOR` role with `/promote` and `/demote`.

## Media proxy
`/api/media/:fileId` now requires a valid Telegram WebApp session (`telegramAuth`) — it's no longer an open, unauthenticated proxy to arbitrary Telegram file IDs.

## Important production notes
The current rate limiter is process-local. Before horizontal scaling, replace it with Redis-backed counters. Media-level classification, OCR, perceptual hashing, device/IP reputation, and a human-review workflow should be added before opening high-risk media/community features broadly. Keyword-based moderation remains a first line of defense — it does not catch paraphrased abuse, new slang, or non-listed-language content, and should be paired with human review for anything at scale.
