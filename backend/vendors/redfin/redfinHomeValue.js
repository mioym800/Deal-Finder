// backend/vendors/redfin/redfinHomeValue.js
// Single-threaded Redfin Home-Value scraper -> saves { redfin_avm_value } to MongoDB
// Resilient to A/B variants & proxy tunnel failures. Auto-fallback to direct if proxy breaks.

import 'dotenv/config';
import puppeteer from 'puppeteer';
import { MongoClient, ObjectId } from 'mongodb';
import url from 'url';
import fs from 'fs';
import path from 'path';


console.log(`[redfinHomeValue] boot… mode=${process.env.REDFIN_PROXY_MODE||'direct'} budget=${process.env.REDFIN_TOTAL_BUDGET_MS||'4000'}ms`);
if (!process.env.MONGO_URI) {
  console.error('MONGO_URI is required'); 
  process.exit(1);
}
// --- Address normalization (to avoid re-searching the same address) ---
const ABBREV = [
  [/(\bstreet\b)/gi, 'st'],
  [/(\bavenue\b)/gi, 'ave'],
  [/(\broad\b)/gi, 'rd'],
  [/(\bdrive\b)/gi, 'dr'],
  [/(\bboulevard\b)/gi, 'blvd'],
  [/(\bplace\b)/gi, 'pl'],
  [/(\bcourt\b)/gi, 'ct'],
  [/(\btrail\b)/gi, 'trl'],
  [/(\bterrace\b)/gi, 'ter'],
  [/(\blane\b)/gi, 'ln'],
  [/(\bhighway\b)/gi, 'hwy'],
  [/(\bnorth\b)/gi, 'n'],
  [/(\bsouth\b)/gi, 's'],
  [/(\beast\b)/gi, 'e'],
  [/(\bwest\b)/gi, 'w']
];
function normalizeAddressText(txt = '') {
  let s = String(txt).toLowerCase();
  s = s.replace(/[#.,]/g, ' ');
  for (const [re, rep] of ABBREV) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const {
  // DB
  MONGO_URI,
  REDFIN_VALUE_COLLECTION = 'properties',
  LIMIT = '50',
  START_SKIP = '0',

  // Puppeteer / Chrome
  PUPPETEER_EXECUTABLE_PATH,
  PUPPETEER_ARGS,
  PUPPETEER_EXTRA_ARGS,
  PPTR_HEADLESS,
  REDFIN_HEADLESS,
  HEADLESS_MODE,
  PUPPETEER_PROTOCOL_TIMEOUT_MS = '180000',
  USER_DATA_DIR, // optional persistent profile dir

  // Proxy
  DECODO_PROXY_URL, // e.g. http://user:pass@gate.decodo.com:10011
  REDFIN_PROXY_MODE = 'direct', // decodo | direct | auto  (defaulting to direct for speed/stability)
  REDFIN_PROXY_BYPASS_LIST = '*.redfin.com,redfin.com',

  // Debug
  REDFIN_DEBUG_DIR = '/tmp/redfin_value_debug',
  REDFIN_SCREEN_ON_ERROR = '1',
} = process.env;

const SEARCH_URL = 'https://www.redfin.com/what-is-my-home-worth';

const SELECTORS = {
  // Put the most stable patterns first
  searchBoxList: [
    'input[placeholder*="enter your address" i]',
    'input[aria-label*="enter your address" i]',
    'input.search-input-box',
    'input[name="searchInputBox"]',
    'input[data-rf-test-name="search-box-input"]',
    '#search-box-input',
    'input#search-box-input',
  ],
  avmPrice: '[data-rf-test-name="avmValue"]',
};
const REDFIN_TOTAL_BUDGET_MS = Number(process.env.REDFIN_TOTAL_BUDGET_MS || 4000); // 4s hard cap per address
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureDir = (p) => { try { fs.mkdirSync(p, { recursive: true }); } catch {} };
const isTunnelErr = (msg = '') => /ERR_TUNNEL_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES/i.test(String(msg));
const isBlockyTitle = (t = '') => /access denied|verify you are a human|blocked/i.test(String(t));

function parseMoneyToNumber(txt) {
  if (!txt) return null;
  const clean = txt.replace(/[^\d.]/g, '');
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

// Prefer a street (with digits); append city/state/zip.
function buildAddress(doc) {
    // If you already have a printable full address, just use it.
  if (doc.fullAddress && typeof doc.fullAddress === 'string') {
    return doc.fullAddress.trim();
  }
  if (doc.full_address && typeof doc.full_address === 'string') {
    return doc.full_address.trim();
  }
  const streetCandidates = [
    doc.full_address,
    doc.fullAddress,
    doc.listingAddress,
    doc.formatted_address,
    doc.address,
    doc.street,
    doc.street_address,
  ].filter(Boolean).map(String).map((s) => s.trim());

  const hasDigits = (s) => /\d/.test(s);
  const street = streetCandidates.find(hasDigits) || streetCandidates[0] || '';

  const city = (doc.city || doc.locality || '').trim();
  const state = (doc.state || doc.state_code || '').trim();
  const zip = (doc.zip || doc.postal_code || '').trim();

  if (street) {
    const right = [city, state].filter(Boolean).join(', ');
    const tail = zip ? ` ${zip}` : '';
    // NOTE: buildAddress returns a printable address; normalization happens separately via normalizeAddressText()
    return [street, right].filter(Boolean).join(', ') + tail;
  }
  const right = [city, state].filter(Boolean).join(', ');
  if (right || zip) return (right + (zip ? ` ${zip}` : '')).trim() || null;
  // NOTE: buildAddress returns a printable address; normalization happens separately via normalizeAddressText()
  return null;
}

function headlessValue() {
  if (String(REDFIN_HEADLESS || '').length) return /^true|1|new|shell$/i.test(REDFIN_HEADLESS);
  if (String(PPTR_HEADLESS || '').length) return /^true|1|new|shell$/i.test(PPTR_HEADLESS);
  return true;
}

// Proxy helpers: Chrome flag must not include credentials
function parseProxy(u) {
  if (!u) return null;
  const raw = /^https?:\/\//i.test(u) ? u : `http://${u}`;
  const p = new url.URL(raw);
  return {
    hostPort: `${p.hostname}:${p.port || '80'}`,
    username: decodeURIComponent(p.username || ''),
    password: decodeURIComponent(p.password || ''),
  };
}

function buildLaunchArgs({ useProxy }) {
  const args = [];
  if (PUPPETEER_ARGS) args.push(...PUPPETEER_ARGS.split(/\s+/).filter(Boolean));
  if (PUPPETEER_EXTRA_ARGS) args.push(...PUPPETEER_EXTRA_ARGS.split(/\s+/).filter(Boolean));

  // In auto mode, we still attach proxy but bypass redfin hosts to reduce CONNECT failures.
  const proxy = parseProxy(DECODO_PROXY_URL);
  if (useProxy && proxy?.hostPort) {
    args.push(`--proxy-server=${proxy.hostPort}`);
    const bypass = (REDFIN_PROXY_MODE === 'auto') ? (REDFIN_PROXY_BYPASS_LIST || '') : '';
    if (bypass) args.push(`--proxy-bypass-list=${bypass}`);
  }

  args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
  if (!args.includes('--disable-quic')) args.push('--disable-quic');
  if (USER_DATA_DIR) {
    ensureDir(USER_DATA_DIR);
    args.push(`--user-data-dir=${USER_DATA_DIR}`);
  }
  return args;
}

async function openBrowser({ useProxy }) {
  return puppeteer.launch({
    headless: headlessValue() ? (HEADLESS_MODE || 'new') : false,
    executablePath: PUPPETEER_EXECUTABLE_PATH || undefined,
    args: buildLaunchArgs({ useProxy }),
    protocolTimeout: Number(PUPPETEER_PROTOCOL_TIMEOUT_MS) || 180000,
  });
}

async function getDb() {
  if (!MONGO_URI) throw new Error('MONGO_URI is not set');
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const dbName = (MONGO_URI.match(/^[^?]*\/([^/?]+)(?=\?|$)/)?.[1]) || 'yourdb';
  return { client, db: client.db(dbName) };
}

async function dismissRoadblocks(page) {
  // Buttons like accept/agree/continue
  await page.evaluate(() => {
    const text = (n) => (n.textContent || '').trim().toLowerCase();
    const visible = (el) => {
      const s = el && window.getComputedStyle(el);
      return !!(el && s && s.visibility !== 'hidden' && s.display !== 'none');
    };
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const candidates = ['accept', 'agree', 'got it', 'continue', 'yes', 'allow'];
    for (const b of btns) {
      const t = text(b);
      if (visible(b) && candidates.some((w) => t.includes(w))) {
        try { b.click(); } catch {}
      }
    }
  });

  // Close banners/dialogs
  await page.evaluate(() => {
    const visible = (el) => {
      const s = el && window.getComputedStyle(el);
      return !!(el && s && s.visibility !== 'hidden' && s.display !== 'none');
    };
    const closers = Array.from(document.querySelectorAll('[aria-label*="close" i], .close, .close-button, .icon-close, [data-test*="close" i]'));
    for (const c of closers) {
      if (visible(c)) { try { c.click(); } catch {} }
    }
  });
}

async function getSearchContext(page, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await dismissRoadblocks(page);

    const title = await page.title().catch(() => '');
    if (isBlockyTitle(title)) throw new Error(`Blocked/Anti-bot page: "${title}"`);

    // 1) Main frame – plain selectors first
    for (const sel of SELECTORS.searchBoxList) {
      const ok = await page.$(sel);
      if (ok) return { frame: page.mainFrame(), selector: sel };
    }

    // 1b) Main frame – shadow DOM deep search
    const shadowHandle = await page.mainFrame().evaluateHandle(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none';
      };
      const matches = (el) => {
        if (!(el instanceof HTMLInputElement)) return false;
        const id = (el.id || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const cls = (el.className || '').toLowerCase();
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const ti = (el.getAttribute('title') || '').toLowerCase();
        const signals = [
          id.includes('search-box-input'),
          name.includes('searchinputbox'),
          cls.includes('search-input-box'),
          ph.includes('enter your address'),
          ti.includes('enter your address'),
        ];
        return signals.some(Boolean) && isVisible(el);
      };

      // BFS across document + nested shadow roots
      const q = [document];
      while (q.length) {
        const node = q.shift();
        const roots = [];
        if (node instanceof Document || node instanceof ShadowRoot || node instanceof DocumentFragment) {
          roots.push(node);
        } else if (node instanceof Element) {
          if (matches(node)) return node;
          if (node.shadowRoot) roots.push(node.shadowRoot);
        }
        for (const root of roots) {
          const all = root.querySelectorAll('*');
          for (const el of all) {
            if (matches(el)) return el;
            if (el.shadowRoot) q.push(el.shadowRoot);
          }
        }
      }
      return null;
    });
    const shadowElem = shadowHandle.asElement?.();
    if (shadowElem) return { frame: page.mainFrame(), selector: 'JS-HANDLE-SHADOW' };
    try { await shadowHandle.dispose(); } catch {}

    // 2) Iframes – plain selectors
    const frames = page.frames();
    try { console.log('   ↳ frames detected:', frames.length); } catch {}
    for (const fr of frames) {
      for (const sel of SELECTORS.searchBoxList) {
        const h = await fr.$(sel);
        if (h) return { frame: fr, selector: sel };
      }

      // 2b) Iframes – ad-hoc search (non-shadow)
      const handle = await fr.evaluateHandle(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="search"], input[type="text"]'));
        return inputs.find((el) => {
          const ph = (el.getAttribute('placeholder') || '').toLowerCase();
          const ti = (el.getAttribute('title') || '').toLowerCase();
          return ph.includes('enter your address') || ti.includes('enter your address');
        }) || null;
      });
      const asElem = handle.asElement?.();
      if (asElem) return { frame: fr, selector: 'JS-HANDLE' };
      try { await handle.dispose(); } catch {}
    }

    await sleep(500);
  }
  throw new Error('Search box not found (after roadblock dismissal + frame + shadow scan)');
}

// NOTE: page is now the first param (so we can re-find if needed)
async function clearAndType(page, frame, elementOrSelector, text) {
  const isPlainSelector = (s) => typeof s === 'string' && !/^JS-HANDLE/.test(s);

  // helper: focus & clear via selector
  const focusAndClear = async (fr, sel) => {
    await fr.waitForSelector(sel, { visible: true, timeout: 15000 });
    await fr.focus(sel);
    try { await fr.click(sel, { clickCount: 3, delay: 20 }); } catch {}
    await fr.$eval(sel, el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
  };

  let currentFrame = frame;
  let sel = elementOrSelector;

  // If we had a plain selector but it vanished, re-find using getSearchContext
  const ensureUsableSelector = async () => {
    if (isPlainSelector(sel)) {
      try {
        await currentFrame.waitForSelector(sel, { visible: true, timeout: 15000 });
        return;
      } catch {
        const ctx = await getSearchContext(page, 15000);
        currentFrame = ctx.frame;
        sel = ctx.selector;
      }
    }
  };

  if (isPlainSelector(sel)) {
    await ensureUsableSelector();
    await focusAndClear(currentFrame, sel);
    await currentFrame.type(sel, text, { delay: 18 + Math.floor(Math.random() * 22) });

    // nudge React-controlled inputs
    try { await currentFrame.type(sel, ' ', { delay: 10 }); await currentFrame.keyboard.press('Backspace'); } catch {}

    let val = await currentFrame.$eval(sel, el => ('value' in el ? el.value : '' )).catch(() => '');
    console.log(`   ↳ typed: "${val}"`);

    if (!val) {
      await currentFrame.$eval(sel, (el, v) => {
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
      }, text);
      val = await currentFrame.$eval(sel, el => ('value' in el ? el.value : '' )).catch(() => '');
      console.log(`   ↳ typed (fallback): "${val}"`);
    }
    return;
  }

  // ---- JS-HANDLE path (shadow/iframe deep find) ----
  const elem = await (async () => {
    const handle = await currentFrame.evaluateHandle((shadowAware) => {
      const isVisible = (el) => el && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
      const matches = (el) => {
        if (!(el instanceof HTMLInputElement)) return false;
        const id = (el.id || '').toLowerCase();
        const name = (el.name || '').toLowerCase();
        const cls = (el.className || '').toLowerCase();
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const ti = (el.getAttribute('title') || '').toLowerCase();
        return [id.includes('search-box-input'), name.includes('searchinputbox'), cls.includes('search-input-box'), ph.includes('enter your address'), ti.includes('enter your address')].some(Boolean) && isVisible(el);
      };
      const find = () => {
        const q = [document];
        while (q.length) {
          const node = q.shift();
          if (node instanceof Document || node instanceof ShadowRoot || node instanceof DocumentFragment) {
            const inputs = node.querySelectorAll('input[type="search"], input[type="text"], input');
            for (const el of inputs) if (matches(el)) return el;
            node.querySelectorAll('*').forEach(el => { if (el.shadowRoot) q.push(el.shadowRoot); });
          }
        }
        return null;
      };
      return find();
    }, elementOrSelector === 'JS-HANDLE-SHADOW');
    const el = handle.asElement?.();
    if (!el) { try { await handle.dispose(); } catch {} throw new Error('Failed to resolve address input handle'); }
    return el;
  })();

  try { await elem.focus(); } catch {}
  try { await elem.click({ clickCount: 3, delay: 20 }); } catch {}
  try { await elem.type(text, { delay: 18 + Math.floor(Math.random() * 22) }); } catch {}

  let val = await currentFrame.evaluate(el => ('value' in el ? el.value : ''), elem).catch(() => '');
  console.log(`   ↳ typed: "${val}"`);
  if (!val) {
    await currentFrame.evaluate((el, v) => {
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    }, elem, text);
    val = await currentFrame.evaluate(el => ('value' in el ? el.value : ''), elem).catch(() => '');
    console.log(`   ↳ typed (fallback): "${val}"`);
  }
}

// Try to find an explicit suggestion URL and hard-navigate to it
async function navigateToBestSuggestion(page, frame, queryText, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  const score = (s) => {
    const a = String(queryText).toLowerCase();
    const b = String(s).toLowerCase();
    let pts = 0;
    for (const token of a.split(/[\s,]+/).filter(Boolean)) {
      if (b.includes(token)) pts += 1;
    }
    return pts;
  };
  while (Date.now() < deadline) {
    const best = await frame.evaluate((q) => {
      const pickFromRoot = (root) => {
        const out = [];
        const optRoots = [];
        // common containers
        root.querySelectorAll('[role="listbox"], ul[role="listbox"], .typeahead, .autocomplete, .search-suggestions').forEach((el) => optRoots.push(el));
        for (const r of optRoots) {
          // both anchors and generic options
          r.querySelectorAll('a, [role="option"], li').forEach((el) => {
            const txt = (el.textContent || '').trim();
            const a = el.tagName === 'A' ? el : el.querySelector('a');
            const href = a ? a.getAttribute('href') : '';
            const vis = (() => {
              const s = getComputedStyle(el);
              return s.display !== 'none' && s.visibility !== 'hidden';
            })();
            if (vis && (txt || href)) out.push({ txt, href });
          });
        }
        return out;
      };
      const walk = () => {
        const qroots = [document];
        const all = [];
        while (qroots.length) {
          const node = qroots.shift();
          if (node instanceof Document || node instanceof ShadowRoot || node instanceof DocumentFragment) {
            all.push(...pickFromRoot(node));
            node.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) qroots.push(el.shadowRoot); });
          }
        }
        return all;
      };
      const items = walk();
      const scored = items
        .map((it, i) => ({ ...it, i }))
        .map((it) => ({ ...it, pts: (() => {
          const a = String(q).toLowerCase();
          const b = String(it.txt || '').toLowerCase();
          let p = 0;
          for (const t of a.split(/[\s,]+/).filter(Boolean)) if (b.includes(t)) p++;
          return p;
        })() }))
        .sort((A, B) => B.pts - A.pts || A.i - B.i);
      const top = scored[0];
      if (!top) return null;
      // Normalize to absolute URL if needed
      let href = top.href || '';
      if (href && /^\/[^/]/.test(href)) {
        try { href = new URL(href, location.origin).toString(); } catch {}
      }
      return { href, txt: top.txt, pts: top.pts };
    }, queryText);
    if (best && best.href) {
      // Hard navigate to the suggestion URL
      try {
        await page.evaluate((u) => { location.assign(u); }, best.href);
        return true;
      } catch {}
    }
    await page.waitForTimeout(200);
  }
  return false;
}

// Helper: wait for and pick a suggestion from autosuggest dropdowns
async function waitAndPickSuggestion(page, frame, queryText, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;

  // heuristics to score suggestions by overlap with our query
  const score = (s) => {
    const a = String(queryText).toLowerCase();
    const b = String(s).toLowerCase();
    let pts = 0;
    for (const token of a.split(/[\s,]+/).filter(Boolean)) {
      if (b.includes(token)) pts += 1;
    }
    return pts;
  };

  // Try a few common containers and ARIA patterns, including inside shadow roots.
  const selectors = [
    '[role="listbox"] [role="option"]',
    'ul[role="listbox"] li',
    '.typeahead [role="listbox"] [role="option"]',
    '.autocomplete [role="option"]',
    '.search-suggestions li, .search-suggestions [role="option"]',
  ];

  while (Date.now() < deadline) {
    // Gather options text across main doc + shadow roots
    const options = await frame.evaluate((sels) => {
      const collectFromRoot = (root) => {
        const out = [];
        for (const sel of sels) {
          root.querySelectorAll(sel).forEach((el) => {
            const txt = (el.textContent || '').trim();
            const visible = (() => {
              const s = getComputedStyle(el);
              return s.display !== 'none' && s.visibility !== 'hidden';
            })();
            if (txt && visible) out.push({ txt, pathSel: sel });
          });
        }
        return out;
      };

      // Walk across shadow roots
      const q = [document];
      const results = [];
      while (q.length) {
        const node = q.shift();
        if (node instanceof Document || node instanceof ShadowRoot || node instanceof DocumentFragment) {
          results.push(...collectFromRoot(node));
          const all = node.querySelectorAll('*');
          for (const el of all) {
            if (el.shadowRoot) q.push(el.shadowRoot);
          }
        }
      }
      return results;
    }, selectors);

    if (options.length) {
      // Pick best match
      const best = options
        .map((o, i) => ({ ...o, i, pts: score(o.txt) }))
        .sort((a, b) => b.pts - a.pts || a.i - b.i)[0];

      // Click it via evaluate to avoid overlay issues
      const clicked = await frame.evaluate(({ sel, text }) => {
        const visible = (el) => {
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        };
        // Search again and click the first element whose text matches our choice
        const all = Array.from(document.querySelectorAll(sel));
        const cand = all.find((el) => {
          const t = (el.textContent || '').trim();
          return visible(el) && t === text;
        }) || all[0];
        if (cand) { cand.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); cand.click(); return true; }
        return false;
      }, { sel: best.pathSel, text: best.txt }).catch(() => false);

      if (clicked) {
        // Give the page a brief moment to route
        await page.waitForTimeout(200);
        return true;
      }
    }

    await page.waitForTimeout(200);
  }

  return false;
}

async function submitAddress(page, frame) {
  const urlBefore = page.url();
  // ensure an input has focus
  try {
    const hasFocus = await frame.evaluate(() => {
      const el = document.activeElement;
      if (el && 'value' in el) return true;
      const cand = document.querySelector('#search-box-input, input[data-rf-test-name="search-box-input"], input[name="searchInputBox"], input.search-input-box, input[placeholder*="enter your address" i]');
      if (cand) { cand.focus(); return true; }
      return false;
    });
    if (!hasFocus) await page.waitForTimeout(50);
  } catch {}

  // grab what we typed
  const queryVal = await frame.evaluate(() => {
    const sel = '#search-box-input, input[data-rf-test-name="search-box-input"], input[name="searchInputBox"], input.search-input-box, input[placeholder*="enter your address" i]';
    const el = document.querySelector(sel);
    return el && 'value' in el ? el.value : '';
  }).catch(() => '');

  // 1) Enter
  try { await page.keyboard.press('Enter'); } catch {}
  await Promise.race([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2500 }).catch(()=>{}), page.waitForTimeout(2500)]);
  if (page.url() !== urlBefore) return;

  // 2) Visible "Next" (top doc)
  await page.evaluate(() => {
    const visible = el => el && getComputedStyle(el).visibility!=='hidden' && getComputedStyle(el).display!=='none';
    const textOf = n => (n.textContent||'').trim().toLowerCase();
    const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
    const nextBtn = btns.find(b => visible(b) && textOf(b)==='next' && !b.disabled);
    if (nextBtn) nextBtn.click();
  });
  await Promise.race([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 2500 }).catch(()=>{}), page.waitForTimeout(2500)]);
  if (page.url() !== urlBefore) return;

  // 3) Pick best suggestion or hard navigate to its href
  const picked = await waitAndPickSuggestion(page, frame, queryVal, 3000);
  if (!picked) {
    const jumped = await navigateToBestSuggestion(page, frame, queryVal, 3000);
    if (jumped) {
      await Promise.race([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 3000 }).catch(()=>{}), page.waitForTimeout(3000)]);
    }
  }

  // Final guard: if we didn't route off the landing page, bail fast
  try {
    const urlAfter = page.url();
    if (urlAfter === urlBefore) {
      const e = new Error('NO_NAVIGATION');
      e.code = 'NO_NAVIGATION';
      throw e;
    }
  } catch (e) {
    // Re-throw so callers can classify and skip
    e.code = e.code || 'NO_NAVIGATION';
    throw e;
  }
}



  // Helper: detect "Sorry, we couldn't find" modal and bail fast
async function detectNotFoundModal(page) {
  const PATTERNS = [
    "Sorry, we couldn’t find",   // curly apostrophe
    "Sorry, we couldn't find",   // straight apostrophe
    "Your search might be outside our service areas"
  ];
  const check = async (fr) => {
    try {
      return await fr.evaluate((patterns) => {
        const t = (document.body?.innerText || "").toLowerCase();
       return patterns.some(p => t.includes(p.toLowerCase()));
      }, PATTERNS);
    } catch { return false; }
  };
  if (await check(page.mainFrame())) return true;
  for (const fr of page.frames()) if (await check(fr)) return true;
  return false;
}

// Helper: detect if the page shows "Estimate Not Available"
async function detectNoEstimate(page) {
  const PATTERNS = [
    'Estimate Not Available',
    "We don’t have enough information",
    "We don't have enough information",
    'Redfin Estimate is not available',
    "Let’s find your home",
    "Let's find your home",
    "get your home estimate"
  ];

  const checkFrame = async (fr) => {
    try {
      return await fr.evaluate((patterns) => {
        const text = (document.body && document.body.innerText) || '';
        const t = text.toLowerCase();
        return patterns.some((p) => t.includes(p.toLowerCase()));
      }, PATTERNS);
    } catch {
      return false;
    }
  };

  if (await checkFrame(page.mainFrame())) return true;
  for (const fr of page.frames()) {
    if (fr !== page.mainFrame() && (await checkFrame(fr))) return true;
  }
  return false;
}

// Helper: detect if the page shows "Sorry, we couldn't find ..." or similar address-not-found modal
async function detectAddressNotFound(page) {
  const PATTERNS = [
    "Sorry, we couldn’t find",   // curly apostrophe
    "Sorry, we couldn't find",   // straight apostrophe
    "might be outside our service areas",
    "We couldn't find",          // alternate casing
    "We could not find",
  ];

  const checkFrame = async (fr) => {
    try {
      return await fr.evaluate((patterns) => {
        const text = (document.body && document.body.innerText) || '';
        const t = text.toLowerCase();
        return patterns.some((p) => t.includes(p.toLowerCase()));
      }, PATTERNS);
    } catch {
      return false;
    }
  };

  if (await checkFrame(page.mainFrame())) return true;
  for (const fr of page.frames()) {
    if (fr !== page.mainFrame() && (await checkFrame(fr))) return true;
  }
  return false;
}

async function waitForValueCard(page, timeoutMs = 90000) {
  const altSelectors = [
    '[data-rf-test-name="avmValue"]',
    '#content .NewAvmLandingPage .home-info .price.font-size-larger',
    '.home-info .price.font-size-larger',
    '.price.font-size-larger[data-rf-test-name]'
  ];

  const start = Date.now();
while (Date.now() - start < timeoutMs) {
    if (await detectNotFoundModal(page)) {
      const e = new Error('NOT_FOUND');
      e.code = 'NOT_FOUND';
      throw e;
    }    // Fast exit when Redfin shows the "Estimate Not Available" panel
    if (await detectNoEstimate(page)) {
      const err = new Error('NO_ESTIMATE');
      err.code = 'NO_ESTIMATE';
      throw err;
    }
    // Fast exit when Redfin shows "Sorry, we couldn't find ..." or similar address-not-found modal
    if (await detectAddressNotFound(page)) {
      const err = new Error('NOT_FOUND');
      err.code = 'NOT_FOUND';
      throw err;
    }
    // common intermediate: route change — wait a bit for network quiet
    try { await page.waitForNetworkIdle({ idleTime: 250, timeout: 1200 }); } catch {}

    // Check any of the known price selectors
    for (const sel of altSelectors) {
      const ok = await page.$eval(sel, (el) => (el && (el.textContent || '').trim()) || null).catch(() => null);
      if (ok) {
        const priceRaw = ok;
        const clean = priceRaw.trim();
        const price = parseMoneyToNumber(clean);
        return { price, priceRaw: clean };
      }
    }

    // Some variants render inside iframes — try to probe frames quickly
    const frames = page.frames();
    for (const fr of frames) {
      for (const sel of altSelectors) {
        const ok = await fr.$eval(sel, (el) => (el && (el.textContent || '').trim()) || null).catch(() => null);
        if (ok) {
          const priceRaw = ok.trim();
          const price = parseMoneyToNumber(priceRaw);
          return { price, priceRaw };
        }
      }
    }

    await page.waitForTimeout(400);
  }
  // Last-chance: if URL looks like an AVM details page, try one more deep scan
  try {
    const href = await page.url();
    if (/what-is-my-home-worth|home\-value|home\-estimate/i.test(href)) {
      const frames = page.frames();
      for (const fr of [page.mainFrame(), ...frames]) {
        for (const sel of altSelectors) {
          const ok = await fr.$eval(sel, (el) => (el && (el.textContent || '').trim()) || null).catch(() => null);
          if (ok) {
            const s = ok.trim();
            const price = (s.match(/\$[\d,\.]+/) || [s])[0];
            return { price: Number((price || '').replace(/[^\d.]/g, '')) || null, priceRaw: s };
          }
        }
      }
    }
  } catch {}
  throw new Error('Value card not found/timed out');
}

async function fetchOneEstimate(page, address) {
  // keep page light (after load we block heavy assets)
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

  await page.setRequestInterception(true);
  page.removeAllListeners('request');
  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'media', 'font'].includes(type)) return req.abort();
    req.continue();
  });

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await dismissRoadblocks(page);

  const { frame, selector } = await getSearchContext(page, 60000);
  await clearAndType(page, frame, selector, address);
  await submitAddress(page, frame);

   const attemptDeadline = Date.now() + REDFIN_TOTAL_BUDGET_MS;

  // brief settle
  try { await page.waitForNetworkIdle({ idleTime: 400, timeout: 2000 }); } catch {}

  // immediate negative states
  if (await detectNotFoundModal(page)) {
    const e = new Error('NOT_FOUND');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (await detectNoEstimate(page)) {
    const e = new Error('NO_ESTIMATE');
    e.code = 'NO_ESTIMATE';
    throw e;
  }

  // Wait for value card but with a hard overall budget
  const budgetLeft = Math.max(1200, attemptDeadline - Date.now());
  return await waitForValueCard(page, budgetLeft);
}

async function runPass({ useProxy }) {
  const browser = await openBrowser({ useProxy });
  const page = await browser.newPage();

  // Polyfill for Puppeteer v22+ where page.waitForTimeout was removed.
  if (typeof page.waitForTimeout !== 'function') {
    page.waitForTimeout = (ms) => new Promise((r) => setTimeout(r, ms));
  }

  // Proxy auth if needed (only when actually using proxy)
  const proxy = parseProxy(DECODO_PROXY_URL);
  if (useProxy && proxy?.username) {
    await page.authenticate({ username: proxy.username, password: proxy.password });
  }

  await page.setViewport({ width: 1360, height: 900 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  return { browser, page };
}

async function main() {
  const { client, db } = await getDb();
  const col = db.collection(REDFIN_VALUE_COLLECTION);

  const limit = Number(LIMIT) || 50;
  const skip = Number(START_SKIP) || 0;

const docs = await col
    .find(
      {
        $and: [
          { $or: [{ redfin_avm_value: { $exists: false } }, { redfin_avm_value: null }] },
          { $or: [{ redfin_avm_skip_reason: { $exists: false } }, { redfin_avm_skip_reason: null }] }
        ]
      },
      {
        projection: {
          _id: 1,
          full_address: 1,
          displayAddress: 1,
          fullAddress: 1,
          address: 1,
          formatted_address: 1,
          listingAddress: 1,
          street: 1,
          street_address: 1,
          city: 1,
          locality: 1,
          state: 1,
          state_code: 1,
          zip: 1,
          postal_code: 1,
        },
      }
    )
    .skip(skip)
    .limit(limit)
    .toArray();

    console.log('[HV] fetched docs:', docs.length);

  // Precompute addresses and group by normalized address to avoid re-searching duplicates in this run
  const withAddrs = docs.map(d => {
    const printable = buildAddress(d);
    const norm = printable ? normalizeAddressText(printable) : null;
    return { doc: d, printable, norm };
  }).filter(x => !!x.norm);

  // Map of norm -> array of document _ids that share the same address
  const groups = new Map();
  for (const { doc, norm } of withAddrs) {
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(doc._id);
  }

  const uniqueItems = Array.from(groups.keys()).map(norm => {
    const firstDoc = withAddrs.find(x => x.norm === norm).doc;
    const printable = withAddrs.find(x => x.norm === norm).printable;
    console.log('[HV] with usable addresses:', withAddrs.length);
    return { norm, printable, ids: groups.get(norm) };
  });

  // In-run caches (avoid re-typing/re-fetching same address)
  const seenNorms = new Set();
  const valueCache = new Map();     // norm -> { price, priceRaw }
  const negativeCache = new Map();  // norm -> reason ('NO_ESTIMATE'|'NOT_FOUND'|'NO_NAVIGATION')

  // Decide proxy usage for first pass
  let preferProxy =
    REDFIN_PROXY_MODE === 'decodo' ? true :
    REDFIN_PROXY_MODE === 'direct' ? false :
    true; // auto => try proxy first, then fallback

  let { browser, page } = await runPass({ useProxy: preferProxy });

  let processed = 0, updated = 0, skipped = 0, failed = 0;

  for (const item of uniqueItems) {
    const { norm, printable: address, ids } = item;

    // Skip if we've already handled this address in this run
    if (seenNorms.has(norm)) {
      console.log(`⤼ Skip (dup in-run) ${address}`);
      continue;
    }
    seenNorms.add(norm);

    if (!address) {
      skipped += ids.length;
      console.log(`⤼ Skip (no usable address fields) for ${ids.length} doc(s)`);
      continue;
    }

    console.log(`→ [${processed + 1}] ${address}`);

    try {
      let result = null, lastErr = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          result = await fetchOneEstimate(page, address);
          break;
        } catch (e) {
          lastErr = e;

          // If tunnel/proxy error on attempt 1 and we're allowed to fallback, relaunch direct
          if (attempt === 1 && (REDFIN_PROXY_MODE === 'auto') && isTunnelErr(e.message)) {
            console.log('   ↳ proxy tunnel failed; relaunching browser WITHOUT proxy...');
            try { await browser.close(); } catch {}
            ({ browser, page } = await runPass({ useProxy: false }));
            continue;
          }

          // If hard block/captcha, bail fast for this norm
          const title = await page.title().catch(() => '');
          if (isBlockyTitle(title) || /captcha/i.test(String(e.message))) break;

          await sleep(300);
        }
      }

      if (!result) throw lastErr || new Error('Unknown error fetching estimate');

      const { price, priceRaw } = result;
      if (price) {
        valueCache.set(norm, { price, priceRaw });

        const res = await col.updateMany(
          { _id: { $in: ids } },
          { $set: {
              redfin_avm_value: price,
              redfin_avm_value_raw: priceRaw,
              redfin_avm_scraped_at: new Date(),
              redfin_norm_address: norm
            } }
        );
        updated += res.modifiedCount || 0;
        console.log(`   ✓ Saved redfin_avm_value=${price} (${priceRaw}) for ${ids.length} doc(s)`);
      } else {
        skipped += ids.length;
        await col.updateMany(
          { _id: { $in: ids } },
          { $set: { redfin_avm_skip_reason: 'NO_PRICE_EXTRACTED', redfin_avm_skipped_at: new Date(), redfin_norm_address: norm } }
        );
        console.log(`   ⚠ No price extracted — marked ${ids.length} doc(s) with redfin_avm_skip_reason=NO_PRICE_EXTRACTED`);
      }
    } catch (err) {
      const isNegative =
        String(err?.code) === 'NO_ESTIMATE' || /NO_ESTIMATE/.test(String(err?.message)) ||
        String(err?.code) === 'NOT_FOUND'  || /NOT_FOUND/.test(String(err?.message))  ||
        String(err?.code) === 'NO_NAVIGATION' || /NO_NAVIGATION/.test(String(err?.message));

      if (isNegative) {
        const reason =
          (String(err?.code) === 'NOT_FOUND'  || /NOT_FOUND/.test(String(err?.message))) ? 'NOT_FOUND' :
          (String(err?.code) === 'NO_NAVIGATION' || /NO_NAVIGATION/.test(String(err?.message))) ? 'NO_NAVIGATION' :
          'NO_ESTIMATE';

        negativeCache.set(norm, reason);
        skipped += ids.length;

        await col.updateMany(
          { _id: { $in: ids } },
          { $set: { redfin_avm_skip_reason: reason, redfin_avm_skipped_at: new Date(), redfin_norm_address: norm } }
        );

        console.log(`   ↳ Redfin skip — ${reason.toLowerCase().replace('_',' ')}. Marked ${ids.length} doc(s).`);
        await sleep(100);
        processed++;
        await sleep(150 + Math.floor(Math.random() * 120));
        continue;
      }

      failed += ids.length;
      console.log(`   ✗ Failed: ${err.message}`);
      try {
        const cur = await page.evaluate(() => ({ href: location.href, title: document.title }));
        console.log(`   ↳ page: ${cur.href} | title: "${cur.title}"`);
      } catch {}

      try {
        const inputDump = await page.evaluate(() => {
          const el = document.activeElement;
          if (el && 'value' in el) return el.value;
          const cand = document.querySelector('#search-box-input, input[data-rf-test-name="search-box-input"], input[name="searchInputBox"], input.search-input-box');
          return cand && 'value' in cand ? cand.value : '';
        });
        console.log(`   ↳ input now: "${inputDump || ''}"`);
      } catch {}

      if (REDFIN_SCREEN_ON_ERROR === '1') {
        try {
          ensureDir(REDFIN_DEBUG_DIR);
          const stamp = Date.now();
          const base = path.join(REDFIN_DEBUG_DIR, `${stamp}-${String(ids[0])}`);
          await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
          const html = await page.content().catch(() => '');
          if (html) fs.writeFileSync(`${base}.html`, html);
          console.log(`   ↳ saved debug to ${base}.{png,html}`);
        } catch {}
      }
      await sleep(400);
    }

    processed++;
    await sleep(220 + Math.floor(Math.random() * 260));
  }

  try { await browser.close(); } catch {}
  await client.close();

  console.log('—'.repeat(60));
  console.log(`Done. processed=${processed} updated=${updated} skipped=${skipped} failed=${failed}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}