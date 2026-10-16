# Telegram ማዋቀሪያ

1. Telegram ላይ BotFather ይክፈቱ።
2. አዲስ bot ይፍጠሩ።
3. Token ወደ `.env` ውስጥ `TELEGRAM_BOT_TOKEN` ያስገቡ።
4. የTelegram numeric user IDዎን `TELEGRAM_OWNER_ID` ውስጥ ያስገቡ።
5. GENZI channel/group ይፍጠሩ።
6. Bot-ውን administrator ያድርጉት።
7. `GENZI_CHANNEL_ID` እና `GENZI_GROUP_ID` ያስገቡ።
8. Mini App ለማስጀመር HTTPS URL በ `WEBAPP_URL` ያስገቡ።

## አስፈላጊ
Bot API token በpublic repository ውስጥ አታስገቡ።


## የቻናል ልጥፎች ቁልፎች (Channel post buttons)

እያንዳንዱ የተለጠፈ የGENZI ቻናል ልጥፍ URL-ዓይነት Inline ቁልፎች ይኖሩታል፦ ▶️ Watch on <መድረክ> (አዘጋጁው በቅደም-ሰዌ "Link" ደረጃ ውስጥ የ YouTube፣ TikTok፣ Instagram፣ X፣ Facebook ወይም LinkedIn ኦፊሴላዊ የፖስት አገናኝ ካስገባ ብቻ)፣ 📖 Read More (Mini App ውስጥ ወደዚያ ልጥፍ በቀጥታ ይወስዳል)፣ 🔗 Share (የTelegram ባህሪያዊ የመካፈያ ሰሌዳ ይክፈታል) እና 💬 Discuss (ወደ GENZI ውይይት ቡድን)።

| ተለዋዋጭ | ዓላማ | ካልተዘጋጀ |
| --- | --- | --- |
| `TELEGRAM_BOT_USERNAME` | የቦት ሽም — 📖 Read More የMini App ጥልቅ-አገናኝ ለመገንባት | Read More ቁልፍ ይወገዳል (ማስጠንቀቂያ ይመዘገባል) |
| `GENZI_CHANNEL_USERNAME` | የቻናል ሽም (@ ያለ) — 🔗 Share አገናኝ ለመገንባት | Share ቁልፍ ይወገዳል |
| `GENZI_DISCUSSION_URL` | የውይይት ቡድን ሙሉ t.me ግብዣ አገናኝ — 💬 Discuss ለመክፈት | Discuss ቁልፍ ይወገዳል |

Share ቁልፍ ልጥፉ ከተለጠፈ በኋላ (በedit reply-markup) ይጨመራል — እውነተኛው የቻናል መልእክት ID ስለሚያስፈልገዋል። ረጅም (ብዙ-መልእክት) ልጥፎች ላይ ቁልፎቹ የሚጫኑት በመጀመሪያው መልእክት ላይ ብቻ ነው። "Approve & Publish" ከመጫንዎ በፊት የሚያዩት የግል ቅድመ-እይታ ከተለጠፈው ልጥፍ ጋር ሙሉ በሙሉ አንድ ነው (👤 ደራሲ · 📅 ቀን ያለው የግርጌ ክፍልን ጨምሮ) — WYSIWYG።
