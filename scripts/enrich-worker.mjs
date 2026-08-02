#!/usr/bin/env node
/**
 * Auto-enrich Yad2 / Facebook apartments via headed Chrome / patchright.
 * - Ensures a local Chrome CDP endpoint
 * - Drains bot-meta/enrich-queue/*
 * - Creates/updates apartments only after a successful scrape (name + thumb)
 * - Each scrape is capped at 2 minutes
 * Never touches verdicts notes (ignore-duplicates only).
 */
import { createHash } from "crypto";
import { readFileSync, mkdirSync } from "fs";
import { spawn } from "child_process";
import { scrapeYad2 } from "./yad2-scrape.mjs";
import { scrapeFacebook } from "./fb-scrape.mjs";

const CDP_PORT = process.env.CHROME_CDP_PORT || "9223";
const CDP_URL = process.env.CHROME_CDP_URL || `http://127.0.0.1:${CDP_PORT}`;
process.env.CHROME_CDP_URL = CDP_URL;
const SCRAPE_TIMEOUT_MS = Number(process.env.SCRAPE_TIMEOUT_MS || 120_000);

async function ensureChromeCdp() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) {
      console.log("chrome cdp ready", CDP_URL);
      return null;
    }
  } catch {
    /* start */
  }
  const profile = "/tmp/yad2-chrome-profile-worker";
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    "google-chrome",
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  child.unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`${CDP_URL}/json/version`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) {
        console.log("chrome cdp started", CDP_URL, "pid", child.pid);
        return child.pid;
      }
    } catch {
      /* retry */
    }
  }
  throw new Error("failed to start chrome CDP");
}

const env = Object.fromEntries(
  readFileSync(new URL("../.secrets/supabase.env", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const SB_URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const TOKEN = readFileSync(
  new URL("../.secrets/telegram_bot_token.txt", import.meta.url),
  "utf8",
).trim();
const GEMINI = readFileSync(
  new URL("../.secrets/gemini_api_key.txt", import.meta.url),
  "utf8",
).trim();
const META = "bot-meta";
const QUEUE_PREFIX = "enrich-queue/";

const headers = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
};

function isGenericName(name) {
  return /ממתין|מודעת|דירה במודיעין|דירה במדלן|יד2 |מדלן |שחזרה להיות|ליד הקניון|דירת גן במודיעין \(יד2|דירת גן \d חדרים ב|לא זמין|ללא פרטים|^דירת גן — יד2/i.test(
    String(name || ""),
  );
}

function withTimeout(promise, ms, label = "op") {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

async function uploadThumb(aptId, bytes, mime = "image/jpeg") {
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
  const path = `${aptId}-${hash}.${ext}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/listing-thumbs/${path}`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": mime,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`upload ${await res.text()}`);
  return `${SB_URL}/storage/v1/object/public/listing-thumbs/${path}`;
}

async function listQueue() {
  const res = await fetch(
    `${SB_URL}/storage/v1/object/list/${META}?prefix=${QUEUE_PREFIX}`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ prefix: QUEUE_PREFIX, limit: 100 }),
    },
  );
  if (!res.ok) {
    const res2 = await fetch(`${SB_URL}/storage/v1/object/list/${META}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ prefix: QUEUE_PREFIX, limit: 100 }),
    });
    if (!res2.ok) return [];
    return (await res2.json()).filter((o) => o.name && !o.name.endsWith("/"));
  }
  return (await res.json()).filter((o) => o.name && !o.name.endsWith("/"));
}

async function loadQueueItem(name) {
  const path = name.startsWith(QUEUE_PREFIX) ? name : `${QUEUE_PREFIX}${name}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/${META}/${path}`, {
    headers,
  });
  if (!res.ok) return null;
  return { path, data: await res.json() };
}

async function deleteQueueItem(path) {
  await fetch(`${SB_URL}/storage/v1/object/${META}/${path}`, {
    method: "DELETE",
    headers,
  });
}

async function apartmentExists(id) {
  const res = await fetch(
    `${SB_URL}/rest/v1/apartments?select=id,name&id=eq.${encodeURIComponent(id)}`,
    { headers },
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

async function upsertApartment(row) {
  const res = await fetch(`${SB_URL}/rest/v1/apartments?on_conflict=id`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`upsert ${row.id} ${res.status} ${await res.text()}`);

  await fetch(`${SB_URL}/rest/v1/verdicts?on_conflict=apartment_id`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({
      apartment_id: row.id,
      relevant: true,
      note: "",
      updated_at: new Date().toISOString(),
    }),
  });
}

async function patchApartment(id, patch) {
  const res = await fetch(`${SB_URL}/rest/v1/apartments?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...headers, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`patch ${id} ${res.status} ${await res.text()}`);
}

async function notify(chatId, text) {
  if (!chatId || !TOKEN) return;
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function parseListingWithGemini({ text, imagePng }) {
  if (!GEMINI) return null;
  const parts = [
    {
      text:
        "Extract a Modiin Israel apartment listing from this Facebook post.\n" +
        "Return ONLY JSON keys: is_apartment, name (Hebrew 'street — neighborhood'), neighborhood, price, rooms, built, garden, chat_notes.\n" +
        "If not a listing: {\"is_apartment\":false}.\n\nPost text:\n" +
        (text || "(none)"),
    },
  ];
  if (imagePng?.length) {
    parts.push({
      inline_data: {
        mime_type: "image/png",
        data: Buffer.from(imagePng).toString("base64"),
      },
    });
  }
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${GEMINI}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    console.warn("gemini", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  const raw = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text || "")
    .join("");
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function toNum(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function scrapeOk(fields) {
  return Boolean(fields?.name && !isGenericName(fields.name) && fields.thumb);
}

async function scrapeFacebookFields({ aptId, url }) {
  const scraped = await scrapeFacebook(url, {
    screenshot: true,
    timeoutMs: SCRAPE_TIMEOUT_MS,
  });
  if (scraped.blocked || scraped.private || scraped.unavailable) {
    return {
      ok: false,
      blocked: !!scraped.private,
      gone: !!scraped.unavailable,
      reason: scraped.reason || "fb_gated",
    };
  }

  const parsed = await parseListingWithGemini({
    text: scraped.text,
    imagePng: scraped.screenshotPng,
  });
  const fields = {
    url: scraped.url || url,
    source: "telegram-facebook",
    chat_notes: (scraped.postText || scraped.text || "").slice(0, 400),
  };
  if (parsed?.is_apartment !== false) {
    if (parsed?.name) fields.name = parsed.name;
    if (parsed?.neighborhood) fields.neighborhood = parsed.neighborhood;
    const price = toNum(parsed?.price) ?? scraped.priceHint ?? null;
    if (price != null) fields.price = price;
    const rooms = toNum(parsed?.rooms);
    if (rooms != null) fields.rooms = rooms;
    const built = toNum(parsed?.built);
    if (built != null) fields.built = built;
    if (parsed?.garden != null && parsed.garden !== "") {
      const g = String(parsed.garden).replace(/[^\d.]/g, "");
      fields.garden = g || String(parsed.garden);
    }
  } else if (scraped.priceHint != null) {
    fields.price = scraped.priceHint;
  }
  if (!fields.name && scraped.postText) {
    fields.name = scraped.postText.split("\n")[0].slice(0, 80);
  }

  for (const imageUrl of scraped.imageUrls || []) {
    try {
      const imgRes = await fetch(imageUrl, {
        headers: { Referer: scraped.url || url, Accept: "image/*,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!imgRes.ok) continue;
      const buf = Buffer.from(await imgRes.arrayBuffer());
      if (buf.length < 10000) continue;
      const ct = imgRes.headers.get("content-type") || "image/jpeg";
      fields.thumb = await uploadThumb(aptId, buf, ct);
      break;
    } catch (e) {
      console.warn("fb thumb", e.message);
    }
  }
  if (!fields.thumb && scraped.screenshotPng?.length > 20000) {
    fields.thumb = await uploadThumb(aptId, scraped.screenshotPng, "image/png");
  }

  if (!scrapeOk(fields)) {
    return { ok: false, reason: "incomplete", fields };
  }
  return { ok: true, fields };
}

async function scrapeYad2Fields({ aptId, url }) {
  const scraped = await scrapeYad2(url, { timeoutMs: SCRAPE_TIMEOUT_MS });
  if (scraped.blocked) {
    return { ok: false, blocked: true, reason: scraped.reason };
  }
  if (scraped.gone) {
    return { ok: false, gone: true, reason: scraped.reason };
  }

  const fields = {
    url: scraped.url || url,
    source: "telegram-yad2",
    name: scraped.name || null,
    neighborhood: scraped.neighborhood || null,
    price: scraped.price ?? null,
    rooms: scraped.rooms ?? null,
    built: scraped.built ?? null,
    garden: scraped.garden ?? null,
  };

  if (scraped.imageUrl) {
    try {
      const imgRes = await fetch(scraped.imageUrl, {
        headers: { Referer: scraped.url || url, Accept: "image/*,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (imgRes.ok) {
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.length > 8000) {
          const ct = imgRes.headers.get("content-type") || "image/jpeg";
          fields.thumb = await uploadThumb(aptId, buf, ct);
        }
      }
    } catch (e) {
      console.warn("thumb", aptId, e.message);
    }
  }

  if (!scrapeOk(fields)) {
    return { ok: false, reason: "incomplete", fields };
  }
  return { ok: true, fields };
}

async function enrichOne(job) {
  const { aptId, url, chatId, create } = job;
  if (!url) return { ok: false, skip: true, reason: "no_url" };

  let result;
  try {
    result = await withTimeout(
      /facebook\.com|fb\.watch/i.test(url)
        ? scrapeFacebookFields({ aptId, url })
        : /yad2\.co\.il/i.test(url)
        ? scrapeYad2Fields({ aptId, url })
        : Promise.resolve({ ok: false, skip: true, reason: "unsupported" }),
      SCRAPE_TIMEOUT_MS,
      "scrape",
    );
  } catch (e) {
    console.warn("scrape timeout/error", aptId, e.message);
    if (chatId) {
      await notify(
        chatId,
        "עיבוד המודעה לקח יותר מדי זמן (מעל 2 דקות) — לא נוספה רשומה.",
      );
    }
    return { ok: false, timedOut: true, reason: e.message };
  }

  if (!result.ok) {
    if (chatId && !result.skip) {
      const msg = result.gone
        ? "המודעה לא זמינה יותר — לא נוספה רשומה."
        : result.blocked
        ? "לא הצלחתי לקרוא את המודעה (חסום/פרטי) — לא נוספה רשומה.\nשלחו צילום מסך + כתובת במקום."
        : "לא הצלחתי לקרוא שם רחוב/תמונה — לא נוספה רשומה.";
      await notify(chatId, msg);
    }
    return result;
  }

  const fields = result.fields;
  const existing = await apartmentExists(aptId);
  if (create || !existing) {
    await upsertApartment({
      id: aptId,
      name: fields.name,
      neighborhood: fields.neighborhood || "",
      price: fields.price ?? null,
      rooms: fields.rooms ?? null,
      built: fields.built ?? null,
      garden: fields.garden ?? null,
      url: fields.url,
      thumb: fields.thumb,
      source: fields.source || "telegram",
      visited: false,
      expired: false,
      chat_notes: fields.chat_notes || job.context || null,
    });
    if (chatId) {
      await notify(
        chatId,
        `${existing ? "כבר קיימת, עודכנה" : "נוספה"}: ${fields.name}`,
      );
    }
  } else {
    await patchApartment(aptId, fields);
    if (chatId) {
      await notify(chatId, `עודכנה: ${fields.name}`);
    }
  }
  return { ok: true, fields };
}

async function loadYad2Apartments() {
  const res = await fetch(
    `${SB_URL}/rest/v1/apartments?select=id,name,url,thumb,price,rooms&or=(url.ilike.*yad2*)&order=id`,
    { headers },
  );
  return res.json();
}

const loop = process.argv.includes("--loop");
const once = !loop;

await ensureChromeCdp();

async function runPass() {
  let done = 0;
  let blocked = 0;

  const objects = await listQueue();
  console.log("queue items", objects.length);
  for (const obj of objects) {
    const item = await loadQueueItem(obj.name);
    if (!item?.data?.aptId) continue;
    console.log("queue", item.data.aptId, item.data.url);
    const result = await enrichOne(item.data);
    console.log(" ->", result.ok ? "ok" : result.reason, result.fields?.name || "");
    // Always drop queue item after attempt: no placeholders left hanging.
    await deleteQueueItem(item.path);
    if (result.ok) done++;
    else if (result.blocked) blocked++;
    await new Promise((r) => setTimeout(r, 4000));
  }

  // Backfill incomplete Yad2 rows that already exist
  const apts = await loadYad2Apartments();
  const need = apts.filter((a) => {
    if (!a.url || !/yad2\.co\.il/i.test(a.url)) return false;
    if (/לא זמין|ללא פרטים|מושכרת/.test(a.name || "")) return false;
    return (
      isGenericName(a.name) ||
      !a.thumb ||
      /placeholder|logo|name-card/i.test(a.thumb || "")
    );
  });
  console.log("backfill candidates", need.length);
  for (const apt of need) {
    console.log("backfill", apt.id, apt.name, apt.url);
    const result = await enrichOne({
      aptId: apt.id,
      url: apt.url,
      name: apt.name,
      create: false,
    });
    console.log(" ->", result.ok ? "ok" : result.reason);
    if (result.ok) done++;
    if (result.blocked) {
      blocked++;
      if (blocked >= 2) {
        console.log("too many captcha blocks, stopping pass");
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log("pass done", { done, blocked });
  return { done, blocked };
}

if (once) {
  await runPass();
} else {
  console.log("enrich worker loop starting");
  for (;;) {
    try {
      await runPass();
    } catch (e) {
      console.error("pass error", e);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
