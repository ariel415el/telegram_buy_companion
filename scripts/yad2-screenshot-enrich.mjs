#!/usr/bin/env node
// Screenshot Yad2 listings → Gemini vision → update name + thumb.
// Never touches verdicts.
import { chromium } from "playwright-core";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const root = new URL("..", import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(`${root}.secrets/supabase.env`, "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("=")),
);
const SB = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI = readFileSync(`${root}.secrets/gemini_api_key.txt`, "utf8").trim();
const MODEL = "gemini-flash-lite-latest";
const OUT = "/tmp/yad2-shots";
mkdirSync(OUT, { recursive: true });

const apts = await fetch(`${SB}/rest/v1/apartments?select=id,name,url,price,rooms&order=id`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then((r) => r.json());

const targets = apts.filter((a) => a.url && /yad2\.co\.il/i.test(a.url));
console.log("yad2 targets", targets.length);

async function uploadThumb(aptId, bytes) {
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
  const path = `${aptId}-${hash}.jpg`;
  const res = await fetch(`${SB}/storage/v1/object/listing-thumbs/${path}`, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "content-type": "image/jpeg",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(await res.text());
  return `${SB}/storage/v1/object/public/listing-thumbs/${path}`;
}

async function parseShot(bytes, url) {
  const b64 = bytes.toString("base64");
  const prompt =
    `This is a screenshot of an Israeli Yad2 apartment listing page (${url}).\n` +
    `If it's a captcha/blocked/security page, return {"blocked":true}.\n` +
    `Otherwise return ONLY JSON:\n` +
    `{"blocked":false,"name":"Hebrew street (+number if shown) — neighborhood","neighborhood":"...","price":integer_or_null,"rooms":number_or_null,"street":"...","street_number":"..._or_null","expired":boolean}\n` +
    `name MUST prefer street+number when visible (e.g. "נץ החלב 12 — הפרחים").`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/jpeg", data: b64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
      }),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status} ${await res.text()}`);
  const data = await res.json();
  const raw = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { blocked: true };
  }
}

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    "--lang=he-IL",
  ],
});

for (const apt of targets) {
  console.log("\n===", apt.id, apt.url);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "he-IL",
    extraHTTPHeaders: { "Accept-Language": "he-IL,he;q=0.9,en;q=0.8" },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  try {
    await page.goto(apt.url, { waitUntil: "domcontentloaded", timeout: 90000 });
    // Give Radware time; reload once if still verifying
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(4000);
      const title = await page.title();
      const text = await page.evaluate(() => (document.body?.innerText || "").slice(0, 200));
      const blocked =
        /Radware|אבטחת אתר|Verifying your browser|מתנצלים|robot/i.test(title + text);
      console.log(`  wait ${i} title=${title.slice(0, 40)} blocked=${blocked}`);
      if (!blocked) break;
      if (i === 3 || i === 6) {
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      }
    }
    // Scroll a bit so listing content paints
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(1500);

    const shotPath = `${OUT}/${apt.id}.jpg`;
    await page.screenshot({ path: shotPath, type: "jpeg", quality: 75, fullPage: false });
    const bytes = readFileSync(shotPath);
    console.log("  shot", bytes.length);

    const parsed = await parseShot(bytes, apt.url);
    console.log("  gemini", JSON.stringify(parsed).slice(0, 200));

    if (parsed.blocked) {
      console.log("  still blocked — skip");
      await context.close();
      continue;
    }

    const patch = { updated_at: new Date().toISOString() };
    if (parsed.name && String(parsed.name).trim().length > 2) {
      patch.name = String(parsed.name).trim();
    } else if (parsed.street) {
      const num = parsed.street_number ? ` ${parsed.street_number}` : "";
      const hood = parsed.neighborhood ? ` — ${parsed.neighborhood}` : "";
      patch.name = `${parsed.street}${num}${hood}`.trim();
    }
    if (parsed.neighborhood) patch.neighborhood = String(parsed.neighborhood);
    if (parsed.price != null && Number.isFinite(Number(parsed.price))) {
      patch.price = Number(parsed.price);
    }
    if (parsed.rooms != null && Number.isFinite(Number(parsed.rooms))) {
      patch.rooms = Number(parsed.rooms);
    }
    if (parsed.expired === true) patch.expired = true;

    // Prefer an in-page listing image if present; else use screenshot
    const imgSrc = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll("img")]
        .map((img) => ({
          src: img.currentSrc || img.src,
          w: img.naturalWidth,
          h: img.naturalHeight,
        }))
        .filter(
          (i) =>
            i.src &&
            i.w >= 400 &&
            i.h >= 250 &&
            !/logo|sprite|icon|captcha|robot/i.test(i.src),
        );
      return imgs[0]?.src || null;
    });
    let thumbBytes = bytes;
    if (imgSrc) {
      try {
        const imgRes = await context.request.get(imgSrc, { headers: { Referer: apt.url } });
        if (imgRes.ok()) {
          const buf = Buffer.from(await imgRes.body());
          if (buf.length > 10000) thumbBytes = buf;
        }
      } catch {
        /* keep screenshot */
      }
    }
    patch.thumb = await uploadThumb(apt.id, thumbBytes);

    const res = await fetch(`${SB}/rest/v1/apartments?id=eq.${encodeURIComponent(apt.id)}`, {
      method: "PATCH",
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(patch),
    });
    console.log("  patched", res.status, patch.name, !!patch.thumb, patch.price);
    writeFileSync(`${OUT}/${apt.id}.json`, JSON.stringify({ parsed, patch }, null, 2));
  } catch (e) {
    console.log("  err", e.message);
  }
  await context.close();
}

await browser.close();
console.log("done");
