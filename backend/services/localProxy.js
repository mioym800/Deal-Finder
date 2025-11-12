// backend/services/localProxy.js
// ESM-only. Requires: npm i proxy-chain

import { Server as ProxyChainServer } from 'proxy-chain';
import { randomUUID } from 'crypto';

function ensureProxySafetyFlags(args) {
  const hasProxy = Array.isArray(args) && args.some(a => typeof a === 'string' && a.startsWith('--proxy-server='));
  if (!hasProxy) return args;
  const needBypass = !args.some(a => typeof a === 'string' && a.startsWith('--proxy-bypass-list='));
  const needNoQuic = !args.includes('--disable-quic');
  if (needBypass) args.push('--proxy-bypass-list=<-loopback>');
  if (needNoQuic) args.push('--disable-quic');
  return args;
}

// Start a local HTTP proxy that forwards to the authenticated upstream proxy
export async function startLocalForwarder(upstreamProxyUrl) {
  if (!upstreamProxyUrl) {
    throw new Error('startLocalForwarder: missing upstreamProxyUrl');
  }

  const server = new ProxyChainServer({
    port: 0, // random free port
    prepareRequestFunction: () => {
      return { upstreamProxyUrl }; // forward every request to Decodo (or other gateway)
    },
  });

  await server.listen();
  const port = server.port;
  const localUrl = `http://127.0.0.1:${port}`;

  const id = randomUUID();
  const close = async () => {
    try {
      await server.close();
    } catch {}
  };

  return { id, port, localUrl, close, server };
}

// Build Chrome/Puppeteer proxy args
export function makeChromeProxyArgs({ localProxyUrl, bypassList = [] } = {}) {
  const args = [];
  if (localProxyUrl) {
    args.push(`--proxy-server=${localProxyUrl}`);
  }
  const list = (bypassList || [])
    .map(s => String(s).trim())
    .filter(Boolean);
  if (list.length) {
    args.push(`--proxy-bypass-list=${list.join(';')}`);
  }
  return ensureProxySafetyFlags(args);
}

// Read env, start local forwarder if enabled, and return launch args + teardown
export async function setupPaidProxyFromEnv({
  serviceFlagEnv = 'USE_PAID',
  bypassEnv = 'PROXY_BYPASS_DOMAINS',
} = {}) {
  // Per-vendor toggle, e.g. MOVOTO_USE_PAID, PRIVY_USE_PAID, etc. Defaults to true if unset.
  const usePaid = (() => {
    const v = process.env[serviceFlagEnv];
    if (v == null || v === '') return true;
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
  })();

  const bypassRaw = process.env[bypassEnv] || '';
  const bypassList = bypassRaw
    .split(/[,\s;]+/)
    .map(s => s.trim())
    .filter(Boolean);

  // Upstream (Decodo) can be provided as full gateway or split parts
  let upstream = process.env.DECODO_GATEWAY;
  if (!upstream) {
    const host = process.env.DECODO_HOST;
    const port = process.env.DECODO_PORT;
    const user = process.env.DECODO_USER;
    const pass = process.env.DECODO_PASS;
    if (host && port && user && pass) {
      upstream = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
  }

  // If not using paid or no upstream configured, just return no proxy args.
  if (!usePaid || !upstream) {
    return { args: makeChromeProxyArgs({}), forwarder: null, used: false };
  }

  // Spin local forwarder that authenticates to upstream and give Chrome a local, unauthenticated hop
  const fwd = await startLocalForwarder(upstream);
  let args = makeChromeProxyArgs({ localProxyUrl: fwd.localUrl, bypassList });
  args = ensureProxySafetyFlags(args);

  return { args, forwarder: fwd, used: true };
}

// Back-compat wrapper used by vendor bots
export async function buildPuppeteerProxy({
  serviceFlagEnv = 'USE_PAID',
  bypassEnv = 'PROXY_BYPASS_DOMAINS',
} = {}) {
  const { args, forwarder, used } = await setupPaidProxyFromEnv({ serviceFlagEnv, bypassEnv });
  const arg = (args || []).find(a => a.startsWith('--proxy-server=')) || null;
  return { args, arg, forwarder, used };
}