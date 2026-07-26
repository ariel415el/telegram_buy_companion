# Apartment buy companion

Live shared apartment tracker for Modiin house hunt.

## Stack
- **GitHub Pages** — hosts the website
- **Supabase** — shared database (apartments + your relevance marks)
- **Telegram bot** `@bu_companion_bot` — paste listing links; they appear on the site (via GitHub Action poller every minute)

## Add the bot to your group

1. Open your Telegram group
2. Tap the group name → **Add members**
3. Search **`@bu_companion_bot`** → add it
4. **Important — let the bot read group messages:**
   - Open a chat with **@BotFather**
   - Send `/mybots` → choose **buy_companion** / `@bu_companion_bot`
   - **Bot Settings** → **Group Privacy** → **Turn off**
   - If the bot was already in the group, remove it and add it again after turning privacy off

## How to use
- Paste a Yad2 / Madlan / Keyz link in the group (or DM the bot)
- Or: `/add שם | מחיר | חדרים | קישור`
- Within about a minute it appears on the site

## View the database
Supabase dashboard → **Table Editor** → `apartments` / `verdicts`
