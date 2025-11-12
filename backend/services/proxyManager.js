import net from 'node:net';
import ProxyChain from 'proxy-chain';
import https from 'node:https';
import http from 'node:http';
import * as HttpsProxyAgentNS from 'https-proxy-agent';
// Support both v5 (default export) and v7+ (named export)
const HttpsProxyAgentCtor =
  (HttpsProxyAgentNS && (HttpsProxyAgentNS.HttpsProxyAgent || HttpsProxyAgentNS.default)) ||
  HttpsProxyAgentNS;

const DECODO_ENABLED = String(process.env.DECODO_ENABLED || 'true').toLowerCase() !== 'false';
const DECODO_GATEWAY = process.env.DECODO_GATEWAY || '';
const DECODO_COUNTRY = process.env.DECODO_COUNTRY || 'us';

const BOFA_USE_PAID = String(process.env.BOFA_USE_PAID || 'true').toLowerCase() !== 'false';
const CHASE_USE_PAID = String(process.env.CHASE_USE_PAID || 'true').toLowerCase() !== 'false';
const MOVOTO_USE_PAID = String(process.env.MOVOTO_USE_PAID || 'true').toLowerCase() !== 'false';
const PRIVY_USE_PAID = String(process.env.PRIVY_USE_PAID || 'true').toLowerCase() !== 'false';
const HOMES_USE_PAID = String(process.env.HOMES_USE_PAID || 'true').toLowerCase() !== 'false';
const REALTOR_USE_PAID = String(process.env.REALTOR_USE_PAID || 'true').toLowerCase() !== 'false';

export const PROXY_BYPASS_CHASE = String(process.env.PROXY_BYPASS_CHASE || 'false').toLowerCase() === 'true';

// Ensure safety flags are present when using a proxy
function ensureProxySafetyFlags(args) {
  const hasProxy = Array.isArray(args) && args.some(a => typeof a === 'string' && a.startsWith('--proxy-server='));
  if (!hasProxy) return args;

  const needBypass = !args.some(a => typeof a === 'string' && a.startsWith('--proxy-bypass-list='));
  const needNoQuic = !args.includes('--disable-quic');

  if (needBypass) args.push('--proxy-bypass-list=<-loopback>');
  if (needNoQuic) args.push('--disable-quic');

  return args;
}
function extractHostname(input) {
  if (!input) return '';
  try {
    // If it's a full URL
    const u = new URL(input);
    return u.hostname || '';
  } catch {
    // Otherwise assume it's already a hostname
    const s = String(input).trim();
    // strip port if present
    const m = s.match(/^\[?[a-z0-9:.%-]+\]?/i);
    return m ? m[0].replace(/:\d+$/, '') : s;
  }
}

export function shouldBypass(hostname) {
  const h = extractHostname(hostname).toLowerCase();
  if (!h) return false;

  // Conditional bypass for Chase/CoreLogic controlled by PROXY_BYPASS_CHASE
  if (PROXY_BYPASS_CHASE && (
    /\.chase\.com$/i.test(h) ||
    /\.corelogic\.com$/i.test(h) ||
    /(^|\.)valuemap\.corelogic\.com$/i.test(h)
  )) {
    return true;
  }

  // --- existing/general bypass rules go here (keep minimal + safe) ---
  // Local/loopback & link-local should never go through proxies
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;

  return false;
}

export function shouldBypassUrl(urlOrHostname) {
  return shouldBypass(extractHostname(urlOrHostname));
}

// ==== Paid proxies pool (env: PAID_PROXIES) ====
// Accepts either "user:pass@host:port" or "host:port:user:pass", comma/space separated.
const RAW_PAID_PROXIES = process.env.PAID_PROXIES || '';

function normalizePaidEntry(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  if (str.includes('@')) {
    // Already user:pass@host:port, allow http(s) prefix or bare
    const noProto = str.replace(/^https?:\/\//i, '');
    return `http://${noProto}`;
  }
  // host:port:user:pass
  const parts = str.split(':');
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    if (host && port && user && pass) return `http://${user}:${pass}@${host}:${port}`;
  }
  return null;
}

const PAID_POOL = RAW_PAID_PROXIES
  .split(/[,\s]+/)
  .map(normalizePaidEntry)
  .filter(Boolean);

// ==== Local forwarder farm (sticky & multi-forwarder) ====
// We pre-spawn anonymized local proxies (http://127.0.0.1:port) that each forward to a specific paid upstream.
// This allows many concurrent Chrome instances to use distinct local ports without bottlenecking a single forwarder.
const FORWARDER_TARGET_COUNT = Number(process.env.FORWARDER_COUNT || process.env.AUTOCONCURRENCY_CAP || 40);

let _fwdRR = 0;
const _forwarders = []; // { id, upstream, localUrl, port, busy, createdAt }
const _stickyMap = new Map(); // key(string) -> forwarder

// --- Global concurrency calculation (single source of truth) ---
function envConcurrencyCap() {
  // Explicit env overrides (first match wins)
  const picks = [
    Number(process.env.GLOBAL_CONCURRENCY),
    Number(process.env.CONCURRENCY),
    Number(process.env.AUTOMATION_CONCURRENCY),
    Number(process.env.AUTOCONCURRENCY_CAP),
  ].map(n => Number.isFinite(n) && n > 0 ? n : null).filter(Boolean);
  // Default ceiling if nothing is set
  return picks.length ? Math.max(1, Math.floor(picks[0])) : 40;
}

export function getForwarderSummary() {
  return {
    count: _forwarders.length,
    ports: _forwarders.map(f => f.port).filter(Boolean),
  };
}

export function getGlobalConcurrencyInfo() {
  const envCap = envConcurrencyCap();

  // Treat number of spawned forwarders as "healthy paid IPs" proxy for capacity
  const healthyPaidIPs = _forwarders.length;

  // Default when we don't have forwarders yet
  const baseDefault = 4;

  // Auto concurrency heuristic:
  // - If we have paid forwarders, cap at 5 (good stability) and at the number of forwarders.
  // - Otherwise use a conservative base default.
  const autoConcurrency = healthyPaidIPs
    ? Math.max(1, Math.min(5, healthyPaidIPs))
    : baseDefault;

  const effective = Math.max(1, Math.min(envCap, autoConcurrency));

  return {
    envConcurrency: envCap,
    healthyPaidIPs,
    autoConcurrency,
    effectiveConcurrency: effective,
  };
}

// Back-compat short getter
export function getGlobalConcurrency() {
  return getGlobalConcurrencyInfo().effectiveConcurrency;
}

async function spawnForwarder(upstream, idx) {
  // ProxyChain.anonymizeProxy() returns a local URL like http://127.0.0.1:59xxx and keeps a server alive.
  const localUrl = await ProxyChain.anonymizeProxy(upstream);
  const portMatch = String(localUrl).match(/:(\d+)\b/);
  const port = portMatch ? Number(portMatch[1]) : null;
  const rec = { id: `fwd_${idx}_${Date.now()}`, upstream, localUrl, port, busy: 0, createdAt: Date.now() };
  _forwarders.push(rec);
  return rec;
}

export async function warmLocalForwarders(n = FORWARDER_TARGET_COUNT) {
  // If no paid upstreams configured, nothing to do.
  if (!DECODO_ENABLED) return 0;
  if (!PAID_POOL.length && !DECODO_GATEWAY) return 0;

  // Determine upstream list to use for spawning.
  const upstreams = PAID_POOL.length ? [...PAID_POOL] : (DECODO_GATEWAY ? [DECODO_GATEWAY] : []);
  if (!upstreams.length) return 0;

  // Already spawned enough?
  if (_forwarders.length >= Math.min(n, upstreams.length)) return _forwarders.length;

  // Spawn up to n forwarders, round-robin across upstreams so we distribute load across paid IPs.
  const need = Math.min(n, upstreams.length) - _forwarders.length;
  for (let i = 0; i < need; i++) {
    const upstream = upstreams[(_forwarders.length + i) % upstreams.length];
    try {
      await spawnForwarder(upstream, _forwarders.length + i);
    } catch (e) {
      console.warn('[proxy] Failed to spawn forwarder for', upstream, e?.message || e);
    }
  }
  console.info('[proxy] Forwarder farm ready', { count: _forwarders.length });
  return _forwarders.length;
}

function pickLeastBusyForwarder() {
  if (!_forwarders.length) return null;
  let best = _forwarders[0];
  for (let i = 1; i < _forwarders.length; i++) {
    if (_forwarders[i].busy < best.busy) best = _forwarders[i];
  }
  return best;
}

function rrForwarder() {
  if (!_forwarders.length) return null;
  const rec = _forwarders[_fwdRR++ % _forwarders.length];
  return rec;
}

function acquireForwarder({ sticky = false, key = null } = {}) {
  if (!_forwarders.length) return null;

  // Sticky by key
  if (sticky && key) {
    const k = String(key);
    let rec = _stickyMap.get(k);
    if (rec) {
      rec.busy++;
      return { rec, release: () => { rec.busy = Math.max(0, rec.busy - 1); } };
    }
    // allocate a fresh forwarder for this key
    rec = pickLeastBusyForwarder() || rrForwarder();
    if (rec) {
      _stickyMap.set(k, rec);
      rec.busy++;
      return { rec, release: () => { rec.busy = Math.max(0, rec.busy - 1); } };
    }
    return null;
  }

  // Non-sticky: round-robin (or least-busy)
  const rec = pickLeastBusyForwarder() || rrForwarder();
  if (!rec) return null;
  rec.busy++;
  return { rec, release: () => { rec.busy = Math.max(0, rec.busy - 1); } };
}

export async function closeAllForwarders() {
  // Keep anonymized proxies up for reuse; optionally we could close them:
  // for (const f of _forwarders) { try { await ProxyChain.closeAnonymizedProxy(f.localUrl, true); } catch {} }
  // For stability we don't auto-close here.
  _stickyMap.clear();
  return _forwarders.length;
}

// Round-robin index for paid pool
let _paidIdx = 0;
function nextPaidUpstream() {
  if (PAID_POOL.length > 0) {
    const u = PAID_POOL[_paidIdx++ % PAID_POOL.length];
    return u;
  }
  return DECODO_GATEWAY || '';
}
const _stickyPaid = new Map();

function probeUrlFor(service, fallback) {
  const key = String(service || '').toLowerCase();
  return fallback || SERVICE_PROBE_URL[key] || null;
}

// --- Debug: show whether paid proxy env is visible (mask secrets) ---
(function logDecodoEnvOnce(){
  try {
    const enabled = DECODO_ENABLED;
    const count = PAID_POOL.length;
    const single = DECODO_GATEWAY ? (new URL(DECODO_GATEWAY).host) : null;
    if (!enabled) {
      console.warn('[proxy] Paid proxy disabled via DECODO_ENABLED=false');
      return;
    }
    if (count > 0) {
      console.info('[proxy] Paid proxy pool detected', { entries: count });
    } else if (single) {
      console.info('[proxy] Single paid proxy gateway detected', { gatewayHost: single });
    } else {
      console.warn('[proxy] Paid proxy NOT configured (no PAID_PROXIES and no DECODO_GATEWAY)');
    }
  } catch {}
})();
// --- Timezone helpers & cache ---
const US_STATE_TZ = {
  AL:'America/Chicago', AK:'America/Anchorage', AZ:'America/Phoenix', AR:'America/Chicago',
  CA:'America/Los_Angeles', CO:'America/Denver', CT:'America/New_York', DE:'America/New_York',
  FL:'America/New_York', GA:'America/New_York', HI:'Pacific/Honolulu', IA:'America/Chicago',
  ID:'America/Boise', IL:'America/Chicago', IN:'America/Indiana/Indianapolis', KS:'America/Chicago',
  KY:'America/New_York', LA:'America/Chicago', MA:'America/New_York', MD:'America/New_York',
  ME:'America/New_York', MI:'America/Detroit', MN:'America/Chicago', MO:'America/Chicago',
  MS:'America/Chicago', MT:'America/Denver', NC:'America/New_York', ND:'America/Chicago',
  NE:'America/Chicago', NH:'America/New_York', NJ:'America/New_York', NM:'America/Denver',
  NV:'America/Los_Angeles', NY:'America/New_York', OH:'America/New_York', OK:'America/Chicago',
  OR:'America/Los_Angeles', PA:'America/New_York', RI:'America/New_York', SC:'America/New_York',
  SD:'America/Chicago', TN:'America/Chicago', TX:'America/Chicago', UT:'America/Denver',
  VA:'America/New_York', VT:'America/New_York', WA:'America/Los_Angeles', WI:'America/Chicago',
  WV:'America/New_York', WY:'America/Denver', DC:'America/New_York', PR:'America/Puerto_Rico',
};
const STATE_NAME_TO_CODE = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA','colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA','hawaii':'HI','iowa':'IA','idaho':'ID','illinois':'IL','indiana':'IN','kansas':'KS','kentucky':'KY','louisiana':'LA','massachusetts':'MA','maryland':'MD','maine':'ME','michigan':'MI','minnesota':'MN','missouri':'MO','mississippi':'MS','montana':'MT','north carolina':'NC','north dakota':'ND','nebraska':'NE','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','nevada':'NV','new york':'NY','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN','texas':'TX','utah':'UT','virginia':'VA','vermont':'VT','washington':'WA','wisconsin':'WI','west virginia':'WV','wyoming':'WY','district of columbia':'DC','puerto rico':'PR'
};
const tzCache = new Map(); // key -> IANA tz string

function keyForProxy(proxyInfo) {
  if (!proxyInfo) return 'direct';
  if (proxyInfo.type === 'paid') return `paid:${DECODO_COUNTRY || 'us'}`;
  const m = proxyInfo.arg && String(proxyInfo.arg).match(/^--proxy-server=(.+)$/);
  return m ? `free:${m[1]}` : 'free:unknown';
}

function fetchJsonViaAgent(url, agent, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    try {
      const isHttps = /^https:/i.test(url);
      const mod = isHttps ? https : http;
      const req = mod.request(url, { agent, method: 'GET', timeout }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch { resolve(null); }
        });
      });
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} resolve(null); });
      req.on('error', () => resolve(null));
      req.end();
    } catch { resolve(null); }
  });
}

function resolveUsTimezone(obj) {
  if (!obj) return null;
  const tz = obj.timezone || obj.time_zone || obj.timezone_name;
  if (tz) return tz;
  const cc = (obj.country || obj.country_code || obj.countryCode || '').toString().toUpperCase();
  if (cc === 'US') {
    let state = (obj.region_code || obj.region || obj.state || obj.regionCode || obj.regionName || '').toString();
    if (state.length === 2) {
      state = state.toUpperCase();
    } else if (state) {
      state = STATE_NAME_TO_CODE[state.toLowerCase()] || '';
    }
    if (US_STATE_TZ[state]) return US_STATE_TZ[state];
  }
  return null;
}

export async function getProxyTimezone(proxyInfo, { timeout = 5000 } = {}) {
  const key = keyForProxy(proxyInfo);
  if (tzCache.has(key)) return tzCache.get(key);

  // Build an agent for this proxy
  let agent = null;
  if (proxyInfo?.type === 'paid') {
    agent = getHttpsAgentForPaid();
  } else if (proxyInfo?.type === 'free' && proxyInfo?.arg) {
    const m = String(proxyInfo.arg).match(/^--proxy-server=(.+)$/);
    const proxyUrl = m ? m[1] : null;
    if (proxyUrl) {
      try { agent = new HttpsProxyAgentCtor(proxyUrl); } catch {}
    }
  }

  // Try endpoints (for paid, prefer decodo endpoint first)
  const endpoints = [];
  if (proxyInfo?.type === 'paid') endpoints.push('https://ip.decodo.com/json');
  endpoints.push('https://ipapi.co/json', 'http://ip-api.com/json');

  let tz = null;
  for (const u of endpoints) {
    const data = await fetchJsonViaAgent(u, agent, { timeout });
    tz = resolveUsTimezone(data);
    if (tz) break;
  }

  if (!tz) tz = 'America/New_York'; // sensible default
  tzCache.set(key, tz);
  return tz;
}

// --- Service-specific paid-proxy cooldown (avoid re-using paid when target blocks/connect fails)
const paidCooldown = new Map(); // service -> timestamp until which paid is skipped
function isPaidCooled(service) {
  const s = String(service || '').toLowerCase();
  const until = paidCooldown.get(s);
  return !!until && Date.now() < until;
}
export function cooldownPaidForService(service, ms = 5 * 60 * 1000) {
  const s = String(service || '').toLowerCase();
  paidCooldown.set(s, Date.now() + ms);
}

const STATIC_FREE_PROXIES = [
  '104.223.135.178:10000',
  '138.68.60.8:8080',
  '139.59.1.14:3128',
  '157.245.27.9:3128',
  '159.203.61.169:3128',
  '167.71.199.228:8080',
  '167.172.238.6:10000',
  '176.9.75.42:3128',
  '178.62.193.19:3128',
  '188.166.197.129:3128',
  '194.67.91.153:80',
  '198.199.86.11:8080',
  '206.189.22.24:443',
  '209.97.150.167:8080',
  '141.94.254.138:443',
  '116.202.165.119:3124',
  '144.217.7.157:9300',
  '146.190.94.249:8080',
  '152.67.10.190:3128',
  '161.35.214.127:443',
];

// --- Public sources of raw proxy lists (ip:port per line) ---
const SOURCES = [
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxy-list.txt',

  'https://www.proxy-list.download/api/v1/get?type=http',
  'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=4000&country=all&ssl=all&anonymity=all',
  'https://raw.githubusercontent.com/HyperBeats/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
];

const ipPortRe = /^(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}$/;

const deadProxies = new Set();
const healthyProxies = new Set();
const lastChecked = new Map();

export const NETWORK_OR_PROXY_ERRORS = [
  /ERR_TUNNEL/i,
  /ERR_PROXY/i,
  /ECONNRESET/i,
  /ENETUNREACH/i,
  /EHOSTUNREACH/i,
  /ECONNREFUSED/i,
  /Timed out/i,
];

export function isNetworkOrProxyError(err) {
  const msg = String(err && (err.message || err));
  return NETWORK_OR_PROXY_ERRORS.some((rx) => rx.test(msg));
}

export function paidProxyAvailable() {
  return DECODO_ENABLED && (!!DECODO_GATEWAY || PAID_POOL.length > 0);
}

// Assert whether a paid proxy is realistically usable for a given service.
// For now this checks global DECODO_* config; you can extend with service-specific envs later.
export function assertPaidProxyReady(service) {
  return DECODO_ENABLED && (!!DECODO_GATEWAY || PAID_POOL.length > 0);
}

// Decide if we should prefer paid proxy for a given service based on env flags and availability.
export function preferPaidForService(service) {
  const svc = String(service || '').toLowerCase();
  switch (svc) {

    case 'realtor':
      return REALTOR_USE_PAID && assertPaidProxyReady('realtor');
    case 'privy':
      return PRIVY_USE_PAID && assertPaidProxyReady('privy');
    // case 'homes':
    //   return HOMES_USE_PAID && assertPaidProxyReady('homes');
    case 'movoto':
      return MOVOTO_USE_PAID && assertPaidProxyReady('movoto');
    case 'chase':
      return CHASE_USE_PAID && assertPaidProxyReady('chase');
    case 'bofa':
    case 'boa':
      return BOFA_USE_PAID && assertPaidProxyReady('bofa');
    default:
      return BOFA_USE_PAID && assertPaidProxyReady();
  }
}

let cache = {
  list: [...STATIC_FREE_PROXIES],
  lastRefresh: 0,
};

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; 
const HEALTHY_TTL_MS = 30 * 60 * 1000;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function filterNewCandidates(list) {
  const now = Date.now();
  return list.filter((p) => {
    if (!ipPortRe.test(p)) return false;
    if (deadProxies.has(p)) return false;
    const last = lastChecked.get(p) || 0;
    if (healthyProxies.has(p) && now - last < HEALTHY_TTL_MS) return false; // recently validated
    return true;
  });
}

export async function warmProxyCache(force = false) {
  const now = Date.now();
  if (!force && now - cache.lastRefresh < REFRESH_INTERVAL_MS && cache.list.length) {
    return cache.list;
  }

  try {
    const results = await Promise.allSettled(
      SOURCES.map((u) => fetch(u).then((r) => (r.ok ? r.text() : '')))
    );

    const set = new Set(cache.list);
    for (const res of results) {
      if (res.status === 'fulfilled') {
        const text = res.value || '';
        for (const line of text.split(/\r?\n/)) {
          const item = line.trim();
          if (ipPortRe.test(item)) set.add(item);
        }
      }
    }

    const fresh = Array.from(set);
    if (fresh.length) {
      cache.list = fresh;
      cache.lastRefresh = now;
    }
  } catch {
  }

  return cache.list;
}

function buildDecodoUrl(service) {
  if (!paidProxyAvailable()) return null;
  const key = String(service || 'default').toLowerCase();
  if (_stickyPaid.has(key)) return _stickyPaid.get(key);
  const upstream = nextPaidUpstream(); // pick once per service
  _stickyPaid.set(key, upstream);
  return upstream;
}

export function buildDecodoSessions(count = 50) {
  const host = process.env.DECODO_GATEWAY || 'us.decodo.com';
  const baseUser = process.env.DECODO_USER; // e.g., user-spsty1qtz2-sessionduration-30
  const pass = process.env.DECODO_PASS;
  const port = Number(process.env.DECODO_PORT || 10004);

  if (!baseUser || !pass) throw new Error('Missing DECODO_USER/DECODO_PASS');

  const sessions = [];
  for (let i = 1; i <= Math.max(1, Number(count || 50)); i++) {
    // Append a short, stable suffix so sessions are unique but predictable
    const user = `${baseUser}-session-s${i}`;
    const httpNoCreds = `http://${host}:${port}`;

    sessions.push({
      type: 'paid',
      args: ensureProxySafetyFlags([`--proxy-server=${http}`]),
      arg: `--proxy-server=${httpNoCreds}`,      // ✅ host:port only
           credentials: { username: user, password: pass }, // ✅ used by page.authenticate
           url: `http://${user}:${pass}@${host}:${port}`,
      id: `decodo-s${i}`,
      close: async () => {
        /* no-op for backconnect sessions (left intentionally empty) */
      },
      raw: `${host}:${port}`,
    });
  }

  return sessions;
}

export async function getChromeProxyForPaid(serviceOrOpts) {
  // Backward-compatible signature: getChromeProxyForPaid(serviceString)
  let svc = typeof serviceOrOpts === 'string' ? serviceOrOpts : (serviceOrOpts?.service || 'default');
  const sticky = typeof serviceOrOpts === 'object' ? !!serviceOrOpts.sticky : false;
  const key    = typeof serviceOrOpts === 'object' ? (serviceOrOpts.key || null) : null;

  if (!paidProxyAvailable()) return { arg: null, close: async () => {}, type: 'paid' };

  // Ensure we have a forwarder farm up (size ~= concurrency cap)
  await warmLocalForwarders(FORWARDER_TARGET_COUNT);

  const lease = acquireForwarder({ sticky, key: key || svc });
  if (!lease || !lease.rec) {
    console.warn('[proxy] No forwarder available; falling back to single anonymized proxy');
    // Single fallback (old path)
    const upstream = nextPaidUpstream();
    if (!upstream) return { arg: null, close: async () => {}, type: 'paid' };
    const localUrl = await ProxyChain.anonymizeProxy(upstream);
    const arg = `--proxy-server=${localUrl}`;
    const args = ensureProxySafetyFlags([arg]);
    const close = async () => { try { await ProxyChain.closeAnonymizedProxy(localUrl, true); } catch {} };
    return { arg, args, close, type: 'paid', raw: upstream };
  }

  const rec = lease.rec;
  const arg = `--proxy-server=${rec.localUrl}`;
  const args = ensureProxySafetyFlags([arg]);
  const close = async () => { try { lease.release(); } catch {} };
  return { arg, args, close, type: 'paid', raw: rec.upstream, port: rec.port, id: rec.id };
}

export function getHttpsAgentForPaid(service) {
  const upstream = buildDecodoUrl(service);
  if (!upstream) {
    console.warn('[proxy] Paid proxy disabled or missing PAID_PROXIES/DECODO_GATEWAY');
    return null;
  }
  try {
    return new HttpsProxyAgentCtor(upstream);
  } catch (e) {
    console.warn('[proxy] Failed to build HttpsProxyAgent for paid proxy:', e?.message || e);
    return null;
  }
}

export function precheckPaidProxy({ timeout = 5000, service } = {}) {
  return new Promise((resolve) => {
    const agent = getHttpsAgentForPaid(service);
    if (!agent) return resolve(false);
    const req = https.get('https://ip.decodo.com/json', { agent, timeout }, (res) => {
      const ok = res.statusCode && res.statusCode < 400;
      res.resume();
      resolve(!!ok);
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
    req.on('error', () => resolve(false));
  });
}

export function precheckPaidProxyForUrl(url, { method = 'HEAD', timeout = 5000, service } = {}) {
  return new Promise((resolve) => {
    const agent = getHttpsAgentForPaid(service);
    if (!agent) {
      console.warn('[proxy] Paid proxy precheck: agent unavailable (check PAID_PROXIES/DECODO_* env and https-proxy-agent version).');
      return resolve(false);
    }
    const req = https.request(url, { agent, method, timeout }, (res) => {
      const ok = !!res.statusCode && res.statusCode < 500;
      res.resume();
      resolve(ok);
    });
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function pickRandomHealthy(list = Array.from(healthyProxies)) {
  if (!list.length) return null;
  return list[Math.floor(Math.random() * list.length)];
}

export function markDeadProxy(proxy) {
  if (!proxy) return;
  deadProxies.add(proxy);
  healthyProxies.delete(proxy);
}

export function getRandomProxySync() {
  const healthy = Array.from(healthyProxies);
  if (healthy.length) return pickRandomHealthy(healthy);
  const pool = cache.list.filter((p) => !deadProxies.has(p));
  return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
}

export async function getRandomProxy() {
  await warmProxyCache();
  return getRandomProxySync();
}

export function toChromeArg(proxy) {
  return proxy ? `--proxy-server=http://${proxy}` : null;
}

// Try to bias free proxies by service (e.g., prefer US timezones for certain targets like Chase)
export async function getChromeProxyForFreeService(service, { attempts = 6, timeout = 4000 } = {}) {
  const svc = String(service || '').toLowerCase();

  // For Chase (and other US banking targets), prefer free proxies that resolve to US timezones.
  const preferUsTz = svc === 'chase';

  // Fallback to the standard free selector when no bias is needed
  if (!preferUsTz) {
    return getChromeProxyForFree();
  }

  // US timezones we consider acceptable
  const US_TZ = new Set([
    'America/New_York',
    'America/Chicago',
    'America/Los_Angeles',
    'America/Denver',
    'America/Phoenix',
    'America/Boise',
    'America/Detroit',
    'America/Indiana/Indianapolis',
    'America/Puerto_Rico',
  ]);

  // Try multiple times to find a US-ish proxy
  for (let i = 0; i < attempts; i++) {
    const candidate = await getValidatedProxy({ maxTries: Math.max(4, Math.ceil(attempts / 2)), timeout });
    if (!candidate) break;

    // Quick sanity filter: ping timezone endpoints through the proxy
    let tz = null;
    try {
      tz = await getProxyTimezone({ type: 'free', arg: `--proxy-server=http://${candidate}` }, { timeout: Math.max(2500, timeout) });
    } catch {
      tz = null;
    }

    if (tz && US_TZ.has(tz)) {
      const arg = `--proxy-server=http://${candidate}`;
      const args = ensureProxySafetyFlags([arg]);
      const close = async () => { /* keep no-op here; do not mark as dead automatically */ };
      return { arg, args, close, type: 'free', proxy: candidate, tz };
    } else {
      // mark as dead so we don't reuse in this run
      try { markDeadProxy(candidate); } catch {}
    }
  }

  // If we couldn't find a US-timezone proxy, fall back to generic free selection
  return getChromeProxyForFree();
}

export default getRandomProxySync;

export function validateHttpProxy(proxy, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    if (!proxy || !ipPortRe.test(proxy)) return resolve(false);
    const [host, portStr] = proxy.split(':');
    const port = Number(portStr);
    const socket = net.connect({ host, port });

    const onFail = () => {
      try { socket.destroy(); } catch {}
      resolve(false);
    };

    const timer = setTimeout(onFail, timeout);

    socket.on('error', onFail);
    socket.on('connect', () => {
      const req =
        'CONNECT www.google.com:443 HTTP/1.1\r\n' +
        'Host: www.google.com:443\r\n' +
        'User-Agent: curl/8\r\n' +
        'Proxy-Connection: Keep-Alive\r\n\r\n';
      socket.write(req);
    });

    socket.on('data', (buf) => {
      clearTimeout(timer);
      const header = buf.toString('utf8');
      const ok = /^HTTP\/[0-9.]+\s+2\d\d/.test(header); // 2xx on CONNECT
      try { socket.destroy(); } catch {}
      resolve(ok);
    });
  });
}

async function prevalidateProxies(candidates, { timeout = 4000, concurrency = 30, maxOk = 25 } = {}) {
  candidates = candidates.filter((p) => ipPortRe.test(p));
  if (!candidates.length) return [];

  const ok = [];
  let idx = 0;
  let active = 0;

  return await new Promise((resolve) => {
    const run = () => {
      while (active < concurrency && idx < candidates.length && ok.length < maxOk) {
        const p = candidates[idx++];
        if (deadProxies.has(p)) continue;
        active++;
        lastChecked.set(p, Date.now());
        validateHttpProxy(p, { timeout })
          .then((isOk) => {
            if (isOk) {
              healthyProxies.add(p);
              ok.push(p);
            } else {
              deadProxies.add(p);
            }
          })
          .catch(() => deadProxies.add(p))
          .finally(() => {
            active--;
            if ((idx >= candidates.length || ok.length >= maxOk) && active === 0) return resolve(ok);
            run();
          });
      }
      if (idx >= candidates.length && active === 0) resolve(ok);
    };
    run();
  });
}

export async function ensureHealthyPool({ min = 40, sample = 800, timeout = 5000, concurrency = 60 } = {}) {
  if (healthyProxies.size >= min) return healthyProxies.size;

  await warmProxyCache(healthyProxies.size === 0);

  let candidates = filterNewCandidates(cache.list);
  if (!candidates.length) {
    await warmProxyCache(true);
    candidates = filterNewCandidates(cache.list);
  }

  candidates = shuffle(candidates).slice(0, sample);
  await prevalidateProxies(candidates, { timeout, concurrency, maxOk: min - healthyProxies.size });

  if (healthyProxies.size < min && deadProxies.size > cache.list.length * 0.5) {
    await warmProxyCache(true);
  }

  return healthyProxies.size;
}

export async function getValidatedProxy({ maxTries = 6, timeout = 4000 } = {}) {
  // Try the healthy pool first
  await ensureHealthyPool({ min: 10, sample: 250, timeout });
  const healthy = Array.from(healthyProxies);
  if (healthy.length) {
    return healthy[Math.floor(Math.random() * healthy.length)];
  }
  await warmProxyCache();
  const pool = shuffle(cache.list.filter((p) => !deadProxies.has(p))).slice(0, Math.max(10, maxTries));
  for (const candidate of pool) {
    const ok = await validateHttpProxy(candidate, { timeout });
    lastChecked.set(candidate, Date.now());
    if (ok) {
      healthyProxies.add(candidate);
      return candidate;
    }
    deadProxies.add(candidate);
  }
  return null;
}

class SimpleQueue {
  constructor({ concurrency = 2 } = {}) {
    this.concurrency = concurrency;
    this.active = 0;
    this.queue = [];
  }
  add(task) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.active++;
        try { resolve(await task()); }
        catch (e) { reject(e); }
        finally { this.active--; this._next(); }
      };
      this.queue.push(run);
      this._next();
    });
  }
  _next() {
    if (this.active >= this.concurrency) return;
    const fn = this.queue.shift();
    if (fn) fn();
  }
}
export async function getChromeProxyForFree() {
  const proxy = await getValidatedProxy();
  if (!proxy) {
    return { arg: null, args: [], close: async () => {}, type: 'free' };
  }
  const arg = `--proxy-server=http://${proxy}`;
  const args = ensureProxySafetyFlags([arg]);
  const close = async () => { /* keep no-op here; do not mark as dead automatically */ };
  return { arg, args, close, type: 'free', proxy };
}

export async function getPreferredChromeProxy({ preferPaid = true, timeout = 5000, service, testUrl, sticky = false, key = null } = {}) {
  const PROXY_FORCE_PAID_ONLY = String(process.env.PROXY_FORCE_PAID_ONLY || 'false').toLowerCase() === 'true';
  const svc = String(service || '').toLowerCase();

  if (PROXY_FORCE_PAID_ONLY) {
    // Try paid; if not OK, return a null-arg proxy (direct) instead of falling back to free lists
    let ok = false;
    try {
      const url = testUrl || probeUrlFor(svc);
      ok = url
        ? await precheckPaidProxyForUrl(url, { timeout, service: svc })
        : await precheckPaidProxy({ timeout, service: svc });
    } catch {}
    if (!ok) { try { cooldownPaidForService(svc, 10 * 60 * 1000); } catch {} }
    if (ok) {
      const paid = await getChromeProxyForPaid({ service: svc, sticky, key });
      if (paid && paid.arg) return paid;
    }
    return { arg: null, args: [], close: async () => {}, type: 'none' };
  }
  // Hard-prefer a paid proxy for Privy when configured and not in cooldown.
  if (svc === 'privy' && preferPaidForService('privy') && !isPaidCooled(svc)) {
    let ok = false;
    try {
      const url = testUrl || probeUrlFor('privy');
      ok = url
        ? await precheckPaidProxyForUrl(url, { timeout, service: svc })
        : await precheckPaidProxy({ timeout, service: svc });
    } catch {}
    if (!ok) { try { cooldownPaidForService(svc, 10 * 60 * 1000); } catch {} }
    if (ok) {
      const paid = await getChromeProxyForPaid({ service: svc, sticky, key });
      if (paid && paid.arg) return paid;
    }
  }

  // Hard-prefer a paid proxy for Chase when configured and not in cooldown.
  if (svc === 'chase' && preferPaidForService('chase') && !isPaidCooled(svc)) {
    let ok = false;
    try {
      const url = testUrl || probeUrlFor('chase');
      ok = url
        ? await precheckPaidProxyForUrl(url, { timeout, service: svc })
        : await precheckPaidProxy({ timeout, service: svc });
    } catch {}
    if (!ok) { try { cooldownPaidForService(svc, 10 * 60 * 1000); } catch {} }
    if (ok) {
      const paid = await getChromeProxyForPaid({ service: svc, sticky, key });
      if (paid && paid.arg) return paid;
    }
  }
  // Hard-prefer a paid proxy for Homes.com when configured and not in cooldown.
  if (svc === 'homes' && preferPaidForService('homes') && !isPaidCooled(svc)) {
    let ok = false;
    try {
      const url = testUrl || probeUrlFor('homes');
      ok = url
        ? await precheckPaidProxyForUrl(url, { timeout, service: svc })
        : await precheckPaidProxy({ timeout, service: svc });
    } catch {}
    if (!ok) { try { cooldownPaidForService(svc, 10 * 60 * 1000); } catch {} }
    if (ok) {
      const paid = await getChromeProxyForPaid({ service: svc, sticky, key });
      if (paid && paid.arg) return paid;
    }
  }
  let envFlag = true;
  switch (svc) {
    case 'homes': envFlag = HOMES_USE_PAID; break;
    case 'movoto': envFlag = MOVOTO_USE_PAID; break;
    case 'chase': envFlag = CHASE_USE_PAID; break;
    case 'bofa':
    case 'boa': envFlag = BOFA_USE_PAID; break;
    default: envFlag = BOFA_USE_PAID; break;
  }

  const usePaid = preferPaid && envFlag && paidProxyAvailable() && !isPaidCooled(svc);

  if (usePaid) {
    let ok = false;
    try {
      const url = testUrl || probeUrlFor(svc);
      ok = url
        ? await precheckPaidProxyForUrl(url, { timeout, service: svc })
        : await precheckPaidProxy({ timeout, service: svc });
    } catch {}
    if (!ok) { try { cooldownPaidForService(svc, 10 * 60 * 1000); } catch {} }
    if (ok) {
      const paid = await getChromeProxyForPaid({ service: svc, sticky, key });
      if (paid && paid.arg) return paid;
    }
  }

  // Prefer a service-aware free proxy selection when possible
  const free = await getChromeProxyForFreeService(service, { timeout });
  return free;
}

// Vendor-specific queues (low concurrency; override via env)
const CHASE_CONCURRENCY  = Math.max(1, Number(process.env.CHASE_CONCURRENCY  || 2));
const MOVOTO_CONCURRENCY = Math.max(1, Number(process.env.MOVOTO_CONCURRENCY || 2));

export const chaseQueue  = new SimpleQueue({ concurrency: CHASE_CONCURRENCY });
export const movotoQueue = new SimpleQueue({ concurrency: MOVOTO_CONCURRENCY });

export const jobQueue = new SimpleQueue({ concurrency: getGlobalConcurrency() });
export const queues = { chaseQueue, movotoQueue, jobQueue };
export const SERVICE_PROBE_URL = Object.freeze({
    privy: 'https://app.privy.pro/users/sign_in',
    chase: 'https://secure.chase.com/',
    bofa:  'https://homevaluerealestatecenter.bankofamerica.com/',
    boa:   'https://homevaluerealestatecenter.bankofamerica.com/',
    movoto:'https://www.movoto.com/',
    homes: 'https://www.homes.com/',
  });