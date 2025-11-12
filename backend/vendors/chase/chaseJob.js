// vendors/chase/chaseJob.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import * as launcher from '../../utils/puppeteer-launch.js';
import connectDB from '../../db/db.js';
import Property from '../../models/Property.js';
import { getChaseEstimate, ChaseSearchError } from './chaseScraper.js';
import { CHASE_URL, RUN_LIMIT } from './chaseSelectors.js';
import fs from 'fs';
import path from 'path';

dotenv.config();

function pickProxy() {
  // Optional rotation across your paid gateway list (env: PAID_PROXIES or DECODO_PROXY_URL)
  const inline = (process.env.PAID_PROXIES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (inline.length === 0 && process.env.DECODO_PROXY_URL) {
    return process.env.DECODO_PROXY_URL;
  }
  if (inline.length === 0) return null;
  const i = Math.floor(Math.random() * inline.length);
  const p = inline[i];
  // Support both host:port:user:pass and full http://user:pass@host:port
  if (p.includes('http')) return p;
  const [host, port, user, pass] = p.split(':');
  return `http://${user}:${pass}@${host}:${port}`;
}

export default async function runChaseJob() {
  await connectDB();

  const query = {
    $and: [
      { fullAddress: { $ne: null } },
      {
        $or: [
          { chase_value: null },
          { chase_value: { $exists: false } },
          { chasePrice: null },
          { chasePrice: { $exists: false } },
        ],
      },
    ],
  };
  // --- Preflight: how many candidates? sample a few
  const totalCandidates = await Property.countDocuments(query);
  console.log('[chase] candidates matching query:', totalCandidates);
  if (totalCandidates === 0) {
    console.log('[chase] Nothing to do: no properties missing Chase values. Exiting early.');
    await mongoose.connection.close().catch(() => {});
    return;
  }
  const sample = await Property.find(query).select({ fullAddress: 1 }).limit(3);
  console.log('[chase] sample addresses:', sample.map(s => s.fullAddress));

  const cursor = Property.find(query)
    .sort({ createdAt: -1 })
    .skip(RUN_LIMIT.startSkip)
    .limit(RUN_LIMIT.limit)
    .cursor();

  let processed = 0, solved = 0, notFound = 0, captchas = 0, failures = 0;

// Build a Chrome-friendly proxy flag (no creds) + keep creds for page.authenticate
const rawProxy = pickProxy();
let proxyFlag = null;
let proxyAuth = null;

// Split-tunnel: these hosts often break through corporate/resi forward proxies (CONNECT blocked/CDN shenanigans)
// We’ll bypass proxy for them while keeping proxy for everything else.
const proxyBypass = [
  '*.go-mpulse.net',              // boomerang/beacon
  's2.go-mpulse.net',
  '*.chasecdn.com',               // static assets/CDN
  '*.split.io', '*.splitio.com',  // feature flags
  '*.corelogic.com', 'valuemap.corelogic.com', // added
  // Common Google ad/analytics/CDN hosts that shouldn't go through an auth proxy
  '*.google.com',
  '*.gstatic.com',
  '*.googleapis.com',
  '*.g.doubleclick.net',
  '*.doubleclick.net',
  '*.googletagmanager.com',
  '*.google-analytics.com',
  // Keep loopback/local bypasses
  '<-loopback>',
  '127.0.0.1',
  'localhost'
  // NOTE: we intentionally do NOT bypass www.chase.com so that the main page still uses the proxy.
].join(';');

if (rawProxy) {
  try {
    const needsScheme = !/^[a-z]+:\/\//i.test(rawProxy);
    const u = new URL(needsScheme ? `http://${rawProxy}` : rawProxy);
    const hp = `${u.hostname}:${u.port || '80'}`;
    const proto = (u.protocol || 'http:').replace(':', '');
    // Chrome likes explicit mappings; for SOCKS keep single mapping
    proxyFlag = proto.startsWith('socks') ? `${proto}=${hp}` : `http=${hp};https=${hp}`;
    if (u.username || u.password) {
      proxyAuth = {
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
      };
    }
  } catch (e) {
    console.warn('[chase] Invalid proxy string; continuing without proxy:', e?.message || e);
  }
}

// Decide headless mode safely.
// We FORCE headless unless you explicitly set CHASE_HEADLESS=false (or HEADLESS=false) *and* a DISPLAY exists.
function envFalseish(v) {
  if (v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'false' || s === '0' || s === 'no' || s === 'off';
}
const __displayWas = process.env.DISPLAY || null;
const requestedHeadful = (envFalseish(process.env.CHASE_HEADLESS) || envFalseish(process.env.HEADLESS));
let wantHeadless = true;
if (requestedHeadful && __displayWas) {
  // Only allow headful if a DISPLAY is present
  wantHeadless = false;
} else {
  // No DISPLAY or not explicitly requested → headless
  wantHeadless = true;
}

// If headless, nuke DISPLAY so Chromium won't even attempt X11/DBus path
try { if (wantHeadless && process.env.DISPLAY) delete process.env.DISPLAY; } catch {}

const stabilityFlags = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=Translate,BackForwardCache,AudioServiceOutOfProcess',
  '--mute-audio',
];

console.log('[chase:launch]', {
  headless: wantHeadless,
  displayWas: __displayWas,
  headfulRequested: requestedHeadful,
  reason: wantHeadless ? (requestedHeadful ? 'DISPLAY missing → forced headless' : 'no headful requested') : 'honoring headful request'
});
const browser = await launcher.launchChromeWithProfile('chase-live', {
  headless: wantHeadless,
  userAgent: process.env.CHASE_UA,
  extraArgs: [
    ...(proxyFlag ? [`--proxy-server=${proxyFlag}`] : []),
    ...(proxyFlag ? [`--proxy-bypass-list=${proxyBypass}`] : []),
    ...(wantHeadless ? ['--headless=new'] : []),
    '--disable-blink-features=AutomationControlled',
    // Allow embedded CoreLogic inside chase.com
    '--disable-features=BlockThirdPartyCookies,ThirdPartyStoragePartitioning,PrivacySandboxAdsAPIs',
    '--allow-third-party-cookies',
    // Headless network stability
    '--disable-features=PaintHolding',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    ...stabilityFlags,
  ],
});
  // Reuse first page if the profile spawns one; otherwise open a new tab
  let [page] = await browser.pages();
  if (!page) page = await browser.newPage();
  try { await page.bringToFront(); } catch {}
  try { await page.setBypassCSP(true); } catch {}
  try { await page.setCacheEnabled(true); } catch {}

  // Helpful defaults + logging
  page.setDefaultTimeout(Number(process.env.PPTR_TIMEOUT_MS || 20000));
  page.setDefaultNavigationTimeout(Number(process.env.PPTR_NAV_TIMEOUT_MS || 45000));
  page.on('console', msg => {
    try { console.log('[chase:page]', msg.type(), msg.text()); } catch {}
  });
  page.on('pageerror', err => {
    try { console.error('[chase:pageerror]', err?.message || String(err)); } catch {}
  });
  page.on('requestfailed', req => {
    try { console.warn('[chase:reqfail]', req.url(), req.failure()?.errorText); } catch {}
  });

  try {
    await page.setRequestInterception(true);
    const blockRe = /(?:doubleclick|googlesyndication|google-analytics|optimizely|appdynamics|newrelic|segment|mpulse|linkedin\.com\/collect|facebook\.com\/tr|hotjar|bat\.bing|adsystem)/i;
    const allowRe = /(?:chase\.com|chasecdn\.com|corelogic\.com|googleapis\.com\/maps|gstatic\.com\/maps)/i;
    page.on('request', req => {
      try {
        const url = req.url();
        const resourceType = req.resourceType();
        // Always allow the CoreLogic valuemap resources through the proxy
        if (/valuemap\.corelogic\.com/i.test(url)) return req.continue();
        // Always allow main/doc/script/style/xhr on core domains
        if (allowRe.test(url)) return req.continue();
        // Drop obvious ad/beacon/image/gif trackers to reduce proxy noise/407s
        if (blockRe.test(url) || resourceType === 'media') return req.abort();
        // Drop 1x1 gifs/pixels
        if (/\.(?:gif|png|jpg|jpeg)$/i.test(url) && /(?:pixel|beacon|collect|measure|analytics)/i.test(url)) {
          return req.abort();
        }
        return req.continue();
      } catch {
        return req.continue();
      }
    });
  } catch {}

  // keep language stable for bank flows (optional but helps with parsing)
  try {
    await page.setExtraHTTPHeaders({
      'Accept-Language': process.env.PPTR_LANG || 'en-US,en;q=0.9',
      // Light UA Client Hints (these commonly appear on real Chrome requests)
      'sec-ch-ua': '"Chromium";v="129", "Not?A_Brand";v="24", "Google Chrome";v="129"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Linux"'
    });
  } catch {}

  // Lightweight stealth: neutralize obvious bot signals early (before any scripts run)
  try {
    await page.evaluateOnNewDocument(() => {
      // 1) webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      // 2) plugins
      Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
      // 3) languages
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US','en'] });
      // 4) chrome object
      window.chrome = window.chrome || { runtime: {} };
      // 5) permissions (avoid notifications permission mismatch)
      const originalQuery = window.navigator.permissions?.query;
      if (originalQuery) {
        window.navigator.permissions.query = (parameters) => (
          parameters && parameters.name === 'notifications'
            ? Promise.resolve({ state: Notification.permission })
            : originalQuery(parameters)
        );
      }
      // 6) WebGL vendor/renderer
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Intel Inc.';            // UNMASKED_VENDOR_WEBGL
        if (param === 37446) return 'Intel(R) UHD Graphics'; // UNMASKED_RENDERER_WEBGL
        return getParameter.apply(this, [param]);
      };
      // 7) outer/inner sizes to align with window size flags
      try {
        const { width, height } = screen || {};
        if (width && height) {
          Object.defineProperty(window, 'outerWidth', { get: () => width });
          Object.defineProperty(window, 'outerHeight', { get: () => height });
        }
      } catch {}
    });
  } catch {}

  // If proxy has credentials, authenticate BEFORE first navigation
  if (proxyAuth) {
    try {
      await page.authenticate(proxyAuth);
      console.log('[chase] Applied proxy auth for', (proxyFlag || '').split('=')[1] || 'proxy');
    } catch (e) {
      console.warn('[chase] Proxy auth failed:', e?.message || e);
    }
  }

  // Smoke-check: try hitting the entry once with a tight timeout to surface proxy/captcha/network issues early
  try {
    await page.goto(CHASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('[chase] Entry reachable:', CHASE_URL);
  } catch (e) {
    console.warn('[chase] Entry reachability failed (will continue address-by-address):', e?.message || e);
  }

  try {
    for await (const doc of cursor) {
      processed += 1;
      if (processed % 10 === 1) {
        console.log(`[chase] progress heartbeat: processed=${processed}, solved=${solved}, notFound=${notFound}, captchas=${captchas}, failures=${failures}`);
      }

      // hard safety: skip obviously bad addresses
      const addr = String(doc.fullAddress || '').trim();
      if (!addr || addr.length < 5) {
        failures += 1;
        await markNote(doc, 'CHASE_SKIP:bad_address');
        continue;
      }

      let attempt = 0, success = false;
      while (attempt < RUN_LIMIT.maxAttemptsPerAddress && !success) {
        attempt += 1;
        try {
          console.log('[chase] fetching estimate for:', addr);
          try {
            const el = await ensureOnEstimator(page);
            if (el) console.log('[chase] estimator ready (address input present)');
          } catch (e) {
            // Take a quick snapshot and retry once by reloading
            await snap(page, `ensure_failed_${safeName(addr)}`);
            await page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{});
            await wait(800);
            await ensureOnEstimator(page); // propagate if still failing
          }
          const { estimate, estimateText, url } = await getChaseEstimate(page, addr);

          // write back to Mongo
          const set = {
            chase_value: estimate,
            chasePrice: estimate,
            amv: computeAMV({ doc, chase: estimate }),
            updatedAt: new Date(),
          };
          await Property.updateOne({ _id: doc._id }, { $set: set, $push: { notes: `CHASE_OK:${estimateText}` } });

          solved += 1;
          success = true;
        } catch (err) {
          if (err instanceof ChaseSearchError) {
            await snap(page, `err_${err.message}_${safeName(addr)}`);
            if (err.message === 'CaptchaDetected') {
              captchas += 1;
              await markNote(doc, 'CHASE_CAPTCHA');
              // rotate page (fresh context) to cool off
              try { await page.close(); } catch {}
              page = await browser.newPage();
              try { await page.bringToFront(); } catch {}
              // Reapply defaults, headers, and proxy auth on the fresh tab
              try {
                await page.setExtraHTTPHeaders({
                  'Accept-Language': process.env.PPTR_LANG || 'en-US,en;q=0.9',
                  'sec-ch-ua': '"Chromium";v="129", "Not?A_Brand";v="24", "Google Chrome";v="129"',
                  'sec-ch-ua-mobile': '?0',
                  'sec-ch-ua-platform': '"Linux"'
                });
                await page.evaluateOnNewDocument(() => {
                  Object.defineProperty(navigator, 'webdriver', { get: () => false });
                });
                if (proxyAuth) {
                  await page.authenticate(proxyAuth);
                }
              } catch {}
              try {
                await page.setRequestInterception(true);
                const blockRe = /(?:doubleclick|googlesyndication|google-analytics|optimizely|appdynamics|newrelic|segment|mpulse|linkedin\.com\/collect|facebook\.com\/tr|hotjar|bat\.bing|adsystem)/i;
                const allowRe = /(?:chase\.com|chasecdn\.com|corelogic\.com|googleapis\.com\/maps|gstatic\.com\/maps)/i;
                page.on('request', req => {
                  try {
                    const url = req.url();
                    const resourceType = req.resourceType();
                    if (allowRe.test(url)) return req.continue();
                    if (blockRe.test(url) || resourceType === 'media') return req.abort();
                    if (/\.(?:gif|png|jpg|jpeg)$/i.test(url) && /(?:pixel|beacon|collect|measure|analytics)/i.test(url)) {
                      return req.abort();
                    }
                    return req.continue();
                  } catch {
                    return req.continue();
                  }
                });
              } catch {}
              try { await ensureOnEstimator(page); } catch {}
              break; // stop retrying this address for now
            }
            if (err.message === 'AddressNotFound') {
              notFound += 1;
              await Property.updateOne({ _id: doc._id }, { $push: { notes: 'CHASE_NOT_FOUND' } });
              break;
            }
            // EstimateMissing or others → retry once
            if (attempt >= RUN_LIMIT.maxAttemptsPerAddress) {
              failures += 1;
              await markNote(doc, `CHASE_FAIL:${err.message}`);
              break;
            }
            await wait(1200);
          } else {
            await snap(page, `unhandled_${safeName(addr)}`);
            failures += 1;
            await markNote(doc, `CHASE_ERR:${err?.message || String(err)}`);
            break;
          }
        }
      }
    }
  } finally {
    try { await page.close(); } catch {}
    try { await browser.close(); } catch {}
    await mongoose.connection.close().catch(() => {});
  }

  console.log(JSON.stringify({
    processed, solved, notFound, captchas, failures,
    proxyUrl: (rawProxy || null),
    headless: wantHeadless,
    display: process.env.DISPLAY || null,
    entry: CHASE_URL
  }, null, 2));
}

function computeAMV({ doc, chase }) {
  const vals = [doc.bofa_value, doc.redfinPrice, doc.chase_value, doc.chasePrice]
    .concat(chase != null ? [chase] : [])
    .filter(v => typeof v === 'number' && !isNaN(v));
  if (vals.length === 0) return doc.amv ?? null;
  const avg = Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
  return avg;
}

async function markNote(doc, note) {
  await Property.updateOne({ _id: doc._id }, { $push: { notes: note } });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

// --- Debug artifacts (screenshots / HTML) ---
const CHASE_DEBUG_DIR = process.env.CHASE_DEBUG_DIR || '/tmp/chase_debug';
function ensureDebugDir() {
  try { fs.mkdirSync(CHASE_DEBUG_DIR, { recursive: true }); } catch {}
}
function safeName(s) {
  return String(s).replace(/[^a-z0-9\-_.]/gi, '_').slice(0, 120);
}
async function snap(page, base) {
  try {
    ensureDebugDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(CHASE_DEBUG_DIR, `${base}-${ts}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('[chase:debug] saved', file);
  } catch (e) {
    console.warn('[chase:debug] snapshot failed:', e?.message || e);
  }
}

// --- Helpers for robust text clicks (no Playwright selectors) and iframe handling ---
async function clickFirstByText(pageOrFrame, texts, { timeout = 4000 } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // run in the browsing context
    const clicked = await pageOrFrame.evaluate((candidates) => {
      function visible(el) {
        const s = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return s && s.visibility !== 'hidden' && s.display !== 'none' && rect.width > 0 && rect.height > 0;
      }
      const hay = Array.from(document.querySelectorAll('a,button,input[type="button"],input[type="submit"]'));
      for (const want of candidates) {
        const wantLower = String(want).toLowerCase();
        for (const el of hay) {
          const txt = (el.innerText || el.value || '').trim().toLowerCase();
          if (txt && (txt === wantLower || txt.includes(wantLower)) && visible(el)) {
            el.click();
            return true;
          }
        }
      }
      return false;
    }, list).catch(() => false);
    if (clicked) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function getEstimatorFrame(page) {
  // Prefer by URL hints; fall back to any iframe containing "valuemap"/"corelogic"
  const frames = page.frames();
  let f = frames.find(fr => /valuemap|corelogic/i.test(fr.url()));
  if (f) return f;
  // Try the most recently attached frame
  return frames[frames.length - 1];
}

async function findAddressInputIn(pageOrFrame, selectors, { timeout = 8000 } = {}) {
  const sels = Array.isArray(selectors) ? selectors : [selectors];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of sels) {
      try {
        const h = await pageOrFrame.$(sel);
        if (h) {
          const visible = await pageOrFrame.evaluate(el => {
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s && s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
          }, h).catch(() => true);
          if (visible) return h;
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

// --- Page priming: make sure we're on the estimator and the address box is ready ---
const ESTIMATOR_SELECTORS = [
  'input[id*="address" i]',
  'input[name*="address" i]',
  'input[placeholder*="address" i]',
  '#address',
  '#homeValueAddress',
];

async function ensureOnEstimator(page) {
  const target = CHASE_URL;
  try {
    // If we're already on the page and an address box exists, we're good.
    const url = page.url() || '';
    if (url.startsWith(target)) {
      const el = await findAddressInputIn(page, ESTIMATOR_SELECTORS, { timeout: 1000 });
      if (el) return el;
    }

    // Otherwise, go (back) to the entry page
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Handle potential cookie/consent banners
    const dismissers = [
      'button[aria-label="Close"]',
      'button[aria-label="Dismiss"]',
      'button[aria-label*="accept" i]',
      'button:has-text("Accept")',
      '#onetrust-accept-btn-handler',
      'button[aria-label*="got it" i]'
    ];
    try {
      await page.waitForTimeout(800);
      for (const d of dismissers) {
        const b = await page.$(d);
        if (b) { await b.click().catch(()=>{}); await page.waitForTimeout(200); }
      }
    } catch {}

    // Some variants require clicking a CTA to reveal the embedded estimator
    try {
      await clickFirstByText(page, ['Get started', 'Start online', 'Start now', 'Estimate', 'Check now'], { timeout: 3000 });
      await page.waitForTimeout(700);
    } catch {}

    // After CTA, try again for visible address input in the main document
    {
      const el = await findAddressInputIn(page, ESTIMATOR_SELECTORS, { timeout: 4000 });
      if (el) return el;
    }

    // First try: direct input in the main document (fallback, extended timeout)
    {
      const el = await findAddressInputIn(page, ESTIMATOR_SELECTORS, { timeout: 10000 });
      if (el) return el;
    }

    // Second try: estimator inside an iframe (CoreLogic / ValueMap)
    try {
      await page.waitForTimeout(500);
      const frame = getEstimatorFrame(page);
      if (frame) {
        // Some variants show a splash/CTA inside the frame
        try {
          await clickFirstByText(frame, ['Get started', 'Start online', 'Start now'], { timeout: 2000 });
          await page.waitForTimeout(500);
        } catch {}
        const inner = await findAddressInputIn(frame, ESTIMATOR_SELECTORS, { timeout: 7000 });
        if (inner) return inner;
      }
    } catch {}

    // If we get here, the estimator didn’t render its input box
    await snap(page, 'no_address_box');
    throw new Error('Estimator input not found');
  } catch (e) {
    console.warn('[chase] ensureOnEstimator failed:', e?.message || e);
    throw e;
  }
}