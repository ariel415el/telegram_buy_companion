# Apartment buy companion

Live shared apartment tracker for Modiin house hunt.

## Stack
- **GitHub Pages** — hosts the website
- **Supabase** — shared database (apartments + your relevance marks)
- **Telegram bot** — paste listing links in a group; they appear on the site

## What you need to do now

### Step A — Supabase SQL (in the website, not on your PC)
1. Open your Supabase project
2. Left sidebar → **SQL Editor** → **New query**
3. Open `supabase/schema.sql` on your computer → Ctrl+A → Ctrl+C
4. Paste into Supabase → **Run**
5. New query → open `supabase/seed.sql` → copy all → paste → **Run**
6. **Project Settings** (gear) → **API Keys**
7. Reply here with:
   - Project URL (`https://xxxxx.supabase.co`)
   - anon / public key
   - service_role / secret key

### Step B — Telegram bot
1. Telegram → **@BotFather** → `/newbot`
2. Reply here with the **bot token**
3. Create a group → add you, your wife, and the bot

### Step C — I’ll finish
After you paste those keys, I’ll connect config, deploy the bot, and push to:
https://github.com/ariel415el/telegram_buy_companion
