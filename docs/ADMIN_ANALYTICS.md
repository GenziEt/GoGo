# GENZI Admin & Analytics

## v0.2.6

The admin application now exposes operational analytics for users, content, communities, opportunities, events, polls, quizzes, engagement and safety.

### API
- `GET /api/admin/analytics?days=14` — overview, daily activity series, content categories, creator activity and safety breakdowns.
- `GET /api/admin/users?limit=50` — recent user operational list with role, restriction state, XP/level and participation counts.

All admin endpoints require the existing `adminAuth` credentials.

### Dashboard
The admin app provides Amharic-first tabs for overview, analytics, safety and users. The analytics chart is intentionally lightweight and uses no external analytics provider.
