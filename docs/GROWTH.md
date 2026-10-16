# GENZI Growth & Viral Loops

## v0.2.8

Growth is built around Telegram-native referrals and share attribution without paid services.

### Referral loop
- Each authenticated user receives a persistent unique `GZ...` referral code.
- The Mini App exposes a Telegram deep link: `https://t.me/<BOT_USERNAME>?start=ref_<CODE>`.
- The bot reads the `ref_` start payload and completes attribution when the invited account is created/opens the bot.
- Each invitee can be attributed only once.
- Self-referrals are rejected.
- Successful referral rewards: inviter +50 internal GENZI Coins; invitee +20 internal GENZI Coins.

Coins remain internal promotional/test credits in this release and are not cash or withdrawable funds.

### Share attribution
Share/copy actions are recorded as `GrowthEvent` records. A short duplicate window prevents accidental double-counting.

### Configuration
Set `TELEGRAM_BOT_USERNAME` to the bot's public username without `@` so referral links can be generated.

### Data models
- `ReferralProfile` — persistent referral code per user.
- `Referral` — one-time inviter/invitee attribution and reward record.
- `GrowthEvent` — share and growth activity telemetry.
