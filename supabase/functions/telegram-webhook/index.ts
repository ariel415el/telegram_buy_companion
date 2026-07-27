// Supabase Edge Function — Telegram webhook (near-realtime)
// Secrets: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY

const TELEGRAM_API = "https://api.telegram.org";
const THUMB_BUCKET = "listing-thumbs";
const META_BUCKET = "bot-meta";
const USAGE_OBJECT = "gemini-usage.json";
const GEMINI_MODEL = "gemini-flash-lite-latest";
const MAX_PHOTOS = 4;
const SITE_URL = "https://ariel415el.github.io/telegram_buy_companion/";
const SITE_LINK = "סיכום דירות";
const GEMINI_USD_PER_M_IN = 0.1;
const GEMINI_USD_PER_M_OUT = 0.4;
const GEMINI_FREE_RPD = 1000;

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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok", { status: 200 });

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const geminiKey = Deno.env.get("GEMINI_API_KEY") || "";
  if (!token || !supabaseUrl || !serviceKey) {
    return json({ error: "missing secrets" }, 500);
  }

  const env = { token, supabaseUrl, serviceKey, geminiKey };
  try {
    const update = await req.json();
    const msg = update.message || update.edited_message;
    if (!msg) return json({ ok: true });

    // Album parts without caption: skip (captioned part handles the listing)
    const text = (msg.text || msg.caption || "").trim();
    const photoId = largestPhotoFileId(msg);
    if (msg.media_group_id && !text && photoId) return json({ ok: true });

    await handleMessage(env, msg.chat.id, text, photoId ? [photoId] : []);
    return json({ ok: true });
  } catch (err) {
    console.error("webhook error", err);
    return json({ ok: true, error: String(err) });
  }
});

async function handleMessage(
  env: Env,
  chatId: number,
  text: string,
  photoFileIds: string[],
) {
  if (
    text.startsWith("/start") || text.startsWith("/help") ||
    text.startsWith("/start@") || text.startsWith("/help@")
  ) {
    await send(env.token, chatId, HELP_TEXT, true);
    return;
  }

  if (text.startsWith("/costs") || text.startsWith("/costs@")) {
    await send(env.token, chatId, await formatCostsMessage(env));
    return;
  }

  if (text.startsWith("/add ") || text.startsWith("/add@")) {
    const body = text.replace(/^\/add(?:@\w+)?\s*/, "");
    const apt = parseManualAdd(body);
    if (!apt) {
      await send(env.token, chatId, "פורמט: /add שם | מחיר | חדרים | קישור");
      return;
    }
    const { error, created } = await saveApartment(env, apt);
    await send(
      env.token,
      chatId,
      error ? `שגיאה: ${error}` : created ? `נוספה: ${apt.name}` : `כבר קיימת, עודכנה: ${apt.name}`,
    );
    return;
  }

  const listingUrls = extractUrls(text).filter(isListingUrl);
  if (listingUrls.length) {
    const results: string[] = [];
    for (const url of listingUrls) {
      const apt = listingFromUrl(url, text);
      await enrichFromListingPage(env, apt);
      const { error, created } = await saveApartment(env, apt);
      results.push(
        error
          ? `שגיאה עבור ${apt.name}: ${error}`
          : created
          ? `נוספה: ${apt.name}`
          : `כבר קיימת, עודכנה: ${apt.name}`,
      );
    }
    await send(env.token, chatId, results.join("\n"));
    return;
  }

  if (!text && !photoFileIds.length) return;

  if (!env.geminiKey) {
    console.warn("no GEMINI_API_KEY");
    return;
  }

  const images: ImageBlob[] = [];
  for (const fileId of photoFileIds.slice(0, MAX_PHOTOS)) {
    const img = await downloadTelegramFile(env.token, fileId);
    if (img) images.push(img);
  }

  const parsed = await parseWithGemini(env, text, images);
  if (!parsed || parsed.is_apartment === false) return;

  const apt = normalizeGeminiApt(parsed, text);
  if (!apt?.name) return;

  if (images.length) {
    const thumbUrl = await uploadThumb(env, apt.id, images[0]);
    if (thumbUrl) apt.thumb = thumbUrl;
  }

  const { error, created } = await saveApartment(env, apt);
  await send(
    env.token,
    chatId,
    error
      ? `שגיאה: ${error}`
      : `${created ? "נוספה" : "כבר קיימת, עודכנה"} (AI): ${apt.name}${
        apt.price ? ` · ${Number(apt.price).toLocaleString("en-US")} ₪` : ""
      }`,
  );
}

type Env = {
  token: string;
  supabaseUrl: string;
  serviceKey: string;
  geminiKey: string;
};

type ImageBlob = { mime: string; data: string; bytes: Uint8Array };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function largestPhotoFileId(msg: Record<string, unknown>): string | null {
  const photo = msg.photo as { file_id: string }[] | undefined;
  if (!photo?.length) return null;
  return photo[photo.length - 1].file_id;
}

async function send(token: string, chatId: number, text: string, html = false) {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (html) {
    body.parse_mode = "HTML";
    body.disable_web_page_preview = false;
  }
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function tg(token: string, method: string, body: Record<string, unknown>) {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function isListingUrl(url: string) {
  return /yad2\.co\.il|madlan\.co\.il|keyz\.ai|facebook\.com|fb\.watch|madlan\.com/i.test(url);
}

async function downloadTelegramFile(token: string, fileId: string): Promise<ImageBlob | null> {
  const meta = await tg(token, "getFile", { file_id: fileId });
  const path = meta.result?.file_path as string | undefined;
  if (!path) return null;
  const res = await fetch(`${TELEGRAM_API}/file/bot${token}/${path}`);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  const mime = path.endsWith(".png")
    ? "image/png"
    : path.endsWith(".webp")
    ? "image/webp"
    : "image/jpeg";
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return { mime, data: btoa(binary), bytes };
}

async function parseWithGemini(env: Env, text: string, images: ImageBlob[]) {
  const parts: Record<string, unknown>[] = [
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
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.geminiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
      }),
    },
  );
  if (!res.ok) {
    console.error("gemini error", await res.text());
    return null;
  }
  const data = await res.json();
  await logGeminiUsage(env, data.usageMetadata || {});
  const raw = (data.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
  return parseJsonLoose(raw);
}

function parseJsonLoose(raw: string) {
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

function normalizeGeminiApt(parsed: Record<string, unknown>, fallbackNotes: string) {
  const name = String(parsed.name || "").trim();
  const idBase = String(parsed.id || name || "listing").trim();
  const id = slugId(idBase).replace(/^tg-/, "tg-ai-");
  return {
    id,
    name: name || "דירה מטלגרם",
    neighborhood: String(parsed.neighborhood || ""),
    price: toNum(parsed.price),
    rooms: toNum(parsed.rooms),
    built: toNum(parsed.built),
    garden: parsed.garden != null && parsed.garden !== "" ? String(parsed.garden) : null,
    url: parsed.url ? String(parsed.url) : null,
    source: "telegram-gemini",
    visited: false,
    expired: false,
    thumb: null as string | null,
    chat_notes: String(parsed.chat_notes || fallbackNotes || "").slice(0, 500),
  };
}

function toNum(v: unknown) {
  if (v == null || v === "") return null;
  if (typeof v === "string") {
    const s = v.trim();
    const mil = s.match(/^(\d+(?:\.\d+)?)\s*[מmM](?:illion|׳|'|)?$/i);
    if (mil) return Math.round(parseFloat(mil[1]) * 1_000_000);
    const n = Number(s.replace(/[^\d.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function ensureBucket(env: Env, id: string, isPublic: boolean) {
  const res = await fetch(`${env.supabaseUrl}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      id,
      name: id,
      public: isPublic,
      ...(isPublic
        ? { file_size_limit: 5_000_000, allowed_mime_types: ["image/jpeg", "image/png", "image/webp"] }
        : {}),
    }),
  });
  if (!res.ok && res.status !== 409) {
    const body = await res.text();
    if (!/already exists|Duplicate/i.test(body)) console.error("ensureBucket", id, res.status, body);
  }
}

async function sha1Hex(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadThumb(env: Env, aptId: string, image: ImageBlob) {
  await ensureBucket(env, THUMB_BUCKET, true);
  const ext = image.mime === "image/png" ? "png" : image.mime === "image/webp" ? "webp" : "jpg";
  const hash = (await sha1Hex(image.bytes)).slice(0, 8);
  const path = `${aptId}-${hash}.${ext}`;
  const res = await fetch(`${env.supabaseUrl}/storage/v1/object/${THUMB_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      "content-type": image.mime,
      "x-upsert": "true",
    },
    body: image.bytes,
  });
  if (!res.ok) {
    console.error("uploadThumb", await res.text());
    return null;
  }
  return `${env.supabaseUrl}/storage/v1/object/public/${THUMB_BUCKET}/${path}`;
}

function estimateCostUsd(promptTokens: number, outputTokens: number) {
  return (promptTokens / 1e6) * GEMINI_USD_PER_M_IN + (outputTokens / 1e6) * GEMINI_USD_PER_M_OUT;
}

function fmtUsd(n: number) {
  if (n < 0.0001) return "$0.0000";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

async function loadUsageLog(env: Env) {
  await ensureBucket(env, META_BUCKET, false);
  const res = await fetch(`${env.supabaseUrl}/storage/v1/object/${META_BUCKET}/${USAGE_OBJECT}`, {
    headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` },
  });
  if (res.status === 404) return { entries: [] as Record<string, unknown>[] };
  if (!res.ok) return { entries: [] as Record<string, unknown>[] };
  try {
    const data = await res.json();
    return { entries: Array.isArray(data.entries) ? data.entries : [] };
  } catch {
    return { entries: [] as Record<string, unknown>[] };
  }
}

async function saveUsageLog(env: Env, log: { entries: Record<string, unknown>[] }) {
  await ensureBucket(env, META_BUCKET, false);
  await fetch(`${env.supabaseUrl}/storage/v1/object/${META_BUCKET}/${USAGE_OBJECT}`, {
    method: "POST",
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      "content-type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify(log),
  });
}

async function logGeminiUsage(env: Env, usage: Record<string, unknown>) {
  const prompt = Number(usage.promptTokenCount || 0);
  const output = Number(usage.candidatesTokenCount || 0);
  const entry = {
    ts: new Date().toISOString(),
    model: GEMINI_MODEL,
    promptTokens: prompt,
    outputTokens: output,
    totalTokens: Number(usage.totalTokenCount || prompt + output),
    listPriceUsd: estimateCostUsd(prompt, output),
  };
  const log = await loadUsageLog(env);
  log.entries.push(entry);
  if (log.entries.length > 2000) log.entries = log.entries.slice(-2000);
  await saveUsageLog(env, log);
}

function dayKey(iso: string) {
  return String(iso || "").slice(0, 10);
}

async function formatCostsMessage(env: Env) {
  const log = await loadUsageLog(env);
  const today = dayKey(new Date().toISOString());
  const entries = log.entries;
  const todayEntries = entries.filter((e) => dayKey(String(e.ts || "")) === today);
  const sum = (arr: Record<string, unknown>[], key: string) =>
    arr.reduce((s, e) => s + Number(e[key] || 0), 0);
  const todayCalls = todayEntries.length;
  const leftToday = Math.max(0, GEMINI_FREE_RPD - todayCalls);
  return (
    "עלויות Gemini (מעקב מהבוט)\n\n" +
    `היום (${today} UTC):\n` +
    `• ${todayCalls} קריאות · ${sum(todayEntries, "promptTokens") + sum(todayEntries, "outputTokens")} טוקנים\n` +
    `• מחיר מחירון: ${fmtUsd(sum(todayEntries, "listPriceUsd"))}\n` +
    `• חיוב בפועל: $0 (free tier)\n\n` +
    `סה״כ מאז תחילת המעקב:\n` +
    `• ${entries.length} קריאות · ${sum(entries, "promptTokens") + sum(entries, "outputTokens")} טוקנים\n` +
    `• מחיר מחירון: ${fmtUsd(sum(entries, "listPriceUsd"))}\n` +
    `• חיוב בפועל: $0 (free tier)\n\n` +
    `יתרה בחבילה:\n` +
    `• אין יתרת כסף (מפתח free / AI Studio)\n` +
    `• מכסת בקשות יומית משוערת: ${leftToday} מתוך ~${GEMINI_FREE_RPD} נותרו היום\n\n` +
    `מודל: ${GEMINI_MODEL}`
  );
}

async function saveApartment(env: Env, apt: Record<string, unknown>) {
  const existing = await findDuplicate(env, apt);
  const row = {
    ...apt,
    id: existing?.id || apt.id,
    thumb: apt.thumb || existing?.thumb || null,
    visited: existing?.visited ?? apt.visited ?? false,
    expired: existing?.expired ?? apt.expired ?? false,
    updated_at: new Date().toISOString(),
  };
  const error = await upsertApartment(env, row);
  return { error, created: !existing, id: row.id };
}

async function listApartments(env: Env) {
  const res = await fetch(
    `${env.supabaseUrl}/rest/v1/apartments?select=id,name,neighborhood,price,rooms,url,thumb,visited,expired`,
    { headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` } },
  );
  if (!res.ok) return [];
  return res.json();
}

async function findDuplicate(env: Env, apt: Record<string, unknown>) {
  const rows = await listApartments(env);
  const urlKey = listingKey(apt.url as string | null);
  if (urlKey) {
    const byUrl = rows.find((r: Record<string, unknown>) => listingKey(r.url as string) === urlKey);
    if (byUrl) return byUrl;
  }
  return rows.find((r: Record<string, unknown>) => isSameListing(apt, r)) || null;
}

function listingKey(url: string | null | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    const path = u.pathname.replace(/\/+$/, "");
    if (/yad2\.co\.il$/i.test(host)) {
      const m = path.match(/\/(?:item\/(?:[^/]+\/)?|s\/c\/)([a-z0-9]+)/i) ||
        path.match(/\/([a-z0-9]{6,})$/i);
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
    if (/facebook\.com|fb\.watch/i.test(host)) return `fb:${path}`;
    return `${host}${path}`;
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function normTokens(s: unknown) {
  return String(s || "")
    .toLowerCase()
    .replace(/[״"']/g, "")
    .replace(/[^\u0590-\u05ffa-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function isSameListing(a: Record<string, unknown>, b: Record<string, unknown>) {
  if (a.price != null && b.price != null && Number(a.price) !== Number(b.price)) return false;
  if (a.rooms != null && b.rooms != null && Number(a.rooms) !== Number(b.rooms)) return false;
  const aTokens = new Set([...normTokens(a.name), ...normTokens(a.neighborhood)]);
  const bTokens = new Set([...normTokens(b.name), ...normTokens(b.neighborhood)]);
  if (!aTokens.size || !bTokens.size) return false;
  let inter = 0;
  for (const t of aTokens) if (bTokens.has(t)) inter++;
  const union = aTokens.size + bTokens.size - inter;
  return inter / union >= 0.45 && inter >= 2;
}

async function upsertApartment(env: Env, apt: Record<string, unknown>) {
  const res = await fetch(`${env.supabaseUrl}/rest/v1/apartments?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(apt),
  });
  if (!res.ok) return await res.text();

  await fetch(`${env.supabaseUrl}/rest/v1/verdicts?on_conflict=apartment_id`, {
    method: "POST",
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
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

function extractUrls(text: string) {
  const re = /https?:\/\/[^\s<>"']+/g;
  return [...new Set((text.match(re) || []).map((u) => u.replace(/[).,;]+$/, "")))];
}

function slugId(input: string) {
  const ascii = String(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/https?:\/\//, "")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  if (ascii.length >= 4) return "tg-" + ascii;
  // fallback short hash from string
  let h = 0;
  const s = String(input);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return "tg-" + (ascii ? ascii + "-" : "") + h.toString(16).slice(0, 10);
}

function parseManualAdd(body: string) {
  const parts = body.split("|").map((p) => p.trim());
  if (parts.length < 1 || !parts[0]) return null;
  const [name, priceRaw, roomsRaw, url] = parts;
  const price = priceRaw ? Number(String(priceRaw).replace(/[^\d]/g, "")) : null;
  const rooms = roomsRaw ? Number(roomsRaw) : null;
  return {
    id: slugId(url || name),
    name,
    price: Number.isFinite(price as number) ? price : null,
    rooms: Number.isFinite(rooms as number) ? rooms : null,
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

function listingFromUrl(url: string, context: string) {
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
    url: cleanListingUrl(url),
    source,
    neighborhood: "",
    price: extractPrice(context),
    rooms: extractRooms(context),
    built: null,
    garden: null,
    visited: false,
    expired: false,
    thumb: null as string | null,
    chat_notes: context.slice(0, 300),
  };
}

function cleanListingUrl(url: string) {
  try {
    const u = new URL(url);
    // drop tracking noise
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** Fetch OG image (+ title when useful) from Madlan/Keyz listing pages. */
async function enrichFromListingPage(env: Env, apt: Record<string, unknown>) {
  const url = String(apt.url || "");
  if (!url) return;
  // Facebook share pages usually only expose group cover — skip
  if (/facebook\.com|fb\.watch/i.test(url)) return;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
        Accept: "text/html",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn("enrich fetch", res.status, url);
      return;
    }
    const html = await res.text();
    const ogImage = matchMeta(html, "og:image");
    const ogTitle = matchMeta(html, "og:title");
    if (ogTitle && (/madlan|keyz/i.test(url))) {
      // e.g. "דירת גן למכירה: לבונה , רעות ... | מדלן"
      const cleaned = ogTitle.split("|")[0].replace(/\s+למכירה:?/g, "").trim();
      if (cleaned.length > 5 && cleaned.length < 120) apt.name = cleaned;
    }
    if (!ogImage) return;
    if (/yad2logo|logo\.png|placeholder/i.test(ogImage)) return;

    const imgRes = await fetch(ogImage, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Referer: url,
        Accept: "image/*,*/*",
      },
    });
    if (!imgRes.ok) return;
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    if (bytes.length < 5000) return;
    const ctype = imgRes.headers.get("content-type") || "image/jpeg";
    const mime = ctype.includes("png")
      ? "image/png"
      : ctype.includes("webp")
      ? "image/webp"
      : "image/jpeg";
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const thumbUrl = await uploadThumb(env, String(apt.id), {
      mime,
      data: btoa(binary),
      bytes,
    });
    if (thumbUrl) apt.thumb = thumbUrl;
  } catch (err) {
    console.warn("enrichFromListingPage", err);
  }
}

function matchMeta(html: string, prop: string) {
  const re1 = new RegExp(
    `property=["']${prop}["'][^>]*content=["']([^"']+)["']`,
    "i",
  );
  const re2 = new RegExp(
    `content=["']([^"']+)["'][^>]*property=["']${prop}["']`,
    "i",
  );
  const m = html.match(re1) || html.match(re2);
  return m ? m[1].replace(/&amp;/g, "&") : null;
}

function extractPrice(text: string) {
  const m = text.match(/(\d{1,2}(?:[.,]\d{3}){2,})\s*₪?/) ||
    text.match(/(\d(?:\.\d)?)\s*מ['׳']?/);
  if (!m) return null;
  let raw = m[1];
  if (raw.includes(".") && raw.length <= 4) return Math.round(parseFloat(raw) * 1_000_000);
  raw = raw.replace(/[^\d]/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function extractRooms(text: string) {
  const m = text.match(/(\d+(?:\.\d)?)\s*חדר/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
