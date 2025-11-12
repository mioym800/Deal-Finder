#!/usr/bin/env node
/**
 * cities-to-urls.js
 * Build backend/urls.json (state -> [city dashboard URLs]) from a CSV like:
 *   City,State short
 *   Holtsville,NY
 *   Agawam,MA
 *
 * Flags:
 *   --include-dc   Include Washington, DC (otherwise only the 50 states)
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// --- Config ---
const INCLUDE_DC = process.argv.includes('--include-dc'); // optional
const BASE = 'https://app.privy.pro/dashboard';
const QS_DEFAULT = [
  ['location_type','city'],
  ['project_type','buy_hold'],
  ['spread_type','arv'],
  ['spread','50'],
  ['list_price_from','75000'],
  ['list_price_to','750000'],
  ['beds_from','3'],
  ['sqft_from','1000'],
  ['hoa','no'],
  ['include_detached','true'],
  ['include_active','true'],
  ['date_range','all'],
  ['source','Any'],
  ['sort_by','days-on-market'],
  ['sort_dir','asc'],
];

// Official 50-state whitelist (optionally DC)
const FIFTY_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'
]);
if (INCLUDE_DC) FIFTY_STATES.add('DC');

const isStateCode = (s) => typeof s === 'string' && /^[A-Z]{2}$/.test(s.trim());
const normCity = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const normState = (s) => String(s || '').trim().toUpperCase();

// Build a Privy dashboard URL from (city, state)
function buildUrl(city, stateCode) {
  const u = new URL(BASE);
  u.searchParams.set('search_text', `${normCity(city)}, ${stateCode}`);
  for (const [k, v] of QS_DEFAULT) u.searchParams.set(k, v);
  return u.toString();
}

// Map various header spellings to {city, state}
function normalizeHeaders(cols) {
  const lower = cols.map(c => (c || '').toLowerCase().trim());
  const out = { cityIdx: -1, stateIdx: -1 };
  lower.forEach((c, i) => {
    if (out.cityIdx < 0 && (c === 'city' || c === 'city name')) out.cityIdx = i;
    if (out.stateIdx < 0 && (c === 'state' || c === 'state short' || c === 'state_code' || c === 'st' || c === 'state abbrev')) out.stateIdx = i;
  });
  return out;
}

async function main() {
  // Args: input CSV, output JSON
  const [,, inputCsv = 'us-cities.csv', outputJsonCli] = process.argv.filter(a => !a.startsWith('--'));
  const outputJson = outputJsonCli || path.resolve(__dirname, '../../urls.json');

  if (!fs.existsSync(inputCsv)) {
    console.error(`Input CSV not found: ${inputCsv}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(inputCsv), crlfDelay: Infinity });

  let header = null;
  let idx = { cityIdx: -1, stateIdx: -1 };

  /** @type {Record<string, string[]>} */
  const out = {};
  const unknownCodes = new Map(); // code -> count
  let totalRows = 0;

  for await (const line of rl) {
    const raw = line.trim();
    if (!raw) continue;

    const parts = raw.split(',').map(s => s.trim());
    if (!header) {
      header = parts;
      idx = normalizeHeaders(header);
      if (idx.cityIdx < 0 || idx.stateIdx < 0) {
        console.error(`CSV needs headers like "City,State short" (got: ${header.join(', ')})`);
        process.exit(1);
      }
      continue;
    }

    totalRows++;
    const city  = parts[idx.cityIdx];
    const state = normState(parts[idx.stateIdx]);

    if (!city || !isStateCode(state)) {
      if (state) unknownCodes.set(state, (unknownCodes.get(state) || 0) + 1);
      continue;
    }
    if (!FIFTY_STATES.has(state)) {
      unknownCodes.set(state, (unknownCodes.get(state) || 0) + 1);
      continue; // skip territories/extra codes
    }

    const url = buildUrl(city, state);
    if (!out[state]) out[state] = [];
    out[state].push(url);
  }

  // Dedupe + sort per state
  for (const st of Object.keys(out)) {
    out[st] = Array.from(new Set(out[st])).sort((a, b) => a.localeCompare(b));
  }

  fs.mkdirSync(path.dirname(outputJson), { recursive: true });
  fs.writeFileSync(outputJson, JSON.stringify(out, null, 2));

  const totalUrls = Object.values(out).reduce((n, arr) => n + arr.length, 0);
  const stateCount = Object.keys(out).length;

  console.log(`✅ Wrote ${outputJson} • ${totalUrls} city URLs across ${stateCount} states`);
  console.log(`   Rows processed: ${totalRows}`);
  if (unknownCodes.size) {
    const sample = [...unknownCodes.entries()].slice(0, 15).map(([k, v]) => `${k}:${v}`).join(', ');
    console.log(`   Skipped non-allowed codes (showing up to 15): ${sample}${unknownCodes.size > 15 ? ', ...' : ''}`);
    console.log(`   Tip: pass --include-dc to include DC; territories (PR, GU, VI, AS, MP) are excluded by default.`);
  }
}

main().catch(err => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});