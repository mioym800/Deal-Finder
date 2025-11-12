const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

// Enable stealth mode
puppeteer.use(StealthPlugin());

// Configuration from .env
const PROXY_ENABLED = process.env.PRICE_SYNC_PROXY_ENABLED === 'true';
const PROXY_GATEWAY = process.env.PRICE_SYNC_PROXY_GATEWAY || 'gate.decodo.com';
const PROXY_USER = process.env.PRICE_SYNC_PROXY_USER;
const PROXY_PASS = process.env.PRICE_SYNC_PROXY_PASS;
const PROXY_PORTS = (process.env.PRICE_SYNC_PROXY_PORTS || '10011,10012,10013').split(',');

const DELAY_MIN = parseInt(process.env.PRICE_SYNC_DELAY_MIN_MS || '5000');
const DELAY_MAX = parseInt(process.env.PRICE_SYNC_DELAY_MAX_MS || '10000');
const BATCH_SIZE = parseInt(process.env.PRICE_SYNC_BATCH_SIZE || '20');
const NAV_TIMEOUT = parseInt(process.env.PRICE_SYNC_NAV_TIMEOUT_MS || '60000');
const HEADLESS = process.env.PRICE_SYNC_HEADLESS !== 'false';
const DEBUG = process.env.PRICE_SYNC_DEBUG === '1';
const SCREENSHOT_ON_ERROR = process.env.PRICE_SYNC_SCREENSHOT_ON_ERROR === '1';
const DEBUG_DIR = process.env.PRICE_SYNC_DEBUG_DIR || '/tmp/price_sync_debug';

let mongoClient;
let db;
let browser;
let currentProxyIndex = 0;

// Rotate through proxy ports
function getNextProxy() {
  if (!PROXY_ENABLED || !PROXY_USER || !PROXY_PASS) {
    return null;
  }
  
  const port = PROXY_PORTS[currentProxyIndex];
  currentProxyIndex = (currentProxyIndex + 1) % PROXY_PORTS.length;
  
  return {
    server: `${PROXY_GATEWAY}:${port}`,
    username: PROXY_USER,
    password: PROXY_PASS
  };
}

async function initBrowser() {
  const launchOptions = {
    headless: HEADLESS ? 'new' : false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      `--window-size=${1200 + Math.floor(Math.random() * 400)},${800 + Math.floor(Math.random() * 400)}`
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH
  };

  browser = await puppeteer.launch(launchOptions);
  console.log('[INIT] Browser launched');
  return browser;
}

async function createStealthPage(browser, useProxy = true) {
  const page = await browser.newPage();

  // Get proxy for this page
  const proxy = useProxy ? getNextProxy() : null;
  
  if (proxy) {
    // Set proxy via Chrome DevTools Protocol
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    
    // Configure proxy authentication
    await page.authenticate({
      username: proxy.username,
      password: proxy.password
    });
    
    if (DEBUG) {
      console.log(`[PROXY] Using ${proxy.server}`);
    }
  }

  // Set realistic viewport
  await page.setViewport({
    width: 1200 + Math.floor(Math.random() * 400),
    height: 800 + Math.floor(Math.random() * 400),
    deviceScaleFactor: 1,
    hasTouch: false,
    isLandscape: false,
    isMobile: false
  });

  // Randomize user agent
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];
  await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);

  // Anti-detection measures
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    
    // Mock Chrome properties
    window.chrome = { runtime: {} };
    
    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });

  // Set extra headers
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0'
  });

  // Block unnecessary resources to speed up
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  return page;
}

function randomDelay() {
  return DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN);
}

async function humanBehavior(page) {
  // Random scroll
  await page.evaluate(() => {
    window.scrollBy(0, Math.floor(Math.random() * 300) + 100);
  });
  await page.waitForTimeout(1000 + Math.random() * 2000);
  
  // Random mouse movement
  const viewport = page.viewport();
  await page.mouse.move(
    Math.random() * viewport.width,
    Math.random() * viewport.height
  );
  await page.waitForTimeout(500 + Math.random() * 1000);
}

async function scrapeMovoto(address, page) {
  try {
    // Clean address for URL
    const searchTerm = address.replace(/,/g, '').replace(/\s+/g, '-').toLowerCase();
    const searchUrl = `https://www.movoto.com/${searchTerm}`;
    
    if (DEBUG) console.log(`[MOVOTO] Navigating to: ${searchUrl}`);
    
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT
    });

    await page.waitForTimeout(2000 + Math.random() * 3000);
    await humanBehavior(page);

    // Try multiple price selectors
    const price = await page.evaluate(() => {
      const selectors = [
        '[data-testid="property-price"]',
        '.property-price',
        '[class*="PropertyPrice"]',
        '[class*="price"]',
        'span[class*="Price"]',
        'div[class*="price"]'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = element.textContent.trim();
          const match = text.match(/\$[\d,]+/);
          if (match) {
            const cleanPrice = match[0].replace(/[$,]/g, '');
            const numPrice = parseInt(cleanPrice);
            // Sanity check: price should be reasonable (20k - 50M)
            if (numPrice >= 20000 && numPrice <= 50000000) {
              return numPrice;
            }
          }
        }
      }
      return null;
    });

    if (DEBUG && price) console.log(`[MOVOTO] Found price: $${price}`);
    return price;
  } catch (error) {
    console.error(`[MOVOTO-ERROR] ${address}:`, error.message);
    
    if (SCREENSHOT_ON_ERROR) {
      try {
        const fs = require('fs');
        if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const filename = `${DEBUG_DIR}/movoto_${Date.now()}.png`;
        await page.screenshot({ path: filename, fullPage: true });
        console.log(`[MOVOTO] Screenshot saved: ${filename}`);
      } catch (e) {}
    }
    
    return null;
  }
}

async function scrapeZillow(address, page) {
  try {
    // Zillow uses address in URL format
    const searchTerm = address.replace(/,/g, '').replace(/\s+/g, '-').toLowerCase();
    const searchUrl = `https://www.zillow.com/homes/${searchTerm}_rb/`;
    
    if (DEBUG) console.log(`[ZILLOW] Navigating to: ${searchUrl}`);
    
    await page.goto(searchUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT
    });

    await page.waitForTimeout(2000 + Math.random() * 3000);
    await humanBehavior(page);

    // Extract price
    const price = await page.evaluate(() => {
      const selectors = [
        '[data-test="property-card-price"]',
        'span[data-test="property-card-price"]',
        '[class*="PropertyCardWrapper__StyledPriceLine"]',
        '[data-testid="price"]',
        '.price',
        'span[class*="price"]'
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        for (const element of elements) {
          const text = element.textContent.trim();
          const match = text.match(/\$[\d,]+/);
          if (match) {
            const cleanPrice = match[0].replace(/[$,]/g, '');
            const numPrice = parseInt(cleanPrice);
            if (numPrice >= 20000 && numPrice <= 50000000) {
              return numPrice;
            }
          }
        }
      }
      return null;
    });

    if (DEBUG && price) console.log(`[ZILLOW] Found price: $${price}`);
    return price;
  } catch (error) {
    console.error(`[ZILLOW-ERROR] ${address}:`, error.message);
    
    if (SCREENSHOT_ON_ERROR) {
      try {
        const fs = require('fs');
        if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const filename = `${DEBUG_DIR}/zillow_${Date.now()}.png`;
        await page.screenshot({ path: filename, fullPage: true });
        console.log(`[ZILLOW] Screenshot saved: ${filename}`);
      } catch (e) {}
    }
    
    return null;
  }
}

async function processProperty(property) {
  const address = `${property.streetNumber || ''} ${property.streetName || ''} ${property.streetType || ''}, ${property.city || ''}, ${property.state || ''}, ${property.zip || ''}`.trim();
  
  console.log(`[AI-GET] ${property._id} :: ${address}`);

  let page;
  try {
    page = await createStealthPage(browser, PROXY_ENABLED);

    // Scrape Movoto
    const movotoPrice = await scrapeMovoto(address, page);
    await page.waitForTimeout(randomDelay());
    
    // Create new page for Zillow (fresh context)
    await page.close();
    page = await createStealthPage(browser, PROXY_ENABLED);
    
    // Scrape Zillow
    const zillowPrice = await scrapeZillow(address, page);

    // Update database
    await db.collection('properties').updateOne(
      { _id: property._id },
      {
        $set: {
          movotoPrice: movotoPrice,
          zillowPrice: zillowPrice,
          lastPriceSync: new Date(),
          priceSyncStatus: (movotoPrice || zillowPrice) ? 'success' : 'failed'
        }
      }
    );

    const movotoDisplay = movotoPrice ? `$${movotoPrice.toLocaleString()}` : '—';
    const zillowDisplay = zillowPrice ? `$${zillowPrice.toLocaleString()}` : '—';
    console.log(`[OK] ${property._id} -> M:${movotoDisplay} Z:${zillowDisplay}`);

    return { 
      success: !!(movotoPrice || zillowPrice),
      movotoPrice, 
      zillowPrice 
    };
  } catch (error) {
    console.error(`[ERROR] ${property._id}:`, error.message);
    
    await db.collection('properties').updateOne(
      { _id: property._id },
      {
        $set: {
          priceSyncStatus: 'error',
          priceSyncError: error.message,
          lastPriceSync: new Date()
        }
      }
    );
    
    return { success: false, movotoPrice: null, zillowPrice: null };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

async function main() {
  let successCount = 0;
  let failCount = 0;

  try {
    // Connect to MongoDB
    mongoClient = new MongoClient(process.env.MONGO_URI);
    await mongoClient.connect();
    db = mongoClient.db('deal_finder');

    console.log('[INIT] Connected to MongoDB');

    // Initialize browser
    await initBrowser();
    console.log(`[INIT] Browser initialized (Headless: ${HEADLESS}, Proxy: ${PROXY_ENABLED})`);

    // Get properties to sync
    const properties = await db.collection('properties')
      .find({
        $or: [
          { movotoPrice: { $exists: false } },
          { zillowPrice: { $exists: false } },
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

    // Process properties sequentially
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      console.log(`\n[PROGRESS] ${i + 1}/${properties.length}`);
      
      const result = await processProperty(property);
      
      if (result.success) {
        successCount++;
      } else {
        failCount++;
      }
      
      // Delay between properties
      if (i < properties.length - 1) {
        const delay = randomDelay();
        if (DEBUG) console.log(`[DELAY] Waiting ${Math.round(delay/1000)}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    console.log(`\n[COMPLETE] Price sync finished`);
    console.log(`[STATS] Success: ${successCount}, Failed: ${failCount}, Rate: ${Math.round(successCount/(successCount+failCount)*100)}%`);
  } catch (error) {
    console.error('[FATAL]', error);
  } finally {
    if (browser) {
      await browser.close();
    }
    if (mongoClient) {
      await mongoClient.close();
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Closing...');
  if (browser) await browser.close().catch(() => {});
  if (mongoClient) await mongoClient.close().catch(() => {});
  process.exit(0);
});

main();
