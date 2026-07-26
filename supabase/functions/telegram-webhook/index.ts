// Deno Supabase Edge Function — Telegram webhook
// Secrets: TELEGRAM_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TELEGRAM_API = "https://api.telegram.org";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("ok", { status: 200 });
  }

  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !supabaseUrl || !serviceKey) {
    return json({ error: "missing secrets" }, 500);
  }

  const sb = createClient(supabaseUrl, serviceKey);
  const update = await req.json();
  const msg = update.message || update.edited_message;
  if (!msg?.text && !msg?.caption) {
    return json({ ok: true });
  }

  const text = (msg.text || msg.caption || "").trim();
  const chatId = msg.chat.id;

  // Commands
  if (text.startsWith("/start") || text.startsWith("/help")) {
    await sendTelegram(token, chatId,
      "שלחו קישור למודעה (Yad2 / Madlan / Keyz) ואני אוסיף לטבלת הדירות.\n" +
      "אפשר גם: /add שם | מחיר | חדרים | קישור"
    );
    return json({ ok: true });
  }

  if (text.startsWith("/add ")) {
    const apt = parseManualAdd(text.slice(5));
    if (!apt) {
      await sendTelegram(token, chatId, "פורמט: /add שם | מחיר | חדרים | קישור");
      return json({ ok: true });
    }
    const { error } = await upsertApartment(sb, apt);
    await sendTelegram(
      token,
      chatId,
      error ? `שגיאה: ${error.message}` : `נוספה: ${apt.name}`
    );
    return json({ ok: true });
  }

  const urls = extractUrls(text);
  if (!urls.length) {
    return json({ ok: true }); // ignore normal chat
  }

  const results: string[] = [];
  for (const url of urls) {
    const apt = await listingFromUrl(url, text);
    if (!apt) {
      results.push(`לא זיהיתי מודעה: ${url}`);
      continue;
    }
    const { error } = await upsertApartment(sb, apt);
    results.push(error ? `שגיאה עבור ${apt.name}: ${error.message}` : `נוספה/עודכנה: ${apt.name}`);
  }

  await sendTelegram(token, chatId, results.join("\n"));
  return json({ ok: true });
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sendTelegram(token: string, chatId: number, text: string) {
  await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s<>"']+/g;
  return [...new Set((text.match(re) || []).map((u) => u.replace(/[).,;]+$/, "")))];
}

function slugId(input: string): string {
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

function parseManualAdd(body: string) {
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

async function listingFromUrl(url: string, context: string) {
  if (/yad2\.co\.il/i.test(url)) {
    return {
      id: slugId(url),
      name: "מודעת יד2",
      url,
      source: "telegram-yad2",
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
  if (/madlan\.co\.il/i.test(url)) {
    return {
      id: slugId(url),
      name: "מודעת מדלן",
      url,
      source: "telegram-madlan",
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
  if (/keyz\.ai/i.test(url)) {
    return {
      id: slugId(url),
      name: "מודעת Keyz",
      url,
      source: "telegram-keyz",
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
  return {
    id: slugId(url),
    name: "דירה מטלגרם",
    url,
    source: "telegram",
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

function extractPrice(text: string): number | null {
  const m =
    text.match(/(\d{1,2}(?:[.,]\d{3}){2,})\s*₪?/) ||
    text.match(/(\d(?:\.\d)?)\s*מ['׳']?/);
  if (!m) return null;
  let raw = m[1];
  if (raw.includes(".") && raw.length <= 4) {
    // e.g. 2.89 meaning millions
    return Math.round(parseFloat(raw) * 1_000_000);
  }
  raw = raw.replace(/[^\d]/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function extractRooms(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d)?)\s*חדר/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

async function upsertApartment(sb: ReturnType<typeof createClient>, apt: Record<string, unknown>) {
  const row = {
    ...apt,
    updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from("apartments").upsert(row, { onConflict: "id" });
  if (!error) {
    await sb.from("verdicts").upsert(
      {
        apartment_id: apt.id,
        relevant: true,
        note: "",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "apartment_id", ignoreDuplicates: true }
    );
  }
  return { error };
}
