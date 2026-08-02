#!/usr/bin/env node
// Enrich apartments that have URLs: street name + real photo via Playwright.
// Never touches verdicts.
import { chromium } from "playwright-core";
import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.secrets/supabase.env", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((l) => l.split("=")),
);
const SB_URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

async function uploadThumb(aptId, bytes, mime = "image/jpeg") {
  const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 8);
  const path = `${aptId}-${hash}.${ext}`;
  const res = await fetch(`${SB_URL}/storage/v1/object/listing-thumbs/${path}`, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "content-type": mime,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`upload ${await res.text()}`);
  return `${SB_URL}/storage/v1/object/public/listing-thumbs/${path}`;
}

function cleanTitle(title) {
  if (!title) return null;
  let t = title.split("|")[0].trim();
  if (/Radware|אבטחת אתר|^Madlan$/i.test(t)) return null;
  t = t.replace(/^דירת?\s+(?:גן\s+)?למכירה:\s*/i, "");
  t = t.replace(/\s+ב-?[‏\u200f]?\s*[\d,.]+\s*(?:מ['׳]?)?\s*₪?.*$/u, "").trim();
  // "street N, neighborhood, city" → "street N — neighborhood"
  if (t.includes(",")) {
    const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
    const cityIdx = parts.findIndex((p) => /מודיעין|מכבים|רעות/.test(p));
    const useful = cityIdx >= 0 ? parts.slice(0, cityIdx) : parts.slice(0, 2);
    if (useful.length >= 2) t = `${useful[0]} — ${useful[1]}`;
    else if (useful.length === 1) t = useful[0];
  }
  // Keyz style: "דירת גן 3 חדרים בהמגינים" — keep if has street elsewhere
  if (t.length < 3 || t.length > 120) return null;
  return t;
}

function needsEnrich(apt) {
  const name = apt.name || "";
  const generic =
    /ממתין|מודעת|דירה במודיעין|דירה במדלן|יד2 |מדלן |שחזרה להיות|ליד הקניון|דירת גן במודיעין \(יד2|דירת גן \d חדרים ב/.test(
      name,
    );
  const noStreetNum = !/\d/.test(name) && !/נץ החלב|נהר הירדן|עמק האלה|לבונה|ירמוך|טבת|יצחק רבין/.test(name);
  return { generic, noStreetNum, needImage: true };
}

async function scrapeListing(browser, url) {
  const isYad2 = /yad2\.co\.il/i.test(url);
  const context = await browser.newContext({
    viewport: isYad2 ? { width: 390, height: 844 } : { width: 1365, height: 900 },
    userAgent: isYad2
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    locale: "he-IL",
    isMobile: isYad2,
    hasTouch: isYad2,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(isYad2 ? 12000 : 8000);
    for (let i = 0; i < 5; i++) {
      const title = await page.title();
      const blocked =
        /Radware|אבטחת|סליחה על ההפרעה|^Madlan$/i.test(title) ||
        (await page.locator("text=סליחה על ההפרעה").count()) > 0 ||
        (await page.locator("text=Verifying your browser").count()) > 0;
      if (!blocked) break;
      await page.waitForTimeout(5000);
      if (i === 2) await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    const meta = await page.evaluate(() => {
      const get = (p) =>
        document.querySelector(`meta[property="${p}"]`)?.content ||
        document.querySelector(`meta[name="${p}"]`)?.content ||
        null;
      // Yad2 sometimes embeds JSON
      const scripts = [...document.querySelectorAll("script")]
        .map((s) => s.textContent || "")
        .filter((t) => t.includes("address") || t.includes("street") || t.includes("og:"));
      return {
        title: get("og:title") || document.title,
        image: get("og:image") || get("twitter:image"),
        desc: get("og:description"),
        text: (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 800),
        jsonHints: scripts.slice(0, 2).map((t) => t.slice(0, 200)),
      };
    });
    // Prefer large in-page images if OG missing/bad
    const imgs = await page.evaluate(() =>
      [...document.querySelectorAll("img")]
        .map((img) => ({
          src: img.currentSrc || img.src,
          w: img.naturalWidth,
          h: img.naturalHeight,
        }))
        .filter((i) => i.src && i.w >= 400 && i.h >= 250 && !/logo|sprite|icon/i.test(i.src))
        .slice(0, 6),
    );
    let imageUrl = meta.image;
    if (!imageUrl || /logo|placeholder|robot|image\.png|Radware/i.test(imageUrl)) {
      imageUrl = imgs[0]?.src || null;
    }
    let imageBytes = null;
    let mime = "image/jpeg";
    if (imageUrl) {
      try {
        const imgRes = await context.request.get(imageUrl, {
          headers: { Referer: url, Accept: "image/*,*/*" },
        });
        if (imgRes.ok()) {
          const buf = Buffer.from(await imgRes.body());
          if (buf.length > 8000) {
            imageBytes = buf;
            const ct = imgRes.headers()["content-type"] || "";
            mime = ct.includes("png")
              ? "image/png"
              : ct.includes("webp")
              ? "image/webp"
              : "image/jpeg";
          }
        }
      } catch {
        /* ignore */
      }
    }
    return { meta, imageBytes, mime, finalUrl: page.url() };
  } finally {
    await context.close();
  }
}

const apts = await fetch(`${SB_URL}/rest/v1/apartments?select=id,name,url,thumb,neighborhood,price,rooms&order=id`, {
  headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
}).then((r) => r.json());

const withUrl = apts.filter((a) => a.url && /yad2|madlan|keyz/i.test(a.url));
console.log("with listing urls", withUrl.length);

const browser = await chromium.launch({
  headless: true,
  executablePath: "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
});

const results = [];
for (const apt of withUrl) {
  const flags = needsEnrich(apt);
  try {
    const { meta, imageBytes, mime } = await scrapeListing(browser, apt.url);
    const patch = { updated_at: new Date().toISOString() };
    const name = cleanTitle(meta.title);
    // Prefer scraped street name when current is generic OR scraped has a digit (street number)
    if (name) {
      const scrapedHasNum = /\d/.test(name);
      const curGeneric =
        /ממתין|מודעת|דירה במודיעין|דירה במדלן|יד2 |דירת גן \d חדרים ב|שחזרה|ליד הקניון|דירת גן במודיעין/.test(
          apt.name || "",
        );
      if (curGeneric || (scrapedHasNum && !/\d/.test(apt.name || ""))) {
        patch.name = name;
        const parts = name.split("—").map((s) => s.trim());
        if (parts[1]) patch.neighborhood = parts[1].replace(/\(.*\)/, "").trim();
      }
    }
    // Keyz desc often has "street N, city"
    if (meta.desc && (!patch.name || !/\d/.test(patch.name))) {
      const m = meta.desc.match(/\|\s*([^|]+?),\s*מודיעין/);
      if (m && /\d/.test(m[1])) {
        patch.name = m[1].trim();
      }
    }
    if (meta.title) {
      const pm = meta.title.match(/([\d,]+)\s*₪/);
      if (pm && !apt.price) patch.price = Number(pm[1].replace(/,/g, ""));
    }
    if (meta.desc) {
      const rm = meta.desc.match(/(\d+(?:\.\d)?)\s*חדר/);
      if (rm && apt.rooms == null) patch.rooms = Number(rm[1]);
    }
    if (imageBytes) {
      patch.thumb = await uploadThumb(apt.id, imageBytes, mime);
    }
    const changed = Object.keys(patch).length > 1;
    if (changed) {
      const res = await fetch(`${SB_URL}/rest/v1/apartments?id=eq.${encodeURIComponent(apt.id)}`, {
        method: "PATCH",
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(patch),
      });
      console.log(
        "patched",
        apt.id,
        res.status,
        patch.name || "-",
        !!patch.thumb,
        meta.title?.slice(0, 50),
      );
      results.push({ id: apt.id, ok: true, patch, title: meta.title });
    } else {
      console.log("nochange", apt.id, meta.title?.slice(0, 60));
      results.push({ id: apt.id, ok: false, title: meta.title });
    }
  } catch (e) {
    console.log("err", apt.id, e.message);
    results.push({ id: apt.id, ok: false, error: e.message });
  }
}

await browser.close();
writeFileSync("/tmp/enrich_results.json", JSON.stringify(results, null, 2));
console.log("done", results.filter((r) => r.ok).length, "/", results.length);
