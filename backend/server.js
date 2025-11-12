import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import connectDB from './db/db.js';
import { log } from './utils/logger.js';
import { ensureMasterAdmin } from './utils/ensureMasterAdmin.js';
import agentOffersRoutes from './routes/agent_offers.js';
import mongoose from 'mongoose';
import runBofaJob from './vendors/bofa/bofaJob.js';

dotenv.config();

const L = log.child('server');
// ---- Boot Janitor: free disk space from stale Puppeteer artifacts ----
// Enabled by default in production. Disable with DISK_JANITOR=0.
const JANITOR_ENABLED = process.env.DISK_JANITOR !== '0';
const JANITOR_MAX_AGE_HOURS = Number(process.env.DISK_JANITOR_MAX_AGE_HOURS || 12);
const JANITOR_INTERVAL_MIN = Number(process.env.DISK_JANITOR_INTERVAL_MIN || 0); // 0 = run once at boot
const PUPPETEER_DIR = process.env.PUPPETEER_CACHE_DIR || (process.platform === 'linux' ? '/var/data/puppeteer' : path.resolve(process.cwd(), '.puppeteer-cache'));

async function safeRm(p) {
  try {
    await fs.rm(p, { recursive: true, force: true });
    L.info('Janitor: removed', { path: p });
  } catch (e) {
    L.warn('Janitor: remove failed', { path: p, error: e.message });
  }
}

function isOldStat(stat, maxAgeHours) {
  const ageMs = Date.now() - stat.mtimeMs;
  return ageMs > maxAgeHours * 60 * 60 * 1000;
}

async function janitorOnce() {
  if (!JANITOR_ENABLED) return;

  try {
    // 1) Clean Puppeteer workspace: keep browser builds under "chrome/"
    // Remove stale ephemeral profiles like "*-profile-*", "user-data-dir*", "screenshots", "traces", etc.
    try {
      const entries = await fs.readdir(PUPPETEER_DIR, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(PUPPETEER_DIR, ent.name);
        // Keep the browser cache folder named "chrome"
        if (ent.isDirectory() && ent.name === 'chrome') continue;

        // Only touch known ephemeral clutter or anything older than threshold
        const matchesEphemeral =
          /profile|user[-_ ]?data|session|tmp|temp|screenshots?|traces?|trace|crash|report/i.test(ent.name);

        try {
          const st = await fs.stat(full);
          const oldEnough = isOldStat(st, JANITOR_MAX_AGE_HOURS);
          if (ent.isDirectory() || ent.isSymbolicLink() || ent.isFile()) {
            if (matchesEphemeral || oldEnough) {
              await safeRm(full);
            }
          }
        } catch {
          // If stat fails, try to remove anyway
          await safeRm(full);
        }
      }
    } catch (e) {
      L.debug('Janitor: puppeteer dir scan skipped', { dir: PUPPETEER_DIR, error: e.message });
    }

    // 2) Clean common temp locations (/tmp)
    try {
      const tmpDir = os.tmpdir();
      const tmpEntries = await fs.readdir(tmpDir, { withFileTypes: true });
      for (const ent of tmpEntries) {
        const name = ent.name;
        const full = path.join(tmpDir, name);
        // common puppeteer/chrome tmp prefixes
        const isPptrTmp = /^(puppeteer|puppeteer_dev|pptr-|chrome-profile|core\.)/i.test(name);
        if (!isPptrTmp) continue;

        try {
          const st = await fs.stat(full);
          if (isOldStat(st, JANITOR_MAX_AGE_HOURS)) {
            await safeRm(full);
          }
        } catch {
          await safeRm(full);
        }
      }
    } catch (e) {
      L.debug('Janitor: tmp dir scan skipped', { error: e.message });
    }
  } catch (e) {
    L.warn('Janitor: run failed', { error: e.message });
  }
}

// Run once at boot (default). Optionally run on an interval if configured.
(async () => {
  await janitorOnce();
  if (JANITOR_INTERVAL_MIN > 0) {
    const ms = JANITOR_INTERVAL_MIN * 60 * 1000;
    setInterval(janitorOnce, ms).unref();
    L.info('Janitor: scheduled', { everyMinutes: JANITOR_INTERVAL_MIN });
  } else {
    L.info('Janitor: ran once at boot', { enabled: JANITOR_ENABLED, maxAgeHours: JANITOR_MAX_AGE_HOURS });
  }
})();
// ---- End Boot Janitor ----
const app = express();
const PORT = Number(process.env.PORT || 3015);
const IS_WORKER = ['1','true','yes','on'].includes(String(process.env.AUTOMATION_WORKER || '').toLowerCase());

import userRoutes from './routes/users.js';
import automationRoutes from './routes/automation/automation.js';
import automationStatusRoutes from './routes/automation/status.js'
import authRoutes from './routes/auth.js';
import propertyRoutes from './routes/properties.js';
import emailRoutes from './routes/email.js';
import floodRoute from './routes/flood.js';
import automationServiceRoutes from './routes/automation/automationService.js';
import dashboardRoutes from './routes/dashboard.js';

// Global guards: never crash the process; log and continue
process.on('warning', (w) => {
  L.warn('Node warning', { name: w.name, message: w.message, stack: w.stack });
});
process.on('unhandledRejection', (reason) => {
  L.error('Unhandled promise rejection', { reason: (reason && reason.message) || String(reason) });
});
process.on('uncaughtException', (err) => {
  L.error('Uncaught exception', { error: err.message, stack: err.stack });
});

// Graceful stop for background cron

// Graceful shutdown: close HTTP server and Mongo connection
let httpServer = null;
async function shutdown(signal) {
  try {
    L.info('Shutting down on signal', { signal });
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
      L.info('HTTP server closed');
    }
    if (mongoose.connection && mongoose.connection.readyState !== 0) {
      await mongoose.connection.close();
      L.info('MongoDB connection closed');
    }
  } catch (e) {
    L.warn('Shutdown encountered issues', { error: e?.message });
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const envOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.FRONTEND_URLS ? process.env.FRONTEND_URLS.split(',') : []),
]
  .map(v => (v || '').trim())
  .filter(Boolean);

const whitelist = [
  ...envOrigins,                               // env-based (single or comma-separated)
  'https://deal-finder-six-green.vercel.app', // your prod Vercel domain
  /\.vercel\.app$/,                           // allow preview deploys
  'http://localhost:3000',                    // local dev
  /.vercel\.app$/,                           // allow preview deploys
  /.onrender\.com$/,                         // render domains (api + previews)
  /^http:\/\/localhost:\d+$/,               // any localhost port
  /^http:\/\/127\.0\.0\.1:\d+$/,          // loopback variants
];

const corsOptions = {
  origin(origin, cb) {
    // allow non-browser requests (no Origin), and whitelisted origins
    if (!origin || whitelist.some(w => w instanceof RegExp ? w.test(origin) : w === origin)) {
      return cb(null, true);
    }
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Cache-Control',
    'Pragma',
    'X-Requested-With',
    'Accept',
  ],
  exposedHeaders: ['Content-Length'],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // handle preflight
app.use('/api', cors(corsOptions));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Vary', 'Origin');
  next();
});

// If behind a load balancer / reverse proxy (Railway, Render, Nginx, Cloudflare)
app.set('trust proxy', true);
app.disable('x-powered-by');

// Accept typical payloads comfortably
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Simple health check (no DB dependency to be fast)
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const apiRoutes = express.Router();

// Mount sub-routers on apiRoutes FIRST (clear grouping)
apiRoutes.use('/auth', authRoutes);
apiRoutes.use('/user', userRoutes);
apiRoutes.use('/automation', automationRoutes);
apiRoutes.use('/automation/status', automationStatusRoutes);
apiRoutes.use('/automation/service', automationServiceRoutes);
apiRoutes.use('/properties', propertyRoutes);
// Non-API namespaces
app.use('/email', emailRoutes);

// Routes that live directly under /api (flood, plus the grouped apiRoutes)
app.use('/api', floodRoute);
app.use('/api', apiRoutes);
app.use('/api/agent-offers', agentOffersRoutes);
// Dedicated dashboard prefix
app.use('/api/dashboard', dashboardRoutes);

// Start the server; connect to DB within the listener so logs are grouped
if (!IS_WORKER) {
  const start = async (boundPort) => {
    httpServer = app
      .listen(boundPort, async () => {
        L.start('Booting API server', { port: boundPort });

        try {
          await connectDB();
          L.success('Database connected successfully');
          await ensureMasterAdmin();
        } catch (err) {
          L.error('Database connection failed', { error: err?.message || String(err) });
        }

        L.success('Deal Finder API server running', { port: boundPort });
        L.info('API routes mounted', {
          routes: [
            '/healthz',
            '/email/*',
            '/api/auth/*',
            '/api/user/*',
            '/api/automation/*',
            '/api/automation/status/*',
            '/api/automation/service/*',
            '/api/properties/*',
            '/api (flood)',
            '/api/agent-offers/*',
            '/api/dashboard/*',
          ],
        });
        L.info('Base API endpoint', { url: `http://localhost:${boundPort}/api` });

        // Centralized concurrency log (single source via proxyManager)
        try {
          const info = await (typeof getGlobalConcurrencyInfo === 'function' ? getGlobalConcurrencyInfo() : null);
          if (info) {
            L.info('Global concurrency configured', info);
          }
        } catch {}
      })
      .on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
          // Fall back to an ephemeral port instead of crashing
          const srv = app.listen(0, () => {
            const p = srv.address().port;
            L.warn('Port in use; rebound to random port', { requested: boundPort, actual: p });
          });
          httpServer = srv;
        } else {
          L.error('HTTP listen error', { error: e?.message || String(e) });
          throw e;
        }
      });
  };
  start(PORT);
} else {
  L.info('Worker mode detected — HTTP server not started');

  // Simple job dispatcher driven by JOBS="job1,job2"
  const jobsRequested = String(process.env.JOBS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  const jobMap = {
    bofa: runBofaJob,
    // add more jobs here later, e.g.:
    // privy: runPrivyJob,
    // redfin: runRedfinJob,
  };

  (async () => {
    const selected = jobsRequested.length ? jobsRequested : Object.keys(jobMap);
    L.info('Starting automations…', { requestedJobs: jobsRequested.join(',') || '(all)', resolvedJobs: selected });

    // If your individual job modules already connect to Mongo (your BofA module does),
    // you do NOT need to connect here. Otherwise, uncomment the next two lines:
    // await connectDB();
    // L.info('DB connected for worker dispatcher');

    for (const name of selected) {
      const fn = jobMap[name];
      if (!fn) {
        L.warn('Job not recognized — skipping', { name });
        continue;
      }
      try {
        L.info(`Running ${name} job…`);
        await fn();
        L.info(`Finished ${name} job`);
      } catch (e) {
        L.error(`Error in ${name} job`, { error: e?.message || String(e) });
      }
    }

    L.info('All automations completed.');
    // Optional: exit in worker mode so the orchestrator can relaunch on a schedule
    // process.exit(0);
  })();
}