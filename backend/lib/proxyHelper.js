// backend/lib/proxyHelper.js
import http from 'http';
import { Server as ProxyChainServer } from 'proxy-chain';
import { PROXY_BYPASS_CHASE } from '../services/proxyManager.js';

const BYPASS = (process.env.PROXY_BYPASS_DOMAINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);


function pickUpstream() {
  // Prefer explicit pool (PAID_PROXIES), else DECODO_GATEWAY
  const pool = (process.env.PAID_PROXIES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (pool.length > 0) {
    const choice = pool[Math.floor(Math.random() * pool.length)];
    // Normalize to URL
    const url = choice.startsWith('http') ? choice : `http://${choice}`;
    return url;
  }
  const gw = process.env.DECODO_GATEWAY;
  return gw && gw.startsWith('http') ? gw : null;
}

/**
 * Build Puppeteer args & start a local forwarder if usePaid is true.
 * - When usePaid=false: no proxy args are returned (banks go direct).
 * - When usePaid=true: starts a local HTTP proxy that forwards to your upstream
 *   (PAID_PROXIES or DECODO_GATEWAY) and returns --proxy-server + --proxy-bypass-list.
 */
export async function buildPuppeteerProxy({ usePaid = false, service = 'generic', sticky = false } = {}) {
    const svc = String(service || 'generic').toLowerCase();
  
    // Hard bypass for Chase/CoreLogic when requested
    if (svc === 'chase' && PROXY_BYPASS_CHASE) {
      return { args: [], localProxyUrl: null, close: async () => {} };
    }
  
   if (!usePaid) {
      // Direct connection (good defaults for banks)
      return { args: [], localProxyUrl: null, close: async () => {} };
    }

  const upstream = pickUpstream();
    if (!upstream) {
        // Fail-soft: go direct instead of crashing production
        return { args: [], localProxyUrl: null, close: async () => {} };
      }

  // Start a local HTTP forwarder that routes to the upstream proxy with auth
  const server = new ProxyChainServer({
    // This function lets proxy-chain forward *everything* through your upstream.
    prepareRequestFunction: ({ request, username, password, hostname, port, isHttp, connectionId }) => {
      return {
        upstreamProxyUrl: upstream,
        failMsg: 'Upstream proxy refused the connection',
      };
    },
    // Keep it quiet
    verbose: false,
  });

  await server.listen(0); // pick a free port
  const port = server.server.address().port;
  const localProxyUrl = `http://127.0.0.1:${port}`;

    // Build bypass list; add Chase/CoreLogic automatically if bypass is requested
    const extraBypass = (svc === 'chase' && PROXY_BYPASS_CHASE)
      ? ['*.chase.com', '*.corelogic.com', '*.valuemap.corelogic.com']
    : [];
    const bypassList = [...BYPASS, ...extraBypass].filter(Boolean).join(',');

  const args = [
    `--proxy-server=${localProxyUrl}`,
    bypassList ? `--proxy-bypass-list=${bypassList}` : '',
  ].filter(Boolean);

  return {
    args,
    localProxyUrl,
    close: async () => {
      try { await server.close(false); } catch (_) {}
    }
  };
}