// stickyProxyPool.js
import { getPreferredChromeProxy, markDeadProxy } from './proxyManager.js';

const slots = new Map(); // workerId -> { proxyInfo, expiresAt }
const blacklist = new Set();

export async function getStickyProxy(workerId, { preferPaid = true, ttlMs = 10*60*1000, service = 'generic', timeout=5000 } = {}) {
  const now = Date.now();
  const existing = slots.get(workerId);
  if (existing && existing.expiresAt > now && existing.proxyInfo) return existing.proxyInfo;

  // Try to obtain a new proxy up to two attempts (preferPaid then fallback)
  let proxyInfo = null;
  try {
    proxyInfo = await getPreferredChromeProxy({ service, preferPaid, timeout });
  } catch(e){ proxyInfo = null; }

  if ((!proxyInfo || !proxyInfo.arg) && preferPaid) {
    // fallback to non-paid pool
    try { proxyInfo = await getPreferredChromeProxy({ service, preferPaid: false, timeout }); } catch(e) { proxyInfo = null; }
  }

  if (!proxyInfo || !proxyInfo.arg) {
    throw new Error('NO_PROXY_AVAILABLE');
  }

  // Skip blacklisted proxy
  if (proxyInfo.arg) {
    const m = String(proxyInfo.arg).match(/^--proxy-server=http:\/\/(.+)$/i);
    const host = m ? m[1] : null;
    if (host && blacklist.has(host)) {
      // mark as dead in proxy manager if possible, then try again recursively (small guard)
      try { markDeadProxy(host); } catch {}
      return getStickyProxy(workerId, { preferPaid, ttlMs, service, timeout });
    }
  }

  slots.set(workerId, { proxyInfo, expiresAt: now + Math.max(1000, ttlMs) });
  return proxyInfo;
}

export function invalidateStickyProxy(workerId) {
  slots.delete(workerId);
}

export function reportDeadProxy(workerId, proxyInfo) {
  try {
    if (proxyInfo?.arg) {
      const m = String(proxyInfo.arg).match(/^--proxy-server=http:\/\/(.+)$/i);
      if (m && m[1]) {
        blacklist.add(m[1]);
        try { markDeadProxy(m[1]); } catch (e) {}
      }
    }
  } catch (e) {}
  invalidateStickyProxy(workerId);
}