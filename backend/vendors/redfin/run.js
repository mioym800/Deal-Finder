// backend/vendors/redfin/run.js
require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

const { getCityUrls } = require('./sitemapEnumerator');
const { fetchHtml } = require('./fetcher');
const { parseIndexHtml } = require('./indexParser');
const { parseDetailHtml } = require('./detailParser');
const { FILTERS, passesAll } = require('./filters');
const { toNumberOrNull, parseBeds, parseBaths, propIdFromUrl, cityFromAddress, lowerCI } = require('./normalize');

const Property = require('../../models/Property');
const RawProperty = require('../../models/rawProperty');

async function connectMongo() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/yourdb';
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log('✅ Mongo connected (redfin)');
}

async function savePair({ it, d }) {
  const address = (it.address || '').trim();
  const city    = cityFromAddress(address);
  const prop_id = propIdFromUrl(it.url);

  const price = d.price ?? toNumberOrNull(it.priceText);
  const sqft  = d.sqft ?? toNumberOrNull(it.sqftText);
  const beds  = d.beds ?? parseBeds(it.bedsText || '');
  const baths = d.baths ?? parseBaths(it.bathsText || '');

  await RawProperty.updateOne(
    { fullAddress: address || it.url },
    {
      $set: {
        fullAddress: address || it.url,
        address,
        city,
        state: '',
        zip: '',
        price: (() => {
  const cand = price ?? raw?.listingPrice ?? raw?.listPrice ?? raw?.asking_price ?? raw?.lp;
  const n = Number(String(cand ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
})(),
        details: { beds, baths, sqft, _raw: d.raw || {} },
        agent_name:  d.agentName ?? null,
        agent_email: d.agentEmail ?? null,
        status: 'scraped',
      }
    },
    { upsert: true }
  );

  const set = {
    prop_id, fullAddress, fullAddress_ci,
    address: fullAddress,
    city: city || '',
    state: (state || '').toUpperCase(),
    zip: zip || '',
    details: { beds, baths, sqft, built: built ?? null, _raw: raw || {} },
    agentName: agentName ?? null,
    agentEmail: agentEmail ?? null,
    agentPhone: agentPhone ?? null,
  };
  // Only write price when it’s a finite number (don’t erase an existing one)
  const n = Number(String(price ?? '').replace(/[^0-9.\-]/g, ''));
  if (Number.isFinite(n)) set.price = n;

  await Property.updateOne(
    { prop_id },
    { $set: set },
    { upsert: true }
  );

  console.log(`✔ Saved ${prop_id} | ${address}`);
}

async function runCity(cityUrl) {
  const token = process.env.CRAWLBASE_TOKEN;
  const maxIndexPages = Number(process.env.MAX_INDEX_PAGES_PER_CITY || '1');
  const maxListings   = Number(process.env.MAX_LISTINGS_PER_CITY || '400');

  console.log(`\n=== City: ${cityUrl} ===`);
  const html1 = await fetchHtml(cityUrl, { token, render: false });
  const listings = parseIndexHtml(html1);

  let processed = 0;
  for (const it of listings) {
    if (processed >= maxListings) break;
    processed++;
    try {
      const detailHtml = await fetchHtml(it.url, { token, render: false });
      const d = parseDetailHtml(detailHtml);

      const price = d.price ?? toNumberOrNull(it.priceText);
      const sqft  = d.sqft ?? toNumberOrNull(it.sqftText);

      const keep = passesAll({ price, sqft, hoa: d.hoa ?? null, listedAt: d.listedAt ?? null }, FILTERS);
      if (!keep) continue;

      await savePair({ it, d });
    } catch (e) {
      console.warn(`Detail failed for ${it.url}: ${e.message}`);
    }
  }
}

async function runRedfin(_queriesIgnored, { userDataDir } = {}) {
  // The job passes queries, but we’re doing sitemap-wide crawl instead.
  await connectMongo();

  const maxCities = Number(process.env.MAX_CITIES || '0') || undefined;
  const cities = await getCityUrls(maxCities);
  console.log(`Total cities from sitemap: ${cities.length}`);

  for (const c of cities) {
    await runCity(c.url);
  }

  await mongoose.disconnect();
  console.log('🎉 Redfin run finished.');
}

module.exports = { default: runRedfin };