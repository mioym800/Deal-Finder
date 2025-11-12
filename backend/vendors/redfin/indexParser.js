// backend/vendors/redfin/indexParser.js
import * as cheerio from 'cheerio';

// ✅ allow 8–9 digit prices (up to hundreds of millions)
const PRICE_RE = /\$?\s*([\d,]{2,9})(?:\.\d{2})?/;

function parsePrice(text) {
  if (!text) return null;
  const m = PRICE_RE.exec(String(text));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseIndexHtml(html) {
  const $ = cheerio.load(html);
  const results = [];

  $('a[href*="/home/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!/\/home\/\d+/.test(href)) return;

    const container = $(a).closest('[class*="HomeCard"], [data-testid*="home-card"], li, article');

    const textOrNull = (sel) => {
      const t = container.find(sel).first().text().trim();
      return t || null;
    };

    // 🔽 broaden price selectors + keep original text for debugging
    const priceText =
      textOrNull('[class*="Price"]') ||
      textOrNull('[data-rf-test-id="homecard-price"]') ||
      textOrNull('.homecardV2Price') ||
      textOrNull('[data-testid="price"]') ||
      textOrNull('[data-rf-test-id="abp-price"] > span') ||
      // last-ditch: scan the card text for a $123,456 pattern
      (PRICE_RE.test(container.text()) ? container.text().match(PRICE_RE)?.[0] || null : null);

    // ✅ numeric price (Number) for saving to Mongo
    const price = parsePrice(priceText);

    const address =
      textOrNull('[class*="Address"]') ||
      textOrNull('[data-rf-test-id="homecard-address"]');

    const statsText = container
      .find('[class*="Stats"], [data-rf-test-id*="homecard"]')
      .text()
      .replace(/\s+/g, ' ')
      .trim();

    const mBeds  = statsText.match(/(\d+(?:\.\d+)?)\s*Beds?/i);
    const mBaths = statsText.match(/(\d+(?:\.\d+)?)\s*Baths?/i);
    const mSqft  = statsText.match(/([\d,]+)\s*Sq\.?\s*Ft/i);

    results.push({
      url: new URL(href, 'https://www.redfin.com').toString(),
      priceText,         // keep for diagnostics
      price,             // <-- use THIS in your saver: Number | null
      address,
      bedsText:  mBeds  ? mBeds[0]  : null,
      bathsText: mBaths ? mBaths[0] : null,
      sqftText:  mSqft  ? mSqft[0]  : null,
    });
  });

  const seen = new Set();
  return results.filter(r => (seen.has(r.url) ? false : (seen.add(r.url), true)));
}