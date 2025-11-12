// backend/utils/requestFilters.js

// Lightweight host-based blocklist (trackers, analytics, ads, pixels).
// Keep stylesheets allowed by default; bots decide per-site if they want to block CSS.
export const defaultBlockList = [
  'doubleclick.net',
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'stats.g.doubleclick.net',
  'bat.bing.com',
  'facebook.net',
  'facebook.com/tr',
  'px.ads.linkedin.com',
  'snap.licdn.com',
  'segment.io',
  'cdn.segment.com',
  'hotjar.com',
  'mixpanel.com',
  'newrelic.com',
  'optimizely.com',
  'amplitude.com',
  'fullstory.com',
];

export function shouldBlockByHost(url = '') {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return defaultBlockList.some((needle) => host.includes(needle));
  } catch {
    return false;
  }
}

/**
 * Low-level Puppeteer Request handler factory.
 * Blocks requests whose URL matches blockList OR resource types you passed in,
 * but **never blocks stylesheets** here (leave that to installNetworkFilters()).
 */
export function makeRequestBlocker(blockList = defaultBlockList) {
  return (req) => {
    const type = req.resourceType?.();
    const url = req.url?.() || req.url || '';
    // Always allow stylesheets at this layer
    if (type === 'stylesheet') return req.continue?.() ?? req.continue();

    // Host-based block
    const hostBlocked = (() => {
      try {
        const h = new URL(url).hostname.toLowerCase();
        return blockList.some((needle) => h.includes(needle));
      } catch {
        return false;
      }
    })();

    if (hostBlocked) return req.abort?.() ?? req.abort();

    // Skip heavy types commonly safe to drop
    if (type === 'media' || type === 'font' || type === 'beacon' || type === 'ping') {
      return req.abort?.() ?? req.abort();
    }

    return req.continue?.() ?? req.continue();
  };
}

/**
 * Higher-level convenience: applies sane defaults per site.
 * - block: array of resource types to block (e.g., ['image','media','font','analytics','tracking'])
 * - allowStylesheets: if false, will block CSS; if true (default), keep CSS.
 */
export async function installNetworkFilters(page, { block = [], allowStylesheets = true } = {}) {
  if (!page) return;

  await page.setRequestInterception(true);

  page.on('request', (req) => {
    const type = req.resourceType?.();
    const url = req.url?.() || req.url || '';

    // CSS handling
    if (type === 'stylesheet') {
      if (allowStylesheets) return req.continue?.() ?? req.continue();
      return req.abort?.() ?? req.abort();
    }

    // Optional semantic toggles for convenience
    const typedBlock = new Set(block.map((s) => String(s).toLowerCase()));
    const isAnalyticsLike =
      shouldBlockByHost(url) ||
      url.includes('analytics') ||
      url.includes('pixel') ||
      url.includes('/collect');

    if (typedBlock.has('analytics') || typedBlock.has('tracking')) {
      if (isAnalyticsLike) return req.abort?.() ?? req.abort();
    }

    if (typedBlock.has(type)) {
      return req.abort?.() ?? req.abort();
    }

    // Always drop heavy types we rarely need
    if (type === 'beacon' || type === 'ping' || type === 'media' || type === 'font') {
      return req.abort?.() ?? req.abort();
    }

    return req.continue?.() ?? req.continue();
  });
}

/**
 * Homes.com special-case: keep CSS on, but block heavy/tracking.
 * Use like:
 *   page.on('request', makeHomesRequestBlocker());
 *   await page.setRequestInterception(true);
 */
export function makeHomesRequestBlocker() {
  const list = defaultBlockList.slice(); // keep css allowed, rely on handler logic
  const handler = makeRequestBlocker(list);
  return (req) => handler(req);
}