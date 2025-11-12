import { 
  propertyCountSelector, 
  mapNavSelector,
  propertyListContainerSelector,
  propertyContentSelector,
  addressLine1Selector,
  addressLine2Selector,
  priceSelector,
  propertyStatsSelector,
  agentNameSelector,
  agentEmailSelector,
  agentPhoneSelector,
  openDetailSelector
} from '../config/selection.js';
import { upsertRawProperty } from '../../../controllers/rawPropertyController.js';
import { upsertPropertyDetailsFromRaw } from '../../../controllers/propertyController.js';
import { randomMouseMovements, randomWait, parseAddresses } from '../../../helpers.js';
import { logPrivy } from '../../../utils/logger.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { loginToPrivy, enableRequestBlocking } from '../auth/loginService.js';
import { clickClustersRecursively } from '../clusterCrawlerGoogleMaps.js';
import { toNumber } from '../../../utils/normalize.js';

import { applyFilters } from '../filters/filterService.js';

// --- Quick Filters / Tags support (URL mode) ---
// human label -> URL param key as used by Privy
const DEFAULT_TAGS = [
  ['Absentee Owner','absentee_owner'],
  ['Bank Owned/REO','bank_owned'],
  ['Cash Buyer','cash_buyer'],
  ['Auction','auction'],
  ['Corporate Owned','corporate_owned'],
  ['Inter-Family Transfer','inter_family_transfer'],
  ['Pre-Foreclosures','pre_foreclosures'],
  ['Foreclosures','foreclosures'],
  ['Owned 20+ Years','owned_20_plus_years'],
  ['Tired Landlord','tired_landlord'],
  ['Vacant','vacant'],
  ['Zombie Properties','zombie_properties'],
];

// Allow override: PRIVY_TAGS="tired_landlord,foreclosures"
const QUICK_TAGS = (process.env.PRIVY_TAGS || '')
  .split(',')
  .map(s => s.trim()).filter(Boolean)
  .map(k => [k, k])
  .concat(process.env.PRIVY_TAGS ? [] : DEFAULT_TAGS);

function withQuickTag(url, paramKey) {
  const u = new URL(url);
  const key = `tags[${paramKey}]`; // Privy treats empty value as boolean
  if (!u.searchParams.has(key)) u.searchParams.append(key, '');
  return u.toString();
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// extract first number (incl. decimals) from strings like "5 Beds", "2.5 Baths", "1,456 Sq Ft"
const numFromText = (s) => {
  if (!s) return null;
  const m = String(s).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
};

// quickStats array -> normalized details
function parseQuickStatsToDetails(quickStats = []) {
  const raw = { bedsText: null, bathsText: null, sqftText: null };

  for (const t of quickStats.map(x => String(x).toLowerCase())) {
    if (t.includes('bed'))  raw.bedsText  = raw.bedsText  ?? t;
    if (t.includes('bath')) raw.bathsText = raw.bathsText ?? t;
    if ((t.includes('sq') && t.includes('ft')) || t.includes('sqft')) {
      raw.sqftText = raw.sqftText ?? t;
    }
  }

  return {
    beds:  numFromText(raw.bedsText),
    baths: numFromText(raw.bathsText),
    sqft:  numFromText(raw.sqftText),
    _raw:  raw,
  };
}

// --- Agent extraction helpers ---
async function extractAgentFromContext(ctx) {
  const text = async (sel) => {
    try { return await ctx.$eval(sel, el => (el.textContent || '').trim()); } catch { return null; }
  };
  const href = async (sel, starts) => {
    try {
      const v = await ctx.$eval(sel, el => (el.getAttribute('href') || '').trim());
      return v && v.startsWith(starts) ? v.slice(starts.length) : null;
    } catch { return null; }
  };
  let name = await text(agentNameSelector);
  let email = await href(agentEmailSelector, 'mailto:');
  let phone = await href(agentPhoneSelector, 'tel:');
  return { name, email, phone };
}

async function extractAgentWithFallback(page, cardHandle) {
  // Try on-card first
  const onCard = await extractAgentFromContext(cardHandle);
  if (onCard.name || onCard.email || onCard.phone) return onCard;
  // Open details (new panel or page)
  try { await cardHandle.click({ delay: 20 }); } catch {}
  await sleep(600);
  // Try common detail roots
  const roots = [page, ...page.frames()];
  for (const r of roots) {
    const got = await extractAgentFromContext(r);
    if (got.name || got.email || got.phone) return got;
  }
  // Last resort: scan mailto/tel anywhere on page
  try {
    const { email, phone } = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href^="mailto:"],a[href^="tel:"]'));
      const res = { email: null, phone: null };
      for (const el of a) {
        const h = (el.getAttribute('href') || '').trim();
        if (h.startsWith('mailto:') && !res.email) res.email = h.slice(7);
        if (h.startsWith('tel:') && !res.phone) res.phone = h.slice(4);
      }
      return res;
    });
    return { name: null, email, phone };
  } catch {}
  return { name: null, email: null, phone: null };
}

// Try to find the card DOM handle that matches a given full address
async function findCardHandleByAddress(page, {
  listContainerSelector,
  itemSelector,
  line1Selector,
  line2Selector
}, fullAddress) {
  const els = await page.$$(itemSelector);
  const needle = String(fullAddress || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const el of els) {
    try {
      const [l1, l2] = await Promise.all([
        el.$eval(line1Selector, n => (n.textContent || '').trim()).catch(() => ''),
        el.$eval(line2Selector, n => (n.textContent || '').trim()).catch(() => '')
      ]);
      const addr = [l1, l2].filter(Boolean).join(', ').toLowerCase().replace(/\s+/g, ' ').trim();
      if (addr && (addr === needle || needle.includes(addr) || addr.includes(needle))) {
        return el;
      }
    } catch {}
  }
  return null;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const NAV_TIMEOUT = Number(process.env.PRIVY_NAV_TIMEOUT_MS || 120000);
const SELECTOR_TIMEOUT = Number(process.env.PRIVY_LIST_SELECTOR_TIMEOUT_MS || 60000);
const LOGIN_PATH_CUES = ['sign_in', 'two_factor', 'otp', 'verify', 'code'];

const READY_SELECTOR = (process.env.PRIVY_READY_SELECTOR || '').trim();
const HYDRATE_MAX_RELOADS = Number(process.env.PRIVY_HYDRATE_MAX_RELOADS || 1);

// Wait until any one of the provided selectors appears; returns the selector that won.
async function waitForAnySelector(page, selectors, { timeout = SELECTOR_TIMEOUT } = {}) {
  const trimmed = (selectors || []).map(s => s && String(s).trim()).filter(Boolean);
  if (!trimmed.length) throw new Error('waitForAnySelector: no selectors provided');
  const wrapped = trimmed.map(sel =>
    page.waitForSelector(sel, { timeout }).then(() => sel).catch(() => null)
  );
  const winner = await Promise.race(wrapped);
  if (!winner) throw new Error(`waitForAnySelector: none matched within ${timeout}ms`);
  return winner;
}

// Ensure we are on a loaded Privy dashboard view (SPA hydration finished enough to read).
async function ensureDashboardReady(page, { timeout = 60000 } = {}) {
  // 1) Confirm we actually landed on dashboard
  await page.waitForFunction(() => /\/dashboard/.test(location.pathname), { timeout });

  // 2) Multi-signal readiness (any one is OK). This avoids brittle single selectors.
  const countSels = (READY_SELECTOR
    ? [READY_SELECTOR]
    : []
  ).concat(
    propertyCountSelector.split(',').map(s => s.trim()),
    [
      '[data-testid="properties-found"]',
      '.properties-found',
      '[data-test="properties-found"]',
      '[data-testid*="count"]',
    ]
  );

  const listSels = [
    propertyListContainerSelector,
    '[data-testid="property-list"]',
    '.properties-list',
    '.property-list',
    '.grid-view-container',
    '.view-container',
  ].filter(Boolean);

  const cardSels = [
    propertyContentSelector,
    '[data-testid="property-card"]',
    '.property-card',
    '.result-card',
  ].filter(Boolean);

  // First try: any of our known anchors
  try {
    await waitForAnySelector(page, [...countSels, ...listSels, '#react-app', '#ldp-page-app', '.map-view-container'], { timeout });
    return;
  } catch {}

  // Second try: SPA hydrated if skeletons are gone AND either list container or at least one card exists
  try {
    await page.waitForFunction(() => {
      const noSkeleton = !document.querySelector('.skeleton, .loading, [aria-busy="true"]');
      const list =
        document.querySelector('[data-testid="property-list"], .properties-list, .property-list, .grid-view-container, .view-container');
      const hasCard =
        document.querySelector('[data-testid="property-card"], .property-card, .result-card');
      return noSkeleton && (list || hasCard);
    }, { timeout });
    return;
  } catch (e) {
    // Last resort: dump a tiny HTML snapshot to debug selector drift, then rethrow
    try {
      if (String(process.env.PRIVY_DEBUG_HTML || '1') !== '0') {
        const html = await page.content();
        const ts = new Date().toISOString().replace(/[:.]/g,'-');
        const p = `/tmp/privy_debug_dashboard_${ts}.html`;
        fs.writeFileSync(p, html.slice(0, 500000)); // cap to 500KB
        logPrivy.warn('Dashboard readiness failed — saved HTML snapshot', { path: p });
      }
    } catch {}
    throw new Error('PRIVY_DASHBOARD_NOT_READY');
  }
}

async function navigateWithSession(page, url, { retries = 1 } = {}) {
  const L = logPrivy.with({ url });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    const currentUrl = page.url();

    // If we hit any login/2FA route, reauthenticate and retry
    if (LOGIN_PATH_CUES.some((cue) => currentUrl.includes(cue))) {
      if (attempt >= retries) {
        throw new Error('PRIVY_SESSION_EXPIRED');
      }
      L.warn('Detected Privy login screen mid-scrape — re-authenticating');
      await loginToPrivy(page);
      await randomWait(800, 1600);
      continue;
    }

     // Ensure dashboard is hydrated; allow multiple reloads if needed
    let ok = false;
    for (let r = 0; r <= HYDRATE_MAX_RELOADS; r += 1) {
      try {
        await ensureDashboardReady(page, { timeout: 30000 });
        ok = true; break;
      } catch (e) {
        if (r < HYDRATE_MAX_RELOADS) {
          L.info('Dashboard not ready; reloading to complete hydration', { reload: r + 1 });
          await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        }
      }
    }
    if (!ok) throw new Error('PRIVY_DASHBOARD_NOT_READY');
     return page.url();
  }
  throw new Error('PRIVY_SESSION_UNRECOVERABLE');
}

// --- UI settle + results helpers ---

async function waitForNetworkQuiet(page, { idleTime = 1000, timeout = 15000 } = {}) {
  try { await page.waitForNetworkIdle({ idleTime, timeout }); } catch {}
}

// Waits for the number of children in a list container to grow, or reach min.
async function waitForListGrowth(page, { containerSelector, min = 1, timeout = 20000 } = {}) {
  const sel = containerSelector || '[data-testid="property-list"], .property-list, .properties-list';
  return page.waitForFunction((s, min) => {
    const list = document.querySelector(s);
    const n = list && list.children ? list.children.length : 0;
    if (!window.__df_listCount) window.__df_listCount = n;
    const grew = n > window.__df_listCount;
    window.__df_listCount = n;
    return grew || n >= min;
  }, { timeout }, sel, min).catch(() => false);
}

// Utility to read the current child count of a list container
async function getListChildCount(page, containerSelector) {
  const sel = containerSelector || '[data-testid="property-list"], .property-list, .properties-list';
  try {
    return await page.$eval(sel, el => (el && el.children ? el.children.length : 0));
  } catch {
    return 0;
  }
}

async function readResultCount(page, countSelector) {
  try {
    const count = await page.$eval(
      countSelector,
      el => parseInt((el.textContent || '').trim().replace(/[^0-9]/g, ''), 10)
    );
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * Scroll the main page to trigger lazy loading.
 */
async function autoScrollPage(page, { step = 900, pause = 200, max = 160 } = {}) {
  let last = await page.evaluate('document.body.scrollHeight');
  for (let i = 0; i < max; i++) {
    await page.evaluate(y => window.scrollBy(0, y), step);
    await sleep(pause);
    const now = await page.evaluate('document.body.scrollHeight');
    if (now === last) break;
    last = now;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

/**
 * Scroll an inner list container (if Privy renders results inside a scroller).
 */
async function autoScrollListContainer(page, containerSelector, { pause = 180, max = 240 } = {}) {
  const ok = await page.$(containerSelector);
  if (!ok) return false;

  await page.evaluate(async (sel, max, pause) => {
    const el = document.querySelector(sel);
    if (!el) return;
    let i = 0;
    let last = el.scrollHeight;
    while (i < max) {
      el.scrollTop = el.scrollHeight;
      await new Promise(r => setTimeout(r, pause));
      const now = el.scrollHeight;
      if (now === last) break;
      last = now;
      i++;
    }
  }, containerSelector, max, pause);

  return true;
}

/**
 * After navigation or filters apply, ensure the grid has fully loaded:
 * - wait for network quiet
 * - try to read count
 * - perform auto scroll (container or page)
 * - re-read count to capture fully loaded set
 */
async function hydrateAndLoadAll(page, {
  countSelector,
  listContainerSelector,
  expectSome = true
} = {}) {
  await waitForNetworkQuiet(page, { idleTime: 800, timeout: 15000 });

  // Stage 1: nudge initial growth quickly
  await waitForListGrowth(page, { containerSelector: listContainerSelector, min: 60, timeout: 25000 });
  // initial count (may be partial)
  let before = await readResultCount(page, countSelector);
  // Stage 2: if a target count is visible, aim proportionally so we don't over-wait
  if (Number.isFinite(before) && before > 0) {
    const proportional = Math.min(Math.max(20, Math.ceil(before * 0.4)), 120); // 40% of reported, capped
    await waitForListGrowth(page, { containerSelector: listContainerSelector, min: proportional, timeout: 20000 });
  }

  // try container scroll first (faster), fall back to page scroll
  const didContainer = await autoScrollListContainer(page, listContainerSelector);
  if (!didContainer) {
    await autoScrollPage(page);
  }

  await waitForNetworkQuiet(page, { idleTime: 800, timeout: 15000 });

  // read again after we forced lazy load
  let after = await readResultCount(page, countSelector);

  // sometimes Privy increments in chunks; do one more short scroll if numbers look odd
  if (after !== null && before !== null && after === before) {
    // short “nudge” scroll
    await autoScrollListContainer(page, listContainerSelector, { pause: 150, max: 20 });
    await waitForNetworkQuiet(page, { idleTime: 500, timeout: 8000 });
    after = await readResultCount(page, countSelector);
  }

  // If nothing is readable but we expect results, don’t fail—just proceed.
  if (expectSome && (after === null || Number.isNaN(after))) {
    // No strong count read—ok, we’ll scrape what we see.
    return null;
  }
  return after ?? before ?? null;
}

/**
 * Iteratively scrolls the list and collects cards until we reach the target count
 * or no new cards appear. Works with virtualized lists.
 */
async function collectAllCardsWithScrolling(page, {
  listContainerSelector,
  itemSelector,
  line1Selector,
  line2Selector,
  priceSelector,
  statSelector,
  targetCount = null,
  maxLoops = 500,      // was 160 — give virtualization more room
  pause = 220,         // slightly longer for network / hydration
  pageNudges = 6,      // a few more nudges to trip observers
} = {}) {
  const byKey = new Map();

  // Merge new property batches into dst uniquely by address (case-insensitive)
  const mergeUnique = (dst, src) => {
    const seen = new Set(dst.map(p => p.fullAddress.toLowerCase()));
    for (const p of src) {
      const k = p.fullAddress.toLowerCase();
      if (!seen.has(k)) {
        dst.push(p);
        seen.add(k);
      }
    }
    return dst;
  };

  async function readBatch() {
    const batch = await page.$$eval(
      itemSelector,
      (items, s1, s2, sp, statSel) => {
        const bySelText = (root, sel) => root.querySelector(sel)?.textContent?.trim() || '';
        const isVisible = (el) => !!(el && (el.offsetParent !== null || getComputedStyle(el).display !== 'none'));
        return items
          .filter(isVisible)
          .map((el) => {
            const line1 = bySelText(el, s1);
            const line2 = bySelText(el, s2);
            const address = line1 && line2 ? `${line1}, ${line2}` : (line1 || line2 || '');
            const price = bySelText(el, sp);
            const quickStats = Array.from(el.querySelectorAll(statSel)).map(li => li.textContent.trim());
            return { fullAddress: address, address, price, quickStats };
          })
          .filter(x => x.fullAddress && typeof x.fullAddress === 'string');
      },
      line1Selector, line2Selector, priceSelector, statSelector
    );
    return batch;
  }

  const hasContainer = !!(await page.$(listContainerSelector));
  let stagnationLoops = 0;
  let lastSize = 0;
  let lastHeight = 0;

  for (let loop = 0; loop < maxLoops; loop++) {
    // Read currently mounted cards
    const batch = await readBatch();
    for (const card of batch) {
      const key = card.fullAddress.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, card);
    }

    if (targetCount && byKey.size >= targetCount) break;

    const sizeUnchanged = byKey.size === lastSize;
    lastSize = byKey.size;

    // Track container height to detect virtualization progress
    let heightNow = 0;
    if (hasContainer) {
      heightNow = await page.$eval(listContainerSelector, el => el.scrollHeight || 0).catch(() => 0);
    }
    const heightUnchanged = heightNow === lastHeight;
    lastHeight = heightNow;

    if (sizeUnchanged && heightUnchanged) {
      stagnationLoops++;
    } else {
      stagnationLoops = 0;
    }
    if (stagnationLoops > 6) break; // several no-progress cycles → done

    // Scroll inner container first
    if (hasContainer) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        el.dispatchEvent(new Event('scroll', { bubbles: true })); // poke observers
      }, listContainerSelector).catch(() => {});
    }

    // Nudge page scroll a few times to tick any outer observers
    for (let i = 0; i < pageNudges; i++) {
      await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      await sleep(55);
    }

    // Occasionally bounce back up to encourage re-mounting
    if (loop % 10 === 0) {
      await page.evaluate(() => window.scrollBy(0, -1200)).catch(() => {});
      await sleep(80);
    }

    // Dynamic min: chase targetCount when known, otherwise grow in small steps
    const currentChildCount = await getListChildCount(page, listContainerSelector);
    const desired = targetCount
      ? Math.min(targetCount, Math.max(currentChildCount + 8, Math.ceil(targetCount * 0.8)))
      : Math.min((byKey.size || 0) + 10, 80);
    await waitForListGrowth(page, {
      containerSelector: listContainerSelector,
      min: desired,
      timeout: Math.max(2000, Math.min(10000, pause * 6))
    });
    await sleep(Math.max(60, Math.min(400, pause)));
  }

  // Return to top so any follow-up actions aren’t off-screen
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  return Array.from(byKey.values());
}

const scrapePropertiesV1 = async (page) => {
  // Allow slower Privy responses without tripping the default 30s limit.
  try {
    page.setDefaultNavigationTimeout?.(NAV_TIMEOUT);
    page.setDefaultTimeout?.(SELECTOR_TIMEOUT);
  } catch {}

  const urlsFilePath = path.resolve(__dirname, '../../../urls.json');
  if (!fs.existsSync(urlsFilePath)) {
    throw new Error(`❌ URLs file not found at ${urlsFilePath}`);
  }
  const urls = JSON.parse(fs.readFileSync(urlsFilePath, 'utf-8'));
  // Match the size params used in your Privy URLs so virtualization behaves consistently
try {
  await page.setViewport({ width: 1947, height: 1029, deviceScaleFactor: 1 });
} catch {}
try {
  await enableRequestBlocking(page);
} catch {}
  const allProperties = [];

  const randomizedStates = shuffle(Object.keys(urls));

  for (const state of randomizedStates) {
    const LState = logPrivy.with({ state });
    LState.start('Processing state');

    const stateUrls = shuffle(urls[state] || []);
    let stateSaved = 0;

    for (const url of stateUrls) {
      if (!url) continue;

      // Build {base + each tag} variants for this state URL
      const includeBase = String(process.env.PRIVY_INCLUDE_BASE || 'false').toLowerCase() === 'true';
      const urlVariants = [];
      if (includeBase) urlVariants.push({ url, tag: null });
      for (const [label, param] of QUICK_TAGS) {
        urlVariants.push({ url: withQuickTag(url, param), tag: label });
      }

      for (const { url: targetUrl, tag } of urlVariants) {
        // keep the SPA/session warm between navigations
        await page.evaluate(() => {
          try { localStorage.setItem('keepalive', String(Date.now())); } catch (e) {}
        }).catch(() => {});

        // Scoped logger auto-includes state + url on every line
        const L = LState.with({ url: targetUrl, quickTag: tag || 'none' });
        try {
          L.http('Navigating');
          await navigateWithSession(page, targetUrl, { retries: 2 });
          await randomWait(1000, 5000);

          // kill overlays before waiting on selectors
await page.evaluate(() => {
  const killers = [
    'button#hs-eu-confirmation-button',
    'button[id*="cookie" i]',
    'button[aria-label*="accept" i]',
    'button[aria-label*="close" i]',
    '.hs-cookie-notification button',
    '.intercom-close-button',
    'button[aria-label*="dismiss" i]'
  ];
  killers.forEach(sel => {
    try { document.querySelector(sel)?.click(); } catch {}
  });
});

          // Ensure nav UI elements exist
          // Make these tolerant too: accept either map/nav OR a hydrated list as equivalent "ready"
          try {
            await waitForAnySelector(page, mapNavSelector.split(',').map(s => s.trim()), { timeout: SELECTOR_TIMEOUT });
          } catch {
            await waitForAnySelector(page, [
              ...propertyCountSelector.split(',').map(s => s.trim()),
              '[data-testid="property-list"]',
              '.properties-list', '.property-list', '.grid-view-container'
            ], { timeout: SELECTOR_TIMEOUT });
          }
          // Apply filters (best effort) before collecting cards
          try {
            await applyFilters(page);
          } catch (e) {
            L.warn('Filter application failed (continuing)', { error: e?.message || String(e) });
          }
          // Use cluster walker to explode big map regions into bite-size lists,
          // then run the exact same per-view routine inside the callback.
          await clickClustersRecursively(page, page.browser(), async () => {
            // 1) Hydrate + lazy-load the current view
            const loadedCount = await hydrateAndLoadAll(page, {
              countSelector: propertyCountSelector,
              listContainerSelector: propertyListContainerSelector,
              expectSome: true
            });

            const LC = L.with({ count: loadedCount ?? 'unknown' });
            LC.info('Scraping properties from URL', { quickTag: tag || 'none' });

            // 2) Collect cards currently mounted
            await page.waitForSelector(propertyListContainerSelector);
            let properties = await collectAllCardsWithScrolling(page, {
              listContainerSelector: propertyListContainerSelector,
              itemSelector: propertyContentSelector,
              line1Selector: addressLine1Selector,
              line2Selector: addressLine2Selector,
              priceSelector: priceSelector,
              statSelector: propertyStatsSelector,
              targetCount: loadedCount || null,
              maxLoops: 200,
              pause: 180,
              pageNudges: 4,
            });

            // Optional second pass if we're significantly under the loadedCount
            if (loadedCount !== null && properties.length + 10 < loadedCount) {
              const secondPass = await collectAllCardsWithScrolling(page, {
                listContainerSelector: propertyListContainerSelector,
                itemSelector: propertyContentSelector,
                line1Selector: addressLine1Selector,
                line2Selector: addressLine2Selector,
                priceSelector: priceSelector,
                statSelector: propertyStatsSelector,
                targetCount: loadedCount,
                maxLoops: 200,
                pause: 300,
                pageNudges: 8,
              });
              // Merge unique without dups by address
              const seen = new Set(properties.map(p => p.fullAddress.toLowerCase()));
              for (const p of secondPass) {
                const k = p.fullAddress.toLowerCase();
                if (!seen.has(k)) { properties.push(p); seen.add(k); }
              }
            }

            // Final micro-pass: if we're within 10 of the reported total, try a short top-up
            if (loadedCount !== null) {
              const deficit = loadedCount - properties.length;
              if (deficit > 0 && deficit <= 10) {
                LC.info('Running final micro-pass to close small deficit', { deficit, loadedCount, seen: properties.length });
                for (let j = 0; j < 3; j++) {
                  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
                  const childNow = await getListChildCount(page, propertyListContainerSelector);
                  await waitForListGrowth(page, {
                    containerSelector: propertyListContainerSelector,
                    min: Math.min(loadedCount, Math.max(childNow + 4, loadedCount - 1)),
                    timeout: 4000
                  }).catch(() => {});
                  await randomWait(250, 500);
                }
                const micro = await collectAllCardsWithScrolling(page, {
                  listContainerSelector: propertyListContainerSelector,
                  itemSelector: propertyContentSelector,
                  line1Selector: addressLine1Selector,
                  line2Selector: addressLine2Selector,
                  priceSelector: priceSelector,
                  statSelector: propertyStatsSelector,
                  targetCount: loadedCount,
                  maxLoops: 30,
                  pause: 120,
                  pageNudges: 2,
                });
                const seen2 = new Set(properties.map(p => p.fullAddress.toLowerCase()));
                for (const p of micro) {
                  const k = p.fullAddress.toLowerCase();
                  if (!seen2.has(k)) { properties.push(p); seen2.add(k); }
                }
              }
            }

            // OPTIONAL: sanity check vs reported count
            if (loadedCount !== null && properties.length + 3 < loadedCount) {
              LC.warn('Fewer cards than count suggests (still virtualized or selector drift)', {
                loadedCount, seen: properties.length
              });
            }

            // 3) Normalize & upsert (existing pipeline)
            await randomWait(800, 2000);
            await randomMouseMovements(page);

            const validProperties = properties.filter(prop => prop.fullAddress && typeof prop.fullAddress === 'string');
            const parsed = parseAddresses(validProperties);

            const normalized = [];
            for (const prop of parsed) {
              const priceNum = toNumber(prop.price);
              const details = { ...parseQuickStatsToDetails(prop.quickStats || []) };

              // Augment details with agent contacts (best-effort) — try to find the card DOM node for this address
              try {
                const handle = await findCardHandleByAddress(page, {
                  listContainerSelector: propertyListContainerSelector,
                  itemSelector: propertyContentSelector,
                  line1Selector: addressLine1Selector,
                  line2Selector: addressLine2Selector
                }, prop.fullAddress);

                if (handle) {
                  const agent = await extractAgentWithFallback(page, handle);
                  if (agent?.name || agent?.email || agent?.phone) {
                    details.agent_name  = agent.name  || null;
                    details.agent_email = agent.email || null;
                    details.agent_phone = agent.phone || null;
                  }
                } else {
                  // fallback: scan mailto/tel anywhere on page (view-level)
                  try {
                    const res = await page.evaluate(() => {
                      const out = { email: null, phone: null };
                      const a = Array.from(document.querySelectorAll('a[href^="mailto:"],a[href^="tel:"]'));
                      for (const el of a) {
                        const h = (el.getAttribute('href') || '').trim();
                        if (h.startsWith('mailto:') && !out.email) out.email = h.slice(7);
                        if (h.startsWith('tel:') && !out.phone) out.phone = h.slice(4);
                      }
                      return out;
                    });
                    if (res.email || res.phone) {
                      details.agent_name  = details.agent_name  ?? null;
                      details.agent_email = details.agent_email ?? res.email ?? null;
                      details.agent_phone = details.agent_phone ?? res.phone ?? null;
                    }
                  } catch {}
                }
              } catch (e) {
                logPrivy.warn('Agent extraction failed (non-fatal)', { error: e?.message, fullAddress: prop?.fullAddress || null });
              }

              normalized.push({
                ...prop,
                price_text: prop.price ?? null,
                price: priceNum,
                details
              });
            }

            let urlSaved = 0;
            for (const prop of normalized) {
              try {
                if (!prop || !prop.fullAddress || typeof prop.fullAddress !== 'string') {
                  logPrivy.warn('Skipping invalid property', { fullAddress: prop?.fullAddress || null, state });
                  continue;
                }
                await upsertRawProperty(prop);
                // Mirror numeric & agent details into the main properties collection
                try {
                  await upsertPropertyDetailsFromRaw(prop);
                } catch (e) {
                  logPrivy.warn('Failed to mirror details into properties', { fullAddress: prop?.fullAddress || null, error: e?.message });
                }
                urlSaved += 1;
                stateSaved += 1;
                allProperties.push(prop);
              } catch (error) {
                logPrivy.warn('Failed to upsert property', {
                  fullAddress: prop?.fullAddress || 'Unknown Address',
                  error: error.message,
                  state,
                });
              }
            }

            LC.info('Properties saved for URL', { saved: urlSaved, stateSaved, quickTag: tag || 'none' });
          });
          // (No early return here; continue to next URL variant/state)
        } catch (err) {
          if (err?.message === 'PRIVY_SESSION_EXPIRED' || err?.message === 'PRIVY_SESSION_UNRECOVERABLE') {
            L.error('Privy session expired and could not be recovered — aborting remaining URLs');
            throw err;
          }
          L.warn('Timeout or error on URL — skipping', { error: err.message, quickTag: tag || 'none' });
          continue;
        }
      } // end urlVariants loop
    }
    LState.info('State scrape complete', { stateSaved });
  }

  logPrivy.success('Scrape complete', { total: allProperties.length });
  return allProperties;
};

export default scrapePropertiesV1;