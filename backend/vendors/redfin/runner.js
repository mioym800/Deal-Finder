import 'dotenv/config';
import { fetchHtml } from './fetcher.js';
import { parseIndexHtml } from './indexParser.js';
import { parseDetailHtml } from './detailParser.js';
import { getCityUrls } from './sitemapEnumerator.js';
import { FILTERS, passesAll } from './filters.js';
import { propIdFromUrl, toNumberOrNull, parseBeds, parseBaths, cityFromAddress } from './normalize.js';
import { upsertRaw, upsertProperty } from './save.js';

function uniqueByUrl(arr) {
  const seen = new Set();
  const out = [];
  for (const it of arr) {
    if (!it?.url) continue;
    if (seen.has(it.url)) continue;
    seen.add(it.url);
    out.push(it);
  }
  return out;
}

function applyUrlFilters(url) {
  const seg = process.env.REDFIN_FILTER_SEGMENT;
  if (!seg) return url;
  // if URL already has a filter segment, leave it alone
  if (url.includes('/filter/')) return url;
  // insert `/filter/<segment>` after the city path
  // e.g., https://www.redfin.com/city/1823/AL/Birmingham → .../Birmingham/filter/<seg>
  return url.replace(/\/?$/, '') + '/filter/' + seg;
}

async function enumerateIndexPages(cityUrl) {
  const maxPages = Number(process.env.MAX_INDEX_PAGES_PER_CITY || '1');
  const forceFirstRender = String(process.env.REDFIN_FORCE_RENDER || '1') === '1';

  const all = [];
  let page = 1;
  let lastCount = 0;

  while (page <= maxPages) {
    const url = page === 1 ? cityUrl : `${cityUrl.replace(/\/$/, '')}/page-${page}`;
    let html;
    try {
      // First page: render=true to punch through; subsequent pages usually fine without render
      const render = page === 1 ? forceFirstRender : false;
      html = await fetchHtml(url, { render });
    } catch (e) {
      console.warn(`Index fetch failed: ${url} -> ${e.message}`);
      break;
    }

    const items = parseIndexHtml(html);
    if (!items.length) {
      console.log(`No items on page ${page}; stopping pagination.`);
      break;
    }

    // Append & de-dupe
    const before = all.length;
    all.push(...items);
    const deduped = uniqueByUrl(all);
    const gained = deduped.length - before;
    all.length = 0; all.push(...deduped);

    console.log(`Page ${page}: found ${items.length} (new: ${gained})`);

    // Stop if no growth vs. last iteration (safety)
    if (all.length === lastCount) {
      console.log(`No additional unique listings after page ${page}; stopping.`);
      break;
    }
    lastCount = all.length;
    page += 1;
  }

  return all;
}

export async function runCity(cityUrl) {
  const maxListings = Number(process.env.MAX_LISTINGS_PER_CITY || '500');

  console.log(`\n=== City: ${cityUrl} ===`);

// Fetch page 1..N and merge
const listings = await enumerateIndexPages(cityUrl);
console.log(`Found ${listings.length} index listings (all pages)`);

  let processed = 0;
  let fetched = 0;
  let passed = 0;
  let saved = 0;
  let filteredOut = 0;
  let detailErrors = 0;

  // allow tuning delay via env to reduce blocks on large crawls
  const BASE_JITTER = Number(process.env.REDFIN_JITTER_MS || '0');
  const jitter = () => (BASE_JITTER || (75 + Math.floor(Math.random() * 125)));

  for (const it of listings) {
    if (processed >= maxListings) break;
    processed++;

    try {
      // small pause between detail requests
      await new Promise(r => setTimeout(r, jitter()));

      const forceDetailRender = process.env.REDFIN_DETAIL_RENDER === '1';
      const detailHtml = await fetchHtml(it.url, { render: forceDetailRender });
      fetched++;
      if (processed % 10 === 0) {
        console.log(`Progress: processed=${processed} fetched=${fetched} saved=${saved} filtered=${filteredOut} errors=${detailErrors}`);
      }

      const d = parseDetailHtml(detailHtml);

      // Merge index + detail values
      const price = d.price ?? toNumberOrNull(it.priceText);
      const sqft  = d.sqft ?? toNumberOrNull(it.sqftText);
      const beds  = d.beds ?? parseBeds(it.bedsText || '');
      const baths = d.baths ?? parseBaths(it.bathsText || '');

      // Apply filters (can be disabled via env; see Patch 2)
      const ok = passesAll(
        { price, sqft, hoa: d.hoa ?? null, listedAt: d.listedAt ?? null }
      );

      if (!ok) { filteredOut++; continue; }
      passed++;

      const address = (it.address || '').trim();
      const city    = cityFromAddress(address);
      const prop_id = propIdFromUrl(it.url);

      await upsertRaw({
        address, city, state: '', zip: '',
        price, beds, baths, sqft,
        raw: d.raw || {},
        agentName: d.agentName ?? null,
        agentEmail: d.agentEmail ?? null
      });

      await upsertProperty({
        prop_id,
        address, city, state: '', zip: '',
        price, beds, baths, sqft, built: d.built ?? null,
        raw: d.raw || {},
        agentName: d.agentName ?? null,
        agentEmail: d.agentEmail ?? null,
        agentPhone: d.agentPhone ?? null,
      });

      saved++;
      console.log(`✔ Saved ${prop_id} | ${address || '(no address)'} | $${price ?? 'NA'} | ${beds ?? '?'}bd/${baths ?? '?'}ba | ${sqft ?? '?'} sqft`);
    } catch (e) {
      detailErrors++;
      console.warn(`Detail failed for ${it.url}: ${e.message}`);
    }
  }

  console.log(`City summary -> processed:${processed} fetched:${fetched} passed:${passed} saved:${saved} filtered:${filteredOut} errors:${detailErrors}`);
}

export async function runAllCities() {
  const maxCities = Number(process.env.MAX_CITIES || '0') || undefined;
  const cities = await getCityUrls(maxCities);
  console.log(`Total cities: ${cities.length}`);

  for (const c of cities) {
    await runCity(c.url);
  }
}