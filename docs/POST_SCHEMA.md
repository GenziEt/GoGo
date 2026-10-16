# GENZI Standardized Post Contract

## Immutable display order

1. Media
2. Title
3. Body / Caption
4. Tags
5. Author + Timestamp

The same semantic schema is used by:
- Bot preview
- Mini App feed
- Detail view
- Search result representation
- Published Telegram content generation

## Rules

- Aspect ratio: 16:9
- Title: max 100 characters
- Body: max 6000 characters
- Tags: predefined category + up to 8 normalized tags
- No user-controlled typography
- No user-controlled colors
- No user-controlled alignment
- No custom CSS
- Server validates limits again
- `lockedSchema=true` on published posts
