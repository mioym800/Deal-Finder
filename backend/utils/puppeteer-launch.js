// utils/puppeteer-launch.js (cross‑platform)
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';

// ---------- Profile root (ensure writable, mkdirp automatically) ----------
const DEFAULT_PROFILE_ROOT = path.resolve('./tmp/profiles');
const ENV_PROFILE_ROOT = process.env.PRIVY_PROFILE_ROOT;

function ensureDirWritable(dir) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // quick writability probe
    const probe = path.join(dir, '.probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return dir;
  } catch {
    return null;
  }
}

// Prefer env, but fall back to ./tmp/profiles if env path is not writable
const _candidateRoots = [
  ENV_PROFILE_ROOT && path.resolve(ENV_PROFILE_ROOT),
  DEFAULT_PROFILE_ROOT,
].filter(Boolean);

let _resolvedProfileRoot = null;
for (const d of _candidateRoots) {
  const ok = ensureDirWritable(d);
  if (ok) { _resolvedProfileRoot = ok; break; }
}
// Final, guaranteed-writable profile dir for Privy (permanent “device”)
const PRIVY_PROFILE_DIR = _resolvedProfileRoot ? path.join(_resolvedProfileRoot, 'privy-live') : undefined;
if (PRIVY_PROFILE_DIR) {
  try { fs.mkdirSync(PRIVY_PROFILE_DIR, { recursive: true }); } catch {}
}
// Helper to get a persistent profile folder for any vendor without collisions
function resolveProfileDir(name) {
  const root = _resolvedProfileRoot || DEFAULT_PROFILE_ROOT;
  const dir = path.join(root, name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

const defaultArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
];

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch { return false; }
}

/**
 * Resolve a Chrome/Chromium executable path in this order:
 *  1) PUPPETEER_EXECUTABLE_PATH or CHROME_PATH (env)
 *  2) Common OS-specific install locations (macOS/Linux/Windows)
 *  3) puppeteer.executablePath() (works when using full `puppeteer` with downloaded Chromium)
 * If nothing is found and we are on puppeteer-core, caller may choose to throw with a helpful message.
 */
function resolveChromePath() {
  // 1) From environment
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (exists(fromEnv)) return fromEnv;

  // 2) OS candidates
  const darwin = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    // Chrome for Testing default locations
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ];
  const linux = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
  ];
  const win = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    // Chrome for Testing on Windows (typical)
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome for Testing/Application/chrome.exe'),
  ];

  const candidates = process.platform === 'darwin' ? darwin
                    : process.platform === 'linux'  ? linux
                    : process.platform === 'win32'  ? win
                    : [];

  for (const p of candidates) {
    if (exists(p)) return p;
  }

  // 3) Puppeteer-managed Chromium (only if using full puppeteer)
  const fromPptr = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : null;
  if (exists(fromPptr)) return fromPptr;

  // Nothing found
  return undefined;
}
// Add this small helper once in the file (top-level, near other utils)
function ensureProxySafetyFlags(args) {
  const hasProxy = args.some(a => a.startsWith('--proxy-server='));
  if (!hasProxy) return args;

  const needBypass = !args.some(a => a.startsWith('--proxy-bypass-list='));
  const needNoQuic = !args.includes('--disable-quic');

  if (needBypass) args.push('--proxy-bypass-list=<-loopback>');
  if (needNoQuic) args.push('--disable-quic');
  return args;
}

export async function launchChromeForPrivy({ headless = true } = {}) {
  const resolvedPath = resolveChromePath();
  const userDataDir = PRIVY_PROFILE_DIR || path.join(DEFAULT_PROFILE_ROOT, 'privy-live');
  // ensure final folder exists even if env was missing
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch {}
  const args = ensureProxySafetyFlags([
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    ...(process.env.PUPPETEER_ARGS ? process.env.PUPPETEER_ARGS.split(' ') : []),
  ]);

  const launchOpts = {
    headless: process.env.PPTR_HEADLESS === 'false' ? false : headless,
    args,
    userDataDir,
    executablePath: resolvedPath,
    product: 'chrome',
  };

  console.log('[launcher] Launching Chrome for Privy', {
        userDataDir,
        headless: launchOpts.headless,
        profileRoot: _resolvedProfileRoot || '(default ./tmp/profiles)',
      });
  return await puppeteer.launch(launchOpts);
}

/**
 * Launch Chrome with a dedicated persistent profile (e.g. for Chase).
 * Non-breaking: only used when explicitly called by a job.
 */
export async function launchChromeWithProfile(profileName, {
  headless = (process.env.PPTR_HEADLESS === 'false' ? false : true),
  extraArgs = [],
  userAgent = process.env.PPTR_UA,         // optional per-job UA
  lang = process.env.PPTR_LANG || 'en-US', // ensure stable locale for banking sites
  viewport = null,                         // null => use --window-size below
  windowSize = process.env.PPTR_WINDOW_SIZE || '1366,824',
} = {}) {
  const resolvedPath = resolveChromePath();
  const userDataDir = resolveProfileDir(profileName);
  const args = ensureProxySafetyFlags([
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--lang=${lang}`,
    `--window-size=${windowSize}`,
    ...(process.env.PUPPETEER_ARGS ? process.env.PUPPETEER_ARGS.split(' ') : []),
    ...extraArgs,
  ]);

  const launchOpts = {
    headless,
    args,
    userDataDir,
    executablePath: resolvedPath,
    product: 'chrome',
    defaultViewport: viewport, // keep null for full window size unless overridden
  };

  console.log('[launcher] Launching Chrome with profile', {
    profileName, userDataDir, headless: launchOpts.headless,
  });
  const browser = await puppeteer.launch(launchOpts);
  if (userAgent) {
    try {
      const [page] = await browser.pages();
      if (page) await page.setUserAgent(userAgent);
    } catch {}
  }
  return browser;
}

/**
 * Robust Puppeteer launcher used across all automations.
 * - Auto-detects Chrome across macOS/Linux/Windows (or uses env override)
 * - Falls back to puppeteer.executablePath() when available
 * - If no executable resolved and you are using puppeteer-core, throws with a helpful error
 */
export async function launchBrowser(extraOptions = {}) {
  const resolvedPath = resolveChromePath();

  // Merge args (ensuring uniqueness and preserving caller order last)
  const callerArgs = Array.isArray(extraOptions.args) ? extraOptions.args : [];
  let mergedArgs = [...new Set([...defaultArgs, ...callerArgs])];
  mergedArgs = ensureProxySafetyFlags(mergedArgs);

  const launchOpts = {
    headless: process.env.HEADLESS === 'true' ? 'shell' : 'new',
    product: process.env.PUPPETEER_PRODUCT || 'chrome',
    ...(resolvedPath ? { executablePath: resolvedPath } : {}),
    args: mergedArgs,
    ...extraOptions,
  };

  if (!resolvedPath) {
    // If using puppeteer-core, we must have an executable. Give a clear message.
    const usingCore = (() => {
      try { return require.resolve('puppeteer-core'); } catch { return null; }
    })();
    if (usingCore) {
      const hint = process.platform === 'darwin'
        ? 'Set PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" in your .env.'
        : process.platform === 'linux'
        ? 'Set PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome in your .env (or install google-chrome).'
        : 'Set CHROME_PATH to your Chrome executable on Windows.';
      throw new Error(`No Chrome executable found. You appear to be using puppeteer-core. ${hint}`);
    }
  }

  console.log('[launcher] Launching Puppeteer', {
    headless: launchOpts.headless,
    product: launchOpts.product,
    executablePath: launchOpts.executablePath || '(puppeteer-managed)',
  });


  const browser = await puppeteer.launch(launchOpts);
  return browser;
}