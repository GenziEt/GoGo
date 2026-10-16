## Current release: v0.3.5 — Pre-Deployment Hardening

<p align="center"><img src="docs/assets/genzi-logo.png" alt="GENZI 🇪🇹" width="140"></p>

# GENZI 🇪🇹

Telegram-native Gen Z community ecosystem for Ethiopia.

## Language
Amharic is the default and complete user-facing language. English is available as an optional secondary language through the bot language setting.

## Included
- Telegram Bot powered by grammY
- Amharic-first UX
- English secondary locale
- Guided 4-step standardized post creation flow
- Draft → preparation → preview → publish
- One locked post schema and one reusable Mini App post component
- Automated moderation pipeline
- Quarantine/review workflow
- Zero-tolerance blocking for sexual exploitation, non-consensual intimate content, scams, fraud
- Links allowed only for owner/admin
- Forwarded content rejected
- Harassment, doxxing, threats, hate speech and dangerous-content categories are logged/handled according to the configured moderation policy without being blanket-rejected
- Owner + moderator roles
- Admin moderation queue
- SQLite zero-cost development database
- Prisma ORM
- Mini App foundation
- Admin dashboard foundation
- Opportunities hub: jobs, gigs, internships, scholarships, training, competitions and business opportunities
- Opportunity search, filtering, saving and detail pages
- Admin-managed verified opportunities with HTTPS application links
- No paid API dependency
- Docker-ready local deployment
- Strict TypeScript, no `any`

## Safety model
The initial build deliberately does not require a paid AI moderation API. The moderation engine is deterministic/rule-based and designed so an AI provider can be plugged in later after revenue.

The public identity of anonymous submissions is never shown. Moderators can see the minimum Telegram identity needed for enforcement.

## Quick start

1. Copy `.env.example` to `apps/bot/.env` for local development (`npm run dev` runs with that folder as its working directory, so that's where dotenv looks). For `docker-compose`, also copy it to `.env` at the repo root — `docker-compose.yml` reads `env_file: .env` from there. Keep both in sync, or symlink one to the other.
2. Create a Telegram bot using BotFather and put the token in `TELEGRAM_BOT_TOKEN`.
3. Put your Telegram numeric user ID in `TELEGRAM_OWNER_ID`.
4. Run:

```bash
npm install
npm run db:generate
npm run db:push
npm run dev
```

For the Mini App, set `WEBAPP_URL` to the deployed HTTPS URL. During local development the bot works without the Mini App URL.

### Channel post buttons (v0.3.7)

Every published GENZI channel post carries URL-type inline buttons: ▶️ Watch on <Platform> (only when the author supplied an official YouTube/TikTok/Instagram/X/Facebook/LinkedIn link in the wizard's Link step), 📖 Read More (deep-links into the Mini App at that exact post), 🔗 Share (opens Telegram's native share sheet) and 💬 Discuss (the GENZI discussion group). Buttons degrade gracefully — each row is skipped silently if its variable is unset:

| Variable | Purpose | If missing |
| --- | --- | --- |
| `TELEGRAM_BOT_USERNAME` | Bot handle used to build the Mini App deep link (`https://t.me/<bot>/genzi?startapp=post_<slug>`) behind 📖 Read More | Read More button is skipped (a warning is logged) |
| `GENZI_CHANNEL_USERNAME` | Public channel handle (without `@`) used to build the `https://t.me/share/url?...` link behind 🔗 Share | Share button is skipped |
| `GENZI_DISCUSSION_URL` | Full `t.me/...` invite link of the GENZI discussion group behind 💬 Discuss | Discuss button is skipped |

The Share button is attached right after publishing (via edit reply-markup) so it can reference the real channel message id; long multi-message posts carry the keyboard on the first message only. The private preview shown before "Approve & Publish" renders the identical caption (including the 👤 Author · 📅 date footer) and buttons, so what the author sees is exactly what goes live.

## Important
Telegram bots cannot create a Telegram channel/group for you. Create the GENZI channel/group manually in Telegram, add the bot with the required administrator permissions, and configure the IDs in `.env`.

This repository is a working foundation. Production deployment should additionally use HTTPS, backups, secret management, rate limiting, Telegram webhook mode, and a durable object/media store.


## v0.1.1 implemented
- Persistent Telegram conversation sessions in SQLite instead of in-memory state.
- Group/supergroup enforcement for forwarded content and non-admin links, plus moderation event logging.
- Owner/moderator-aware moderation actions.
- API CORS configuration and protected admin statistics endpoint.
- Mini App API base URL can be configured with `VITE_API_URL`.

This release remains zero-paid-service: moderation is local/deterministic and storage is SQLite.

## Release status

**v0.1.1** is the next working foundation package. It strengthens the Telegram-native core with durable post conversations and server-side group moderation enforcement. See `CHANGELOG.md` for the changes in this release.

## v0.1.2 changes
- Real Telegram channel publication from the locked post workflow.
- Telegram WebApp `initData` validation on the API.
- `/api/me` Telegram-authenticated endpoint.
- Admin moderation-event API endpoint.
- Published posts store Telegram message/chat identifiers.
- Mini App initializes the Telegram WebApp SDK and sends authenticated headers.

## v0.1.3 operational notes
- Admin API actions require both `X-Admin-Key` and `X-Moderator-Telegram-ID`; the Telegram ID must belong to an OWNER or MODERATOR account.
- The Mini App reads `VITE_API_URL` and uses `/api/media/:fileId` for Telegram-hosted media through the backend proxy.
- Quarantined submissions appear in the admin queue. Approving them publishes them to `GENZI_CHANNEL_ID` and records the Telegram message reference.

### v0.1.6 community layer
The Mini App now supports persistent comments on published posts. Comment creation uses Telegram WebApp authentication and the same local moderation engine used for submissions. Comments are limited to 600 characters and are stored locally in SQLite through Prisma.

## v0.1.7 Community Identity
Profiles, bookmarks and lightweight local feed personalization are now included. Personalization uses only first-party GENZI interaction events stored locally; no external recommendation API is required.

## v0.1.8 additions
- Creator following with persistent follower relationships.
- Public creator profiles and follower counts.
- In-app notifications for follows, comments, and reactions.
- Notification unread count and mark-all-read support.
- Feed-level follow controls.

After pulling this version, run `npm install`, then `npm run db:generate` and `npm run db:push` before starting the services.


## v0.1.9 — Discovery & Following Feed
- For You, Following, and Trending feeds with pagination.
- Creator discovery cards and public creator profiles.
- Notification-to-post deep links.
- Single-post API retrieval and paginated feed metadata.
- Trending uses local engagement events only; no paid analytics/API service.


## v0.2.0 additions
- Creator dashboard: followers, following, posts, views, reactions and comments.
- Public creator profiles include published post feeds with pagination.
- New authenticated creator analytics APIs.


## v0.2.1 Communities
Community discovery, creation, membership, community feeds, and moderated community post attachment are now included. Communities use the existing Telegram-authenticated Mini App and require no paid external service.


### v0.2.6 interactive layer
Events, RSVP, polls, voting, quizzes, scoring, and interactive community participation are now included in the Telegram Mini App.


## v0.2.5 Gamification
XP, levels, streaks, badges, milestone rewards, leaderboard and activity history are included in this release.


## v0.2.5 Trust & Safety

GENZI now enforces blocked/restricted accounts, route-aware API rate limiting, hardened Unicode/zero-width text normalization, stronger scam/fraud/OTP detection, repeated-violation temporary restrictions, and admin safety-event controls. See `docs/TRUST_SAFETY.md`.


## v0.2.8 Growth
Referral deep links, one-time attribution, internal referral rewards, share tracking, and growth analytics are included. See `docs/GROWTH.md`.


## v0.3.0 Production Reliability
Production-oriented health/readiness checks, structured JSON logging, webhook mode, graceful shutdown, environment hardening, Docker healthchecks, PostgreSQL-ready schema, and backup/deployment documentation are included. See `docs/PRODUCTION.md`.


## v0.3.0 Social Layer
Direct messaging, unread/read state, profile-to-message flows, and persistent post reposts are included. See `docs/SOCIAL.md`.
