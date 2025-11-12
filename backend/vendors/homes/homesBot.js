import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import fs from 'node:fs';
import path from 'path';

import connectDB from '../../db/db.js';
import { updateProperty } from '../../controllers/propertyController.js';
import {
  randomMouseMovements,
  getRandomUserAgent,
  randomWait,
  getLowerValue,
  formatCurrency,
} from '../../helpers.js';
import {
  warmProxyCache,
  isNetworkOrProxyError,
  getPreferredChromeProxy,
  markDeadProxy,
  jobQueue,
  precheckPaidProxyForUrl,
} from '../../services/proxyManager.js';
import { logHomes } from '../../utils/logger.js';

const stealthPlugin = StealthPlugin();
// Remove iframe override to preserve native window handles Homes.com inspects.
stealthPlugin.enabledEvasions.delete('iframe.contentWindow');
puppeteer.use(stealthPlugin);
puppeteer.use(
  AdblockerPlugin({ blockTrackers: true, useSafeBlocklists: true })
);


const DEBUG_HOMES = process.env.DEBUG_HOMES === '1';
// --- In-process concurrency limiter for Homes.com (controls Puppeteer launches only) ---
const HOMES_INPROC_CONCURRENCY = Number(process.env.HOMES_INPROC_CONCURRENCY || 6); // tune per box
const __homesLaunchLimiter = { max: Math.max(0, HOMES_INPROC_CONCURRENCY | 0), active: 0, queue: [] };

function releaseHomesLaunchSlot(token) {
  try {
    if (__homesLaunchLimiter.active > 0) __homesLaunchLimiter.active--;
    const next = __homesLaunchLimiter.queue.shift();
    if (next) next();
  } catch {}
}

async function acquireHomesLaunchSlot(timeoutMs = 120000) {
  if (!__homesLaunchLimiter.max || __homesLaunchLimiter.max <= 0) return true; // disabled
  if (__homesLaunchLimiter.active < __homesLaunchLimiter.max) {
    __homesLaunchLimiter.active++;
    return true;
  }
  return await new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (__homesLaunchLimiter.active < __homesLaunchLimiter.max) {
        clearInterval(timer);
        __homesLaunchLimiter.active++;
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('homes.inproc_queue_timeout'));
      }
    }, 25);
    __homesLaunchLimiter.queue.push(() => {
      clearInterval(timer);
      __homesLaunchLimiter.active++;
      resolve(true);
    });
  });
}

function looksBlocked(html = '') {
  const s = String(html);
  return /\b(captcha|verify you are human|unusual traffic|access denied|request unsuccessful|checking your browser|blocked|forbidden)\b/i.test(s);
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Boise',
];

const LANGUAGE_PROFILES = [
  { languages: ['en-US', 'en'], header: 'en-US,en;q=0.92' },
  { languages: ['en-GB', 'en-US', 'en'], header: 'en-GB,en-US;q=0.9,en;q=0.8' },
  { languages: ['es-US', 'en-US', 'en'], header: 'es-US,en-US;q=0.9,en;q=0.7' },
];

const PLATFORMS = ['Win32', 'MacIntel', 'Linux x86_64'];
const HARDWARE_THREADS = [4, 6, 8, 10, 12];
const COLOR_DEPTHS = [24, 30];
const DEVICE_SCALE_FACTORS = [1, 1.25, 1.5, 2];

const BLOCKED_RESOURCE_PATTERNS = [
  'doubleclick.net',
  'googletagmanager.com',
  'google-analytics.com',
  'px.ads.linkedin.com',
  'bat.bing.com',
  'facebook.net',
];

function pickRandom(list) {
  return list[rand(0, list.length - 1)];
}

async function humanizePage(page) {
  const languageProfile = pickRandom(LANGUAGE_PROFILES);
  const timezone = pickRandom(TIMEZONES);
  const platform = pickRandom(PLATFORMS);
  const hardwareConcurrency = pickRandom(HARDWARE_THREADS);
  const colorDepth = pickRandom(COLOR_DEPTHS);
  const touchPoints = Math.random() > 0.85 ? rand(1, 2) : 0;
  const viewport = {
    width: rand(1280, 1680),
    height: rand(780, 1080),
    deviceScaleFactor: pickRandom(DEVICE_SCALE_FACTORS),
    hasTouch: touchPoints > 0,
    isLandscape: false,
  };

  await page.setUserAgent(getRandomUserAgent());
  await page.setViewport(viewport);
  await page.setExtraHTTPHeaders({ 'accept-language': languageProfile.header });
  try { await page.emulateTimezone(timezone); } catch {}

  await page.evaluateOnNewDocument(
    ({ languages, platformOverride, hwConcurrency, depth, touchCt }) => {
      Object.defineProperty(navigator, 'languages', { get: () => languages });
      Object.defineProperty(navigator, 'platform', { get: () => platformOverride });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => hwConcurrency });
      try { Object.defineProperty(screen, 'colorDepth', { get: () => depth }); } catch {}
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => touchCt });
    },
    {
      languages: languageProfile.languages,
      platformOverride: platform,
      hwConcurrency: hardwareConcurrency,
      depth: colorDepth,
      touchCt: touchPoints,
    }
  );
}

async function snapshot(page, tag) {
  try {
    if (!DEBUG_HOMES || !page) return;
    const safe = String(tag || 'step').replace(/[^a-z0-9_-]/gi, '_');
    fs.mkdirSync('./tmp/screenshots', { recursive: true });
    await page.screenshot({ path: `./tmp/screenshots/homes_${safe}.png`, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(`./tmp/screenshots/homes_${safe}.html`, html);
  } catch {
    // ignore
  }
}

/**
 * Scrape Homes.com for a single property:
 *  - searches by address,
 *  - extracts agent name/phone/email,
 *  - submits the lead form,
 *  - updates the property in DB.
 *
 * Robust against network/proxy failures with rotation & backoff.
 */
export async function searchPropertyByAddress(property, maxRetries = 3) {
  await connectDB().catch(() => {});
  await warmProxyCache().catch(() => {});

  const L = logHomes.with({ address: property?.fullAddress || '(unknown)' });
  if (!property?.fullAddress) {
    L.warn('Missing fullAddress — skipping');
    return null;
  }

  // const offerPrice = getLowerValue(property);
  const offerAddress = property.fullAddress;
  // const { userName, userEmail, userPhone } = user || {};

  let attempt = 0;

  while (attempt < maxRetries) {
    let browser;
    let page;
    let profileDir;
    let proxyInfo = { arg: null, close: async () => {}, type: 'none' };

    async function safeCleanup() {
      try { if (browser) await browser.close(); } catch {}
      try { if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
      try { await proxyInfo.close(); } catch {}
      try { releaseHomesLaunchSlot(true); } catch {}
    }

    try {
      // ---- Domain-specific paid proxy precheck for homes.com
      const preferPaidEnv = String(process.env.HOMES_USE_PAID ?? 'true').toLowerCase() !== 'false';
      let preferPaid = preferPaidEnv;
      try {
        const ok = await precheckPaidProxyForUrl('https://www.homes.com/', { timeout: 4000 });
        if (!ok) {
          preferPaid = false; // fall back when precheck fails
          L.warn('Paid proxy precheck failed for homes.com — falling back to free/direct for this attempt');
        }
      } catch {}

      // ---- Acquire in-process launch slot before launching a browser
      let __launchSlot = null;
      try {
        __launchSlot = await acquireHomesLaunchSlot(Number(process.env.HOMES_LAUNCH_QUEUE_TIMEOUT_MS || 180000));
      } catch (e) {
        L.error('Launch queue timeout for Homes', { error: e.message });
        throw e;
      }

      // ---- Prefer paid proxy (Decodo), fall back to validated free
      proxyInfo = await getPreferredChromeProxy({ preferPaid, service: 'homes', timeout: 5000 });
      const launchArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-blink-features=AutomationController',
        '--disable-features=VizDisplayCompositor',
        '--remote-debugging-port=0',
        '--lang=en-US,en;q=0.9',
      ];
      if (proxyInfo.arg) launchArgs.push(proxyInfo.arg);
      L.proxy('Using proxy', { attempt: attempt + 1, proxyType: proxyInfo.type, arg: proxyInfo.arg || 'none' });

      // const profileDir = path.join(
      //   '/app/tmp',
      //   `homes_${Date.now()}_${Math.random().toString(36).slice(2)}`
      // );
      // fs.mkdirSync(profileDir, { recursive: true });
      profileDir = path.join(
        './tmp/homes_user_data',
        `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
      );
      fs.mkdirSync(profileDir, { recursive: true });
      browser = await puppeteer.launch({
        headless: "shell",
        defaultViewport: null,
        userDataDir: profileDir,
        args: launchArgs,
      });

      page = await browser.newPage();
      if (proxyInfo?.credentials) {
        try { await page.authenticate(proxyInfo.credentials); } catch {}
      }
      await humanizePage(page);

      // Block heavy resources (keep images ON for layout)
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const type = req.resourceType();
        const url = req.url();
        if (BLOCKED_RESOURCE_PATTERNS.some((pattern) => url.includes(pattern))) {
          return req.abort();
        }
        if (['media', 'font'].includes(type)) return req.abort();
        return req.continue();
      });

      if (DEBUG_HOMES) {
        page.on('console', (msg) => L.debug(`[PAGE ${msg.type()}] ${msg.text()}`));
        page.on('response', (res) => {
          const s = res.status();
          if (s >= 400) L.http('HTTP error', { status: s, url: res.url() });
        });
      }
      page.setDefaultTimeout(30000);

      // ---- Navigate and search
      const resp = await page.goto('https://www.homes.com/', {
        waitUntil: ['domcontentloaded', 'networkidle2'],
        timeout: 45000,
      });
      const status = resp ? resp.status() : 0;
      if (status === 403 || status === 429 || status === 503 || status === 520 || status === 521 || status === 522 || status === 523 || status === 524) {
        throw new Error(`BLOCKED_STATUS_${status}`);
      }
      // Some CDNs serve a block page with 200; check content heuristics
      const html0 = await page.content().catch(() => '');
      if (looksBlocked(html0)) {
        throw new Error('BLOCKED_PAGE');
      }
      await randomMouseMovements(page);
      await randomWait(300, 850);
      const initialScroll = rand(120, 280);
      await page.evaluate((y) => window.scrollBy(0, y), initialScroll);
      await randomWait(350, 750);
      await page.evaluate(() => window.scrollTo(0, 0));

      await page.waitForSelector('.multiselect-search', { visible: true });
      await page.click('.multiselect-search', { delay: rand(200, 600) });
      await randomWait(200, 800);
      await page.type('.multiselect-search', offerAddress, { delay: rand(80, 160) });
      await snapshot(page, 'typed');

      // Wait for suggestion list; pick the best match (or fallback to first)
      const dropdownSel = '.multiselect-option';
      await page.waitForSelector(dropdownSel, { visible: true, timeout: 8000 }).catch(() => null);

      const clicked = await (async () => {
        const items = await page.$$(dropdownSel);
        if (!items?.length) return false;

        // Choose item that contains our street number & street fragment
        const texts = await Promise.all(items.map((el) => page.evaluate((n) => n.textContent || '', el)));
        const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const target = norm(offerAddress);

        let idx = texts.findIndex((t) => norm(t).includes(target.split(',')[0])); // line1 match
        if (idx < 0) idx = 0;

        await items[idx].click({ delay: rand(60, 150) });
        return true;
      })();

      if (!clicked) {
        await page.keyboard.press('Enter');
      }

      await randomWait(800, 1600);
      await snapshot(page, 'after_pick');

      // ---- Wait for agent panel (or fail & retry)
      await page.waitForSelector('.agent-information-fullname', { visible: true, timeout: 20000 });
      await page.waitForSelector('.agent-phone .ldp-phone-link', { visible: true, timeout: 10000 });

      const agentName = await page.$eval('.agent-information-fullname', (el) => el.textContent.trim());
      const agentPhone = await page.$eval('.agent-phone .ldp-phone-link', (el) => el.textContent.trim());

      // Try to extract brokerage email (best-effort)
      let agentEmail = null;
      try {
        const emailText = await page.$eval('.agent-information-idx-contact', (el) => el.textContent.trim());
        const match = emailText.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
        agentEmail = match ? match[0] : null;
        L.info('Brokerage email', { agentEmail });
      } catch {
        L.warn('Brokerage email not found');
      }

      L.info('Agent name', { agentName });
      L.info('Agent phone', { agentPhone });
      await randomMouseMovements(page);

      try {
        await updateProperty(property._id, {
          agent: agentName,
          agent_phone: agentPhone,
          agent_email: agentEmail,
        });
        L.success('Property updated with agent & email_sent');
      } catch (error) {
        L.error('Error updating property', { error: error.message });
      }

      await safeCleanup();
      return {
        agentName,
        agentPhone,
        agentEmail,
      };
    } catch (error) {
      try { await snapshot(page, 'caught_error'); } catch {}
      await safeCleanup();

      L.warn('Attempt failed', { attempt: attempt + 1, error: error.message });

      // Rotate proxy on network/tunnel errors or block signals without burning an attempt
      if (isNetworkOrProxyError(error) || /^BLOCKED_/.test(String(error?.message || ''))) {
        L.retry('Proxy/network failure — rotating and retrying (attempt unchanged)', { proxyType: proxyInfo?.type || 'none' });
        // If we used a free proxy, extract and blacklist it
        if (proxyInfo?.type === 'free' && proxyInfo?.arg) {
          const m = String(proxyInfo.arg).match(/^--proxy-server=http:\/\/(.+)$/i);
          if (m && m[1]) {
            try { markDeadProxy(m[1]); } catch {}
          }
        }
        await randomWait(1200, 2500);
        continue; // same attempt number
      }

      // Otherwise, backoff & increment
      attempt++;
      if (attempt >= maxRetries) {
        L.error('All attempts failed');
        return null;
      }
      const waitMs = Math.floor(2000 * Math.pow(2, attempt) + Math.random() * 1000);
      L.retry('Retrying', { attempt: attempt + 1, waitSeconds: waitMs / 1000 });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  return null;
}

/**
 * Queue helper: process a list of properties with the shared jobQueue.
 * Each job calls searchPropertyByAddress (which already rotates proxies and retries).
 */
export async function runHomesQueue(properties = []) {
  const jobs = properties.map((property) =>
    jobQueue.add(async () => {
      const L = logHomes.with({ address: property?.fullAddress || '(unknown)' });
      try {
        L.start('HomesBot job start');
        const res = await searchPropertyByAddress(property);
        if (res) {
          L.success('HomesBot job done', { hasEmail: !!res.agentEmail });
        } else {
          L.warn('HomesBot job returned null');
        }
      } catch (e) {
        L.error('HomesBot job error', { error: e.message });
      }
    })
  );

  await Promise.allSettled(jobs);
  logHomes.success('HomesBot queue complete', { count: jobs.length });
}

export default searchPropertyByAddress;
