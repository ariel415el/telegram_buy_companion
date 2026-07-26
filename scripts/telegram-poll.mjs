#!/usr/bin/env node
// Poll Telegram getUpdates and upsert listings into Supabase.
// Env: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OFFSET_FILE = process.env.OFFSET_FILE || ".telegram-offset";

if (!TOKEN || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("missing env secrets");
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${TOKEN}`;

async function main() {
  const offset = existsSync(OFFSET_FILE)
    ? Number(readFileSync(OFFSET_FILE, "utf8").trim()) || 0
    : 0;

  const updates = await tg("getUpdates", {
    offset,
    timeout: 0,
    allowed_updates: ["message", "edited_message"],
  });

  let next = offset;
  for (const update of updates.result || []) {
    next = Math.max(next, update.update_id + 1);
    try {
      await handleUpdate(update);
    } catch (err) {
      console.error("update failed", update.update_id, err);
    }
  }

  writeFileSync(OFFSET_FILE, String(next));
  console.log(`processed ${(updates.result || []).length} updates; next offset ${next}`);
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg?.text && !msg?.caption) return;

  const text = (msg.text || msg.caption || "").trim();
  const chatId = msg.chat.id;

  if (text.startsWith("/start") || text.startsWith("/help")) {
    await send(
      chatId,
      "שלחו קישור למודעה (Yad2 / Madlan / Keyz) ואני אוסיף לטבלת הדירות.\n" +
        "אפשר גם: /add שם | מחיר | חדרים | קישור"
    );
    return;
  }

  if (text.startsWith("/add ") || text.startsWith("/add@")) {
    const body = text.replace(/^\/add(?:@\w+)?\s*/, "");
    const apt = parseManualAdd(body);
    if (!apt) {
      await send(chatId, "פורמט: /add שם | מחיר | חדרים | קישור");
      return;
    }
    const error = await upsertApartment(apt);
    await send(chatId, error ? `שגיאה: ${error}` : `נוספה: ${apt.name}`);
    return;
  }

  const urls = extractUrls(text);
  if (!urls.length) return;

  const results = [];
  for (const url of urls) {
    const apt = listingFromUrl(url, text);
    if (!apt) {
      results.push(`לא זיהיתי מודעה: ${url}`);
      continue;
    }
    const error = await upsertApartment(apt);
    results.push(error ? `שגיאה עבור ${apt.name}: ${error}` : `נוספה/עודכנה: ${apt.name}`);
  }
  await send(chatId, results.join("\n"));
}

async function tg(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function send(chatId, text) {
  await tg("sendMessage", { chat_id: chatId, text });
}

async function upsertApartment(apt) {
  const row = { ...apt, updated_at: new Date().toISOString() };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/apartments?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) return await res.text();

  await fetch(`${SUPABASE_URL}/rest/v1/verdicts?on_conflict=apartment_id`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({
      apartment_id: apt.id,
      relevant: true,
      note: "",
      updated_at: new Date().toISOString(),
    }),
  });
  return null;
}

function extractUrls(text) {
  const re = /https?:\/\/[^\s<>"']+/g;
  return [...new Set((text.match(re) || []).map((u) => u.replace(/[).,;]+$/, "")))];
}

function slugId(input) {
  return (
    "tg-" +
    input
      .toLowerCase()
      .replace(/https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
  );
}

function parseManualAdd(body) {
  const parts = body.split("|").map((p) => p.trim());
  if (parts.length < 1 || !parts[0]) return null;
  const [name, priceRaw, roomsRaw, url] = parts;
  const price = priceRaw ? Number(String(priceRaw).replace(/[^\d]/g, "")) : null;
  const rooms = roomsRaw ? Number(roomsRaw) : null;
  return {
    id: slugId(url || name),
    name,
    price: Number.isFinite(price) ? price : null,
    rooms: Number.isFinite(rooms) ? rooms : null,
    url: url || null,
    source: "telegram-manual",
    neighborhood: "",
    built: null,
    garden: null,
    visited: false,
    expired: false,
    thumb: null,
    chat_notes: body,
  };
}

function listingFromUrl(url, context) {
  let name = "דירה מטלגרם";
  let source = "telegram";
  if (/yad2\.co\.il/i.test(url)) {
    name = "מודעת יד2";
    source = "telegram-yad2";
  } else if (/madlan\.co\.il/i.test(url)) {
    name = "מודעת מדלן";
    source = "telegram-madlan";
  } else if (/keyz\.ai/i.test(url)) {
    name = "מודעת Keyz";
    source = "telegram-keyz";
  }
  return {
    id: slugId(url),
    name,
    url,
    source,
    neighborhood: "",
    price: extractPrice(context),
    rooms: extractRooms(context),
    built: null,
    garden: null,
    visited: false,
    expired: false,
    thumb: null,
    chat_notes: context.slice(0, 300),
  };
}

function extractPrice(text) {
  const m =
    text.match(/(\d{1,2}(?:[.,]\d{3}){2,})\s*₪?/) ||
    text.match(/(\d(?:\.\d)?)\s*מ['׳']?/);
  if (!m) return null;
  let raw = m[1];
  if (raw.includes(".") && raw.length <= 4) return Math.round(parseFloat(raw) * 1_000_000);
  raw = raw.replace(/[^\d]/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function extractRooms(text) {
  const m = text.match(/(\d+(?:\.\d)?)\s*חדר/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
