import getHomeValue from './vendors/bofa/bofaAutomation.js';
import { STATES, projectTypes, locationTypes, tags } from './constants.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { searchPropertyByAddress } from './vendors/homes/homesBot.js';
import readline from 'readline';
import { log } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Scoped logger
const L = log.child('helpers');

// Generate URLs for all states and project types
function generatePrivyUrls(STATES) {
  L.start('Generating Privy URLs', { states: Array.isArray(STATES) ? STATES.length : 0 });
  const baseUrl = 'https://app.privy.pro/dashboard';
  const spread = 50;
  const preferredOnly = true;
  const listPriceFrom = 75000;
  const listPriceTo = 750000;
  const bedsFrom = 3;
  const sqftFrom = 1000;
  const hoa = 'no';
  const includeDetached = true;
  const includeActive = true;
  const dateRange = 'all';
  const tags = [
    'zombie',
    'preforeclosure',
    'foreclosure',
    'vacant',
    'absentee',
    'cash_buyer,',
    'corporate_owned',
    'tired_landlord',
    'auction',
    'inter_family',
  ];
  const zoom = 7;
  const sizeHeight = 1029;
  const sizeWidth = 1947;
  const projectTypes = ['flip', 'buy_hold', 'scrape'];

  const urlsByState = {};

  STATES.forEach((state) => {
    const stateUrls = [];
    projectTypes.forEach((projectType) => {
      tags.forEach((tag) => {
        const url = new URL(baseUrl);

        // Add query parameters
        url.searchParams.append('search_text', state.name);
        url.searchParams.append('location_type', 'city');
        url.searchParams.append('geography_shape_id', state.geography_shape_id);
        url.searchParams.append('project_type', projectType);
        url.searchParams.append('spread_type', 'arv');
        url.searchParams.append('spread', spread);
        // url.searchParams.append('preferred_only', preferredOnly);
        url.searchParams.append('list_price_from', listPriceFrom);
        url.searchParams.append('list_price_to', listPriceTo);
        url.searchParams.append('lat', state.lat);
        url.searchParams.append('lng', state.lng);
        url.searchParams.append('zoom', zoom);
        url.searchParams.append('sw_lat', state.sw_lat);
        url.searchParams.append('sw_lng', state.sw_lng);
        url.searchParams.append('ne_lat', state.ne_lat);
        url.searchParams.append('ne_lng', state.ne_lng);
        url.searchParams.append('size[height]', sizeHeight);
        url.searchParams.append('size[width]', sizeWidth);
        url.searchParams.append('beds_from', bedsFrom);
        url.searchParams.append('sqft_from', sqftFrom);
        url.searchParams.append('hoa', hoa);
        url.searchParams.append('include_detached', includeDetached);
        url.searchParams.append('include_active', includeActive);
        url.searchParams.append('date_range', dateRange);
        url.searchParams.append('source', 'Any');
        url.searchParams.append('sort_by', 'days-on-market');
        url.searchParams.append('sort_dir', 'asc');
        url.searchParams.append(`tags[${tag}]`, '');

        stateUrls.push(url.toString());
      });
    });
    urlsByState[state.name] = stateUrls;
  });

  // Write URLs to a JSON file in the backend directory
  const filePath = path.resolve(__dirname, '../backend/urls.json');
  fs.writeFileSync(filePath, JSON.stringify(urlsByState, null, 2), 'utf-8');
  L.success('URLs written to file', { filePath });

  return urlsByState;
}

function calculateFortyPercent(propertyValue) {
  if (typeof propertyValue !== 'number' || propertyValue <= 0) {
    return null;
  }
  return propertyValue * 0.4;
}

function calculateThirtyPercent(propertyValue) {
  if (typeof propertyValue !== 'number' || propertyValue <= 0) {
    return null;
  }
  return propertyValue * 0.3;
}

function calculateEightyPercent(propertyValue) {
  if (typeof propertyValue !== 'number' || propertyValue <= 0) {
    return null;
  }
  return propertyValue * 0.8;
}

function parsePrice(value) {
  if (typeof value === 'number' && !isNaN(value)) return value;

  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/[^0-9.]/g, '');
    const number = parseFloat(cleaned);
    return isNaN(number) ? null : number;
  }

  return null;
}

function transformQuickStats(property) {
  const parsedStats = {};

  property.quickStats.forEach((entry) => {
    // Skip if the entry doesn't include the allowed terms
    if (!/(Beds|Baths|Square Ft|Built)/.test(entry)) {
      return;
    }
    // Split at the first digit
    const match = entry.match(/^([^\d]+)(.+)$/);

    if (match) {
      const key = match[1].trim().toLowerCase().replace(/\s+/g, '');
      let value = match[2].trim();

      // Remove commas in numbers like 1,048
      if (!isNaN(value.replace(/,/g, ''))) {
        value = parseFloat(value.replace(/,/g, ''));
      }

      parsedStats[key] = value;
    } else {
      // fallback if not matched
      parsedStats[entry] = true;
    }
  });

  return {
    ...parsedStats,
  };
}

function parseAddresses(properties) {
  return properties
    .map((property) => {
      if (!property || !property.fullAddress) {
        L.warn('Invalid property data (missing fullAddress)', { property: property ? Object.keys(property) : null });
        return null; // Skip invalid properties
      }

      const fullAddress = property?.fullAddress?.trim();
      const parts = fullAddress?.split(',')?.map((s) => s.trim());

      if (parts.length < 3) {
        L.warn('Invalid address format (not enough parts)', { fullAddress });
        return null; // Skip invalid addresses
      }

      const [addressPart, cityPart, stateZipPart] = parts;
      const stateZipParts = stateZipPart?.split(' ')?.filter(Boolean);

      if (stateZipParts.length < 2) {
        L.warn('Invalid state/ZIP format', { stateZipPart });
        return null; // Skip invalid addresses
      }

      const state = stateZipParts[0];
      const zip = stateZipParts.slice(1).join(' '); // Handle ZIP codes with spaces (e.g., "12345-6789")

      return {
        fullAddress,
        address: addressPart,
        city: cityPart,
        state,
        zip,
        price: property.price,
        details: transformQuickStats(property),
        ...property,
      };
    })
    .filter(Boolean); // Remove null values
}

async function appendBofaValuesToProperties(properties, browser) {
  const updatedProperties = [];
  for (const property of properties) {
    const address = property.fullAddress;
    L.info('Fetching BOFA value', { address });
    try {
      const res = await getHomeValue(property, browser); // expect { bofa_value } or Number
      const bofa_value = (res && typeof res === 'object') ? res.bofa_value : (typeof res === 'number' ? res : null);
      updatedProperties.push({ ...property, bofa_value });
      L.success('BOFA value fetched', { address, bofa_value });
    } catch (error) {
      L.error('Failed to get BOFA value', { address, error: error.message });
      updatedProperties.push({ ...property, bofa_value: null });
    }
  }
  return updatedProperties;
}

async function appendMovotoDataToProperties(properties, browser) {
  return await getMovotoDataForAll(properties, browser);
}

async function appendAgentInfoToProperties(properties, browser) {
  const updatedProperties = [];
  for (const property of properties) {
    const address = property.fullAddress;
    L.info('Fetching Agent Info', { address });
    try {
      const result = await searchPropertyByAddress(property);
      updatedProperties.push({
        ...property,
        agent: result?.agentName || property.agent || null,
        agent_phone: result?.agentPhone || property.agent_phone || null,
        agent_email: result?.agentEmail || property.agent_email || null,
      });
      L.success('Agent Info fetched', { address, hasResult: !!result });
    } catch (error) {
      L.warn('Failed to get Agent Info', { address, error: error.message });
      updatedProperties.push({ ...property, agent: null, agent_phone: null, agent_email: null });
    }
  }
  return updatedProperties;
}

const createTiers = (property) => {
  const formatPrice = parsePrice(property.price);
  const bofaValue = parsePrice(property.bofa_value_30);

  if (formatPrice >= 195000 && bofaValue >= 65000) {
    L.success('Tier 1 match', { address: property.fullAddress, price: formatPrice, bofa30: bofaValue });
    property.tier = 1;
    return 1;
  }

  if (formatPrice >= 145000 && formatPrice < 195000 && bofaValue >= 45000) {
    L.success('Tier 2 match', { address: property.fullAddress, price: formatPrice, bofa30: bofaValue });
    property.tier = 2;
    return 2;
  }

  L.warn('No Tier match', { address: property.fullAddress, price: formatPrice, bofa30: bofaValue });
  return null;
};

const appendTiersToProperties = (properties) => {
  return properties.map((property) => createTiers(property)).filter(Boolean);
};

const randomMouseMovements = async (page) => {
  const width = 1920;
  const height = 1080;
  for (let i = 0; i < 10; i++) {
    const x = Math.floor(Math.random() * width);
    const y = Math.floor(Math.random() * height);
    await page.mouse.move(x, y, { steps: 5 });
    const duration = Math.floor(200 + Math.random() * 300);
    await new Promise((resolve) => setTimeout(resolve, duration));
  }
};

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114 Safari/537.36',
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113 Safari/537.36',
];

const getRandomUserAgent = function () {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

const randomWait = async (min = 800, max = 3000) => {
  const time = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, time));
};

async function safeGoto(page, url, opts = {}, retries = 3) {
  let lastErr = null;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await page.goto(url, opts);
      return resp;
    } catch (err) {
      lastErr = err;
      if (String(err.message || '').includes('ERR_HTTP2_PROTOCOL_ERROR')) {
        L.warn('Ignoring HTTP2 error during navigation', { attempt: i + 1, url });
      } else {
        L.warn('Navigation failed', { attempt: i + 1, url, error: err.message });
      }
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

function getLowerValue(property) {
  const price = parsePrice(property.price);
  const amv = parsePrice(property.amv);
  const home80 = (typeof price === 'number') ? price * 0.80 : null;
  const amv40 = (typeof amv === 'number') ? amv * 0.40 : null;
  if (home80 == null && amv40 == null) return null;
  if (home80 == null) return amv40;
  if (amv40 == null) return home80;
  return Math.min(home80, amv40);
}

function formatCurrency(amount, currency = 'USD', locale = 'en-US') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}


const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

function rotateIfTooBig(outputPath) {
  if (!fs.existsSync(outputPath)) return;
  const { size } = fs.statSync(outputPath);
  if (size > MAX_SIZE_BYTES) {
    const dir = path.dirname(outputPath);
    const base = path.basename(outputPath, '.json');
    const archived = path.join(dir, `${base}-${Date.now()}.ndjson`);
    fs.renameSync(outputPath, archived);
    L.info('Rotated output file', { from: outputPath, to: archived });
  }
}

// Helper to save deduplicated properties to file
async function loadAllProperties(outputPath) {
  const props = new Map();
  if (!fs.existsSync(outputPath)) return props;

  const input = fs.createReadStream(outputPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);
      props.set(obj.fullAddress, obj);
    } catch (err) {
      L.warn('Skipping invalid JSON line while loading properties', { length: (line || '').length });
    }
  }
  return props; // Map<fullAddress, object>
}

async function savePropertiesToFile(properties, outputPath) {
  // 1) Rotate if too big
  rotateIfTooBig(outputPath);

  // 2) Load existing entries (streaming)
  const existing = await loadAllProperties(outputPath);

  // 3) Open append stream
  const out = fs.createWriteStream(outputPath, { flags: 'a' });

  // 4) Write only brand-new or updated entries
  for (const prop of properties) {
    if (!existing.has(prop.fullAddress)) {
      out.write(JSON.stringify(prop) + '\n');
      existing.set(prop.fullAddress, prop);
    }
  }

  out.end();
  L.success('Appended records to file', { count: properties.length, outputPath });
  return Array.from(existing.values());
}

export {
  generatePrivyUrls,
  calculateFortyPercent,
  calculateEightyPercent,
  savePropertiesToFile,
  STATES,
  projectTypes,
  locationTypes,
  tags,
  calculateThirtyPercent,
  parseAddresses,
  appendBofaValuesToProperties,
  appendMovotoDataToProperties,
  appendAgentInfoToProperties,
  appendTiersToProperties,
  randomMouseMovements,
  parsePrice,
  getRandomUserAgent,
  randomWait,
  safeGoto,
  getLowerValue,
  formatCurrency,
  createTiers,
};