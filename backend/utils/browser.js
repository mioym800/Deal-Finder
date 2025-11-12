// backend/utils/browser.js
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import path from 'node:path';
import os from 'os';
import { makeRequestBlocker, defaultBlockList } from '../utils/requestFilters.js';

// Use a dedicated userDataDir to avoid Chrome "SingletonLock" on default profile
const SHARED_USER_DATA_DIR = process.env.SHARED_CHROME_USER_DATA_DIR || `/tmp/df-shared-${process.pid}`;
const PROTOCOL_TIMEOUT = Number(process.env.PPTR_PROTOCOL_TIMEOUT || 120000); // 120s default
// ---- Shared browser guard (singleton) ----
function isOpen(b) { try { return !!b && b.isConnected(); } catch { return false; } }

export async function getSharedBrowser(launchOpts = {}) {
  if (global.__df_sharedBrowser && isOpen(global.__df_sharedBrowser)) {
    return global.__df_sharedBrowser;
  }
  // Provide sane defaults but allow callers to override
  const defaults = {
    headless: 'shell',
    defaultViewport: null,
    ignoreHTTPSErrors: true,
    userDataDir: SHARED_USER_DATA_DIR,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--window-size=1366,768',
      '--remote-debugging-port=0',
      '--lang=en-US,en;q=0.9',
    ],
  };
const browser = await puppeteer.launch({ protocolTimeout: PROTOCOL_TIMEOUT, ...defaults, ...(launchOpts || {}) });
  global.__df_sharedBrowser = browser;
  browser.on('disconnected', () => { if (global.__df_sharedBrowser === browser) global.__df_sharedBrowser = null; });
  return browser;
}

puppeteer.use(StealthPlugin());

let __sharedBrowser = null;
let __launching = null;          // promise used to coalesce concurrent calls
const RDP_PORT = Number(process.env.SHARED_CHROME_PORT || 9222);
const PROFILE_DIR = process.env.SHARED_CHROME_USER_DATA_DIR
  || path.join(os.homedir(), '.cache', 'deal-finder', 'shared-profile');
const STATE_DIR = process.env.SHARED_CHROME_STATE_DIR
  || path.join(os.tmpdir(), 'deal-finder-shared');
const WS_FILE   = path.join(STATE_DIR, 'chrome.ws.json');
const LOCK_FILE = path.join(STATE_DIR, 'chrome.launch.lock');

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function tryAcquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, 'wx');  // atomic create or throw if exists
    return fd;
  } catch (e) { return null; }
}

function releaseLock(fd) {
  try { fs.closeSync(fd); } catch {}
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

async function connectFromWsFile() {
  try {
    const { wsEndpoint } = JSON.parse(fs.readFileSync(WS_FILE, 'utf8'));
    if (!wsEndpoint) return null;
    const br = await puppeteer.connect({ browserWSEndpoint: wsEndpoint, defaultViewport: null, protocolTimeout: PROTOCOL_TIMEOUT });    __sharedBrowser = br;
    return br;
  } catch { return null; }
}

// --- UA & viewport helpers ---
const UA_POOL = [
  // Recent Chrome on macOS + Windows (non-headless strings)
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function pickUA() {
  // Allow pinning via env if needed
  const pinned = (process.env.SPOOF_UA || '').trim();
  if (pinned) return pinned;
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function randomViewport(base = { width: 1280, height: 900 }) {
  // Subtle jitter to avoid exact fingerprints; keep reasonable for layout
  const dw = Math.floor(Math.random() * 60) - 30;   // ±30px
  const dh = Math.floor(Math.random() * 60) - 30;   // ±30px
  return { width: Math.max(1100, base.width + dw), height: Math.max(800, base.height + dh), deviceScaleFactor: 1 };
}

// --- Shared browser + pages singleton ---
let _sharedBrowser = null;

/**
 * Backward-compatible helper. If BROWSER_URL is set, connect; otherwise launch once.
 */
export async function openBrowser(launchArgs = []) {
  if (global.__df_sharedBrowser && isOpen(global.__df_sharedBrowser)) {
    return global.__df_sharedBrowser;
  }
  const { BROWSER_URL } = process.env;
  if (BROWSER_URL) {
    const br = await puppeteer.connect({ browserURL: BROWSER_URL, defaultViewport: null, protocolTimeout: PROTOCOL_TIMEOUT });    global.__df_sharedBrowser = br;
    br.on('disconnected', () => { if (global.__df_sharedBrowser === br) global.__df_sharedBrowser = null; });
    return br;
  }
  const br = await puppeteer.launch({
    protocolTimeout: PROTOCOL_TIMEOUT,
    headless: 'shell',
    defaultViewport: null,
    ignoreHTTPSErrors: true,
    userDataDir: SHARED_USER_DATA_DIR,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--window-size=1366,768',
      '--remote-debugging-port=0',
      '--lang=en-US,en;q=0.9',
      ...launchArgs,
    ],
  });
  global.__df_sharedBrowser = br;
  br.on('disconnected', () => { if (global.__df_sharedBrowser === br) global.__df_sharedBrowser = null; });
  return br;
}

export async function initSharedBrowser() {
  // If already connected/launched in this process
  if (__sharedBrowser) return __sharedBrowser;
  if (__launching) return (__launching = __launching.catch(() => null)); // return the in-flight promise

  __launching = (async () => {
    // 1) Try to connect to an existing shared Chrome first.
    const fromWs = await connectFromWsFile();
    if (fromWs) return fromWs;

    // 2) Acquire a file lock. If another process is launching, wait and then connect.
    const lockFd = tryAcquireLock(LOCK_FILE);
    if (!lockFd) {
      // Someone else is launching — wait for WS file to appear
      const t0 = Date.now();
      while (Date.now() - t0 < 30000) {  // 30s
        const br = await connectFromWsFile();
        if (br) return br;
        await sleep(300);
      }
      throw new Error('Timeout waiting for shared Chrome to come up');
    }

    // 3) We hold the lock: perform the launch.
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    const headless = String(process.env.PRIVY_HEADLESS || 'true').toLowerCase() !== 'false' ? 'new' : false;
    const browser = await puppeteer.launch({
      protocolTimeout: PROTOCOL_TIMEOUT,
      headless,
      userDataDir: PROFILE_DIR,
      defaultViewport: null,
      ignoreHTTPSErrors: true,
      args: [
        `--remote-debugging-port=${RDP_PORT}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--lang=en-US,en;q=0.9',
      ],
    });

    // Persist ws endpoint for other processes to connect.
    const wsEndpoint = browser.wsEndpoint();
    fs.mkdirSync(path.dirname(WS_FILE), { recursive: true });
    fs.writeFileSync(WS_FILE, JSON.stringify({ wsEndpoint }, null, 2));
    releaseLock(lockFd);

    __sharedBrowser = browser;
    return browser;
  })();

  try {
    const br = await __launching;
    return br;
  } finally {
    __launching = null; // allow future reconnects if this one dies
  }
}


/** Ensure the UA is a real (non-headless) UA. Optionally randomize. */
export async function applyRealUA(page, { randomize = true } = {}) {
  try {
    const current = await page.browser().userAgent();
    const cleaned = (current || '').replace(/Headless\s?/i, '');
    const ua = randomize ? pickUA() : cleaned || pickUA();
    await page.setUserAgent(ua);
  } catch {}
}

/**
 * Attach network request filtering using makeRequestBlocker.
 * @param {import('puppeteer').Page} page
 * @param {object} rules - Rules understood by makeRequestBlocker (e.g., { blocklist, allowlistDomains, resourceTypes })
 * @returns {Function} shouldBlock(url, resourceType)
 */
export async function applyRequestFiltering(page, rules = {}) {
  if (!page) throw new Error('applyRequestFiltering: page is required');
  const shouldBlock = makeRequestBlocker(rules);
  try { await page.setRequestInterception(true); } catch {}
  // Remove any prior listener we may have added
  if (page.__df_req_interceptor) {
    try { page.off('request', page.__df_req_interceptor); } catch {}
  }
  const handler = (req) => {
    try {
      const url = req.url();
      const type = req.resourceType?.() || 'other';
      if (shouldBlock(url, type)) {
        return req.abort('blockedbyclient').catch(()=>{});
      }
      return req.continue().catch(()=>{});
    } catch {
      try { req.continue(); } catch {}
    }
  };
  page.on('request', handler);
  page.__df_req_interceptor = handler;
  return shouldBlock;
}

/** Ensure Chase page has a real UA and sane defaults. */
/** Generic page setup used by vendors (UA, timeouts, viewport, small humanization). */
export async function ensureVendorPageSetup(page, {
  randomizeUA = true,
  timeoutMs   = 30000,
  jitterViewport = true,
  baseViewport   = { width: 1280, height: 900 },
} = {}) {
  if (!page || page.__df_vendorSetup) return;
  await applyRealUA(page, { randomize: randomizeUA });
  try { page.setDefaultTimeout(timeoutMs); } catch {}
  try { await page.setBypassCSP?.(true); } catch {}
  try { if (jitterViewport) await page.setViewport(randomViewport(baseViewport)); } catch {}
  // Dismiss modal dialogs
  if (!page.__df_dialog_handler_attached) {
    page.__df_dialog_handler_attached = true;
    page.on('dialog', async d => { try { await d.dismiss(); } catch {} });
  }
  // If a factory provided intercept rules earlier, apply them now.
  try {
    if (page.__df_interceptRules) {
      await applyRequestFiltering(page, page.__df_interceptRules);
    }
  } catch {}
  page.__df_vendorSetup = true;
}

export async function enableNetworkCDP(page, { blocklist = defaultBlockList } = {}) {
  if (!page) throw new Error('enableNetworkCDP: page is required');

  // If already enabled for this page, return the cached client
  if (page.__df_network_enabled && page.__df_network_client) {
    return page.__df_network_client;
  }

  // Prefer the page's existing client; fall back to a new CDP session only if necessary
  const client = (typeof page._client === 'function' && page._client()) || (await page.createCDPSession());
  page.__df_network_client = client;

  // Best-effort: ensure the protocol timeout is honored
  try {
    client._connection?.setProtocolTimeout?.(PROTOCOL_TIMEOUT);
  } catch {}

  // Lightweight retry helper to tame transient CDP stalls
  const withRetries = async (fn, tries = 3, baseDelay = 200) => {
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        // Exponential-ish backoff
        await new Promise(r => setTimeout(r, baseDelay * (i + 1)));
      }
    }
    throw lastErr;
  };

  // Enable Network domain with retries
  await withRetries(() => client.send('Network.enable'), 3, 200);

  // Apply optional URL blocklist if supported by this Chromium build
  if (blocklist && blocklist.length) {
    try {
      await client.send('Network.setBlockedURLs', { urls: blocklist });
    } catch {}
  }

  // Mark as enabled and ensure flags are cleared when the page closes
  page.__df_network_enabled = true;
  try {
    if (!page.__df_network_closeHook) {
      page.__df_network_closeHook = true;
      page.once?.('close', () => {
        page.__df_network_client = null;
        page.__df_network_enabled = false;
      });
    }
  } catch {}

  return client;
}

/** Navigation helper with sane defaults. */
export async function safeGoto(page, url, opts = {}) {
  if (!page) throw new Error('safeGoto: page is required');
  const { waitUntil = ['domcontentloaded', 'networkidle0'], timeout = 45000, referer, headers } = opts;
  try {
    if (headers && typeof headers === 'object') {
      await page.setExtraHTTPHeaders(headers);
    }
    const navOpts = { waitUntil, timeout };
    if (referer) navOpts.referer = referer;
    return await page.goto(url, navOpts);
  } catch (e) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(15000, Math.floor(timeout / 2)) });
    } catch {
      throw e;
    }
  }
}

export async function getSharedPage(
  name = 'default',
  { interceptRules, timeoutMs, allowlistDomains, jitterViewport, baseViewport } = {}
) {
  const browser = await initSharedBrowser();
  const pages = await browser.pages();
  let page = pages.find(p => p.__df_name === name);
  if (!page) {
    page = await browser.newPage();
    page.__df_name = name;
    page.once?.('close', () => {
      page.__df_network_session = null;
      page.__df_network_enabled = false;
    });
  }
  // Basic hardening; you can keep your existing helpers too
  try { if (timeoutMs) page.setDefaultNavigationTimeout(timeoutMs); } catch {}
  try { if (timeoutMs) page.setDefaultTimeout(timeoutMs); } catch {}
  // Attach request filtering if rules were provided
  try {
    if (interceptRules || allowlistDomains) {
      const rules = interceptRules || {};
      if (allowlistDomains) rules.allowlistDomains = allowlistDomains;
      page.__df_interceptRules = rules;
      await applyRequestFiltering(page, rules);
    }
  } catch {}
  return page;
}

// ---------- Page Pools (Movoto / BofA / generic) ----------
const __pools = new Map();

/**
 * Create (or get) a named page pool.
 * @param {string} name                 Pool name, e.g. 'movoto' | 'bofa'.
 * @param {object} options              { size, interceptRules, setup }
 *  - size: integer pool size (default 3)
 *  - interceptRules: unified rules understood by getSharedPage()
 *  - setup(page): optional async one-time page setup (UA, humanize, etc.)
 */
export async function getOrCreatePagePool(name, { size = 3, interceptRules = {}, setup = null } = {}) {
  if (!global.__df_sharedBrowser) await initSharedBrowser();
  if (__pools.has(name)) return __pools.get(name);

  const pool = {
    name,
    size: Math.max(1, Number(size) || 1),
    idle: [],
    busy: new Set(),
    creating: 0,
    waiters: [],
    async _newPage() {
      const pg = await getSharedPage(
        `${name}-pool-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        {
          interceptRules,
          timeoutMs: 20000,
        }
      );
      // Persist the intercept rules on the page for ensureVendorPageSetup
      try { pg.__df_interceptRules = interceptRules; } catch {}
      if (typeof setup === 'function') {
        try { await setup(pg); } catch {}
      }
      return pg;
    },
    async acquire() {
      // Return an idle page when available
      while (pool.idle.length) {
        const pg = pool.idle.pop();
        if (pg && !pg.isClosed?.()) {
          pool.busy.add(pg);
          return { page: pg, release: pool._makeRelease(pg) };
        }
      }

      // Create a new page if under capacity
      if ((pool.busy.size + pool.idle.length + pool.creating) < pool.size) {
        pool.creating++;
        try {
          const created = await pool._newPage();
          pool.busy.add(created);
          return { page: created, release: pool._makeRelease(created) };
        } finally {
          pool.creating--;
        }
      }

      // Otherwise, wait for a release
      return new Promise((resolve) => { pool.waiters.push(resolve); });
    },
    _makeRelease(pg) {
      let done = false;
      return async () => {
        if (done) return; done = true;
        if (!pg || pg.isClosed?.()) { pool.busy.delete(pg); return; }
        pool.busy.delete(pg);
        const next = pool.waiters.shift();
        if (next) {
          pool.busy.add(pg);
          next({ page: pg, release: pool._makeRelease(pg) });
        } else {
          pool.idle.push(pg);
        }
      };
    },
    async destroy() {
      const closers = [];
      for (const p of pool.idle) closers.push(p.close({ runBeforeUnload:false }).catch(()=>{}));
      for (const p of pool.busy) closers.push(p.close({ runBeforeUnload:false }).catch(()=>{}));
      pool.idle.length = 0;
      pool.busy.clear();
      pool.waiters.length = 0;
      await Promise.allSettled(closers);
    }
  };

  __pools.set(name, pool);
  return pool;
}

export const createPagePool = getOrCreatePagePool;

/** Destroy all pools (invoked by closeSharedBrowser). */
export async function shutdownPools() {
  const tasks = [];
  for (const [, pool] of __pools) tasks.push(pool.destroy().catch(()=>{}));
  await Promise.allSettled(tasks);
  __pools.clear();
}

/** Optional teardown (closes pages & browser unless KEEP_BROWSER_ALIVE=true). */
export async function closeSharedBrowser() {
  try { await shutdownPools(); } catch {}
  try {
    if (String(process.env.KEEP_BROWSER_ALIVE).toLowerCase() === 'true') return;

    if (global.__df_sharedPages instanceof Map) {
      for (const [name, pg] of global.__df_sharedPages.entries()) {
        try { if (pg && !pg.isClosed?.()) await pg.close({ runBeforeUnload: false }); } catch {}
      }
      global.__df_sharedPages.clear();
    }

    const br = global.__df_sharedBrowser || _sharedBrowser;
    try { if (br && br.close) await br.close(); } catch {}

    global.__df_sharedBrowser = null;
    _sharedBrowser = null;
  } catch {}
}

// Graceful shutdown hooks
try {
  if (!global.__BROWSER_SHARED_SHUTDOWN_ATTACHED__) {
    global.__BROWSER_SHARED_SHUTDOWN_ATTACHED__ = true;
    const shutdown = async () => { try { await closeSharedBrowser(); } catch {} };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
} catch {}