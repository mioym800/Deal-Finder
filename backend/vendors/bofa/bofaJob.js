// vendors/bofa/bofaJob.js
import 'dotenv/config.js';
import mongoose from 'mongoose';
import pLimit from 'p-limit';
import { launchBrowser, newPage, enableLightInterception } from '../../utils/browser1.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { PAGES_PER_PROXY } from '../../utils/proxy.js';
import { scrapeBofaValues, averageTwo, parseDollarToNumber } from './extractors.js';
import Property from '../../models/Property.js';
import {
  getVendorProxyPool,
  makeProxySupplierFromPool,
  precheckPaidProxyForUrl,
} from '../../utils/proxyBuilder.js';

const HOME_URL = 'https://homevaluerealestatecenter.bankofamerica.com/';

// Logger must exist before any use
const VERBOSE = String(process.env.BOFA_VERBOSE || '0') === '1';
const logv = (...args) => { if (VERBOSE) console.log(...args); };

// Warn and force headless if DISPLAY is not set and headless is disabled
if (!process.env.DISPLAY && String(process.env.PPTR_HEADLESS || process.env.HEADLESS || '').toLowerCase() === 'false') {
  console.log('ℹ️  DISPLAY is not set; forcing headless Chromium to avoid X11 errors.');
  process.env.PPTR_HEADLESS = 'true';
}

const _bofaPool = getVendorProxyPool('bofa', process.env);
const _nextBofaProxy = makeProxySupplierFromPool(_bofaPool);

const {
  MONGO_URI,
  BOFA_MAX_CONCURRENCY = process.env.BOFA_MAX_CONCURRENCY || '12',
  BOFA_BATCH_SIZE = process.env.BOFA_BATCH_SIZE || '2000',
  BOFA_RESULT_TIMEOUT_MS = process.env.BOFA_RESULT_TIMEOUT_MS || '40000',
  BOFA_EGRESS_COOLDOWN_MS = process.env.BOFA_EGRESS_COOLDOWN_MS || '800',
} = process.env;

// --- Tunable fast-path timeouts & behavior ---
const NAV_TIMEOUT = Number(process.env.BOFA_NAV_TIMEOUT_MS || 15000);          // was 45s → 15s
const RESULTS_WAIT = Number(process.env.BOFA_RESULTS_WAIT_MS || 15000);       // was 40s → 15s
const HARD_ADDR_TIMEOUT = Number(process.env.BOFA_HARD_TIMEOUT_MS || (NAV_TIMEOUT + RESULTS_WAIT + 7000));  // dynamic ceiling (~NAV+RESULTS+7s)
const ALLOW_SECOND_SUBMIT = String(process.env.BOFA_SINGLE_TRY || '1') !== '1'; // default: single try
// --- Single-address debug mode ---
const SINGLE_ADDR = (process.env.BOFA_SINGLE_ADDR || '').trim() || '';
const SINGLE_ID   = (process.env.BOFA_SINGLE_ID || '').trim() || '';
const SINGLE_MODE = !!(SINGLE_ADDR || SINGLE_ID);
// ---- LRU + Histogram (opt-in via env) --------------------------------------
const LRU_ENABLED   = String(process.env.BOFA_LRU_ENABLED || '0') === '1';
const LRU_MAX       = Number(process.env.BOFA_LRU_MAX || 100000);
const LRU_TTL       = Number(process.env.BOFA_LRU_TTL_MS || 24 * 60 * 60 * 1000); // 24h
const LRU_ON_FAIL   = String(process.env.BOFA_LRU_ON_FAIL || '1') === '1'; // cache failures too

const HIST_ENABLED  = String(process.env.BOFA_HIST_ENABLED || '1') === '1';
const HIST_EVERY    = Number(process.env.BOFA_HIST_EMIT_EVERY || 200);

class SimpleTTL_LRU {
  constructor(max, ttl) {
    this.max = Math.max(1, Number(max) || 1);
    this.ttl = Math.max(1000, Number(ttl) || 60000);
    this.map = new Map(); // k -> { exp }
  }
  has(k) {
    const rec = this.map.get(k);
    if (!rec) return false;
    if (rec.exp < Date.now()) {
      this.map.delete(k);
      return false;
    }
    return true;
  }
  set(k) {
    const now = Date.now();
    // refresh order for LRU
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, { exp: now + this.ttl });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
  prune() {
    const now = Date.now();
    for (const [k, rec] of this.map) {
      if (rec.exp < now) this.map.delete(k);
    }
  }
  size() { return this.map.size; }
}

const SeenLRU = LRU_ENABLED ? new SimpleTTL_LRU(LRU_MAX, LRU_TTL) : null;

// --- Lightweight timing histogram ---
const hist = {
  n: 0,
  buckets: { typed: new Map(), results: new Map(), total: new Map() },
  outcomes: { success: 0, fail: 0, retried: 0, single: 0 }
};
function _bucketOf(ms) {
  if (ms == null) return 'n/a';
  if (ms < 1000) return '<1s';
  if (ms < 3000) return '1–3s';
  if (ms < 6000) return '3–6s';
  if (ms < 10000) return '6–10s';
  if (ms < 20000) return '10–20s';
  if (ms < 40000) return '20–40s';
  return '40s+';
}
function _bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }
function histRecord({ timings, success }) {
  if (!HIST_ENABLED) return;
  const { typedMs, resultsMs, totalMs, retried } = timings || {};
  _bump(hist.buckets.typed, _bucketOf(typedMs));
  _bump(hist.buckets.results, _bucketOf(resultsMs));
  _bump(hist.buckets.total, _bucketOf(totalMs));
  if (success) hist.outcomes.success++; else hist.outcomes.fail++;
  if (retried) hist.outcomes.retried++; else hist.outcomes.single++;
  hist.n++;
  if (hist.n % HIST_EVERY === 0) histEmit();
}
function histEmit() {
  if (!HIST_ENABLED) return;
  const fmt = (m) => [...m.entries()].sort((a,b) => a[0].localeCompare(b[0]))
    .map(([k,v]) => `${k}:${v}`).join('  ');
  console.log(
    `[HIST] count=${hist.n} ` +
    `typed{ ${fmt(hist.buckets.typed)} } ` +
    `results{ ${fmt(hist.buckets.results)} } ` +
    `total{ ${fmt(hist.buckets.total)} } ` +
    `outcomes{ success:${hist.outcomes.success} fail:${hist.outcomes.fail} retried:${hist.outcomes.retried} single:${hist.outcomes.single} }`
  );
}

// Optional: how many proxies to try before failing the worker
// BOFA_PROXY_RETRIES (default 6)



const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Lightweight HTTP CONNECT preflight through the proxy to BoA (skips Chromium churn if tunnel won't open)
async function preflightConnect({ host, port, credentials }, targetHost = 'homevaluerealestatecenter.bankofamerica.com', targetPort = 443, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(!!ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('error', () => done(false));
    socket.once('connect', () => {
      const auth = credentials?.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${credentials.username}:${credentials.password || ''}`).toString('base64')}\r\n`
        : '';
      const req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`;
      try { socket.write(req); } catch { done(false); }
    });
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // Expect first line like: HTTP/1.1 200 Connection Established
      const m = buf.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      if (m) {
        const code = Number(m[1]);
        // 200 is success; 407 is auth required; anything else treat as fail
        done(code === 200);
      }
    });
  });
}

const shortErr = (e) => (e && (e.message || String(e))) || 'unknown';

// Acquire a fresh Chrome + Page behind a healthy proxy. Retries on tunnel failures.
async function openWithHealthyProxy(getNext, {
  maxTries = Number(process.env.BOFA_PROXY_TRIES || process.env.BOFA_PROXY_RETRIES) || 20
} = {}) {
  if (String(process.env.BOFA_DIRECT || '0') === '1') {
    const noDisplay = !process.env.DISPLAY;
    const headlessWantedEnv =
      String(process.env.PPTR_HEADLESS || process.env.HEADLESS || (noDisplay ? 'true' : 'false')).toLowerCase() === 'true';
    const headlessFlag = headlessWantedEnv || noDisplay ? '--headless=new' : null;
    const launchArgs = [
      '--proxy-bypass-list=<-loopback>,localhost,127.0.0.1',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
      '--disable-quic',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      ...(headlessFlag ? [headlessFlag] : []),
      ...(process.env.PUPPETEER_EXTRA_ARGS ? String(process.env.PUPPETEER_EXTRA_ARGS).split(/\s+/).filter(Boolean) : []),
    ];
    const browser = await launchBrowser(launchArgs);
    const page = await newPage(browser);
    if (typeof page.waitForTimeout !== 'function') {
      page.waitForTimeout = (ms) => new Promise(res => setTimeout(res, Number(ms) || 0));
    }
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
    await enableLightInterception(page);
    return { browser, page, hostPort: 'DIRECT' };
  }
  const skipPrecheck = String(process.env.BOFA_SKIP_PRECHECK || '1') === '1';
  const override = (process.env.BOFA_PROXY_OVERRIDE || '').trim();
  const envCreds = (process.env.BOFA_PROXY_USER || process.env.DECODO_USER)
    ? { username: String(process.env.BOFA_PROXY_USER || process.env.DECODO_USER),
        password: String(process.env.BOFA_PROXY_PASS || process.env.DECODO_PASS || '') }
    : null;

  // Helper to parse override string like "http://user:pass@host:port"
  const parseProxyUrl = (u) => {
    try {
      const url = new URL(u);
      return {
        host: url.hostname,
        port: Number(url.port || 80),
        credentials: (url.username || url.password)
          ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
          : null,
        arg: `--proxy-server=${url.protocol}//${url.username ? `${url.username}:${url.password}@` : ''}${url.hostname}:${url.port}`
      };
    } catch {
      return null;
    }
  };

  // If overrides are provided, try them in order (comma-separated supported).
  const overrideStr = override;
  if (overrideStr) {
    const items = overrideStr.split(',').map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < items.length; i++) {
      let raw = items[i];
      // Allow host:port without scheme
      if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;
      const pin = parseProxyUrl(raw);
      if (!pin) {
        /* warn hidden in prod */
        continue;
      }
      if (!pin.credentials && envCreds) pin.credentials = envCreds;
      if (!skipPrecheck) {
        try {
          const ok = await precheckPaidProxyForUrl(HOME_URL, pin);
          if (!ok) {
            /* warn hidden in prod */
            continue;
          } else {
            /* log hidden in prod */
          }
        } catch (e) {
          /* warn hidden in prod */
          continue;
        }
      }
      try {
        const got = await tryOneProxyCandidate(pin, { label: `override(${i+1}/${items.length})`, skipPrecheck });
        if (got) return got;
      } catch (e) {
        if (String(e?.message) === 'BROWSER_LAUNCH_ENV') {
          throw e;
        }
      }
    }
    throw new Error('Override proxy failed authentication / tunnel');
  }

  // Otherwise, iterate pool candidates up to maxTries
  for (let attempt = 1; attempt <= maxTries; attempt++) {
    const base = getNext(); // { host, port, credentials?, arg? }
    if (VERBOSE) console.log('[proxy] candidate', attempt, base && (base.host + ':' + base.port));
    if (!base) break;
    // Merge env creds into pool candidate if missing
    const candidate = { ...base, credentials: base.credentials || envCreds || null };
    const doPreflight = String(process.env.BOFA_PREFLIGHT || '0') === '1';
    if (doPreflight) {
      const ok = await preflightConnect(candidate).catch(() => false);
      if (!ok) {
        logv(`[proxy] preflight failed for ${candidate.host}:${candidate.port} (CONNECT not established)`);
        continue;
      } else {
        logv(`[proxy] preflight OK for ${candidate.host}:${candidate.port}`);
      }
    }
    /* log hidden in prod */
    if (!skipPrecheck) {
      try {
        const ok = await precheckPaidProxyForUrl(HOME_URL, candidate);
        if (!ok) {
          /* warn hidden in prod */
          continue;
        } else {
          /* log hidden in prod */
        }
      } catch (e) {
        /* warn hidden in prod */
        continue;
      }
    }
    try {
      const got = await tryOneProxyCandidate(candidate, { skipPrecheck, attempt });
      if (got) return got;
    } catch (e) {
      if (String(e?.message) === 'BROWSER_LAUNCH_ENV') {
        throw e;
      }
    }
    // tiny jittered backoff before next port
    await new Promise(r => setTimeout(r, 150 + Math.floor(Math.random() * 200)));
  }
  throw new Error('No healthy proxy after retries');
}

// Try a single proxy candidate with multiple auth/flag styles before giving up that port.
async function tryOneProxyCandidate(candidate, { skipPrecheck, label = '', attempt } = {}) {
  const hostPort = `${candidate.host}:${candidate.port}`;

  // Build a list of proxy-argument variants to try for THIS candidate:
  const flagsToTry = [];

  // Prefer the simple, stable proxy forms first — these mirror the working one-off puppeteer test.
  // 1) Single-scheme http without inline creds; we authenticate via page.authenticate().
  flagsToTry.push(`--proxy-server=http://${candidate.host}:${candidate.port}`);
  // Also try HTTPS scheme
  flagsToTry.push(`--proxy-server=https://${candidate.host}:${candidate.port}`);

  // 2) Bare host:port (some gateways accept this as well).
  flagsToTry.push(`--proxy-server=${candidate.host}:${candidate.port}`);

  // 3) Dual-scheme mapping LAST; some gateways return PROXY_TUNNEL_FAILED with this syntax.
  flagsToTry.push(`--proxy-server=http=${candidate.host}:${candidate.port};https=${candidate.host}:${candidate.port}`);

  // 4) Pool-supplied custom arg, if any.
  if (candidate.arg) flagsToTry.push(candidate.arg);

  // Inline credentials should be a very last resort and are skipped entirely when forcing page-level auth.
  const forcePageAuth = String(process.env.BOFA_FORCE_PAGE_AUTH || '0') === '1';
  if (!forcePageAuth && candidate.credentials?.username) {
    const u = encodeURIComponent(candidate.credentials.username);
    const p = encodeURIComponent(candidate.credentials.password || '');
    flagsToTry.push(`--proxy-server=http://${u}:${p}@${candidate.host}:${candidate.port}`);
  }

  // Force headless when no DISPLAY is available to avoid X11/ozone init errors.
  const noDisplay = !process.env.DISPLAY;
  const headlessWantedEnv =
    String(process.env.PPTR_HEADLESS || process.env.HEADLESS || (noDisplay ? 'true' : 'false')).toLowerCase() === 'true';
  const headlessWanted = noDisplay ? true : headlessWantedEnv;
  const headlessFlag = headlessWanted ? '--headless=new' : null;

  // Helper to detect browser launch environment failures
  const isLaunchEnvFailure = (errMsg = '') => /Missing X server|platform failed to initialize|Failed to launch the browser process|inotify_init\(\) failed|Too many open files|dbus\/bus\.cc:408/i.test(errMsg);

  for (const proxyArg of flagsToTry) {
    logv(`[proxy] trying ${label ? label + ' ' : ''}${hostPort} via '${proxyArg.replace(/:.+@/,'://****:****@')}'`);

    const launchArgs = [
      proxyArg,
      '--proxy-bypass-list=<-loopback>,localhost,127.0.0.1',
      '--ignore-certificate-errors',
      '--allow-insecure-localhost',
      '--disable-quic',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      ...(headlessFlag ? [headlessFlag] : []),
      ...(process.env.PUPPETEER_EXTRA_ARGS
        ? String(process.env.PUPPETEER_EXTRA_ARGS).split(/\s+/).filter(Boolean)
        : []),
    ];

    // If headless is enabled via env, ensure we use the modern headless mode like the passing test.
    if (String(process.env.PPTR_HEADLESS || process.env.HEADLESS || 'false').toLowerCase() === 'true') {
      if (!launchArgs.some(a => a.startsWith('--headless'))) {
        launchArgs.push('--headless=new');
      }
    }

    // Be generous with first navigation through a fresh proxy
    const firstNavTimeout = Number(process.env.BOFA_FIRST_NAV_TIMEOUT_MS) || 45000;

    let browser = null;
    let page = null;

    try {
      browser = await launchBrowser(launchArgs);
      page = await newPage(browser);
      if (typeof page.waitForTimeout !== 'function') {
        page.waitForTimeout = (ms) => new Promise(res => setTimeout(res, Number(ms) || 0));
      }

      // Always attempt page.authenticate() if creds exist (even if inline was tried)
      if (candidate?.credentials?.username) {
        try {
          await page.authenticate({
            username: candidate.credentials.username,
            password: candidate.credentials.password || ''
          });
          const inlineUsed = /\/\/[^@]+@/i.test(proxyArg);
          /* log hidden in prod */
        } catch (e) {
          /* warn hidden in prod */
        }
      }

      // Detect chrome error pages / proxy tunnel failures / bad auth
      let chromeError = false;
      page.on('framenavigated', fr => { if (fr.url()?.startsWith('chrome-error://')) chromeError = true; });
      page.on('requestfailed', req => {
        const f = (req.failure() && req.failure().errorText) || '';
        if (/ERR_(TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|INVALID_AUTH_CREDENTIALS|CONNECTION_(CLOSED|RESET))|net::ERR_FAILED/i.test(f)) {
          chromeError = true;
        }
      });

      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: firstNavTimeout });
      // Now that we’ve completed the first load through the proxy, we can safely
      // enable lightweight request interception to block images/media.
      await enableLightInterception(page);

      if (chromeError || page.url().startsWith('chrome-error://')) {
        throw new Error('PROXY_TUNNEL_FAILED');
      }

      // Normalize UA/Lang for stability
      try { await page.setUserAgent(process.env.BOFA_UA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'); } catch {}
      try { await page.setExtraHTTPHeaders({ 'Accept-Language': process.env.BOFA_LANGS || 'en-US,en;q=0.9' }); } catch {}

      if (skipPrecheck) {/* log hidden in prod */} else {/* log hidden in prod */}
      /* log hidden in prod */
      /* log hidden in prod */
      return { browser, page, hostPort };
    } catch (e) {
      const msg = String(e?.message || e || '');
      logv(`[proxy] ${attempt ? `attempt ${attempt} ` : ''}failed for ${hostPort} → ${msg}`);
      if (browser) { try { await browser.close(); } catch {} }
      if (isLaunchEnvFailure(msg)) {
        // Bubble a sentinel error so the outer loop stops churning (prevents EMFILE/dbus floods).
        const err = new Error('BROWSER_LAUNCH_ENV');
        err.cause = msg;
        throw err;
      }
      // otherwise proceed to next proxy-flag or next candidate
    }
  }
  // Exhausted all flags for this candidate
  return null;
}

// ---- debug helpers ----
async function debugDump(page, label) { return; }

// Strong key press that targets the active element and the page keyboard
async function pressEnterHard(page, delay = 90) {
  try { await page.keyboard.press('Enter'); } catch {}
  await sleep(delay);
  try {
    await page.evaluate(() => {
      const el = document.activeElement || document.querySelector('#address');
      if (!el) return;
      const fire = (type) => el.dispatchEvent(new KeyboardEvent(type, {key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true, cancelable: true}));
      fire('keydown'); fire('keypress'); fire('keyup');
    });
  } catch {}
  await sleep(delay);
}

// Click the most likely submit button near the address input
async function clickNearbySubmit(page) {
  const selectors = [
    'button[type="submit"]',
    '.hvt-search__submit',
    'button[aria-label*="Search"]',
    '[data-testid="search-submit"]',
    'form button[type="submit"]'
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click({ delay: 20 }); return true; }
    } catch {}
  }
  return false;
}

// Click first visible suggestion using in-page logic (handles shadowy classnames)
async function clickFirstVisibleSuggestion(page) {
  try {
    const clicked = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll(
        'ul[role="listbox"] [role="option"], ul[role="listbox"] li[role="option"], .hvt-search__suggestion, .ui-menu-item, .tt-suggestion, .pac-item, .suggestion-list li'
      ));
      const isVisible = (n) => !!(n && (n.offsetParent || (n.getClientRects && n.getClientRects().length)));
      const target = cands.find(isVisible);
      if (target) { target.click(); return true; }
      return false;
    });
    return !!clicked;
  } catch { return false; }
}

async function selectMatchingSuggestion(page, address) {
  try {
    const matched = await page.evaluate((addr) => {
      // Normalize helper similar to server-side normalizeAddress
      function normalize(s) {
        if (!s) return '';
        s = String(s).toUpperCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();

        // Expand common USPS suffixes and compass directions
        const map = [
          [/(\b)ST(\b)\.?/g, '$1STREET$2'],
          [/(\b)AVE(\b)\.?/g, '$1AVENUE$2'],
          [/(\b)RD(\b)\.?/g, '$1ROAD$2'],
          [/(\b)BLVD(\b)\.?/g, '$1BOULEVARD$2'],
          [/(\b)DR(\b)\.?/g, '$1DRIVE$2'],
          [/(\b)LN(\b)\.?/g, '$1LANE$2'],
          [/(\b)CT(\b)\.?/g, '$1COURT$2'],
          [/(\b)HWY(\b)\.?/g, '$1HIGHWAY$2'],
          [/(\b)PKWY(\b)\.?/g, '$1PARKWAY$2'],
          [/(\b)N(\b)\.?/g, '$1NORTH$2'],
          [/(\b)S(\b)\.?/g, '$1SOUTH$2'],
          [/(\b)E(\b)\.?/g, '$1EAST$2'],
          [/(\b)W(\b)\.?/g, '$1WEST$2']
        ];
        for (const [re, rep] of map) s = s.replace(re, rep);
        return s;
      }

      const want = normalize(addr);

      // Collect suggestion elements and their visible text
      const nodes = Array.from(document.querySelectorAll(
        'ul[role="listbox"] [role="option"], ul[role="listbox"] li[role="option"], .hvt-search__suggestion, .ui-menu-item, .tt-suggestion, .pac-item, .suggestion-list li'
      ));

      // Keep only visible
      const visibles = nodes.filter(n => {
        const r = n.getBoundingClientRect?.();
        const visible = !!(r && r.width > 0 && r.height > 0);
        return visible;
      });

      // Build {el, text, norm} list
      const items = visibles.map(el => {
        const text = (el.innerText || el.textContent || '').trim();
        return { el, text, norm: normalize(text) };
      });

      // Prefer exact normalized equality
      let pick = items.find(it => it.norm === want);

      // If not exact, try starts-with on normalized (the suggestion may append county/state)
      if (!pick) {
        pick = items.find(it => it.norm.startsWith(want + ' '));
      }

      if (pick) {
        pick.el.click();
        return true;
      }
      return false;
    }, address);

    return !!matched;
  } catch {
    return false;
  }
}

// Wait for suggestions to appear in the UI
async function waitForSuggestions(page, { timeout = 1000 } = {}) {
  const selectors = [
    'ul[role="listbox"] [role="option"]',
    'ul[role="listbox"] li[role="option"]',
    '.hvt-search__suggestion',
    '.ui-menu-item',
    '.tt-suggestion',
    '.pac-item',
    '.suggestion-list li',
  ];
  try {
    const seen = await page.waitForFunction((sels) => {
      const isVisible = (n) => !!(n && (n.offsetParent || (n.getClientRects && n.getClientRects().length)));
      for (const sel of sels) {
        const nodes = Array.from(document.querySelectorAll(sel));
        if (nodes.some(isVisible)) return true;
      }
      return false;
    }, { timeout }, selectors);
    return !!seen;
  } catch {
    return false;
  }
}

// Find the context (Page or Frame) that actually contains the comparables section.
// BoA sometimes serves results inside an iframe. We probe the main page and all frames.
async function getResultsContext(page, { timeoutMs = Number(process.env.BOFA_RESULT_TIMEOUT_MS) || 40000 } = {}) {
  const valueSel = '#section-comparables .hvt-comparables__avg-est, .hvt-estimate__value, [data-testid="estimated-home-value"]';
  const deadline = Date.now() + timeoutMs;

  const hasResults = async (ctx) => {
    try {
      // Strict selector first
      const strict = await ctx.$(valueSel);
      if (strict) return true;

      // Fallback: look for a dollar amount near the labels
      return await ctx.evaluate(() => {
        const DOLLAR = /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\*?/;
        function findValueNear(labelRe) {
          const all = Array.from(document.querySelectorAll('body *')).slice(0, 5000);
          const label = all.find(n => labelRe.test((n.textContent || '').trim()));
          if (!label) return null;
          const root = label.closest('section,div,article,li') || label.parentElement;
          if (!root) return null;
          const hit = Array.from(root.querySelectorAll('*')).find(n => DOLLAR.test((n.textContent || '').trim()));
          return !!hit;
        }
        return findValueNear(/Average sale price/i) || findValueNear(/Estimated home value/i);
      });
    } catch {
      return false;
    }
  };

  // quick check on the main page first
  try {
    if (await hasResults(page)) return page;
  } catch {}

  // poll frames until deadline
  while (Date.now() < deadline) {
    const frames = page.frames();
    for (const f of frames) {
      try {
        if (await hasResults(f)) return f;
      } catch {}
    }
    await sleep(300);
  }

  // Give up; caller will decide what to do
  return null;
}
// Fallback scraper by label proximity when class names change
async function scrapeByLabelFallback(ctx) {
  try {
    const res = await ctx.evaluate(() => {
      const DOLLAR = /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?\*?/;
      const clean = (s) => (s || '').trim();
      function grab(labelRe) {
        const all = Array.from(document.querySelectorAll('body *')).slice(0, 6000);
        const label = all.find(n => labelRe.test((n.textContent || '').trim()));
        if (!label) return '';
        const container = label.closest('section,div,article,li') || label.parentElement;
        if (!container) return '';
        // 1) Dollar value near the label
    let node = Array.from(container.querySelectorAll('*')).find(n => DOLLAR.test((n.textContent || '').trim()));
    // 2) Or the hero estimate number on details pages
    if (!node) node = document.querySelector('.hvt-estimate__value,[data-testid="estimated-home-value"]');

        return node ? clean(node.textContent) : '';
      }
      return {
        avgSaleText: grab(/Average sale price/i),
        estHomeText: grab(/Estimated home value/i),
      };
    });
    return res || { avgSaleText: '', estHomeText: '' };
  } catch {
    return { avgSaleText: '', estHomeText: '' };
  }
}

// Local ultra-robust dollar parser (fallback if parseDollarToNumber says null)
function parseDollarLoose(s) {
  const cleaned = String(s || '').replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  const n = cleaned ? Number.parseFloat(cleaned) : NaN;
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function acceptConsentIfPresent(page) {
  // OneTrust / cookie walls vary a bit; be permissive and safe-noop on failure
  try {
    const btn = await page.$('#onetrust-accept-btn-handler, #onetrust-accept-all-handler');
    if (btn) await btn.click({ delay: 10 });
  } catch {}
  try {
    const [elt] = await page.$x("//button[contains(., 'Accept') or contains(., 'Agree') or contains(., 'I Accept') or contains(., 'Allow all') or contains(., 'Accept All')]");
    if (elt) await elt.click({ delay: 10 });
  } catch {}
  // Some variants show a banner inside an iframe; attempt a shallow pass
  try {
    for (const f of page.frames()) {
      if (!/bankofamerica|homevaluerealestatecenter/i.test(f.url())) continue;
      const b = await f.$('#onetrust-accept-btn-handler, #onetrust-accept-all-handler');
      if (b) { await b.click({ delay: 10 }); break; }
    }
  } catch {}
}

async function ensurePageReady(page) {
  // Let the shell load and try to dismiss consent
  await page.waitForSelector('body', { timeout: 15000 }).catch(() => {});
  await acceptConsentIfPresent(page);

  // Return early if results are already visible (variant without #address)
  const resultsVisible = await waitForResultsAny(page, { timeout: 3000 });
  if (resultsVisible) return 'results';

  // Otherwise try to find and focus the input
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const input = await page.$('#address');
    if (input) {
      try {
        await input.evaluate(el => el.scrollIntoView({ block: 'center' }));
        await input.evaluate(el => { if (el && el.focus) el.focus(); });
      } catch {}
      return 'input';
    }
    await page.waitForTimeout(250);
  }

  // If we still don’t see either, last chance: check results again
  if (await waitForResultsAny(page, { timeout: 1000 })) return 'results';

  // As a final fallback, signal "no input" — caller will decide what to do.
  return 'none';
}

// Broader wait: any hint of results either in-page or inside a same-origin iframe
async function waitForResultsAny(page, { timeout = 40000 } = {}) {
  const sel = '#section-comparables .hvt-comparables__avg-est, .hvt-estimate__value, [data-testid="estimated-home-value"], h1:has(+ div), h2:has(+ div)';
  const blockedRe = /(verify you are a human|access denied|forbidden|captcha)/i;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const seen = await page.evaluate(() => {
      const sel = '#section-comparables .hvt-comparables__avg-est, .hvt-estimate__value, [data-testid="estimated-home-value"], h1:has(+ div), h2:has(+ div)';
      if (document.querySelector(sel)) return true;
      // also look for the labels themselves
      const textHit = !!Array.from(document.querySelectorAll('body *'))
        .slice(0, 5000)
        .find(n => /Average sale price|Estimated home value/i.test(n.textContent || ''));
      if (textHit) {
        // surface possible captcha/blocker
        if (/(verify you are a human|access denied|forbidden|captcha)/i.test((document.body && document.body.innerText) || '')) return true;
      }
      if (textHit) return true;
      // peek into same-origin iframes
      const iframes = Array.from(document.querySelectorAll('iframe'));
      for (const f of iframes) {
        try {
          const d = f.contentDocument;
          if (!d) continue;
          if (d.querySelector(sel)) return true;
          const hit = !!Array.from(d.querySelectorAll('body *'))
            .slice(0, 5000)
            .find(n => /Average sale price|Estimated home value/i.test(n.textContent || ''));
          if (hit) return true;
        } catch {}
      }
      return false;
    }).catch(() => false);
    if (seen) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

async function maybeScreenshot(page, label) {
  try {
    if (String(process.env.BOFA_SCREEN_ON_ERROR || '0') !== '1') return;
    const dir = process.env.BOFA_DEBUG_DIR || '/tmp/bofa_debug';
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const pathOut = `${dir}/bofa_${label}_${ts}.png`;
    await page.screenshot({ path: pathOut, fullPage: true }).catch(() => {});
  } catch {}
}

// Fully reload the BoA home with a fresh DOM (same tab)
async function hardResetToHome(page) {
  try { await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch {}
  await ensurePageReady(page);
}

// New Tab reset (keeps the same browser/proxy)
async function newTabReset(browser) {
  const page = await newPage(browser);
  if (typeof page.waitForTimeout !== 'function') {
    page.waitForTimeout = (ms) => new Promise(res => setTimeout(res, Number(ms)||0));
  }
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
  await ensurePageReady(page);
  return page;
}

async function dismissAddressPopup(page) {
  try {
    // Close "x" button inside the address input, if present
    const closeBtn = await page.$('button[aria-label="Clear"], .hvt-search__clear, .pac-close, .ui-icon-close');
    if (closeBtn) await closeBtn.click({ delay: 10 });
  } catch {}
}

async function runSearch(page, address) {
  const t0 = Date.now();
  const tmarks = {};
  const logStep = (msg) => { if (VERBOSE) console.log(`[BoA⏱] ${msg}`); };

  // Hard ceiling for *everything* in this function
  const hardTimeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error('ADDR_HARD_TIMEOUT')), HARD_ADDR_TIMEOUT)
  );

  const work = (async () => {
    const input = await page.waitForSelector('#address', { visible: true, timeout: 20000 });
    logStep(`focus:input`);

    // Bring into view and focus hard
    try { await input.evaluate(el => el.scrollIntoView({ block: 'center' })); } catch {}
    try { await input.click({ delay: 10 }); } catch {}
    try {
      await input.evaluate(el => { if (el && typeof el.focus === 'function') el.focus(); });
      await page.waitForTimeout?.(30);
      await input.evaluate(el => { if (el && typeof el.focus === 'function') el.focus(); });
    } catch {}

    // Clear any existing value (keyboard + programmatic to satisfy React)
    try { await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); } catch {}
    try { await page.keyboard.press('Backspace'); } catch {}
    try {
      await input.evaluate((el) => {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    } catch {}

    // Type the address
    await input.type(address, { delay: 14 });
    tmarks.typed = Date.now();
    logStep(`typed:${address}`);

    // Let the page wire up suggestion handlers
    await (typeof page.waitForTimeout === 'function' ? page.waitForTimeout(200) : new Promise(r => setTimeout(r, 200)));

    const sugWait = 800; // faster default
    const gotSuggestions = await waitForSuggestions(page, { timeout: sugWait });
    logStep(`suggestions:${gotSuggestions ? 'yes' : 'no'}`);

    let clicked = false;
    if (gotSuggestions) {
      clicked = await selectMatchingSuggestion(page, address).catch(() => false);
      logStep(`suggestion_click:${clicked ? 'matched' : 'no_match'}`);
    }

          if (!clicked) {
      // Fallback: click first visible suggestion if any
      try {
        const firstClicked = await clickFirstVisibleSuggestion(page);
        if (firstClicked) {
          clicked = true;
          logStep('suggestion_click:first_visible');
        }
      } catch {}
    }
    if (!clicked) {
      // Submit exactly what the user typed (do NOT pick the first suggestion)
      try { await input.press('Enter'); } catch {}
      await page.waitForTimeout?.(80);
      try { await page.keyboard.press('Enter'); } catch {}
      await clickNearbySubmit(page).catch(() => {});
    }
    logStep('submit:sent');

    // Wait for results to show (page or iframe), also race a navigation event
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {}),
      page.waitForNetworkIdle({ idleTime: 1000, timeout: NAV_TIMEOUT }).catch(() => {})
    ]);

    let reached = await waitForResultsAny(page, { timeout: RESULTS_WAIT });
    tmarks.results = Date.now();
    logStep(`results:${reached ? 'seen' : 'not_yet'}`);

    // If we didn’t see any hint of results, optionally try ONE more submit
    if (!reached && ALLOW_SECOND_SUBMIT) {
      const retryDelay = Number(process.env.BOFA_ENTER_RETRY_MS) || 350;
      await (typeof page.waitForTimeout === 'function' ? page.waitForTimeout(retryDelay) : new Promise(r => setTimeout(r, retryDelay)));
      try { await input.press('Tab'); } catch {}
      try { await page.keyboard.press('Enter'); } catch {}
      try { await page.keyboard.press('Enter'); } catch {}
      await clickNearbySubmit(page).catch(() => {});
      logStep('submit:retry');

      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: Math.min(NAV_TIMEOUT, 12000) }).catch(() => {}),
        page.waitForNetworkIdle({ idleTime: 800, timeout: Math.min(NAV_TIMEOUT, 12000) }).catch(() => {}),
      ]);
      reached = await waitForResultsAny(page, { timeout: Math.min(RESULTS_WAIT, 12000) });
      tmarks.resultsRetry = Date.now();
      logStep(`results_after_retry:${reached ? 'seen' : 'no'}`);
    }

    // Choose the right DOM context (page or child frame) and scrape
    let ctx = await getResultsContext(page, { timeoutMs: Number(process.env.BOFA_RESULT_TIMEOUT_MS) || 40000 });
    if (!ctx) {
      await maybeScreenshot(page, 'RESULTS_NOT_FOUND');
      try {
        const urlNow = await page.url();
        const bodyPreview = await page.evaluate(() => (document.body && document.body.innerText || '').slice(0, 800));
        logStep(`RESULTS_NOT_FOUND url=${urlNow} body="${bodyPreview.replace(/\s+/g,' ').slice(0, 120)}…"`);
      } catch {}
      throw new Error('RESULTS_NOT_FOUND');
    }

    let avgSaleText = '', estHomeText = '';
    try {
      ({ avgSaleText, estHomeText } = await scrapeBofaValues(ctx));
    } catch (e) {
      if (ALLOW_SECOND_SUBMIT && /detached Frame/i.test(String(e?.message || e))) {
        ctx = await getResultsContext(page, { timeoutMs: 6000 });
        if (ctx) {
          ({ avgSaleText, estHomeText } = await scrapeBofaValues(ctx));
        }
      }
      // If strict scraper failed, continue to fallback
    }

    // Fallback when strict selectors returned nothing
    if (!avgSaleText && !estHomeText) {
      const fb = await scrapeByLabelFallback(ctx);
      avgSaleText = fb.avgSaleText || avgSaleText;
      estHomeText = fb.estHomeText || estHomeText;
    }

    let avgSaleNum = parseDollarToNumber(avgSaleText);
    let estHomeNum = parseDollarToNumber(estHomeText);
    if (avgSaleNum == null) avgSaleNum = parseDollarLoose(avgSaleText);
    if (estHomeNum == null) estHomeNum = parseDollarLoose(estHomeText);

    // Always emit one compact line showing what we parsed
    console.log(`[bofa:scrape] avg="${avgSaleText}" → ${avgSaleNum ?? 'null'} ; est="${estHomeText}" → ${estHomeNum ?? 'null'}`);
    logStep(`scraped:texts`);

    return {
      avgSale: avgSaleNum,
      estHome: estHomeNum,
      composite: (avgSaleNum && estHomeNum) ? averageTwo(avgSaleText, estHomeText) : (avgSaleNum || estHomeNum || null),
      avgSaleText,
      estHomeText,
      timings: {
        typedMs: tmarks.typed ? (tmarks.typed - t0) : null,
        resultsMs: tmarks.results ? (tmarks.results - t0) : null,
        retried: !!tmarks.resultsRetry,
        totalMs: Date.now() - t0,
      }
    };
  })();

  return await Promise.race([hardTimeout, work]);
}

// REPLACE your existing saveToDoc with this version
async function saveToDoc(id, composite, raw) {
  // Build a lookup query
  const query = id
    ? { _id: id }
    : (raw?.fullAddress ? { fullAddress: raw.fullAddress } : null);

  if (!query) {
    console.log('[bofa:save] no matching doc to update (no id or address)');
    return null;
  }

  // Fetch the current vendor fields ONLY (lean to avoid full doc validation on save)
  const current = await Property.findOne(query)
    .select({ _id: 1, bofa_value: 1, chase_value: 1, redfinPrice: 1, chasePrice: 1 })
    .lean();

  if (!current) {
    console.log('[bofa:save] no matching doc to update (query miss)', query);
    return null;
  }

  // Compute AMV from available vendor fields (including the new BoFA value)
  const vendors = [
    composite,
    current.chase_value,
    current.redfinPrice,
    current.chasePrice,
  ].filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0);

  const amv = vendors.length
    ? Math.round(vendors.reduce((a, b) => a + b, 0) / vendors.length)
    : null;

  // Perform a partial update WITHOUT running validators (avoids "state is required")
  const update = {
    bofa_value: composite ?? null,
    amv,
    bofa_updated_at: new Date(),
  };

  const res = await Property.updateOne(query, { $set: update }, { runValidators: false });

  if (res.matchedCount === 0) {
    console.log('[bofa:save] update matched 0 docs', query);
    return null;
  }

  return { _id: current._id, bofa_value: update.bofa_value, amv, raw };
}

async function fetchBatch(limit) {
  // Single-address debug path: return exactly one job
  if (SINGLE_MODE) {
    // Prefer ID match (supports _id or prop_id)
    if (SINGLE_ID) {
      const byId = await Property.findOne({
        $or: [{ _id: SINGLE_ID }, { prop_id: SINGLE_ID }]
      }).select({ _id: 1, prop_id: 1, fullAddress: 1 }).lean();
      if (byId) return [byId];
      // If no DB row, synthesize a job so we can still scrape + try to save by address later
      if (SINGLE_ADDR) return [{ _id: null, prop_id: null, fullAddress: SINGLE_ADDR }];
      return [];
    }
    // Or match by fullAddress
    if (SINGLE_ADDR) {
      const byAddr = await Property.findOne({ fullAddress: SINGLE_ADDR })
        .select({ _id: 1, prop_id: 1, fullAddress: 1 }).lean();
      return [byAddr || { _id: null, prop_id: null, fullAddress: SINGLE_ADDR }];
    }
  }

  // Normal batch path
  return Property.find({ bofa_value: { $in: [null, 0] } })
    .select({ _id: 1, prop_id: 1, fullAddress: 1 })
    .limit(limit)
    .lean();
}

// Very light address normalizer: collapses whitespace/case and expands common suffixes
function normalizeAddress(s) {
  if (!s) return '';
  const x = String(s).trim().replace(/\s+/g, ' ').toUpperCase();
  // Expand a few common USPS suffixes to reduce dupes
  const suffixes = [
    [/(\b)ST(\b)\.?/g, '$1STREET$2'],
    [/(\b)AVE(\b)\.?/g, '$1AVENUE$2'],
    [/(\b)RD(\b)\.?/g, '$1ROAD$2'],
    [/(\b)BLVD(\b)\.?/g, '$1BOULEVARD$2'],
    [/(\b)DR(\b)\.?/g, '$1DRIVE$2'],
    [/(\b)LN(\b)\.?/g, '$1LANE$2'],
    [/(\b)CT(\b)\.?/g, '$1COURT$2'],
  ];
  return suffixes.reduce((acc, [re, rep]) => acc.replace(re, rep), x);
}

async function worker(chunk) {
  // Acquire browser+page behind a healthy proxy (rotates away from chrome-error / tunnel failures)
  let browser, page;
  try {
    ({ browser, page } = await openWithHealthyProxy(_nextBofaProxy, { maxTries: Number(process.env.BOFA_PROXY_RETRIES) || 6 }));
    if (VERBOSE) console.log('[BoA] proxy acquired and page opened');
  } catch (e) {
    if (String(e?.message) === 'BROWSER_LAUNCH_ENV') {
      logv('❌  Chrome launch failed: no DISPLAY/too many fds. Forcing headless is required on this host.');
    }
    throw e;
  }

  let pagesLeft = PAGES_PER_PROXY;

  // Silence page console logs and responses except for emoji status outputs
  try {
    page.on('console', msg => {
      // Drop noisy CSP / font / failed-resource messages. Keep nothing here to avoid log spam.
      // We intentionally do not forward page console messages in production.
      return;
    });
    page.on('response', () => {}); // ignore non-critical responses in prod logs
  } catch {}

  try {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});

    // If Chrome landed on an internal error page (very rare after openWithHealthyProxy), rotate proxy once more
    if ((await page.url()).startsWith('chrome-error://')) {
      logv('[BoA] chrome-error after goto — rotating proxy once');
      await browser.close().catch(()=>{});
      const acquired = await openWithHealthyProxy(_nextBofaProxy, { maxTries: 3 });
      // overwrite locals
      browser = acquired.browser;
      page = acquired.page;
      pagesLeft = PAGES_PER_PROXY;
    }

    // Quick debug log of the active element to confirm focus
    try {
      const tag = await page.evaluate(() => {
        const ae = document.activeElement;
        if (!ae) return 'none';
        return ae.id || ae.tagName;
      });
      logv('[BoA] active element after ready →', tag);
    } catch {}
    try { await page.setViewport({ width: 1366, height: 768 }); } catch {}

    const results = [];
    for (const job of chunk) {
      const t0 = Date.now();

      try { console.log(`🔍 Searching: ${job.fullAddress}`); } catch {}

      if (pagesLeft <= 0) {
        await page.close().catch(()=>{});
        page = await newPage(browser);
        // re-apply polyfill on new page instances
        if (typeof page.waitForTimeout !== 'function') {
          page.waitForTimeout = (ms) => new Promise(res => setTimeout(res, Number(ms) || 0));
        }
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
        await ensurePageReady(page);
        pagesLeft = PAGES_PER_PROXY;
      }

      try {
        // Determine current page mode for this iteration
        const mode = await ensurePageReady(page);
        // If the input isn't there quickly, snap back to HOME_URL first.
        const hasInputQuick = await page.$('#address').catch(()=>null);
        if (!hasInputQuick) {
          await hardResetToHome(page);
        }

        let r;
        if (mode === 'results') {
          // Already on a results variant — just scrape it, no typing
          let ctx = await getResultsContext(page, { timeoutMs: Number(process.env.BOFA_RESULT_TIMEOUT_MS) || 40000 });
          if (!ctx) {
            // if no results yet, try a gentle reload back to home then normal path
            await hardResetToHome(page);
            r = await runSearch(page, job.fullAddress);
          } else {
            // scrape with detach retry
            let avgSaleText, estHomeText;
            try {
              ({ avgSaleText, estHomeText } = await scrapeBofaValues(ctx));
            } catch (e) {
              if (/detached Frame/i.test(String(e?.message || e))) {
                ctx = await getResultsContext(page, { timeoutMs: 6000 });
                if (!ctx) throw e;
                ({ avgSaleText, estHomeText } = await scrapeBofaValues(ctx));
              } else { throw e; }
            }
            r = {
              avgSale: parseDollarToNumber(avgSaleText),
              estHome: parseDollarToNumber(estHomeText),
              composite: averageTwo(avgSaleText, estHomeText),
              avgSaleText,
              estHomeText,
            };
          }
        } else {
          // normal path: type address and submit
          r = await runSearch(page, job.fullAddress);
        }
        const timings = r?.timings || {};
        if (r.composite != null) {
          console.log(`[bofa:save] ${job.fullAddress} → composite=${r.composite}`);
          const saved = await saveToDoc(job._id, r.composite, {
  avgSaleText: r.avgSaleText,
  estHomeText: r.estHomeText,
  fullAddress: job.fullAddress
});
          const label = saved ? 'saved' : 'save_failed';
          console.log(`[⏱] ${job.fullAddress} → total=${timings.totalMs ?? 'n/a'}ms, results=${timings.resultsMs ?? 'n/a'}ms, ${timings.retried ? 'retried' : 'single'}`);
          // histogram + LRU on success
          try { histRecord({ timings, success: !!saved }); } catch {}
          try { if (LRU_ENABLED && SeenLRU) SeenLRU.set(normalizeAddress(job.fullAddress)); } catch {}
          if (saved) {
            console.log(`✅  ${job.fullAddress} → ${r.composite} (${label})`);
            results.push(saved);
          } else {
            console.log(`❌  ${job.fullAddress} → ${r.composite} (${label})`);
          }
        } else {
          console.log(`[⏱] ${job.fullAddress} → total=${timings.totalMs ?? 'n/a'}ms (no result)`);
          // histogram + optional LRU on failure
          try { histRecord({ timings, success: false }); } catch {}
          try { if (LRU_ENABLED && LRU_ON_FAIL && SeenLRU) SeenLRU.set(normalizeAddress(job.fullAddress)); } catch {}
          console.log(`❌  ${job.fullAddress} → not found`);
          await maybeScreenshot(page, 'MISS');
        }
      } catch (e) {
        console.warn(`⚠️  ${job.fullAddress} → error: ${shortErr(e)}`);
        await maybeScreenshot(page, 'JOB_ERROR');
        try {
          const timings = { totalMs: Date.now() - t0, typedMs: null, resultsMs: null, retried: false };
          histRecord({ timings, success: false });
          if (LRU_ENABLED && LRU_ON_FAIL && SeenLRU) SeenLRU.set(normalizeAddress(job.fullAddress));
        } catch {}
        if (String(e?.message || e).includes('RESULTS_NOT_FOUND')) {
          await maybeScreenshot(page, 'RESULTS_NOT_FOUND');
          try { await hardResetToHome(page); } catch {}
        }
        try { await debugDump(page, 'job-fail'); } catch {}
        // One more recovery: if we failed and the input is still missing, open a brand new tab and carry on.
        try {
          const hasInputNow = await page.$('#address').catch(()=>null);
          if (!hasInputNow) {
            await page.close().catch(()=>{});
            page = await newTabReset(browser);
          }
        } catch {}
      }

      pagesLeft -= 1;
      // small randomized cooldown to reduce detection
      const base = Number(BOFA_EGRESS_COOLDOWN_MS) || 1200;
      const jitter = 200 + Math.floor(Math.random()*300);
      const waitMs = base + jitter;
      if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(waitMs);
      } else {
        await sleep(waitMs);
      }
    }
    return results;
  } finally {
    await browser.close().catch(()=>{});
  }
}

async function runOnce() {
  const batch = await fetchBatch(SINGLE_MODE ? 1 : (Number(BOFA_BATCH_SIZE) || 800));
  if (!batch || !batch.length) {
    console.log('[BoA] nothing to do');
    return 0;
  }

  // In single mode, run exactly one job, once, no chunking, no fanout
  if (SINGLE_MODE) {
    const job = batch[0];
    console.log(`[BoA] single mode → ${job.fullAddress}`);
    const results = await worker([job]); // worker already handles navigation, scrape, save logs
    console.log(`🏁 Single done. Updated ${results.length} properties.`);
    return results.length;
  }

  // Normal path: de-dup + (optional) LRU + chunk
  const seen = new Set();
  const deduped = [];
  for (const row of batch) {
    const key = normalizeAddress(row.fullAddress);
    if (!key) continue;
    if (LRU_ENABLED && SeenLRU && SeenLRU.has(key)) {
      if (VERBOSE) console.log(`[skip:LRU] ${row.fullAddress}`);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }
  console.log(`[BoA] batch=${batch.length} → unique=${deduped.length}${LRU_ENABLED ? ` (lru=${SeenLRU.size()})` : ''}`);

  const chunks = [];
  for (let i = 0; i < deduped.length; i += 25) chunks.push(deduped.slice(i, i + 25));

  const limit = pLimit(Number(BOFA_MAX_CONCURRENCY) || 8);
  const tasks = chunks.map(c => limit(() => worker(c)));
  const all = (await Promise.all(tasks)).flat().filter(Boolean);

  console.log(`🏁 Done. Updated ${all.length} properties.`);
  return all.length;
}

if (global.__BOFA_JOB_RUNNING__) {
  console.log('[BoA] job already running in this process — skipping duplicate start');
} else {
  global.__BOFA_JOB_RUNNING__ = true;
}

export default async function runBofaJob() {
  await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 12000 });
  console.log('[Mongo] connected');

const continuous = !SINGLE_MODE && (String(process.env.BOFA_CONTINUOUS || '0') === '1');
if (!continuous) {
    await runOnce();
    global.__BOFA_JOB_RUNNING__ = false;
    return;
  }

  const idleMs = Number(process.env.BOFA_IDLE_MS || 30000);
  console.log(`[BoA] continuous mode on (idle ${idleMs}ms when empty)`);
  while (true) {
    const updated = await runOnce();
    if (updated === 0) {
      await new Promise(r => setTimeout(r, idleMs));
    }
  }
}

// allow direct execution (optional)
if (import.meta.url === `file://${process.argv[1]}`) {
  runBofaJob().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}