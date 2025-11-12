// backend/vendors/redfin/detailParser.js
import * as cheerio from 'cheerio';

export function parseDetailHtml(html) {
  const $ = cheerio.load(html);
  const out = { raw: {} };

  // Prefer JSON-LD when present
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const obj = JSON.parse($(el).contents().text());
      const arr = Array.isArray(obj) ? obj : [obj];
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        if (['House', 'Residence', 'SingleFamilyResidence'].includes(item['@type'])) {
          out.raw.jsonld = item;
          if (item.price) out.price = Number(item.price);
          if (item.numberOfRooms) out.beds = Number(item.numberOfRooms);
          if (item.numberOfBathroomsTotal) out.baths = Number(item.numberOfBathroomsTotal);
          if (item.floorSize?.value) out.sqft = Number(item.floorSize.value);
          if (item.datePosted) out.listedAt = item.datePosted;
          if (Array.isArray(item.image)) out.images = item.image;
        }
      }
    } catch {}
  });

  const bodyText = $('body').text();

  if (out.price == null) {
    const m = bodyText.match(/\$[\d,]+/);
    if (m) out.price = Number(m[0].replace(/[^\d]/g, ''));
  }
  if (out.beds == null) {
    const m = bodyText.match(/(\d+(?:\.\d+)?)\s*Beds?/i);
    if (m) out.beds = Number(m[1]);
  }
  if (out.baths == null) {
    const m = bodyText.match(/(\d+(?:\.\d+)?)\s*Baths?/i);
    if (m) out.baths = Number(m[1]);
  }
  if (out.sqft == null) {
    const m = bodyText.match(/([\d,]+)\s*(?:Sq\.?\s*Ft|Square Feet)/i);
    if (m) out.sqft = Number(m[1].replace(/[^\d]/g, ''));
  }

  const hoaMatch = bodyText.match(/HOA(?:\s*Fees?)?:?\s*(Yes|No)/i);
  if (hoaMatch) out.hoa = hoaMatch[1];

  const agentNode = $('[class*="Agent"], [data-testid*="agent"]').first().text().trim();
  if (agentNode) out.agentName = agentNode.split('\n')[0];

  return out;
}