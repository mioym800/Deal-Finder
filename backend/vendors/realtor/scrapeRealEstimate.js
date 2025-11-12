// ESM – robust MyHome RealEstimate scraper (iframe + shadow DOM aware) with debug artifacts

const DOLLAR_RE = /^\$\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?$/;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const sleep = async (page, ms) => (typeof page?.waitForTimeout === 'function') ? page.waitForTimeout(ms) : wait(ms);

async function withRetries(fn, { tries = 3, delay = 1000 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try { return await fn(i); }
    catch (e) { err = e; if (i < tries - 1) await wait(delay * (i + 1)); }
  }
  throw err;
}

async function maybeHandleConsent(page) {
  try {
    const onetrust = await page.$?.('#onetrust-accept-btn-handler');
    if (onetrust) await onetrust.click();
  } catch {}
  try {
    const frames = page.frames?.() || [];
    const consentFrame = frames.find(f =>
      /sp_message_iframe|consent|privacy/i.test(f.name?.() || '') ||
      /sourcepoint|consent/i.test(f.url?.() || '')
    );
    if (consentFrame) {
      const btn = await consentFrame.$('button[title*="Accept" i], button[aria-label*="Accept" i], button[id*="accept" i]');
      if (btn) await btn.click();
    }
  } catch {}
}

async function saveDebug(page, tag) {
  try {
    const fs = (await import('node:fs/promises')).default;
    const url = await page.url?.();
    const title = await page.title?.().catch(() => '');
    const html = await page.content?.().catch(() => '');
    await fs.writeFile(`/tmp/realtor_${tag}.url.txt`, `${url}\n${title}\n`);
    if (html) await fs.writeFile(`/tmp/realtor_${tag}.html`, html);
    await page.screenshot?.({ path: `/tmp/realtor_${tag}.png`, fullPage: true }).catch(() => {});
  } catch {}
}

// ---------- Search box discovery (main doc, iframes, shadow DOM) ----------
const QUICK_SELECTORS = [
  '#search-bar',
  'input[data-testid="input-element"]',
  'input[data-name="input-element"]',
  'input[placeholder="Enter your home address"]',
  'input[role="combobox"][aria-label*="Search properties" i]',
];

async function findAddressInputHandleInContext(frame) {
  return await frame.evaluateHandle(() => {
    const matches = [
      el => el.tagName === 'INPUT' && el.id === 'search-bar',
      el => el.tagName === 'INPUT' && /Enter your home address/i.test(el.placeholder || ''),
      el => el.tagName === 'INPUT' && (el.getAttribute('data-testid') || '').toLowerCase() === 'input-element',
      el => el.tagName === 'INPUT' && (el.getAttribute('data-name')   || '').toLowerCase() === 'input-element',
      el => el.tagName === 'INPUT' && (el.getAttribute('role') || '').toLowerCase() === 'combobox' &&
             /search|address/i.test(el.getAttribute('aria-label') || ''),
    ];

    function* deepNodes(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const el = walker.currentNode;
        yield el;
        if (el.shadowRoot) yield* deepNodes(el.shadowRoot);
      }
      for (const n of root.querySelectorAll('*')) {
        if (n.shadowRoot) yield* deepNodes(n.shadowRoot);
      }
    }

    for (const el of deepNodes(document)) {
      try { for (const m of matches) if (m(el)) return el; } catch {}
    }
    return null;
  });
}

async function waitForSearchBox(page) {
  // 1) Quick: main frame basic selectors
  for (const sel of QUICK_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 12000 });
      return { frame: page, selector: sel };
    } catch {}
  }

  // 2) Main frame shadow DOM
  const mainHandle = await findAddressInputHandleInContext(page);
  if (mainHandle && mainHandle.asElement()) {
    return { frame: page, handle: mainHandle.asElement() };
  }

  // 3) Child frames
  const frames = page.frames?.() || [];
  for (const f of frames) {
    if (f === page.mainFrame?.()) continue;

    for (const sel of QUICK_SELECTORS) {
      try {
        await f.waitForSelector(sel, { timeout: 8000 });
        return { frame: f, selector: sel };
      } catch {}
    }
    const h = await findAddressInputHandleInContext(f);
    if (h && h.asElement()) return { frame: f, handle: h.asElement() };
  }

  // 4) Debug + error
  await saveDebug(page, 'no_searchbar');
  const bodyText = (await page.evaluate?.(() => document.body?.innerText || '')).toLowerCase?.() || '';
  if (bodyText.includes('access denied') || bodyText.includes('request blocked') || bodyText.includes('forbidden')) {
    throw new Error('AccessDenied/Blocked');
  }
  throw new Error('SearchBarNotFound');
}

// ---------- Suggestions / selection ----------
async function selectFirstSuggestion(page) {
  // Try listbox route in main doc
  await page.waitForFunction?.(() => {
    const lb = document.getElementById('search-bar-listbox');
    return !!lb && lb.querySelectorAll('[role="option"]').length > 0;
  }, { timeout: 15000 }).catch(() => {});
  const clicked = await page.evaluate?.(() => {
    const lb = document.getElementById('search-bar-listbox');
    const first = lb?.querySelector('[role="option"]');
    if (first) { first.click(); return true; }
    return false;
  }).catch(() => false);

  // Fallback: Enter twice (often picks first suggestion)
  if (!clicked) {
    try { await page.keyboard?.press('Enter'); } catch {}
    await sleep(page, 400);
    try { await page.keyboard?.press('Enter'); } catch {}
  }
}

// ---------- Estimate extraction ----------
async function findEstimate(page) {
  const viaAnchor = await page.evaluate?.((reStr) => {
    const DOLLAR_RE = new RegExp(reStr.slice(1, -1));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    const anchors = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.textContent && /RealEstimate/i.test(el.textContent)) anchors.push(el);
    }
    for (const a of anchors) {
      let scope = a;
      for (let i = 0; i < 4 && scope; i++) {
        const spans = scope.querySelectorAll?.('span, div') ?? [];
        for (const s of spans) {
          const t = (s.textContent || '').trim();
          if (DOLLAR_RE.test(t)) return t;
        }
        scope = scope.parentElement;
      }
    }
    return null;
  }, DOLLAR_RE.toString());
  if (viaAnchor) return viaAnchor;

  // Keep brittle CSS as a last-ditch fallback (site-specific)
  const css = '#__next div.Cardstyles__StyledCard-rui__sc-42t194-0 div h2 div span';
  try {
    const val = await page.$$eval?.(css, nodes =>
      nodes.map(n => (n.textContent || '').trim()).find(t => /^\$\s*\d/.test(t))
    );
    if (val) return val;
  } catch {}

  // Heuristic near hero summary block
  const nearSummary = await page.evaluate?.((reStr) => {
    const DOLLAR_RE = new RegExp(reStr.slice(1, -1));
    const spans = Array.from(document.querySelectorAll('span'));
    const important = spans.filter(s => {
      const txt = (s.closest('[class*="Boxstyles"]')?.textContent || '').toLowerCase();
      return txt.includes('bed') && txt.includes('bath') && txt.includes('sqft');
    });
    const pool = important.length ? important : spans;
    for (const s of pool) {
      const t = (s.textContent || '').trim();
      if (DOLLAR_RE.test(t)) return t;
    }
    return null;
  }, DOLLAR_RE.toString());
  if (nearSummary) return nearSummary;

  throw new Error('EstimateNotFound');
}

// ---------- Main entry ----------
export async function scrapeRealEstimate(page, fullAddress) {
  const BASE_URL = 'https://www.realtor.com/myhome/';

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await maybeHandleConsent(page);

  // Nudge rendering
  await page.evaluate?.(() => window.scrollBy(0, 1)).catch(() => {});
  await sleep(page, 700);

  // Find input (supports iframe + shadow DOM), then type
  const { frame, selector, handle } = await waitForSearchBox(page);
  const target = frame || page;

  if (selector) {
    await target.click?.(selector, { clickCount: 3 }).catch(() => target.focus?.(selector));
    await target.type?.(selector, fullAddress, { delay: 35 });
  } else if (handle) {
    try { await handle.click({ clickCount: 3 }); } catch {}
    try { await handle.type(fullAddress, { delay: 35 }); } catch {
      await target.evaluate(el => el.focus(), handle).catch(() => {});
      await target.keyboard?.type(fullAddress, { delay: 35 }).catch(() => {});
    }
  } else {
    throw new Error('SearchBarNotFound');
  }

  await selectFirstSuggestion(page);

  await Promise.race([
    page.waitForNavigation?.({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
    sleep(page, 3500),
  ]);

  const estimate = await withRetries(() => findEstimate(page), { tries: 3, delay: 1200 });
  return estimate;
}