// backend/vendors/redfin/sitemapEnumerator.js
import * as cheerio from 'cheerio';
import { fetchHtml } from './fetcher.js';

// Enumerate cities by crawling state landing pages (avoids blocked sitemap).
// State strings are URL-ready for Redfin (e.g., New-York, New-Jersey).
const US_STATES = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware',
  'Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky',
  'Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi',
  'Missouri','Montana','Nebraska','Nevada','New-Hampshire','New-Jersey','New-Mexico',
  'New-York','North-Carolina','North-Dakota','Ohio','Oklahoma','Oregon','Pennsylvania',
  'Rhode-Island','South-Carolina','South-Dakota','Tennessee','Texas','Utah','Vermont',
  'Virginia','Washington','West-Virginia','Wisconsin','Wyoming'
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => 150 + Math.floor(Math.random() * 250);

export async function getCityUrls(limit) {
  const stateLimit = Number(process.env.STATE_LIMIT || '0') || US_STATES.length;
  const pickStates = US_STATES.slice(0, stateLimit);
  const seen = new Set();
  const out = [];

  for (const state of pickStates) {
    const url = `https://www.redfin.com/state/${state}`;
    let html;
    try {
      // HTML only; no render needed here
      html = await fetchHtml(url, { render: false });
    } catch (e) {
      console.warn(`State fetch failed: ${state} -> ${e.message}`);
      continue;
    }

    const $ = cheerio.load(html);
    $('a[href^="/city/"]').each((_, a) => {
      const href = $(a).attr('href') || '';
      // Example: /city/30869/FL/Orlando
      if (!href || !href.startsWith('/city/')) return;
      const full = new URL(href, 'https://www.redfin.com').toString();
      if (!seen.has(full)) {
        seen.add(full);
        out.push({ url: full, lastmod: null, state });
      }
    });

    // Tiny pause between states to be polite
    await sleep(jitter());
  }

  return limit ? out.slice(0, limit) : out;
}