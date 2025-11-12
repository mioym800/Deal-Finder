// utils/proxy.js
const {
  PAID_PROXIES_BOFA = '',
  BOFA_PORT_ALLOWLIST = '',
  BOFA_PAGES_PER_PROXY = '2',
} = process.env;

function parseProxyUrl(url) {
  // Accepts http://user:pass@host:port or http://host:port
  // Returns { serverArg: 'http://host:port', auth: {username, password} | null }
  try {
    const u = new URL(url);
    const hostPort = `${u.hostname}:${u.port}`;
    const serverArg = `http://${hostPort}`;
    const auth = u.username
      ? { username: decodeURIComponent(u.username || ''), password: decodeURIComponent(u.password || '') }
      : null;
    return { serverArg, auth };
  } catch {
    return { serverArg: url, auth: null };
  }
}


const allow = new Set(
  BOFA_PORT_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean)
);

const raw = PAID_PROXIES_BOFA
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .filter(url => {
    const m = url.match(/:(\d+)\s*$/);
    return !allow.size || (m && allow.has(m[1]));
  });

let cursor = 0;

export function nextProxy() {
  if (!raw.length) return null;
  const idx = (cursor++) % raw.length;
  const url = raw[idx];
const parsed = parseProxyUrl(url); // { serverArg, auth }
  return { url, ...parsed, label: `decodo:${url.slice(-5)}` };
}

export function buildProxyArgs(serverArg) {
  if (!serverArg) return [];
  // Convert serverArg like "http://host:port" into http/https mappings
  let hostPort = serverArg;
  try {
    const u = new URL(serverArg);
    hostPort = `${u.hostname}:${u.port}`;
  } catch {}
  return [`--proxy-server=http=${hostPort};https=${hostPort}`];

}
export const PAGES_PER_PROXY = Number(BOFA_PAGES_PER_PROXY) || 2;

// helper for consumers that only have URL
export function getProxyAuthFromUrl(url) {
  return parseProxyUrl(url).auth;
}