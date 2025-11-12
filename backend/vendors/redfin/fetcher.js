// backend/vendors/redfin/fetcher.js
import axios from 'axios';
import pkg from 'https-proxy-agent';
 const { HttpsProxyAgent } = pkg;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = n => 500 * (2 ** n) + Math.floor(Math.random() * 250);

function defaultHeaders() {
  return {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
  };
}

function getDecodoAgent() {
  // Provide your Decodo endpoint like: http://user:pass@host:port
  // If Decodo is IP-whitelist only, use http://host:port and skip creds.
  const url = process.env.DECODO_PROXY_URL || process.env.PROXY_URL || '';
  if (!url) throw new Error('DECODO_PROXY_URL (or PROXY_URL) not set');
  return new HttpsProxyAgent(url);
}

// Public API: `render` is accepted for compatibility; the proxy handles JS as it’s configured.
export async function fetchHtml(url, { render = false } = {}) {
  const agent = getDecodoAgent();
  let lastErr;

  for (let i = 0; i < 4; i++) {
    try {
      const res = await axios.get(url, {
        headers: defaultHeaders(),
        timeout: 60000,
        httpsAgent: agent, // route via Decodo
        proxy: false,      // IMPORTANT when using a custom agent
        validateStatus: () => true,
      });

      if (res.status >= 200 && res.status < 300) {
        return typeof res.data === 'string' ? res.data : String(res.data);
      }

      // Retry on common block statuses
      if ([401, 403, 409, 412, 429, 500, 502, 503, 520].includes(res.status)) {
        lastErr = new Error(`HTTP ${res.status} (decodo) for ${url}`);
        await sleep(backoff(i));
        continue;
      }

      throw new Error(`HTTP ${res.status} (decodo) for ${url}`);
    } catch (err) {
      lastErr = err;
      await sleep(backoff(i));
    }
  }
  throw lastErr || new Error(`Failed to fetch ${url}`);
}