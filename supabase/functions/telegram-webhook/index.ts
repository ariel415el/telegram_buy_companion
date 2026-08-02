// Supabase Edge Function — Telegram webhook (near-realtime)
// Secrets: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GEMINI_API_KEY

const TELEGRAM_API = "https://api.telegram.org";
const THUMB_BUCKET = "listing-thumbs";
const META_BUCKET = "bot-meta";
const USAGE_OBJECT = "gemini-usage.json";
const GEMINI_MODEL = "gemini-flash-lite-latest";
const MAX_PHOTOS = 3;
const SITE_URL = "https://ariel415el.github.io/telegram_buy_companion/";
const SITE_LINK = "סיכום דירות";
const GEMINI_USD_PER_M_IN = 0.1;
const GEMINI_USD_PER_M_OUT = 0.4;
const GEMINI_FREE_RPD = 1000;
/** Cap all listing scrapes / page fetches (ms). */
const SCRAPE_TIMEOUT_MS = 120_000;
const PROCESSING_TEXT = "מעבד…";

const HELP_TEXT =
  "מוסיף דירות לאתר המשותף שלנו.\n" +
  `אתר: <a href="${SITE_URL}">${SITE_LINK}</a>\n\n` +
  "איך להשתמש:\n" +
  "• שלחו קישור (יד2 / מדלן / Keyz / פייסבוק) — מוסיף רק אחרי קריאה מוצלחת\n" +
  "• או תיאור + עד 3 תמונות (באותה הודעה, או תמונות ואז תיאור / להפך)\n" +
  "• /costs — כמה עלה Gemini היום ובסה״כ\n" +
  "• /help — ההודעה הזו\n\n" +
  "דירה שכבר קיימת מתעדכנת במקום להיווצר פעמיים.";

const GENERIC_NAME_RE =
  /^(מודעת\s+(יד2|מדלן|keyz)|דירה מטלגרם|דירה במודיעין|ממתין לפרטים|מדלן\s+\w+|יד2\s+\w+)/i;

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

    const chatId = msg.chat.id as number;
    await rememberChatAndDescription(env, chatId, msg.chat);

    const job = await collectJob(env, msg);
    if (!job) return json({ ok: true });

    await handleMessage(env, chatId, job.text, job.photoFileIds);
    return json({ ok: true });
  } catch (err) {
    console.error("webhook error", err);
    return json({ ok: true, error: String(err) });
  }
});

/** Merge album parts + pending text/photos so either order works. */
async function collectJob(
  env: Env,
  msg: Record<string, unknown>,
): Promise<{ text: string; photoFileIds: string[] } | null> {
  const chatId = msg.chat.id as number;
  const text = String(msg.text || msg.caption || "").trim();
  const photoId = largestPhotoFileId(msg);
  const groupId = msg.media_group_id ? String(msg.media_group_id) : null;

  if (groupId) {
    return collectAlbumJob(env, chatId, groupId, {
      text,
      photoId,
      updateId: Number(msg.message_id || 0),
    });
  }

  const photos = photoId ? [photoId] : [];
  if (text.startsWith("/")) {
    return { text, photoFileIds: photos };
  }
  return finalizeSplitJob(env, chatId, text, photos);
}

function albumText(parts: { text?: string }[]) {
  return parts.map((p) => p.text).find((t) => t) || "";
}

function albumPhotos(parts: { photoId?: string | null }[]) {
  return [
    ...new Set(parts.map((p) => p.photoId).filter(Boolean) as string[]),
  ].slice(0, MAX_PHOTOS);
}

/**
 * Telegram delivers album images as separate updates; caption is usually on one part only.
 * Wait long enough for all parts before deciding it's "photos without text".
 */
async function collectAlbumJob(
  env: Env,
  chatId: number,
  groupId: string,
  part: { text: string; photoId: string | null; updateId: number },
): Promise<{ text: string; photoFileIds: string[] } | null> {
  await appendAlbumPart(env, chatId, groupId, part);

  await sleep(2500);
  let latest = await loadAlbum(env, chatId, groupId);

  // Captioned part landed after we already stashed photos from an early incomplete pass.
  if (latest?.processed) {
    if (!part.text) return null;
    const photos =
      albumPhotos(latest.parts || []).length
        ? albumPhotos(latest.parts || [])
        : (await loadPendingInput(env, chatId))?.photoFileIds ||
          (part.photoId ? [part.photoId] : []);
    if (!photos.length) return null;
    await clearPendingInput(env, chatId);
    return { text: part.text, photoFileIds: photos.slice(0, MAX_PHOTOS) };
  }

  let parts = latest?.parts || [part];
  let maxId = Math.max(0, ...parts.map((p: { updateId?: number }) => Number(p.updateId || 0)));
  if (part.updateId !== maxId) return null;

  let combinedText = albumText(parts);
  let photos = albumPhotos(parts);

  // Caption often arrives on another part a moment later — wait once more before prompting.
  if (photos.length && !combinedText) {
    await sleep(2500);
    latest = await loadAlbum(env, chatId, groupId);
    if (latest?.processed) return null;
    parts = latest?.parts || parts;
    maxId = Math.max(0, ...parts.map((p: { updateId?: number }) => Number(p.updateId || 0)));
    if (part.updateId !== maxId) return null;
    combinedText = albumText(parts);
    photos = albumPhotos(parts);
  }

  await markAlbumProcessed(env, chatId, groupId);

  // Album with caption or screenshot-only: process (OCR if no text).
  if (photos.length) {
    await clearPendingInput(env, chatId);
    return { text: combinedText, photoFileIds: photos };
  }

  return finalizeSplitJob(env, chatId, combinedText, photos);
}

async function finalizeSplitJob(
  env: Env,
  chatId: number,
  text: string,
  photos: string[],
): Promise<{ text: string; photoFileIds: string[] } | null> {
  const photoFileIds = photos.slice(0, MAX_PHOTOS);
  const pending = await loadPendingInput(env, chatId);
  const listingUrls = text ? extractUrls(text).filter(isListingUrl) : [];

  // Listing URL alone — process now (photos optional).
  if (listingUrls.length) {
    await clearPendingInput(env, chatId);
    return { text, photoFileIds };
  }

  const finalText = text || pending?.text || "";
  const finalPhotos = photoFileIds.length
    ? photoFileIds
    : (pending?.photoFileIds || []).slice(0, MAX_PHOTOS);

  if (finalText && finalPhotos.length) {
    await clearPendingInput(env, chatId);
    return { text: finalText, photoFileIds: finalPhotos };
  }

  if (finalText && !finalPhotos.length) {
    await savePendingInput(env, chatId, { text: finalText, photoFileIds: [] });
    await send(
      env.token,
      chatId,
      "קיבלתי תיאור — שלחו עכשיו עד 3 תמונות מהמודעה.",
    );
    return null;
  }

  // Photos / screenshot without text — parse via OCR (don't wait for a description).
  if (finalPhotos.length && !finalText) {
    await clearPendingInput(env, chatId);
    return { text: "", photoFileIds: finalPhotos };
  }

  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

const GROUP_DESCRIPTION =
  "סיכום דירות משותף:\n" +
  SITE_URL +
  "\n\nשלחו קישור, או תיאור + תמונות / צילום מסך — הבוט מוסיף לאתר.";

async function rememberChatAndDescription(
  env: Env,
  chatId: number,
  chat: Record<string, unknown>,
) {
  try {
    await ensureBucket(env, META_BUCKET, false);
    await fetch(`${env.supabaseUrl}/storage/v1/object/${META_BUCKET}/last-chat.json`, {
      method: "POST",
      headers: {
        apikey: env.serviceKey,
        Authorization: `Bearer ${env.serviceKey}`,
        "content-type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify({
        chatId,
        type: chat.type,
        title: chat.title || null,
        ts: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.warn("rememberChat", err);
  }

  const type = String(chat.type || "");
  if (type === "group" || type === "supergroup") {
    const info = await tg(env.token, "getChat", { chat_id: chatId });
    const current = String(info.result?.description || "");
    if (!current.includes(SITE_URL)) {
      await tg(env.token, "setChatDescription", {
        chat_id: chatId,
        description: GROUP_DESCRIPTION.slice(0, 255),
      });
    }
  }
}

function scrapeSucceeded(apt: Record<string, unknown>) {
  return !isGenericName(apt.name) && Boolean(apt.thumb);
}

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

  if (text.startsWith("/add") || text.startsWith("/add@")) {
    await send(
      env.token,
      chatId,
      "אין צורך ב-/add.\nשלחו קישור למודעה, או תיאור + תמונות / צילום מסך.",
    );
    return;
  }

  const listingUrls = extractUrls(text).filter(isListingUrl);
  if (listingUrls.length) {
    await send(env.token, chatId, PROCESSING_TEXT);
    const images: ImageBlob[] = [];
    for (const fileId of photoFileIds.slice(0, MAX_PHOTOS)) {
      const img = await downloadTelegramFile(env.token, fileId);
      if (img) images.push(img);
    }
    const results: string[] = [];
    let queued = 0;
    for (const url of listingUrls) {
      const apt = listingFromUrl(url, text);
      const started = Date.now();
      const remaining = () => Math.max(5_000, SCRAPE_TIMEOUT_MS - (Date.now() - started));
      try {
        await withTimeout(
          enrichFromListingPage(env, apt),
          remaining(),
          "scrape",
        );
      } catch (err) {
        console.warn("enrich timeout/error", url, err);
      }
      applyHintsFromText(apt, text);
      if (images.length && !apt.thumb) {
        const thumbUrl = await uploadThumb(env, String(apt.id), images[0]);
        if (thumbUrl) apt.thumb = thumbUrl;
      }
      if ((isGenericName(apt.name) || !apt.thumb) && (images.length || text.length > 40)) {
        try {
          await withTimeout(
            enrichWithGeminiFromMessage(env, apt, text, images),
            remaining(),
            "gemini",
          );
        } catch (err) {
          console.warn("gemini enrich timeout", err);
        }
      }
      delete apt._fbGate;

      if (scrapeSucceeded(apt)) {
        const { error, created } = await saveApartment(env, apt);
        results.push(
          error
            ? `שגיאה עבור ${apt.name}: ${error}`
            : created
            ? `נוספה: ${apt.name}`
            : `כבר קיימת, עודכנה: ${apt.name}`,
        );
        continue;
      }

      // Yad2 / Facebook need headed Chrome — queue create-on-success, no placeholder row.
      if (/yad2\.co\.il|facebook\.com|fb\.watch/i.test(url)) {
        await enqueueEnrich(env, {
          aptId: String(apt.id),
          url: String(apt.url || url),
          chatId,
          name: "",
          context: text.slice(0, 500),
          create: true,
        });
        queued++;
        continue;
      }

      results.push(
        "לא הצלחתי לקרוא שם רחוב/תמונה מהמודעה — לא נוספה רשומה.\n" +
          "שלחו שוב עם צילום מסך + כתובת בהודעה אחת.",
      );
    }
    if (results.length) await send(env.token, chatId, results.join("\n\n"));
    else if (queued && !results.length) {
      await send(
        env.token,
        chatId,
        "המודעה בתור — אעדכן כשאסיים לקרוא אותה (עד כמה דקות).",
      );
    }
    return;
  }

  if (!text && !photoFileIds.length) {
    await send(env.token, chatId, "לא קיבלתי טקסט או תמונה — לא נוספה רשומה.");
    return;
  }

  if (!env.geminiKey) {
    await send(env.token, chatId, "שגיאת הגדרה (Gemini) — לא נוספה רשומה.");
    return;
  }

  if (!photoFileIds.length) {
    await send(
      env.token,
      chatId,
      "חסרה תמונה — לא נוספה רשומה.\nשלחו תיאור עם עד 3 תמונות (יחד, או תמונות ואז תיאור / להפך).",
    );
    return;
  }

  await send(env.token, chatId, PROCESSING_TEXT);

  const images: ImageBlob[] = [];
  for (const fileId of photoFileIds.slice(0, MAX_PHOTOS)) {
    const img = await downloadTelegramFile(env.token, fileId);
    if (img) images.push(img);
  }
  if (!images.length) {
    await send(
      env.token,
      chatId,
      "לא הצלחתי להוריד את התמונות — לא נוספה רשומה. נסו שוב.",
    );
    return;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = await withTimeout(
      parseWithGemini(env, text, images),
      SCRAPE_TIMEOUT_MS,
      "gemini-parse",
    );
  } catch (err) {
    console.warn("gemini parse timeout", err);
    await send(env.token, chatId, "עיבוד לקח יותר מדי זמן — לא נוספה רשומה. נסו שוב.");
    return;
  }
  if (!parsed || parsed.is_apartment === false) {
    if (!text) {
      await savePendingInput(env, chatId, { text: "", photoFileIds });
      await send(
        env.token,
        chatId,
        "לא הצלחתי לקרוא מודעה מהתמונה — שלחו תיאור עם כתובת ואעדכן.",
      );
      return;
    }
    await send(
      env.token,
      chatId,
      "לא זיהיתי מודעת דירה — לא נוספה רשומה.",
    );
    return;
  }

  const apt = normalizeGeminiApt(parsed, text);
  if (!apt?.name || isGenericName(apt.name)) {
    if (!text) {
      await savePendingInput(env, chatId, { text: "", photoFileIds });
      await send(
        env.token,
        chatId,
        "לא זיהיתי שם רחוב בתמונה — שלחו תיאור עם כתובת ואעדכן.",
      );
      return;
    }
    await send(
      env.token,
      chatId,
      "לא זיהיתי שם רחוב — לא נוספה רשומה. שלחו קישור, או תיאור עם כתובת + תמונה.",
    );
    return;
  }

  const listingUrl = apt.url || extractUrls(text).find(isListingUrl) || null;
  if (listingUrl) apt.url = listingUrl;

  const thumbUrl = await uploadThumb(env, apt.id, images[0]);
  if (thumbUrl) apt.thumb = thumbUrl;

  if (!apt.thumb) {
    await send(
      env.token,
      chatId,
      "זיהיתי דירה אבל העלאת התמונה נכשלה — לא נוספה רשומה. נסו שוב.",
    );
    return;
  }

  const { error, created } = await saveApartment(env, apt);
  await send(
    env.token,
    chatId,
    error
      ? `שגיאה: ${error}`
      : `${created ? "נוספה" : "כבר קיימת, עודכנה"}: ${apt.name}${
        apt.price ? ` · ${Number(apt.price).toLocaleString("en-US")} ₪` : ""
      }`,
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = "op",
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
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
        `Input may be: listing URLs, free-text descriptions, and/or photos/screenshots of ads.\n` +
        `Read Hebrew text inside images (OCR). Prefer street name + house number when visible.\n` +
        `Return ONLY a JSON object (no markdown) with keys:\n` +
        `is_apartment (boolean), id (slug string), name (Hebrew string), neighborhood (string),\n` +
        `price (integer ILS or null; convert 2.89מ / 2.89M / 3.49 to 3490000), rooms (number or null),\n` +
        `built (number sqm or null), garden (string sqm or null), url (string or null),\n` +
        `chat_notes (short Hebrew summary of extras/opinions).\n` +
        `If the message is casual chat and not a listing, set is_apartment=false.\n` +
        `id: ascii slug like street-neighborhood-hint, lowercase, hyphens, max 60 chars.\n` +
        `name: like "רחוב — שכונה" (include house number when known).\n\n` +
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
  const name = !isGenericName(apt.name)
    ? apt.name
    : (existing && !isGenericName(existing.name) ? existing.name : apt.name);
  const row = {
    ...apt,
    id: existing?.id || apt.id,
    name,
    neighborhood: apt.neighborhood || existing?.neighborhood || "",
    price: apt.price ?? existing?.price ?? null,
    rooms: apt.rooms ?? existing?.rooms ?? null,
    built: apt.built ?? existing?.built ?? null,
    garden: apt.garden ?? existing?.garden ?? null,
    url: apt.url || existing?.url || null,
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
  if (!url || !isListingUrl(url)) return null;
  const price = priceRaw ? Number(String(priceRaw).replace(/[^\d]/g, "")) : null;
  const rooms = roomsRaw ? Number(roomsRaw) : null;
  return {
    id: slugId(url || name),
    name,
    price: Number.isFinite(price as number) ? price : null,
    rooms: Number.isFinite(rooms as number) ? rooms : null,
    url,
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
  let source = "telegram";
  if (/yad2\.co\.il/i.test(url)) source = "telegram-yad2";
  else if (/madlan\.co\.il/i.test(url)) source = "telegram-madlan";
  else if (/keyz\.ai/i.test(url)) source = "telegram-keyz";
  else if (/facebook\.com|fb\.watch/i.test(url)) source = "telegram-facebook";

  const clean = cleanListingUrl(url);
  const key = listingKey(clean) || clean;
  return {
    id: slugId(key),
    name: "",
    url: clean,
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
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function isGenericName(name: unknown) {
  const s = String(name || "").trim();
  if (!s || s.length < 3) return true;
  if (/ממתין/.test(s)) return true;
  return GENERIC_NAME_RE.test(s);
}

async function enqueueEnrich(
  env: Env,
  data: {
    aptId: string;
    url: string;
    chatId: number;
    name?: string;
    context?: string;
    create?: boolean;
  },
) {
  await ensureBucket(env, META_BUCKET, false);
  const path = `enrich-queue/${data.aptId}.json`;
  await fetch(`${env.supabaseUrl}/storage/v1/object/${META_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      "content-type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify({ ...data, ts: new Date().toISOString() }),
  });
}

function pendingInputPath(chatId: number) {
  return `pending-input/${chatId}.json`;
}

function albumPath(chatId: number, groupId: string) {
  return `albums/${chatId}-${groupId}.json`;
}

async function metaGet(env: Env, path: string) {
  await ensureBucket(env, META_BUCKET, false);
  const res = await fetch(`${env.supabaseUrl}/storage/v1/object/${META_BUCKET}/${path}`, {
    headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` },
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function metaPut(env: Env, path: string, data: unknown) {
  await ensureBucket(env, META_BUCKET, false);
  await fetch(`${env.supabaseUrl}/storage/v1/object/${META_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: env.serviceKey,
      Authorization: `Bearer ${env.serviceKey}`,
      "content-type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify(data),
  });
}

async function metaDel(env: Env, path: string) {
  await fetch(`${env.supabaseUrl}/storage/v1/object/${META_BUCKET}/${path}`, {
    method: "DELETE",
    headers: { apikey: env.serviceKey, Authorization: `Bearer ${env.serviceKey}` },
  });
}

async function savePendingInput(
  env: Env,
  chatId: number,
  data: { text: string; photoFileIds: string[] },
) {
  await metaPut(env, pendingInputPath(chatId), {
    text: data.text || "",
    photoFileIds: (data.photoFileIds || []).slice(0, MAX_PHOTOS),
    ts: new Date().toISOString(),
  });
}

async function loadPendingInput(env: Env, chatId: number) {
  const data = await metaGet(env, pendingInputPath(chatId));
  if (!data) return null;
  const age = Date.now() - Date.parse(String(data.ts || 0));
  if (Number.isFinite(age) && age > 15 * 60_000) {
    await clearPendingInput(env, chatId);
    return null;
  }
  return {
    text: String(data.text || ""),
    photoFileIds: Array.isArray(data.photoFileIds)
      ? data.photoFileIds.map(String).slice(0, MAX_PHOTOS)
      : [],
  };
}

async function clearPendingInput(env: Env, chatId: number) {
  await metaDel(env, pendingInputPath(chatId));
}

async function appendAlbumPart(
  env: Env,
  chatId: number,
  groupId: string,
  part: { text: string; photoId: string | null; updateId: number },
) {
  const path = albumPath(chatId, groupId);
  const existing = (await metaGet(env, path)) || { parts: [], processed: false };
  const parts = Array.isArray(existing.parts) ? existing.parts : [];
  if (!parts.some((p: { updateId?: number }) => p.updateId === part.updateId)) {
    parts.push(part);
  }
  const data = { ...existing, parts, ts: new Date().toISOString() };
  await metaPut(env, path, data);
  return data;
}

async function loadAlbum(env: Env, chatId: number, groupId: string) {
  return await metaGet(env, albumPath(chatId, groupId));
}

async function markAlbumProcessed(env: Env, chatId: number, groupId: string) {
  const path = albumPath(chatId, groupId);
  const existing = (await metaGet(env, path)) || { parts: [] };
  await metaPut(env, path, { ...existing, processed: true, ts: new Date().toISOString() });
}

function applyHintsFromText(apt: Record<string, unknown>, text: string) {
  if (!text) return;
  if (apt.price == null) apt.price = extractPrice(text);
  if (apt.rooms == null) apt.rooms = extractRooms(text);
  if (!isGenericName(apt.name)) return;

  // "אבני חושן 66" / "רחוב לבונה — רעות"
  const street =
    text.match(/(?:^|\n)\s*([\u0590-\u05ff][\u0590-\u05ff"'׳\s\-]{1,30}\d*)\s*$/m) ||
    text.match(
      /(?:רחוב|ברחוב|ב)\s*([\u0590-\u05ff][\u0590-\u05ff"'׳\s\-]{1,25}\d*)/,
    ) ||
    text.match(
      /([\u0590-\u05ff]{2,}(?:\s+[\u0590-\u05ff]{2,}){0,3}\s+\d{1,3})\s*[—\-–,]/,
    );
  const hood = text.match(
    /(?:שכונת|בשכונת)\s*([\u0590-\u05ff][\u0590-\u05ff"'׳\s\/]{1,30})/,
  );
  if (street) {
    const s = street[1].replace(/\s+/g, " ").trim();
    const n = hood ? hood[1].replace(/\s+/g, " ").trim() : String(apt.neighborhood || "");
    apt.name = n ? `${s} — ${n}` : s;
    if (n && !apt.neighborhood) apt.neighborhood = n;
  } else if (hood && isGenericName(apt.name)) {
    apt.neighborhood = hood[1].replace(/\s+/g, " ").trim();
    apt.name = apt.neighborhood;
  }
}

async function enrichWithGeminiFromMessage(
  env: Env,
  apt: Record<string, unknown>,
  text: string,
  images: ImageBlob[],
) {
  if (!env.geminiKey) return;
  const parsed = await parseWithGemini(
    env,
    `Listing URL: ${apt.url || "(none)"}\n` +
      `Current name: ${apt.name || ""}\n` +
      `Extract street-based Hebrew name like "רחוב — שכונה". Message:\n${text}`,
    images,
  );
  if (!parsed || parsed.is_apartment === false) return;
  const name = String(parsed.name || "").trim();
  if (name && !isGenericName(name)) apt.name = name;
  if (parsed.neighborhood) apt.neighborhood = String(parsed.neighborhood);
  if (apt.price == null && parsed.price != null) apt.price = toNum(parsed.price);
  if (apt.rooms == null && parsed.rooms != null) apt.rooms = toNum(parsed.rooms);
  if (apt.built == null && parsed.built != null) apt.built = toNum(parsed.built);
  if (apt.garden == null && parsed.garden != null && parsed.garden !== "") {
    apt.garden = String(parsed.garden);
  }
}

/** Fetch OG/JSON-LD image + street title from listing pages. */
async function enrichFromListingPage(env: Env, apt: Record<string, unknown>) {
  const url = String(apt.url || "");
  if (!url) return;
  if (/facebook\.com|fb\.watch/i.test(url)) {
    await enrichFacebookListing(env, apt);
    return;
  }

  const candidates = [url];
  if (/madlan\.co\.il\/listings\//i.test(url)) {
    candidates.push(url.replace("/listings/", "/bulletins/"));
  }

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn("enrich fetch", res.status, candidate);
        continue;
      }
      const html = await res.text();
      if (/Radware|robot_checkup|סליחה על ההפרעה|מתנצלים/i.test(html) && html.length < 200_000) {
        console.warn("enrich blocked", candidate, html.length);
        continue;
      }

      applyPageMetadata(apt, html, candidate);

      const ogImage = matchMeta(html, "og:image") || matchMeta(html, "twitter:image");
      if (ogImage && !/yad2logo|logo\.png|placeholder|robot_checkup/i.test(ogImage)) {
        const thumbUrl = await downloadAndStoreImage(env, String(apt.id), ogImage, candidate);
        if (thumbUrl) apt.thumb = thumbUrl;
      }
      if (!isGenericName(apt.name) || apt.thumb) return;
    } catch (err) {
      console.warn("enrichFromListingPage", err);
    }
  }
}

function decodeHtmlEntities(s: string) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\u200f|\u200e/g, "");
}

function extractFacebookMessageTexts(html: string): string[] {
  const out: string[] = [];
  const patterns = [
    /"message"\s*:\s*\{\s*"text"\s*:\s*"((?:\\.|[^"\\]){10,2000})"/g,
    /"text"\s*:\s*"((?:\\.|[^"\\]){20,2000})"/g,
  ];
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      try {
        const raw = `"${m[1]}"`;
        const text = decodeHtmlEntities(JSON.parse(raw));
        if (
          /דירת|חדרים|גינה|למכירה|מ״ר|מ"ר|₪|מודיעין|שכונ|רחוב/i.test(text) &&
          !/About this group|קבוצה מיועדת|Group rules|Log into Facebook/i.test(text)
        ) {
          out.push(text);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return [...new Set(out)].slice(0, 8);
}

function facebookLooksPrivate(html: string, textBlob: string) {
  const blob = html.slice(0, 80_000) + "\n" + textBlob;
  if (/פרסום פייסבוק זה אינו זמין|This content isn't available|isn't available right now/i.test(blob)) {
    return "unavailable";
  }
  const listing = /דירת\s*גן|דירה\s*למכירה|\d+(?:\.\d)?\s*חדר|גינה\s*\d|מ״ר|\d[\d,.]*\s*₪/i.test(textBlob);
  if (
    !listing &&
    /Private group|קבוצה פרטית|Only members can see|Join Group|הצטרפו לקבוצה/i.test(blob)
  ) {
    return "private";
  }
  return null;
}

/** Resolve facebook.com/share links and extract post text/images when public. */
async function enrichFacebookListing(env: Env, apt: Record<string, unknown>) {
  const url = String(apt.url || "");
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn("facebook enrich fetch", res.status, url);
      return;
    }
    const finalUrl = res.url || url;
    apt.url = finalUrl;
    const html = await res.text();
    const ogTitle = decodeHtmlEntities(matchMeta(html, "og:title") || "");
    const ogDesc = decodeHtmlEntities(matchMeta(html, "og:description") || "");
    const ogImage = matchMeta(html, "og:image") || matchMeta(html, "twitter:image");
    const messages = extractFacebookMessageTexts(html);
    const blob = [ogTitle, ogDesc, ...messages].filter(Boolean).join("\n");
    const gate = facebookLooksPrivate(html, blob);

    if (gate) {
      apt._fbGate = gate;
      console.warn("facebook enrich gated", gate, finalUrl);
      return;
    }

    if (blob && /דירת|חדרים|גינה|למכירה|מ״ר|₪|אבני|רחוב/i.test(blob)) {
      applyHintsFromText(apt, blob);
      if (isGenericName(apt.name) || apt.price == null || apt.rooms == null) {
        await enrichWithGeminiFromMessage(env, apt, blob, []);
      }
    }

    if (ogImage && !/static\.xx\.fbcdn|rsrc\.php|emoji/i.test(ogImage)) {
      // Skip tiny profile/group icons; still try — downloadAndStoreImage has size floor.
      const thumbUrl = await downloadAndStoreImage(env, String(apt.id), ogImage, finalUrl);
      if (thumbUrl) apt.thumb = thumbUrl;
    }

    // Prefer larger scontent images from HTML when og image is a group cover.
    if (!apt.thumb || isGenericName(apt.name)) {
      const imgs = [...html.matchAll(/https:\/\/scontent[^"'\\\s]+/g)].map((m) =>
        m[0].replace(/&amp;/g, "&"),
      );
      for (const img of [...new Set(imgs)].slice(0, 6)) {
        if (/s130x130|p50x50|p32x32|s200x200/i.test(img)) continue;
        const thumbUrl = await downloadAndStoreImage(env, String(apt.id), img, finalUrl);
        if (thumbUrl) {
          apt.thumb = thumbUrl;
          break;
        }
      }
    }
  } catch (err) {
    console.warn("enrichFacebookListing", err);
  }
}

function applyPageMetadata(apt: Record<string, unknown>, html: string, pageUrl: string) {
  const ld = extractJsonLd(html);
  const ogTitle = matchMeta(html, "og:title");
  const ogDesc = matchMeta(html, "og:description");
  const titleTag = (html.match(/<title[^>]*>([^<]+)/i) || [])[1];

  if (ld) {
    const name = String(ld.name || "").trim();
    if (name && !/Radware|Madlan\s*$/i.test(name)) {
      const cleaned = cleanListingTitle(name, pageUrl);
      if (cleaned) apt.name = cleaned;
    }
    const addr = ld.address;
    if (addr && typeof addr === "object") {
      const locality = String((addr as { addressLocality?: string }).addressLocality || "").trim();
      if (locality) {
        // "חטיבת גולני 18, מודיעין מכבים רעות"
        const parts = locality.split(",").map((p: string) => p.trim()).filter(Boolean);
        if (parts[0] && isGenericName(apt.name)) {
          apt.name = parts.length > 1
            ? `${parts[0]} — ${parts.slice(1).join(", ").replace(/\s*מכבים רעות/, "").trim()}`
            : parts[0];
        }
        if (!apt.neighborhood && parts[1]) apt.neighborhood = parts[1];
      }
    }
    if (apt.price == null && ld.offers) {
      const offers = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
      const price = toNum((offers as { price?: unknown })?.price);
      if (price) apt.price = price;
    }
  }

  for (const raw of [ogTitle, ogDesc, titleTag]) {
    if (!raw || !isGenericName(apt.name)) break;
    const cleaned = cleanListingTitle(raw, pageUrl);
    if (cleaned) apt.name = cleaned;
  }

  // Keyz og:description: "דירת גן · 3 חדרים · 72 מ״ר · קומת קרקע | חטיבת גולני 18, מודיעין..."
  if (ogDesc && isGenericName(apt.name)) {
    const m = ogDesc.match(/\|\s*([^|]+?),\s*מודיעין/);
    if (m) apt.name = m[1].trim();
  }
  if (ogDesc && apt.rooms == null) {
    const m = ogDesc.match(/(\d+(?:\.\d)?)\s*חדר/);
    if (m) apt.rooms = Number(m[1]);
  }
  if (ogDesc && apt.built == null) {
    const m = ogDesc.match(/(\d+)\s*מ["״']?ר/);
    if (m) apt.built = Number(m[1]);
  }
  if (ogTitle && apt.price == null) {
    const m = ogTitle.match(/([\d,]+)\s*₪/);
    if (m) apt.price = Number(m[1].replace(/,/g, ""));
  }
}

function cleanListingTitle(title: string, pageUrl: string) {
  let t = String(title || "").trim();
  if (!t || /Radware|אבטחת אתר|Google Search/i.test(t)) return null;
  t = t.split("|")[0].trim();
  t = t.replace(/^דירת?\s+(?:גן\s+)?למכירה:\s*/i, "");
  t = t.replace(/\s+למכירה:?\s*/g, " ");
  t = t.replace(/\s+ב-?[‏\u200f]?\s*[\d,.]+(?:\s*מ['׳]?)?\s*₪?.*$/u, "");
  t = t.replace(/\s+/g, " ").trim();
  // "street, neighborhood, city" → "street — neighborhood"
  if (t.includes(",")) {
    const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const cityIdx = parts.findIndex((p) => /מודיעין|מכבים|רעות/.test(p));
      const useful = cityIdx >= 0 ? parts.slice(0, cityIdx) : parts.slice(0, 2);
      if (useful.length >= 2) t = `${useful[0]} — ${useful[1]}`;
      else if (useful.length === 1) t = useful[0];
    }
  }
  if (/madlan|keyz|yad2/i.test(t) && t.length < 20) return null;
  if (t.length < 3 || t.length > 120) return null;
  if (/^Madlan$/i.test(t)) return null;
  void pageUrl;
  return t;
}

function extractJsonLd(html: string): Record<string, unknown> | null {
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const m of blocks) {
    try {
      const data = JSON.parse(m[1]);
      const nodes = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const node of nodes) {
        const types = (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]])
          .filter(Boolean)
          .map(String);
        if (
          types.some((t) => /RealEstateListing|Product|Residence|Apartment|House/i.test(t)) ||
          node.address ||
          node.image
        ) {
          return node;
        }
      }
      if (nodes[0]) return nodes[0];
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function downloadAndStoreImage(env: Env, aptId: string, imageUrl: string, referer: string) {
  try {
    const imgRes = await fetch(imageUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Referer: referer,
        Accept: "image/*,*/*",
      },
    });
    if (!imgRes.ok) return null;
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    if (bytes.length < 5000) return null;
    const ctype = imgRes.headers.get("content-type") || "image/jpeg";
    const mime = ctype.includes("png")
      ? "image/png"
      : ctype.includes("webp")
      ? "image/webp"
      : "image/jpeg";
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return await uploadThumb(env, aptId, { mime, data: btoa(binary), bytes });
  } catch {
    return null;
  }
}

function matchMeta(html: string, prop: string) {
  const re1 = new RegExp(
    `(?:property|name)=["']${prop}["'][^>]*content=["']([^"']+)["']`,
    "i",
  );
  const re2 = new RegExp(
    `content=["']([^"']+)["'][^>]*(?:property|name)=["']${prop}["']`,
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
