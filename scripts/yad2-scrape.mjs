import { chromium } from "patchright";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { pathToFileURL } from "url";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";

const PROFILE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".cache",
  "yad2-profile",
);

const CDP_URL = process.env.CHROME_CDP_URL || "http://127.0.0.1:9223";

function contextOptions() {
  return {
    userAgent: USER_AGENT,
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    geolocation: { latitude: 32.0853, longitude: 34.7818 },
    permissions: ["geolocation"],
    viewport: { width: 1365, height: 900 },
    extraHTTPHeaders: {
      "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  };
}

export function tokenFromUrl(url) {
  const m =
    String(url).match(/\/item\/(?:[^/]+\/)?([a-z0-9]+)/i) ||
    String(url).match(/\/s\/c\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function listingName(data) {
  const street = data?.address?.street?.text?.trim();
  const num = data?.address?.house?.number;
  const neighborhood = data?.address?.neighborhood?.text?.trim();
  const search = String(data?.searchText || "");

  if (street && street !== neighborhood) {
    const streetPart =
      num != null && String(num).trim() !== "" ? `${street} ${num}` : street;
    return neighborhood ? `${streetPart} — ${neighborhood}` : streetPart;
  }

  // "ברח יהלום" in free text — do not match bare "ברחוב …"
  const fromDesc = search.match(/ברח\s+([א-ת]+(?:[\s\-][א-ת]+){0,3})/);
  const descStreet = fromDesc?.[1]?.replace(/\s+/g, " ").trim();
  if (descStreet && descStreet.length >= 2) {
    return neighborhood ? `${descStreet} — ${neighborhood}` : descStreet;
  }

  if (street) {
    const streetPart =
      num != null && String(num).trim() !== "" ? `${street} ${num}` : street;
    return neighborhood && neighborhood !== street
      ? `${streetPart} — ${neighborhood}`
      : streetPart;
  }
  if (neighborhood) return neighborhood;
  return null;
}

function parseItemFromNextData(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  const queries = parsed?.props?.pageProps?.dehydratedState?.queries ?? [];
  const itemQ = queries.find((q) => Array.isArray(q.queryKey) && q.queryKey[0] === "item");
  return itemQ?.state?.data ?? null;
}

async function waitForItem(page, timeoutMs = 120000) {
  const start = Date.now();
  let sawCaptcha = false;
  while (Date.now() - start < timeoutMs) {
    const title = await page.title();
    const href = page.url();
    const raw = await page.evaluate(
      () => document.getElementById("__NEXT_DATA__")?.textContent ?? null,
    );
    const data = parseItemFromNextData(raw);
    if (data?.address || data?.price != null || data?.metaData) {
      return { data, sawCaptcha };
    }
    if (/ShieldSquare Captcha/i.test(title) || /validate\.perfdrive/i.test(href)) {
      sawCaptcha = true;
      await page.waitForTimeout(2500);
      continue;
    }
    if (/Radware|אבטחת אתר|Verifying your browser/i.test(title)) {
      sawCaptcha = true;
      await page.waitForTimeout(1200);
      continue;
    }
    // Soft miss: listing removed / empty next data
    if (raw && !data && Date.now() - start > 8000) {
      return { data: null, sawCaptcha, gone: true };
    }
    await page.waitForTimeout(800);
  }
  return { data: null, sawCaptcha };
}

async function openPage() {
  // Prefer an already-running real Chrome (best Radware pass rate).
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(800) });
    if (res.ok) {
      const browser = await chromium.connectOverCDP(CDP_URL);
      const context = browser.contexts()[0] || (await browser.newContext(contextOptions()));
      const page = context.pages()[0] || (await context.newPage());
      return { page, close: async () => browser.close(), mode: "cdp" };
    }
  } catch {
    /* fall through */
  }

  // Headed Chrome clears Yad2 Radware; headless often escalates to hCaptcha.
  mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    ...contextOptions(),
  });
  const page = context.pages()[0] || (await context.newPage());
  return { page, close: async () => context.close(), mode: "headed" };
}

/**
 * Scrape a Yad2 listing. Returns structured fields or { blocked: true }.
 */
export async function scrapeYad2(url, { timeoutMs = 120000 } = {}) {
  const { page, close, mode } = await openPage();
  try {
    const token = tokenFromUrl(url);
    const target =
      token && !/\/realestate\/item\//i.test(url)
        ? `https://www.yad2.co.il/realestate/item/${token}`
        : url;

    await page.goto(target, { waitUntil: "load", timeout: timeoutMs });
    const { data, sawCaptcha, gone } = await waitForItem(page, timeoutMs);
    if (!data) {
      return {
        blocked: !!sawCaptcha,
        gone: !!gone || !sawCaptcha,
        reason: `no_item mode=${mode} captcha=${!!sawCaptcha} title=${await page.title()} url=${page.url()}`,
      };
    }

    const details = data.additionalDetails || {};
    const garden =
      details.squareMeterGarden != null ? String(details.squareMeterGarden) : null;
    return {
      blocked: false,
      mode,
      token: data.token || token,
      url: data.token
        ? `https://www.yad2.co.il/realestate/item/${data.token}`
        : page.url(),
      name: listingName(data),
      neighborhood: data.address?.neighborhood?.text || null,
      price: data.price ?? null,
      rooms: details.roomsCount != null ? Number(details.roomsCount) : null,
      built: details.squareMeterBuild ?? details.squareMeter ?? null,
      garden,
      imageUrl: data.metaData?.coverImage || data.metaData?.images?.[0] || null,
      propertyType: details.property?.text || null,
      searchText: data.searchText || null,
    };
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: node scripts/yad2-scrape.mjs <url>");
    process.exit(1);
  }
  console.log(JSON.stringify(await scrapeYad2(url), null, 2));
}
