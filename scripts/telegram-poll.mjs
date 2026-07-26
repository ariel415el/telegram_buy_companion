#!/usr/bin/env node
// Poll Telegram getUpdates and upsert listings into Supabase.
// Env: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OFFSET_FILE = process.env.OFFSET_FILE || ".telegram-offset";
const THUMB_BUCKET = "listing-thumbs";
const META_BUCKET = "bot-meta";
const USAGE_OBJECT = "gemini-usage.json";
const GEMINI_MODEL = "gemini-flash-lite-latest";
const MAX_PHOTOS = 4;
const SITE_URL = "https://ariel415el.github.io/telegram_buy_companion/";
const SITE_LINK = "סיכום דירות";
// Flash-Lite list price (USD / 1M tokens). Free-tier AI Studio keys bill $0.
const GEMINI_USD_PER_M_IN = 0.1;
const GEMINI_USD_PER_M_OUT = 0.4;
const GEMINI_FREE_RPD = 1000;

if (!TOKEN || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("missing env secrets (need TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.warn("GEMINI_API_KEY missing — URL/commands only; text/photo listings will be skipped");
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

  const raw = updates.result || [];
  let next = offset;
  for (const update of raw) {
    next = Math.max(next, update.update_id + 1);
  }

  const jobs = buildJobs(raw);
  for (const job of jobs) {
    try {
      await handleJob(job);
    } catch (err) {
      console.error("job failed", job.chatId, err);
    }
  }

  writeFileSync(OFFSET_FILE, String(next));
  console.log(`processed ${raw.length} updates → ${jobs.length} jobs; next offset ${next}`);
}

/** Merge media-group albums in one poll batch; skip non-message updates. */
function buildJobs(updates) {
  const groups = new Map();
  const singles = [];

  for (const update of updates) {
    const msg = update.message || update.edited_message;
    if (!msg) continue;
    if (msg.media_group_id) {
      const key = `${msg.chat.id}:${msg.media_group_id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(msg);
    } else {
      singles.push(msg);
    }
  }

  const jobs = [];
  for (const msgs of groups.values()) {
    jobs.push(jobFromMessages(msgs));
  }
  for (const msg of singles) {
    jobs.push(jobFromMessages([msg]));
  }
  return jobs;
}

function jobFromMessages(msgs) {
  const chatId = msgs[0].chat.id;
  const texts = msgs.map((m) => (m.text || m.caption || "").trim()).filter(Boolean);
  const text = texts.join("\n").trim();
  const photos = [];
  for (const m of msgs) {
    const fileId = largestPhotoFileId(m);
    if (fileId) photos.push(fileId);
  }
  return { chatId, text, photoFileIds: photos.slice(0, MAX_PHOTOS), msgs };
}

function largestPhotoFileId(msg) {
  if (!msg.photo?.length) return null;
  return msg.photo[msg.photo.length - 1].file_id;
}

const HELP_TEXT =
  "מוסיף דירות לאתר המשותף שלנו.\n" +
  `אתר: <a href="${SITE_URL}">${SITE_LINK}</a>\n\n` +
  "איך להשתמש:\n" +
  "• שלחו קישור (יד2 / מדלן / Keyz) — מתווסף ישר\n" +
  "• או תיאור + תמונות — AI מפרסר ומוסיף\n" +
  "• /add שם | מחיר | חדרים | קישור — הוספה ידנית\n" +
  "• /costs — כמה עלה Gemini היום ובסה״כ\n" +
  "• /help — ההודעה הזו\n\n" +
  "דירה שכבר קיימת מתעדכנת במקום להיווצר פעמיים.";

async function handleJob(job) {
  const { chatId, text, photoFileIds } = job;

  if (
    text.startsWith("/start") ||
    text.startsWith("/help") ||
    text.startsWith("/start@") ||
    text.startsWith("/help@")
  ) {
    await send(chatId, HELP_TEXT, { html: true });
    return;
  }

  if (text.startsWith("/costs") || text.startsWith("/costs@")) {
    await send(chatId, await formatCostsMessage());
    return;
  }

  if (text.startsWith("/add ") || text.startsWith("/add@")) {
    const body = text.replace(/^\/add(?:@\w+)?\s*/, "");
    const apt = parseManualAdd(body);
    if (!apt) {
      await send(chatId, "פורמט: /add שם | מחיר | חדרים | קישור");
      return;
    }
    const { error, created } = await saveApartment(apt);
    await send(
      chatId,
      error ? `שגיאה: ${error}` : created ? `נוספה: ${apt.name}` : `כבר קיימת, עודכנה: ${apt.name}`
    );
    return;
  }

  const listingUrls = extractUrls(text).filter(isListingUrl);
  if (listingUrls.length) {
    const results = [];
    for (const url of listingUrls) {
      const apt = listingFromUrl(url, text);
      const { error, created } = await saveApartment(apt);
      results.push(
        error
          ? `שגיאה עבור ${apt.name}: ${error}`
          : created
            ? `נוספה: ${apt.name}`
            : `כבר קיימת, עודכנה: ${apt.name}`
      );
    }
    await send(chatId, results.join("\n"));
    return;
  }

  if (!text && !photoFileIds.length) return;

  if (!GEMINI_API_KEY) {
    console.warn("skipping text/photo job — no GEMINI_API_KEY");
    return;
  }

  const images = [];
  for (const fileId of photoFileIds) {
    const img = await downloadTelegramFile(fileId);
    if (img) images.push(img);
  }

  const parsed = await parseWithGemini(text, images);
  if (!parsed || parsed.is_apartment === false) {
    console.log("gemini: not an apartment listing, ignoring");
    return;
  }

  const apt = normalizeGeminiApt(parsed, text);
  if (!apt?.name) {
    console.log("gemini: missing name, ignoring");
    return;
  }

  if (images.length) {
    const thumbUrl = await uploadThumb(apt.id, images[0]);
    if (thumbUrl) apt.thumb = thumbUrl;
  }

  const { error, created } = await saveApartment(apt);
  await send(
    chatId,
    error
      ? `שגיאה: ${error}`
      : `${created ? "נוספה" : "כבר קיימת, עודכנה"} (AI): ${apt.name}${
          apt.price ? ` · ${apt.price.toLocaleString("en-US")} ₪` : ""
        }`
  );
}

function isListingUrl(url) {
  return /yad2\.co\.il|madlan\.co\.il|keyz\.ai|facebook\.com|fb\.watch|madlan\.com/i.test(url);
}

async function downloadTelegramFile(fileId) {
  const meta = await tg("getFile", { file_id: fileId });
  const path = meta.result?.file_path;
  if (!path) return null;
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${path}`);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = path.endsWith(".png")
    ? "image/png"
    : path.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
  return { mime, data: buf.toString("base64"), bytes: buf };
}

async function parseWithGemini(text, images) {
  const parts = [
    {
      text:
        `You extract Modiin (Israel) apartment listings from a couple's Telegram house-hunt chat.\n` +
        `Return ONLY a JSON object (no markdown) with keys:\n` +
        `is_apartment (boolean), id (slug string), name (Hebrew string), neighborhood (string),\n` +
        `price (integer ILS or null; convert 2.89מ / 2.89M to 2890000), rooms (number or null),\n` +
        `built (number sqm or null), garden (string sqm or null), url (string or null),\n` +
        `chat_notes (short Hebrew summary of extras/opinions).\n` +
        `If the message is casual chat and not a listing, set is_apartment=false.\n` +
        `id: ascii slug like street-neighborhood-hint, lowercase, hyphens, max 60 chars.\n` +
        `name: like "רחוב — שכונה" with rooms/garden hint if useful.\n\n` +
        `Message text:\n${text || "(no text, images only)"}`,
    },
  ];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) {
    console.error("gemini error", await res.text());
    return null;
  }
  const data = await res.json();
  await logGeminiUsage(data.usageMetadata || {});
  const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return parseJsonLoose(raw);
}

function parseJsonLoose(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}

function normalizeGeminiApt(parsed, fallbackNotes) {
  const name = String(parsed.name || "").trim();
  const idBase = String(parsed.id || name || "listing").trim();
  const id = slugId(idBase).replace(/^tg-/, "tg-ai-");
  const price = toNum(parsed.price);
  const rooms = toNum(parsed.rooms);
  const built = toNum(parsed.built);
  let garden = parsed.garden;
  if (garden != null && garden !== "") garden = String(garden);
  else garden = null;

  return {
    id,
    name: name || "דירה מטלגרם",
    neighborhood: String(parsed.neighborhood || ""),
    price,
    rooms,
    built,
    garden,
    url: parsed.url ? String(parsed.url) : null,
    source: "telegram-gemini",
    visited: false,
    expired: false,
    thumb: null,
    chat_notes: String(parsed.chat_notes || fallbackNotes || "").slice(0, 500),
  };
}

function toNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    const s = v.trim();
    // 2.85מ / 2.85M → millions
    const mil = s.match(/^(\d+(?:\.\d+)?)\s*[מmM](?:illion|׳|'|)?$/i);
    if (mil) return Math.round(parseFloat(mil[1]) * 1_000_000);
    const cleaned = s.replace(/[^\d.-]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function ensureThumbBucket() {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id: THUMB_BUCKET,
      name: THUMB_BUCKET,
      public: true,
      file_size_limit: 5_000_000,
      allowed_mime_types: ["image/jpeg", "image/png", "image/webp"],
    }),
  });
  // 200 created, 409 already exists — both fine
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    if (!/already exists|Duplicate/i.test(body)) {
      console.error("ensureThumbBucket", res.status, body);
    }
  }
}

async function uploadThumb(aptId, image) {
  await ensureThumbBucket();
  const ext = image.mime === "image/png" ? "png" : image.mime === "image/webp" ? "webp" : "jpg";
  const hash = createHash("sha1").update(image.bytes).digest("hex").slice(0, 8);
  const path = `${aptId}-${hash}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${THUMB_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": image.mime,
      "x-upsert": "true",
    },
    body: image.bytes,
  });
  if (!res.ok) {
    console.error("uploadThumb", await res.text());
    return null;
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${THUMB_BUCKET}/${path}`;
}

async function tg(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function send(chatId, text, { html = false } = {}) {
  const body = { chat_id: chatId, text };
  if (html) {
    body.parse_mode = "HTML";
    body.disable_web_page_preview = false;
  }
  await tg("sendMessage", body);
}

function estimateCostUsd(promptTokens, outputTokens) {
  return (promptTokens / 1e6) * GEMINI_USD_PER_M_IN + (outputTokens / 1e6) * GEMINI_USD_PER_M_OUT;
}

function fmtUsd(n) {
  if (n < 0.0001) return "$0.0000";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

async function ensureMetaBucket() {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: META_BUCKET, name: META_BUCKET, public: false }),
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    if (!/already exists|Duplicate/i.test(body)) console.error("ensureMetaBucket", res.status, body);
  }
}

async function loadUsageLog() {
  await ensureMetaBucket();
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${META_BUCKET}/${USAGE_OBJECT}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (res.status === 404) return { entries: [] };
  if (!res.ok) {
    console.error("loadUsageLog", await res.text());
    return { entries: [] };
  }
  try {
    const data = await res.json();
    return { entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    return { entries: [] };
  }
}

async function saveUsageLog(log) {
  await ensureMetaBucket();
  const body = JSON.stringify(log);
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${META_BUCKET}/${USAGE_OBJECT}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      "x-upsert": "true",
    },
    body,
  });
  if (!res.ok) console.error("saveUsageLog", await res.text());
}

async function logGeminiUsage(usage) {
  const prompt = Number(usage.promptTokenCount || 0);
  const output = Number(usage.candidatesTokenCount || 0);
  const total = Number(usage.totalTokenCount || prompt + output);
  const entry = {
    ts: new Date().toISOString(),
    model: GEMINI_MODEL,
    promptTokens: prompt,
    outputTokens: output,
    totalTokens: total,
    listPriceUsd: estimateCostUsd(prompt, output),
  };
  const log = await loadUsageLog();
  log.entries.push(entry);
  // keep last ~2000 calls
  if (log.entries.length > 2000) log.entries = log.entries.slice(-2000);
  await saveUsageLog(log);
  return entry;
}

function dayKey(iso) {
  return String(iso || "").slice(0, 10); // YYYY-MM-DD UTC
}

async function formatCostsMessage() {
  const log = await loadUsageLog();
  const today = dayKey(new Date().toISOString());
  const entries = log.entries || [];
  const todayEntries = entries.filter((e) => dayKey(e.ts) === today);

  const sum = (arr, key) => arr.reduce((s, e) => s + Number(e[key] || 0), 0);
  const todayList = sum(todayEntries, "listPriceUsd");
  const totalList = sum(entries, "listPriceUsd");
  const todayCalls = todayEntries.length;
  const totalCalls = entries.length;
  const todayIn = sum(todayEntries, "promptTokens");
  const todayOut = sum(todayEntries, "outputTokens");
  const totalIn = sum(entries, "promptTokens");
  const totalOut = sum(entries, "outputTokens");
  const leftToday = Math.max(0, GEMINI_FREE_RPD - todayCalls);

  return (
    "עלויות Gemini (מעקב מהבוט)\n\n" +
    `היום (${today} UTC):\n` +
    `• ${todayCalls} קריאות · ${todayIn + todayOut} טוקנים\n` +
    `• מחיר מחירון: ${fmtUsd(todayList)}\n` +
    `• חיוב בפועל: $0 (free tier)\n\n` +
    `סה״כ מאז תחילת המעקב:\n` +
    `• ${totalCalls} קריאות · ${totalIn + totalOut} טוקנים\n` +
    `• מחיר מחירון: ${fmtUsd(totalList)}\n` +
    `• חיוב בפועל: $0 (free tier)\n\n` +
    `יתרה בחבילה:\n` +
    `• אין יתרת כסף (מפתח free / AI Studio)\n` +
    `• מכסת בקשות יומית משוערת: ${leftToday} מתוך ~${GEMINI_FREE_RPD} נותרו היום\n\n` +
    `מודל: ${GEMINI_MODEL}`
  );
}

/** Save apartment, reusing an existing row when URL/name+price match. */
async function saveApartment(apt) {
  const existing = await findDuplicate(apt);
  const row = {
    ...apt,
    id: existing?.id || apt.id,
    // keep existing thumb if new one missing
    thumb: apt.thumb || existing?.thumb || null,
    visited: existing?.visited ?? apt.visited ?? false,
    expired: existing?.expired ?? apt.expired ?? false,
    updated_at: new Date().toISOString(),
  };
  const error = await upsertApartment(row);
  return { error, created: !existing, id: row.id };
}

async function listApartments() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/apartments?select=id,name,neighborhood,price,rooms,url,thumb,visited,expired`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    }
  );
  if (!res.ok) {
    console.error("listApartments", await res.text());
    return [];
  }
  return res.json();
}

async function findDuplicate(apt) {
  const rows = await listApartments();
  const urlKey = listingKey(apt.url);
  if (urlKey) {
    const byUrl = rows.find((r) => listingKey(r.url) === urlKey);
    if (byUrl) return byUrl;
  }
  return rows.find((r) => isSameListing(apt, r)) || null;
}

function listingKey(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    if (/yad2\.co\.il$/i.test(host)) {
      const m = path.match(/\/(?:item\/(?:[^/]+\/)?|s\/c\/)([a-z0-9]+)/i) || path.match(/\/([a-z0-9]{6,})$/i);
      return m ? `yad2:${m[1].toLowerCase()}` : `yad2:${path}`;
    }
    if (/madlan\.co\.il$/i.test(host)) {
      const m = path.match(/\/listings\/([^/]+)/i);
      return m ? `madlan:${m[1]}` : `madlan:${path}`;
    }
    if (/keyz\.ai$/i.test(host)) {
      const m = path.match(/\/listings\/([^/]+)/i);
      return m ? `keyz:${m[1]}` : `keyz:${path}`;
    }
    if (/facebook\.com|fb\.watch/i.test(host)) {
      return `fb:${path}`;
    }
    return `${host}${path}`;
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function normTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[״"']/g, "")
    .replace(/[^\u0590-\u05ffa-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function isSameListing(a, b) {
  if (a.price != null && b.price != null && Number(a.price) !== Number(b.price)) return false;
  if (a.rooms != null && b.rooms != null && Number(a.rooms) !== Number(b.rooms)) return false;

  const aTokens = new Set([...normTokens(a.name), ...normTokens(a.neighborhood)]);
  const bTokens = new Set([...normTokens(b.name), ...normTokens(b.neighborhood)]);
  if (!aTokens.size || !bTokens.size) return false;

  let inter = 0;
  for (const t of aTokens) if (bTokens.has(t)) inter++;
  const union = aTokens.size + bTokens.size - inter;
  const jaccard = inter / union;
  // same price (or both null) + overlapping street/neighborhood tokens
  return jaccard >= 0.45 && inter >= 2;
}

async function upsertApartment(apt) {
  const row = { ...apt, updated_at: apt.updated_at || new Date().toISOString() };
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
  const ascii = String(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/https?:\/\//, "")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  if (ascii.length >= 4) return "tg-" + ascii;
  const h = createHash("sha1").update(String(input)).digest("hex").slice(0, 10);
  return "tg-" + (ascii ? ascii + "-" : "") + h;
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
