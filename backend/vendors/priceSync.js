import { MongoClient } from 'mongodb';
import { config } from 'dotenv';
import fetch from 'node-fetch';

config();

const DECODO_API_KEY = process.env.DECODO_API_KEY;
const DELAY_MIN = 5000;
const DELAY_MAX = 10000;
const BATCH_SIZE = 15;
const SCRAPE_TIMEOUT = 120000; // 2 minutes

let mongoClient, db;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function buildAddress(property) {
  return property.fullAddress?.trim() || null;
}

// Parse address
function parseAddress(fullAddress) {
  const parts = fullAddress.split(',').map(s => s.trim());
  
  if (parts.length < 2) return null;
  
  const streetAddress = parts[0];
  const city = parts[1] || '';
  
  let state = '';
  let zip = '';
  
  if (parts.length >= 3) {
    const stateZipParts = parts[2].split(' ').filter(Boolean);
    state = stateZipParts[0] || '';
    zip = stateZipParts[1] || '';
  }
  
  return { streetAddress, city, state, zip, fullAddress };
}

// Extract price from HTML using regex
function extractPriceFromHTML(html) {
  if (!html) return null;
  
  // Find all price patterns $XXX,XXX
  const priceMatches = html.match(/\$[\d,]{5,}/g);
  
  if (priceMatches) {
    // Get all valid prices
    const prices = priceMatches
      .map(p => parseInt(p.replace(/[$,]/g, '')))
      .filter(p => p >= 20000 && p <= 50000000);
    
    if (prices.length > 0) {
      // Return the first reasonable price found
      return prices[0];
    }
  }
  
  return null;
}

// Scrape using Decodo
async function scrapeWithDecodo(url) {
  try {
    const payload = {
      url: url,
      headless: 'html',
      country: 'us',
      render_js: true,
      js_scenario: {
        instructions: [
          { wait: 5000 } // Wait for page to load
        ]
      }
    };
    
    const response = await fetch('https://scraper-api.decodo.com/v2/scrape', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${DECODO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      timeout: SCRAPE_TIMEOUT
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[DECODO] Error ${response.status}: ${errorText.substring(0, 150)}`);
      return null;
    }

    const data = await response.json();
    return data.html || null;
  } catch (error) {
    console.error(`[DECODO-ERROR]:`, error.message);
    return null;
  }
}

// Get Redfin estimate
async function getRedfinPrice(address) {
  try {
    const addressParts = parseAddress(address);
    if (!addressParts) return null;
    
    // Use Redfin's direct home value page
    const addressSlug = address
      .toLowerCase()
      .replace(/[,]/g, '')
      .replace(/\s+/g, '-')
      .replace(/---/g, '-')
      .replace(/--/g, '-');
    
    // Redfin URL format: /OH/Columbus/1144-E-Whittier-St-43206/home/XXXXX
    // We'll use their "my home" value estimator instead
    const url = `https://www.redfin.com/what-is-my-home-worth?searchInputValue=${encodeURIComponent(address)}`;
    
    console.log(`[REDFIN] Scraping: ${address}`);
    console.log(`[REDFIN] URL: ${url}`);
    
    const html = await scrapeWithDecodo(url);
    
    if (!html) {
      console.log(`[REDFIN] Failed to get HTML`);
      return null;
    }
    
    const price = extractPriceFromHTML(html);
    
    if (price) {
      console.log(`[REDFIN] Found estimate: $${price.toLocaleString()}`);
    } else {
      console.log(`[REDFIN] No estimate found`);
    }
    
    return price;
  } catch (error) {
    console.error(`[REDFIN-ERROR]:`, error.message);
    return null;
  }
}

// Get Chase estimate
async function getChasePrice(address) {
  try {
    console.log(`[CHASE] Scraping: ${address}`);
    
    // Chase home value estimator - main page
    const url = 'https://www.chase.com/personal/mortgage/calculators-resources/home-value-estimator';
    
    console.log(`[CHASE] URL: ${url}`);
    
    const html = await scrapeWithDecodo(url);
    
    if (!html) {
      console.log(`[CHASE] Failed to get HTML`);
      return null;
    }
    
    // Chase requires interaction - for now, we'll skip it
    // Their tool requires form submission which is harder to automate
    console.log(`[CHASE] Skipping (requires form interaction)`);
    return null;
    
  } catch (error) {
    console.error(`[CHASE-ERROR]:`, error.message);
    return null;
  }
}

// Alternative: Use Realtor.com (easier to scrape)
async function getRealtorPrice(address) {
  try {
    const addressParts = parseAddress(address);
    if (!addressParts) return null;
    
    // Realtor.com home value estimator
    const searchTerm = encodeURIComponent(address);
    const url = `https://www.realtor.com/myhome/${searchTerm}`;
    
    console.log(`[REALTOR] Scraping: ${address}`);
    console.log(`[REALTOR] URL: ${url}`);
    
    const html = await scrapeWithDecodo(url);
    
    if (!html) {
      console.log(`[REALTOR] Failed to get HTML`);
      return null;
    }
    
    const price = extractPriceFromHTML(html);
    
    if (price) {
      console.log(`[REALTOR] Found estimate: $${price.toLocaleString()}`);
    } else {
      console.log(`[REALTOR] No estimate found`);
    }
    
    return price;
  } catch (error) {
    console.error(`[REALTOR-ERROR]:`, error.message);
    return null;
  }
}

async function processProperty(property) {
  const address = buildAddress(property);
  console.log(`\n[PROCESS] ${property._id}`);
  console.log(`[ADDRESS] ${address}`);
  
  if (!address || address.length < 15) {
    console.log(`[SKIP] Incomplete address`);
    return { success: false };
  }
  
  try {
    // Try Redfin first
    const redfinPrice = await getRedfinPrice(address);
    await sleep(3000);
    
    // Try Realtor.com second (replaces Chase since Chase is hard to automate)
    const realtorPrice = await getRealtorPrice(address);
    
    // Update database
    await db.collection('properties').updateOne(
      { _id: property._id },
      {
        $set: {
          redfinPrice: redfinPrice,
          realtorPrice: realtorPrice, // Using Realtor instead of Chase
          lastPriceSync: new Date(),
          priceSyncStatus: (redfinPrice || realtorPrice) ? 'success' : 'failed'
        }
      }
    );
    
    const rDisplay = redfinPrice ? `$${redfinPrice.toLocaleString()}` : '—';
    const rtDisplay = realtorPrice ? `$${realtorPrice.toLocaleString()}` : '—';
    console.log(`[RESULT] Redfin:${rDisplay} Realtor:${rtDisplay}`);
    
    return { success: !!(redfinPrice || realtorPrice) };
  } catch (error) {
    console.error(`[ERROR]:`, error.message);
    return { success: false };
  }
}

async function main() {
  let successCount = 0, failCount = 0;
  
  try {
    if (!DECODO_API_KEY) {
      throw new Error('DECODO_API_KEY is not set in .env file');
    }
    
    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db('deal_finder');
    console.log('[INIT] MongoDB connected');
    console.log('[INIT] Using Redfin + Realtor.com for valuations\n');
    
    const properties = await db.collection('properties')
      .find({
        fullAddress: { $exists: true, $ne: '' },
        $or: [
          { redfinPrice: { $exists: false } },
          { realtorPrice: { $exists: false } },
          { priceSyncStatus: 'failed' }
        ]
      })
      .limit(BATCH_SIZE)
      .toArray();
    
    console.log(`[INIT] Found ${properties.length} properties to sync\n`);
    
    if (properties.length === 0) {
      console.log('[INFO] No properties need syncing');
      return;
    }
    
    for (let i = 0; i < properties.length; i++) {
      console.log(`\n========== Property ${i + 1}/${properties.length} ==========`);
      
      const result = await processProperty(properties[i]);
      result.success ? successCount++ : failCount++;
      
      if (i < properties.length - 1) {
        const delay = DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
        console.log(`\n[DELAY] ${Math.round(delay/1000)}s until next property...`);
        await sleep(delay);
      }
    }
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[COMPLETE] Price sync finished`);
    console.log(`[STATS] Success: ${successCount}, Failed: ${failCount}`);
    if (successCount + failCount > 0) {
      console.log(`[STATS] Success Rate: ${Math.round(successCount/(successCount+failCount)*100)}%`);
    }
    console.log(`${'='.repeat(50)}`);
  } catch (error) {
    console.error('[FATAL]', error);
  } finally {
    if (mongoClient) await mongoClient.close();
  }
}

process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN]');
  if (mongoClient) await mongoClient.close().catch(() => {});
  process.exit(0);
});

main();
