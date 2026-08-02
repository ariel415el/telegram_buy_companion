import { chromium } from "patchright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const PROFILE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".cache",
  "fb-chrome-profile",
);

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9223";

function looksLikeListingText(t) {
  return /דירת\s*גן|דירה\s*למכירה|\d+(?:\.\d)?\s*חדר|גינה\s*\d|מ״ר|מ"ר|\d[\d,.]*\s*₪|שיווק\s*\d/i.test(
    t || "",
  );
}

async function openPage() {
  try {
    const res = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) {
      const browser = await chromium.connectOverCDP(CDP_URL);
      const context = browser.contexts()[0];
      const page = await context.newPage();
      return {
        page,
        close: async () => {
          await page.close().catch(() => {});
          await browser.close().catch(() => {});
        },
        mode: "cdp",
      };
    }
  } catch {
    /* fall through */
  }
  mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    userAgent: USER_AGENT,
    locale: "he-IL",
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || (await context.newPage());
  return { page, close: async () => context.close(), mode: "headed" };
}

async function extractPost(page) {
  return page.evaluate(() => {
    const articles = [
      ...document.querySelectorAll('[role="article"], div[data-ad-preview="message"], div[dir="auto"]'),
    ];
    const blocks = articles
      .map((el) => (el.innerText || "").trim())
      .filter(
        (t) =>
          t.length > 30 &&
          /דירת|חדר|גינה|מ״ר|מ"ר|₪|למכירה|שכונ/i.test(t) &&
          !/About this group|Group rules|Create a post|What's on your mind/i.test(t),
      );
    // unique, longest first
    const uniq = [...new Set(blocks)].sort((a, b) => b.length - a.length);

    const allText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const priceMatch = allText.match(/₪\s*([\d,]+)/) || allText.match(/([\d,]+)\s*₪/);

    const imgs = [...document.querySelectorAll("img")]
      .map((img) => ({
        src: img.currentSrc || img.src,
        w: img.naturalWidth,
        h: img.naturalHeight,
      }))
      .filter(
        (i) =>
          i.src &&
          i.w >= 250 &&
          i.h >= 250 &&
          /scontent|fbcdn/i.test(i.src) &&
          !/emoji|static\.xx|rsrc\.php|s130x130|p50x50|p32x32/i.test(i.src),
      )
      .sort((a, b) => b.w * b.h - a.w * a.h);

    const seen = new Set();
    const imageUrls = [];
    for (const i of imgs) {
      const k = i.src.split("?")[0];
      if (seen.has(k)) continue;
      seen.add(k);
      imageUrls.push(i.src);
      if (imageUrls.length >= 6) break;
    }

    return {
      title: document.title,
      url: location.href,
      postText: uniq[0] || "",
      blocks: uniq.slice(0, 5),
      priceHint: priceMatch ? Number(priceMatch[1].replace(/,/g, "")) : null,
      text: allText.slice(0, 4000),
      imageUrls,
    };
  });
}

/**
 * Scrape a Facebook share/permalink post using a logged-in Chrome session.
 */
export async function scrapeFacebook(url, { timeoutMs = 120000, screenshot = true } = {}) {
  const { page, close, mode } = await openPage();
  const deadline = Date.now() + timeoutMs;
  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: Math.min(timeoutMs, 90_000),
    });
    await page.waitForTimeout(Math.min(3500, Math.max(0, deadline - Date.now())));

    let data = await extractPost(page);
    for (let i = 0; i < 12 && Date.now() < deadline - 2000; i++) {
      if (looksLikeListingText(data.postText) || looksLikeListingText(data.text)) break;
      await page.waitForTimeout(1500);
      data = await extractPost(page);
    }

    const listingText = data.postText || data.blocks.find(looksLikeListingText) || "";
    const combined = [listingText, data.text].filter(Boolean).join("\n");
    const hasListing = looksLikeListingText(combined);

    const privateGate =
      !hasListing &&
      /Private group|קבוצה פרטית|Only members can see|Join Group|Log in or sign up/i.test(
        data.text,
      );
    const unavailable = /פרסום פייסבוק זה אינו זמין|This content isn't available|isn't available right now/i.test(
      data.text,
    );

    if (unavailable) {
      return {
        blocked: true,
        private: false,
        unavailable: true,
        reason: "unavailable",
        mode,
        url: data.url,
        title: data.title,
        text: data.text,
        imageUrls: [],
      };
    }
    if (privateGate) {
      return {
        blocked: true,
        private: true,
        unavailable: false,
        reason: "private_or_login",
        mode,
        url: data.url,
        title: data.title,
        text: data.text,
        imageUrls: [],
      };
    }

    let screenshotPng = null;
    if (screenshot && hasListing) {
      try {
        screenshotPng = await page.screenshot({ type: "png", fullPage: false });
      } catch {
        /* ignore */
      }
    }

    return {
      blocked: false,
      private: false,
      unavailable: false,
      mode,
      url: data.url,
      title: data.title,
      text: combined,
      postText: listingText,
      priceHint: data.priceHint,
      imageUrls: data.imageUrls,
      screenshotPng,
    };
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: node scripts/fb-scrape.mjs <url>");
    process.exit(1);
  }
  const r = await scrapeFacebook(url, { screenshot: false });
  const out = { ...r };
  delete out.screenshotPng;
  console.log(JSON.stringify(out, null, 2));
}
