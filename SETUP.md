# Apartment buy companion

Live shared apartment tracker for Modiin house hunt.

## Stack
- **GitHub Pages** — hosts the website
- **Supabase** — shared database (apartments + your relevance marks)
- **Telegram bot** `@bu_companion_bot` — links / text / photos → site (Supabase Edge Function webhook, near-realtime)
- **Gemini Flash** — parses free-text descriptions and listing photos into apartment rows

## Add the bot to your group

1. Open your Telegram group
2. Tap the group name → **Add members**
3. Search **`@bu_companion_bot`** → add it
4. **Important — let the bot read group messages:**
   - Open a chat with **@BotFather**
   - Send `/mybots` → choose **buy_companion** / `@bu_companion_bot`
   - **Bot Settings** → **Group Privacy** → **Turn off**
   - If the bot was already in the group, remove it and add it again after turning privacy off

## How to use (Telegram `@bu_companion_bot`)
- `/help` — short usage
- Paste a Yad2 / Madlan / Keyz link → added immediately
- Or send a text description and/or photos → Gemini parses it
- `/add שם | מחיר | חדרים | קישור` — manual add
- `/costs` — Gemini usage/cost today and total
- Duplicates (same URL or same street+price) update the existing row
- Appears on the site within a few seconds

## Secrets (GitHub Actions)
- `TELEGRAM_BOT_TOKEN`
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
- `GEMINI_API_KEY` from https://aistudio.google.com/apikey

## View the database
Supabase dashboard → **Table Editor** → `apartments` / `verdicts`
