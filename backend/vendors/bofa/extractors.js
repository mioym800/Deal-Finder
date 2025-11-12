// vendors/bofa/extractors.js
export function parseDollarToNumber(text) {
  if (!text) return null;
  const n = String(text).replace(/[^\d.]/g, '');
  return n ? Math.round(Number(n)) : null;
}

// Find the results frame BoA sometimes uses for the estimator UI
async function getResultsFrame(page, timeoutMs = 45000) {
  // quick, optimistic wait for any iframe to appear
  await page.waitForTimeout(250);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Retry each tick because the frame can reload/repoint
    const frames = page.frames();
    // Heuristics: look for known css present in the frame OR url hints
    const byUrl = frames.find(f => /bankofamerica\.com|homevalue|hvt|realestatecenter/i.test(f.url()));
    if (byUrl) return byUrl;

    // Sometimes the frame exists but url is blank yet; short sleep and retry
    await page.waitForTimeout(250);
  }
  return null; // no frame detected in time
}

/**
 * Scrapes the two values from either the main page or from the results iframe.
 * Returns { avgSaleText, estHomeText } or throws on timeout.
 */
export async function scrapeBofaValues(page, { timeoutMs = 45000 } = {}) {
  // Prefer scraping inside results frame when available
  const frame = await getResultsFrame(page, Math.min(timeoutMs, 10000));

  const scope = frame || page;

  // Wait for the container in whichever browsing context we selected
  await scope.waitForSelector('#section-comparables .hvt-comparables__avg-est', { timeout: timeoutMs });

  const data = await scope.evaluate(() => {
    const root = document.querySelector('#section-comparables .hvt-comparables__avg-est');
    const out = {};
    if (!root) return out;

    const items = root.querySelectorAll('dl .hvt-avg-est__item');
    items.forEach(item => {
      const dt = item.querySelector('dt, .hvt-avg-est__label');
      const dd = item.querySelector('dd.hvt-avg-est__value');
      const label = dt?.textContent?.trim() || '';
      const value = dd?.textContent?.trim() || '';
      if (label) out[label] = value;
    });
    return out;
  });

  const avgSaleText = data['Average sale price'] || data['Average Sale Price'] || null;
  const estHomeText = data['Estimated home value'] || data['Estimated Home Value'] || null;

  return { avgSaleText, estHomeText };
}

export function averageTwo(textA, textB) {
  const a = parseDollarToNumber(textA);
  const b = parseDollarToNumber(textB);
  if (a == null || b == null) return null;
  return Math.round((a + b) / 2);
}