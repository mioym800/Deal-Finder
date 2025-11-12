// backend/utils/proxyBuilder.js
// Helpers for working with vendor-scoped proxy pools and Puppeteer args

import HttpsProxyAgentPkg from 'https-proxy-agent';
const { HttpsProxyAgent } = HttpsProxyAgentPkg; // CJS-safe named extract
import { log } from './logger.js';
const L = log.child('proxy');

// Decide which proxy mode to use for a given vendor based on env:
// PROXY_VENDOR_PRIVY=paid|free|any, PROXY_VENDOR_BOFA=..., or PROXY_VENDOR_DEFAULT=...
function resolveVendorMode(vendor, env = process.env) {
  const key = `PROXY_VENDOR_${String(vendor || '').toUpperCase()}`;
  const envMode = env[key] || env.PROXY_VENDOR_DEFAULT || '';
  const mode = String(envMode).trim().toLowerCase(); // 'paid' | 'free' | 'any'

  // Honor hard override to force paid proxies globally
  const forcePaid = String(env.PROXY_FORCE_PAID_ONLY || '').toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(forcePaid)) {
    return 'paid';
  }

  return ['paid', 'free', 'any'].includes(mode) ? mode : 'any';
}

// Normalize a comma-separated list (helper kept local to avoid export changes)
function _splitListLocal(s) {
  return String(s || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);
}

// Build a "paid" pool from multiple env fallbacks (most specific first).
// Accepts:
//   - Per-vendor list: PAID_PROXIES_PRIVY / PAID_PROXIES_BOFA
//   - Global list:    PAID_PROXIES
//   - Single URL:     DECODO_HTTP_PROXY_URL or PAID_PROXY_URL
//   - Gateway pieces: PROXY_PAID_GATEWAY, PROXY_PAID_USER, PROXY_PAID_PASS  -> http://user:pass@gateway
function buildPaidPoolFor(vendor, env = process.env) {
  const perVendor =
    (vendor === 'privy' && env.PAID_PROXIES_PRIVY) ||
    (vendor === 'bofa' && env.PAID_PROXIES_BOFA) || '';

  let list = _splitListLocal(perVendor || env.PAID_PROXIES || '');

  // Allow a single fully-qualified proxy URL as a pool of one
  const singleUrl = env.DECODO_HTTP_PROXY_URL || env.PAID_PROXY_URL || '';
  if (!list.length && singleUrl) list = [singleUrl.trim()];

  // Accept Decodo gateway envs as well:
  // - DECODO_GATEWAY can be a full URL (with scheme and creds) or host:port
  // - DECODO_USER / DECODO_PASS can provide credentials when DECODO_GATEWAY lacks them
  if (!list.length && env.DECODO_GATEWAY) {
    const gw = env.DECODO_GATEWAY.trim();
    if (/^https?:\/\//i.test(gw)) {
      // Already a full URL (possibly with creds)
      list = [gw];
    } else {
      const user = env.DECODO_USER || '';
      const pass = env.DECODO_PASS || '';
      if (user && pass) {
        list = [`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${gw}`];
      } else {
        list = [`http://${gw}`];
      }
    }
  }

  // Allow gateway pieces
  if (!list.length && env.PROXY_PAID_GATEWAY) {
    const hostPort = env.PROXY_PAID_GATEWAY.trim(); // e.g. gate.decodo.com:10001
    const user = env.PROXY_PAID_USER || '';
    const pass = env.PROXY_PAID_PASS || '';
    if (user && pass) {
      list = [`http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${hostPort}`];
    } else {
      list = [`http://${hostPort}`];
    }
  }

  return list;
}

// Build a "free" pool (optional): FREE_PROXIES (comma separated)
function buildFreePool(env = process.env) {
  return _splitListLocal(env.FREE_PROXIES || '');
}

// Backwards-compatible export that now honors vendor mode + rich fallbacks.
export function getVendorProxyPool(vendor, env = process.env) {
  const mode = resolveVendorMode(vendor, env);

  let pool = [];
  if (mode === 'paid' || mode === 'any') {
    pool = buildPaidPoolFor(vendor, env);
  }
  if ((!pool || pool.length === 0) && (mode === 'free' || mode === 'any')) {
    const freePool = buildFreePool(env);
    if (freePool.length) pool = freePool;
  }

  if (!pool || pool.length === 0) {
    L.warn('No proxies configured for vendor; will throw', { vendor, mode });
    throw new Error(`No proxies configured for ${vendor}`);
  }

  // Optional port allowlist for BofA
  if (String(vendor || '').toLowerCase() === 'bofa') {
    const allow = (process.env.BOFA_PORT_ALLOWLIST || '')
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));
    if (allow.length) {
      const isAllowed = (entry) => {
        try {
          const e = String(entry || '').trim();
          if (e.includes('://')) {
            const u = new URL(e);
            return allow.includes(Number(u.port));
          }
          const parts = e.split(':');
          const port = Number(parts[1]);
          return allow.includes(port);
        } catch {
          return false;
        }
      };
      pool = pool.filter(isAllowed);
      if (!pool.length) {
        L.warn('All BofA proxies filtered out by BOFA_PORT_ALLOWLIST', { allow });
      }
    }
  }

  return pool;
}

// Convert proxy entry into puppeteer launch arg + credentials and a normalized URL
// Accepts:
//  - full URL:            http://user:pass@host:port
//  - colon format (4-tok) host:port:user:pass
//  - host:port            host:port
export function toProxyArg(entryRaw) {
  const entry = String(entryRaw || '').trim();
  if (!entry) return null;

  // Already a URL?
  if (/^https?:\/\//i.test(entry)) {
    try {
      const u = new URL(entry);
      const arg = `--proxy-server=${u.protocol}//${u.host}`;
      const credentials = (u.username || u.password)
        ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
        : null;
      return { url: u.toString(), arg, credentials, host: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80') };
    } catch {
      return null;
    }
  }

  const parts = entry.split(':').map(s => s.trim());
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    const url = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    const arg = `--proxy-server=http://${host}:${port}`;
    const credentials = { username: user, password: pass };
    return { url, arg, credentials, host, port, user, pass };
  }
  if (parts.length === 2) {
    const [host, port] = parts;
    const url = `http://${host}:${port}`;
    const arg = `--proxy-server=http://${host}:${port}`;
    return { url, arg, credentials: null, host, port };
  }
  return null;
}

export function buildHttpsAgent(fromEntry) {
  try {
    const norm = toProxyArg(fromEntry);
    if (!norm?.url) throw new Error('NO_PROXY_URL');
    // Construct with a proper URL instance to avoid "Invalid URL"
    return new HttpsProxyAgent(new URL(norm.url));
  } catch (e) {
    throw new Error(e?.message || 'INVALID_PROXY');
  }
}

// Round-robin supplier from a pool array (immutable).
export function makeProxySupplierFromPool(pool) {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('Empty proxy pool');
  let i = 0;
  return function next() {
    const entry = pool[i++ % pool.length];
    // Accept both already-normalized objects and URL/colon strings
    if (entry && typeof entry === 'object' && entry.arg) {
      return entry;
    }
    if (typeof entry === 'string') {
      const norm = toProxyArg(entry);
      if (!norm) throw new Error('Proxy supplier received invalid proxy URL string');
      return norm;
    }
    throw new Error('Proxy supplier received unsupported entry type');
  };
}

// Round-robin supplier with sticky username sessions (e.g., for Decodo).
// `keyFn(ctx)` → stable key (like state/zip) to reuse the same session.
// Each unique key gets assigned the next pool entry; username is suffixed with "-session-XXXX".
export function makeStickyProxySupplier(pool, keyFn = null) {
  if (!Array.isArray(pool) || pool.length === 0) throw new Error('Empty proxy pool');
  const assigned = new Map();
  let i = 0;

  return function next(ctx = null) {
    const key = keyFn ? keyFn(ctx) : null;

    // Reuse previously assigned sticky proxy if available
    if (key && assigned.has(key)) {
      return assigned.get(key);
    }

    // Get next base proxy from pool (string or normalized object)
    const baseEntry = pool[i++ % pool.length];
    const norm = (baseEntry && typeof baseEntry === 'object' && baseEntry.arg)
      ? baseEntry
      : toProxyArg(String(baseEntry || ''));
    if (!norm?.url) throw new Error('Sticky supplier received invalid proxy');

    // Mutate username to include a session suffix so provider keeps IP sticky
    const u = new URL(norm.url);
    const baseUser = u.username ? decodeURIComponent(u.username).split('-session-')[0] : '';
    // derive session id from key (stable) or random (unstable)
    const sessSeed = key ? String(key) : Math.random().toString(36).slice(2);
    // short, URL-safe suffix
    const sessSuffix = Buffer.from(sessSeed).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'sess';
    if (baseUser) {
      u.username = encodeURIComponent(`${baseUser}-session-${sessSuffix}`);
    }

    const proxy = {
      url: u.toString(),
      arg: `--proxy-server=${u.protocol}//${u.host}`,
      credentials: (u.username || u.password)
        ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }
        : null,
      host: u.hostname,
      port: u.port || (u.protocol === 'https:' ? '443' : '80')
    };

    if (key) assigned.set(key, proxy);
    return proxy;
  };
}

// --- agent helpers (for HTTP prechecks etc.) --------------------------------
// Accept shapes: { arg: "--proxy-server=http://host:port", credentials:{username,password} }
// or { host, port, user, pass } or { entry: "host:port:user:pass" }
export function parseProxyArg(proxyInfo) {
  if (!proxyInfo) return null;

    // NEW: accept strings directly
  if (typeof proxyInfo === 'string') {
    const s = proxyInfo.trim();
    if (!s) return null;
    // URL?
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        const username = u.username ? decodeURIComponent(u.username) : null;
        const password = u.password ? decodeURIComponent(u.password) : null;
        return { host: u.hostname, port: u.port || (u.protocol === 'https:' ? '443' : '80'), username, password };
      } catch {
        return null;
      }
    }
    const parts = s.split(':').map(x => x.trim());
    if (parts.length === 4) {
      const [host, port, username, password] = parts;
      return { host, port, username, password };
    }
    if (parts.length === 2) {
      const [host, port] = parts;
      return { host, port, username: null, password: null };
    }
  }

  // 1) --proxy-server form
  if (proxyInfo.arg) {
    const m = String(proxyInfo.arg).match(/^--proxy-server=http:\/\/([^:\/]+):(\d+)/i);
    if (m) {
      const host = m[1], port = m[2];
      const cred = proxyInfo.credentials || proxyInfo.creds || null;
      const username = cred?.username || cred?.user || cred?.name || null;
      const password = cred?.password || cred?.pass || null;
      return { host, port, username, password };
    }
  }

  // 2) explicit host/port + creds
  if (proxyInfo.host && proxyInfo.port) {
    const username = proxyInfo.username || proxyInfo.user || proxyInfo.credentials?.username || proxyInfo.creds?.user || null;
    const password = proxyInfo.password || proxyInfo.pass || proxyInfo.credentials?.password || proxyInfo.creds?.pass || null;
    return { host: proxyInfo.host, port: proxyInfo.port, username, password };
  }

  // 3) entry: "host:port:user:pass"
  if (proxyInfo.entry && typeof proxyInfo.entry === 'string') {
    const [host, port, username, password] = proxyInfo.entry.split(':');
    if (host && port) return { host, port, username, password };
  }

  return null;
}

export function buildAuthProxyUrl(proxyInfo) {
  const p = parseProxyArg(proxyInfo);
  if (!p) return null;
  if (p.username && p.password) {
    return `http://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.host}:${p.port}`;
  }
  return `http://${p.host}:${p.port}`;
}

// quick HEAD request through agent to verify the proxy can reach a domain
export async function precheckPaidProxyForUrl(url, proxyInfo) {
  try {
    let proxyUrl = null;
    if (proxyInfo) proxyUrl = buildAuthProxyUrl(proxyInfo);
    // Fallback to env (must be a FULL URL incl. creds)
    if (!proxyUrl) proxyUrl = process.env.DECODO_HTTP_PROXY_URL || process.env.PAID_PROXY_URL || null;
    if (!proxyUrl || !/^https?:\/\/.+:\d+/.test(proxyUrl)) {
      return false; // precheck unavailable
    }

    const agent = buildHttpsAgent(proxyUrl);
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      agent,
      signal: AbortSignal.timeout(8000)
    });
    return !!res;
  } catch {
    return false;
  }
}

// NOTE: avoid building agents in warmers; rely on `precheckPaidProxyForUrl(url, proxyInfo)`
// which gracefully handles missing/invalid URLs.

// Convenience: build a sticky supplier for BofA using the configured pool.
// Example keyFn: (prop) => prop?.state || prop?.zip
export function getStickyBofaProxySupplier(keyFn = null, env = process.env) {
  const pool = getVendorProxyPool('bofa', env);
  return makeStickyProxySupplier(pool, keyFn);
}