// vendors/bofa/ensureBofaPageSetup.js
const HOME_URL = 'https://homevaluerealestatecenter.bankofamerica.com/';

export async function ensureBofaPageSetup(page) {
  // Lightweight request filtering — DO NOT enable if your pool already set it
  try {
    // If interception is already on by the pool, don't re-register
    const hasHandlers = page.listenerCount('request') > 0;
    if (!hasHandlers) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const t = req.resourceType();
        if (t === 'image' || t === 'media' || t === 'font') {
          return req.abort();
        }
        req.continue();
      });
    }
  } catch {}

  // Viewport + UA are optional; keep conservative
  try {
    await page.setViewport({ width: 1366, height: 900 });
  } catch {}

  // Go to BoA home if we aren't already there
  if (!page.url().startsWith(HOME_URL)) {
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  }

  // Ensure search UI is present
  await page.waitForSelector('label.hvt-search-form__label[for="address"]', { timeout: 25000 });
  await page.waitForSelector('#address', { timeout: 25000 });

  // Small no-op evaluate to stabilize unhandledrejection noise
  try {
    await page.evaluate(() => {
      if (!window.__dedupeUnhandled) {
        window.__dedupeUnhandled = true;
        window.addEventListener('unhandledrejection', () => {});
      }
    });
  } catch {}

  return page;
}

export default ensureBofaPageSetup;