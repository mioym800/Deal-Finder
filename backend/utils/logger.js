// backend/utils/logger.js
import util from 'node:util';
import { EventEmitter } from 'node:events'; // NEW

// ANSI colors (no deps)
const C = {
  reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

const ICON = {
  start: '🚀', ok: '✅', info: 'ℹ️', warn: '⚠️', err: '❌',
  retry: '🔁', skip: '⏭️', proxy: '🛰️', pool: '🔋', http: '🌐',
  home: '🏠', homes: '🏡', movoto: '📈', privy: '🔍', dedupe: '🧹',
};
export function now() { return new Date().toISOString(); }

const LEVELS = { trace:0, debug:1, info:2, warn:3, error:4 };
let CUR = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const USE_COLOR = !process.env.NO_COLOR;

// === NEW: log bus + ring buffer ===
export const logBus = new EventEmitter();
const RING_SIZE = parseInt(process.env.LOG_RING || '800', 10);
const ring = [];
export function getRecentLogs(count = 200) {
  const n = Math.max(0, Math.min(count, RING_SIZE));
  return ring.slice(-n);
}

const color = (s, c) => USE_COLOR ? C[c] + s + C.reset : s;

// Timestamp in New York time (EST/EDT auto)
const TZ = 'America/New_York';
const nycFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZoneName: 'short',
});
const ts = () => {
  const d = new Date();
  const parts = nycFormatter.formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || '';
  const year = get('year'), month = get('month'), day = get('day');
  const hour = get('hour'), minute = get('minute'), second = get('second');
  const zone = get('timeZoneName') || 'ET';
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${ms} ${zone}`;
};
const fmt = (v) => typeof v === 'string' ? v : util.inspect(v, { colors: USE_COLOR, depth: 5, maxArrayLength: 20 });

function line({icon, scope, msg, fields}) {
  const t = color(ts(), 'gray');
  const sc = scope ? color(`[${scope}]`, 'cyan') : '';
  const f = fields && Object.keys(fields).length ? ' ' + color(JSON.stringify(fields), 'magenta') : '';
  return `${t} ${icon||''} ${sc} ${fmt(msg)}${f}`;
}

export function setLogLevel(level) {
  if (level in LEVELS) CUR = LEVELS[level];
}

export function createLogger(scope='') {
  function log(level, icon, msg, fields) {
    if (LEVELS[level] < CUR) return;
    const out = line({ icon, scope, msg, fields });
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(out);

    // === NEW: emit structured log event & store in ring ===
    try {
      const evt = {
        ts: Date.now(),
        level,
        scope,
        icon,
        msg: typeof msg === 'string' ? msg : (msg && msg.message) ? msg.message : fmt(msg),
        fields: fields || {},
      };
      logBus.emit('log', evt);
      ring.push(evt);
      if (ring.length > RING_SIZE) ring.shift();
    } catch {}
  }

  const api = {
    trace:(m,f)=>log('trace','🔬',m,f),
    debug:(m,f)=>log('debug','🐞',m,f),
    info:(m,f)=>log('info', ICON.info, m,f),
    success:(m,f)=>log('info', ICON.ok, m,f),
    warn:(m,f)=>log('warn', ICON.warn, m,f),
    error:(m,f)=>log('error', ICON.err, m,f),

    // friendly helpers
    start:(m,f)=>log('info', ICON.start, m,f),
    retry:(m,f)=>log('info', ICON.retry, m,f),
    skip:(m,f)=>log('info', ICON.skip, m,f),
    proxy:(m,f)=>log('info', ICON.proxy, m,f),
    pool:(m,f)=>log('info', ICON.pool, m,f),
    http:(m,f)=>log('info', ICON.http, m,f),
    dedupe:(m,f)=>log('info', ICON.dedupe, m,f),

    // standardized "final outcome" logger for vendor attempts
    // usage: logMovoto.outcome({ address, attempt, outcome, ms, reason, value })
    // outcomes: 'estimate' | 'nodata' | 'blocked' | 'timeout' | 'error'
    outcome(payload = {}) {
      const { address, attempt, outcome, ms, reason, value } = payload || {};
      const fields = { address, attempt, outcome, ms, reason, value };
      switch (String(outcome || '').toLowerCase()) {
        case 'estimate':
          return log('info', ICON.ok, 'Outcome: estimate', fields);
        case 'nodata':
          return log('warn', ICON.warn, 'Outcome: nodata', fields);
        case 'blocked':
          return log('warn', ICON.warn, 'Outcome: blocked', fields);
        case 'timeout':
          return log('warn', ICON.warn, 'Outcome: timeout', fields);
        default:
          return log('error', ICON.err, 'Outcome: error', fields);
      }
    },

    // create a child logger with extended scope
    child(extra) { return createLogger(scope ? `${scope}:${extra}` : extra); },

    // bind default fields
    with(defaults={}) {
      const base = api;
      const wrap = {};
      for (const k of Object.keys(base)) {
        if (['child','with','time'].includes(k)) continue;
        wrap[k] = (m,f)=>base[k](m, {...defaults, ...(f||{})});
      }
      wrap.child = base.child;
      wrap.time = base.time;
      wrap.with = (more)=>api.with({...defaults, ...more});
      return wrap;
    },

    // simple timer
    time() { const s = Date.now(); return { end(){ return Date.now() - s; } }; },
  };
  return api;
}

// Pre-scoped loggers for convenience
export const log = createLogger('core');
export const logProxy = createLogger('proxy');
export const logBofa = createLogger('bofa');
export const logPrivy = createLogger('privy');
export const logChase = createLogger('chase'); // NEW
export const logHomes = createLogger('homes');
export const logMovoto = createLogger('movoto');
export const logCurrentListings = createLogger('current_listings');

// optional reuse: NY-local timestamp string
export const tsNY = ts; // alias for external modules

export const ICONS = ICON;