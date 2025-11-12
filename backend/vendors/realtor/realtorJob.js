// ESM – Batch job: read properties from MongoDB, fetch Realtor estimate, save back
// Run: node vendors/realtor/realtorJob.js

import "dotenv/config.js";
import { MongoClient } from "mongodb";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

/* -------------------- CONFIG -------------------- */
const {
  MONGO_URI,
  MONGO_DB = "deal_finder",
  MONGO_COLLECTION = "properties",
  LIMIT = "50",
  START_SKIP = "0",

  // We'll try these URLs in order until one works on your current UI variant.
  REALTOR_URLS = "https://www.realtor.com/myhome/homevalue,https://www.realtor.com/realestatevalue",
  HEADLESS = "true",             // set HEADLESS=false for visual debugging
  SLOWMO = "0",                  // e.g. SLOWMO=25 to slow actions
  SCREENSHOT_DIR = "./snapshots/realtor", // where to save failure screenshots
} = process.env;

if (!MONGO_URI) {
  console.error("Missing MONGO_URI in .env");
  process.exit(1);
}

/* -------------------- HELPERS -------------------- */
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeAddress({ street, city, state, zip }) {
  if (street && !city && !state && !zip) return street;
  return [street, city, state, zip].filter(Boolean).join(", ");
}

function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function parseCurrencyToNumber(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^\d.]/g, "");
  return cleaned ? Number(cleaned) : null;
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: HEADLESS !== "false",
    slowMo: Number.isFinite(+SLOWMO) ? +SLOWMO : 0,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    protocolTimeout: 120_000,
  });
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 900 });
  if (typeof page.setDefaultTimeout === "function") page.setDefaultTimeout(45_000);
  if (typeof page.setDefaultNavigationTimeout === "function") page.setDefaultNavigationTimeout(60_000);
  return page;
}

/** Basic bot/blocked detector (text + obvious gates) */
async function detectGate(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText || "");
    if (/verify you are human|are you a robot|access denied|temporarily blocked/i.test(text)) return "blocked";
  } catch {}
  return null;
}

/** Try selectors across all same-origin frames */
async function findInAllFrames(page, selectors, { visible = true, timeout = 30000 } = {}) {
  const start = Date.now();

  function listFrames() {
    const out = [];
    const stack = [page.mainFrame()];
    while (stack.length) {
      const f = stack.pop();
      out.push(f);
      for (const cf of f.childFrames()) stack.push(cf);
    }
    return out;
  }

  while (Date.now() - start < timeout) {
    const frames = listFrames();
    for (const frame of frames) {
      for (const sel of selectors) {
        try {
          const handle = await frame.$(sel);
          if (handle) {
            if (!visible) return { frame, handle, sel };
            const box = await handle.boundingBox();
            if (box) return { frame, handle, sel };
          }
        } catch {
          // ignore cross-origin frame access errors
        }
      }
    }
    await wait(200);
  }
  throw new Error(`No element found for selectors: ${selectors.join(", ")}`);
}

/** Extract a currency-looking string, prioritizing ones near "RealEstimate" */
async function extractEstimate(page) {
  // 1) Look for obvious “RealEstimate” blocks and read the first $ number inside
  const byLabel = await page.evaluate(() => {
    const results = [];
    const walk = (node) => {
      if (!node) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        const label = (el.innerText || "").toLowerCase();
        if (label.includes("realestimate")) {
          const m = (el.innerText || "").match(/\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?/);
          if (m) results.push(m[0]);
        }
      }
      for (const child of node.childNodes || []) walk(child);
    };
    walk(document.body);
    return results;
  });
  if (byLabel && byLabel.length) return byLabel[0];

  // 2) Fall back: first “big” dollar number on the page (heuristic)
  const anyDollar = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const matches = text.match(/\$\s*\d{1,3}(?:,\d{3})+(?:\.\d+)?/g);
    if (matches && matches.length) {
      // Prefer larger numbers (more commas)
      return matches.sort((a, b) => (b.match(/,/g)||[]).length - (a.match(/,/g)||[]).length)[0];
    }
    return null;
  });
  return anyDollar;
}

/**
 * Realtor estimate flow:
 *  1) Try multiple known entry URLs (AB tests differ)
 *  2) Dismiss consent
 *  3) Find address input (robust selectors, frames)
 *  4) Submit (button or Enter)
 *  5) Wait for results and parse currency
 *
 * Returns: { ok, estimate, rawText, reason }
 */
async function getRealtorEstimate(page, addrString) {
  const urls = (REALTOR_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!urls.length) return { ok: false, reason: "no_urls_configured" };

  const addressSelectors = [
    'input[placeholder*="address" i]',
    'input[aria-label*="address" i]',
    'input[name*="address" i]',
    'input[id*="address" i]',
    'input[type="search"]',
    'input[type="text"]',
    // Realtor site-wide header search fallback:
    'input[aria-label*="Search" i]',
  ];

  const searchSelectors = [
    'button[type="submit"]',
    'button[aria-label*="search" i]',
    'button:has(svg)',
    'button',
    '[role="button"]',
  ];

  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      // Try to accept common consent/cookie prompts
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"]'));
        const btn = btns.find(b => /accept|agree|continue|got it|ok|allow all|yes/i.test((b.innerText || b.value || "").trim()));
        if (btn) btn.click();
      }).catch(() => {});

      await wait(1500);

      const gate = await detectGate(page);
      if (gate) return { ok: false, reason: gate, rawText: null, estimate: null };

      // Find address input
      const { frame: addrFrame, handle: addrHandle } =
        await findInAllFrames(page, addressSelectors, { visible: true, timeout: 30000 })
          .catch(() => ({}));

      if (!addrHandle) {
        // If no input in this variant, skip to next URL
        continue;
      }

      // Type address
      try { await addrHandle.click({ clickCount: 3 }); } catch {}
      try { await addrFrame.evaluate(el => { if (el) el.value = ""; }, addrHandle); } catch {}
      await addrHandle.type(addrString, { delay: 20 });

      // Click search or press Enter
      let clicked = false;
      const deadline = Date.now() + 6000;
      while (!clicked && Date.now() < deadline) {
        try {
          const { frame: btnFrame, handle: btnHandle } =
            await findInAllFrames(page, searchSelectors, { visible: true, timeout: 1200 });
          const text = await btnFrame.evaluate(el => (el.innerText || el.value || "").trim(), btnHandle);
          if (/search|go|estimate|submit|find/i.test(text) || text === "") {
            await btnHandle.click();
            clicked = true;
            break;
          } else {
            await wait(200);
          }
        } catch {
          // keep trying briefly
        }
      }
      if (!clicked) {
        try { await addrHandle.press("Enter"); } catch {}
      }

      // Wait for navigation/content change
      // Heuristic: wait for either a value-looking element or any route change
      let gotValue = null;
      const start = Date.now();
      while (Date.now() - start < 60000) {
        gotValue = await extractEstimate(page);
        if (gotValue) break;
        await wait(500);
      }
      if (!gotValue) {
        // Take a screenshot to help debugging
        try {
          ensureDirSync(SCREENSHOT_DIR);
          const fname = path.join(SCREENSHOT_DIR, `no_value_${Date.now()}.png`);
          await page.screenshot({ path: fname, fullPage: true });
          console.log(`[SNAPSHOT] Saved ${fname}`);
        } catch {}
        // Try next URL, if any
        continue;
      }

      const estimateNum = parseCurrencyToNumber(gotValue);
      if (!estimateNum) return { ok: false, reason: `parse_fail(${gotValue})`, estimate: null, rawText: gotValue };

      return { ok: true, rawText: gotValue, estimate: estimateNum, reason: null };
    } catch (e) {
      // Try the next URL
      console.log(`[Variant fail] ${url}: ${e?.message || e}`);
      continue;
    }
  }

  return { ok: false, reason: "no_variant_succeeded", rawText: null, estimate: null };
}

/* -------------------- JOB -------------------- */

function buildAddressFromDoc(doc) {
  if (doc.fullAddress) return normalizeAddress({ street: doc.fullAddress });
  const street = doc.address || doc.street || "";
  const city = doc.city || "";
  const state = doc.state || "";
  const zip = doc.zip || "";
  return normalizeAddress({ street, city, state, zip });
}

async function run() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const col = client.db(MONGO_DB).collection(MONGO_COLLECTION);

  const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

  // Only docs missing or stale realtor_value
  const filter = {
    $or: [
      { realtor_value: { $exists: false } },
      { realtor_value: null },
      { "realtor_meta.lastChecked": { $lt: new Date(Date.now() - THIRTY_DAYS) } },
    ],
  };

  const limit = parseInt(LIMIT, 10) || 50;
  const skip = parseInt(START_SKIP, 10) || 0;

  const docs = await col.find(filter).skip(skip).limit(limit).toArray();
  if (!docs.length) {
    console.log("No matching properties found for update.");
    await client.close();
    return;
  }

  ensureDirSync(SCREENSHOT_DIR);

  const browser = await launchBrowser();
  const page = await newPage(browser);

  try {
    let gatesInARow = 0;
    const MAX_GATES = 2;

    for (const doc of docs) {
      const _id = doc._id;
      const addr = buildAddressFromDoc(doc);
      if (!addr) {
        console.log(`[SKIP] ${_id} missing address`);
        continue;
      }

      console.log(`[START] ${_id} :: ${addr}`);

      const res = await getRealtorEstimate(page, addr);

      if (res.ok) {
        gatesInARow = 0;
        await col.updateOne(
          { _id },
          {
            $set: {
              realtor_value: res.estimate,
              "realtor_meta.rawText": res.rawText,
              "realtor_meta.lastChecked": new Date(),
              "realtor_meta.source": "realtor_realestimate",
              "realtor_meta.urlsTried": (REALTOR_URLS || "").split(",").map(s => s.trim()).filter(Boolean),
              "realtor_meta.status": "ok",
            },
          }
        );
        console.log(`[OK] ${_id} -> ${res.rawText}`);
      } else if (res.reason === "blocked") {
        gatesInARow++;
        await col.updateOne(
          { _id },
          {
            $set: {
              "realtor_meta.lastChecked": new Date(),
              "realtor_meta.status": "blocked",
            },
          }
        );
        console.log(`[GATE] ${_id} – blocked; backing off`);
        await nap(60_000 + Math.floor(Math.random() * 30_000));
        if (gatesInARow >= MAX_GATES) {
          console.log(`Too many gates in a row (${gatesInARow}). Stopping run.`);
          break;
        }
      } else {
        gatesInARow = 0;
        await col.updateOne(
          { _id },
          {
            $set: {
              "realtor_meta.lastChecked": new Date(),
              "realtor_meta.status": "error",
              "realtor_meta.error": res.reason || "unknown",
            },
          }
        );
        console.log(`[FAIL] ${_id} – ${res.reason}`);
      }

      // Polite pacing
      await nap(3_000 + Math.floor(Math.random() * 2_000));
    }
  } finally {
    await browser.close();
    await client.close();
  }
}

run().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});