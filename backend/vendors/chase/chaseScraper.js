// vendors/chase/chaseScraper.js
import { CHASE_URL } from './chaseSelectors.js';
export class ChaseSearchError extends Error {}

const ESTIMATOR_INPUT_SEL = [
  'input[id*="address" i]',
  'input[name*="address" i]',
  'input[placeholder*="address" i]',
  '#address',
  '#homeValueAddress',
  // CoreLogic patterns we’ve seen
  '#txtAddress',
  'input[id*="txtAddress" i]',
];

function pick(sel) { return Array.isArray(sel) ? sel : [sel]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findVisibleHandle(ctx, selectors, timeoutMs = 6000) {
  const sels = pick(selectors);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of sels) {
      try {
        const h = await ctx.$(sel);
        if (!h) continue;
        const ok = await ctx.evaluate(el => {
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s && s.visibility !== 'hidden' && s.display !== 'none' && r.width > 0 && r.height > 0;
        }, h).catch(() => true);
        if (ok) return h;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

function getCorelogicFrame(page) {
  const frames = page.frames();
  let f = frames.find(fr => /valuemap|corelogic/i.test(fr.url()));
  if (f) return f;
  return frames[frames.length - 1]; // last attached, as fallback
}

function parseDollar(s) {
  if (!s) return null;
  const m = String(s).replace(/[, ]+/g, '').match(/\$?(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Math.round(parseFloat(m[1]));
}

async function waitForEstimate(pageOrFrame, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // Search a few likely containers for a dollar-ish number
      const text = await pageOrFrame.evaluate(() => {
        const roots = document.querySelectorAll(
          [
            '[class*="estimate"]',
            '[id*="estimate"]',
            '[data-testid*="estimate"]',
            '[data-test*="estimate"]',
            '.result, .value, .amount',
          ].join(',')
        );
        const hay = Array.from(roots);
        const patt = /\$?\s*\d{2,3}(?:,\d{3})+(?:\.\d+)?/;
        for (const el of hay) {
          const t = (el.textContent || '').trim();
          if (patt.test(t)) return t;
        }
        // fallback: scan whole body once in a while (cheapish)
        const body = (document.body && document.body.innerText) || '';
        const m = body.match(patt);
        return m ? m[0] : null;
      });
      const num = parseDollar(text);
      if (num) return { estimate: num, estimateText: text };
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new ChaseSearchError('EstimateMissing');
}

async function clickByText(ctx, texts, timeoutMs = 3000) {
  const start = Date.now();
  const needles = texts.map(t => t.toLowerCase());
  while (Date.now() - start < timeoutMs) {
    const clicked = await ctx.evaluate((needles) => {
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const hay = Array.from(document.querySelectorAll('a,button,[role="button"]'));
      for (const el of hay) {
        const t = (el.innerText || el.textContent || '').trim().toLowerCase();
        if (!t) continue;
        for (const n of needles) {
          if (t.includes(n) && isVisible(el)) { el.click(); return true; }
        }
      }
      return false;
    }, needles).catch(() => false);
    if (clicked) return true;
    await sleep(150);
  }
  return false;
}

async function ensureOnEstimator(page) {
  // Some AB variants require a “Get started / Start now” click to mount the CoreLogic iframe.
  // Try a couple of obvious CTAs on the main page first.
  await clickByText(page, ['get started', 'start now', 'start online', 'estimate', 'check now'], 2500).catch(()=>{});
  // Wait briefly for the iframe to attach
  const waitAttachMs = 4000;
  const t0 = Date.now();
  while (Date.now() - t0 < waitAttachMs) {
    const fr = getCorelogicFrame(page);
    if (fr && /valuemap|corelogic/i.test(fr.url() || '')) return fr;
    await sleep(200);
  }
  // If we didn’t see the iframe, just return null; the input might still be on the top page.
  return null;
}

async function typeAndConfirm(ctx, inputHandle, address) {
  try { await inputHandle.click({ clickCount: 3 }); } catch {}
  try { await inputHandle.focus(); } catch {}
  await inputHandle.type(address, { delay: 60 });

  // suggestions often appear; try Enter, then wait a beat; if nothing, click first suggestion-ish button
  try { await ctx.keyboard.press('Enter'); } catch {}
  await sleep(800);
  // best-effort: click the first visible suggestion if present
  try {
    const clicked = await ctx.evaluate(() => {
      const q = document.querySelectorAll('li,div,button');
      for (const el of q) {
        const t = (el.innerText || '').toLowerCase();
        if (t && (t.includes('suggest') || t.includes('match') || t.includes('select'))) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) { el.click(); return true; }
        }
      }
      return false;
    });
    if (clicked) await new Promise(r => setTimeout(r, 500));
  } catch {}
  // In many CoreLogic embeds, Enter doesn’t submit. Try common submit buttons.
  await clickByText(ctx, ['search', 'find', 'get estimate', 'estimate', 'go'], 1500).catch(()=>{});
}

async function captureDebug(page, frame, address, tag='unhandled') {
  try {
    const safe = String(address).replace(/[^a-z0-9]+/gi, '_').slice(0,140);
    const dir = '/tmp/chase_debug';
    await page.screenshot({ path: `${dir}/${tag}_${safe}.png`, fullPage: true }).catch(()=>{});
    const outerHtml = await page.content().catch(()=>null);
    if (outerHtml) {
      await page.evaluate((html, p) => {
        try { const a = document.createElement('a'); a.download = p.split('/').pop(); a.href = 'data:text/html;charset=utf-8,'+encodeURIComponent(html); document.body.appendChild(a); } catch(e) {}
      }, outerHtml, `${dir}/${tag}_${safe}.outer.html`).catch(()=>{});
    }
    if (frame) {
      const innerHtml = await frame.evaluate(() => document.documentElement.outerHTML).catch(()=>null);
      if (innerHtml) {
        await page.evaluate((html, p) => {
          try { const a = document.createElement('a'); a.download = p.split('/').pop(); a.href = 'data:text/html;charset=utf-8,'+encodeURIComponent(html); document.body.appendChild(a); } catch(e) {}
        }, innerHtml, `${dir}/${tag}_${safe}.iframe.html`).catch(()=>{});
      }
    }
  } catch {}
}

export async function getChaseEstimate(page, address) {
  // if we got bounced, go back
  if (!page.url().startsWith(CHASE_URL)) {
    await page.goto(CHASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
  }

  // Make sure the estimator UI (or iframe) is really present
  const maybeFrame = await ensureOnEstimator(page).catch(()=>null);

  // main doc first
  let input = await findVisibleHandle(page, ESTIMATOR_INPUT_SEL, 3000);
  let ctx = page;

  // otherwise try inside CoreLogic iframe
  if (!input) {
    const frame = maybeFrame || getCorelogicFrame(page);
    if (frame) {
      ctx = frame;
      input = await findVisibleHandle(frame, ESTIMATOR_INPUT_SEL, 8000);
    }
  }

  if (!input) {
    await captureDebug(page, maybeFrame || null, address, 'no_address_box');
    throw new ChaseSearchError('AddressInputNotFound');
  }

  await typeAndConfirm(ctx, input, address);

  // Wait for an estimate to appear
  let estimate, estimateText;
  try {
    ({ estimate, estimateText } = await waitForEstimate(ctx, 22000));
  } catch (e) {
    // one more nudge: try clicking obvious submit CTAs and wait again
    await clickByText(ctx, ['search', 'find', 'get estimate', 'estimate', 'go'], 1500).catch(()=>{});
    ({ estimate, estimateText } = await waitForEstimate(ctx, 12000).catch(()=>({}) ));
  }
  if (!estimate) {
    await captureDebug(page, ctx !== page ? ctx : null, address, 'estimate_missing');
    throw new ChaseSearchError('EstimateMissing');
  }
  return { estimate, estimateText, url: page.url() };
}