// vendors/bofa/bofaAutomation.js
// Drop-in shim for runAutomation.js -> getHomeValue(...)

function parseDollarToNumber(text) {
  if (!text) return null;
  const n = String(text).replace(/[^\d.]/g, '');
  return n ? Math.round(Number(n)) : null;
}

async function scrapeBofaValues(page) {
  await page.waitForSelector('#section-comparables .hvt-comparables__avg-est', { timeout: 45000 });

  const data = await page.evaluate(() => {
    const out = {};
    const root = document.querySelector('#section-comparables .hvt-comparables__avg-est');
    if (!root) return out;
    const items = root.querySelectorAll('dl .hvt-avg-est__item');
    items.forEach((item) => {
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

function averageTwo(textA, textB) {
  const a = parseDollarToNumber(textA);
  const b = parseDollarToNumber(textB);
  if (a == null || b == null) return null;
  return Math.round((a + b) / 2);
}

/**
 * getHomeValue(property, maxAttempts, { injected: { page }, reusePage, proxyInfo, proxySupplier })
 * - Only `page` is required here (we run in the pooled page your runner provides).
 * - Returns an object with bofa_value and raw fields.
 */
export default async function getHomeValue(property, maxAttempts = 3, options = {}) {
  const page = options?.injected?.page;
  if (!page) throw new Error('getHomeValue: page is required via options.injected.page');

  const address = property?.fullAddress || property?.address;
  if (!address) throw new Error('getHomeValue: address missing');

  let attempt = 0;
  while (attempt < Math.max(1, maxAttempts)) {
    attempt++;
    try {
      // Focus input, clear, type, submit
      await page.waitForSelector('#address', { timeout: 25000 });
      await page.click('#address', { delay: 10 }).catch(() => {});
      // Clear
      try {
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('Control');
        await page.keyboard.press('Backspace');
      } catch {}

      await page.type('#address', address, { delay: 10 });
      await page.keyboard.press('Enter');

      // Let results load
      await page.waitForNetworkIdle({ idleTime: 1200, timeout: 30000 }).catch(() => {});
      await page.waitForSelector('#section-comparables', { timeout: 40000 }).catch(() => {});

      const { avgSaleText, estHomeText } = await scrapeBofaValues(page);
      const avgSale = parseDollarToNumber(avgSaleText);
      const estHome = parseDollarToNumber(estHomeText);
      const composite = averageTwo(avgSaleText, estHomeText);

      if (composite != null) {
        return {
          status: 'estimate',
          bofa_value: composite,
          avg_sale_price: avgSale,
          estimated_home_value: estHome,
        };
      }

      // If both not found, fall through to retry
      if (attempt >= maxAttempts) {
        return { status: 'nodata', bofa_value: null };
      }
    } catch (e) {
      if (attempt >= maxAttempts) {
        return { status: 'rejected', reason: e?.message || String(e), bofa_value: null };
      }
      // brief backoff to avoid hammering
      await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 300)));
    }
  }

  return { status: 'nodata', bofa_value: null };
}