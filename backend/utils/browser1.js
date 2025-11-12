// utils/browser.js
import puppeteer from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteerExtra from 'puppeteer-extra';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  PUPPETEER_EXECUTABLE_PATH = '/usr/bin/google-chrome',
  PPTR_HEADLESS = 'new',
  PUPPETEER_ARGS = '',
  PUPPETEER_EXTRA_ARGS = '',
  PUPPETEER_PROTOCOL_TIMEOUT_MS = '180000',
  BOFA_BLOCK_MEDIA = '1',
  PUPPETEER_STEALTH = '1',
  CHROME_USER_DATA_DIR = '',
} = process.env;

// enable stealth on top of the stock puppeteer
// enable stealth on top of the stock puppeteer (allow disabling via env)
if (String(PUPPETEER_STEALTH) !== '0') {
  puppeteerExtra.use(StealthPlugin());
}

function makeRunProfile() {
  // If the caller/env pinned a profile, honor it (at your own risk re: SingletonLock)
  if (CHROME_USER_DATA_DIR && CHROME_USER_DATA_DIR.trim()) return CHROME_USER_DATA_DIR.trim();
  const root = process.env.PUPPETEER_TMP_DIR || os.tmpdir();
  const dir = path.join(root, `pptr-profile-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}



export async function launchBrowser(extraArgs = []) {
// Sanitize env-injected args so they don't fight our job-supplied args
  const sanitizedEnvArgs = PUPPETEER_ARGS
    .split(' ')
    .filter(Boolean)
    .filter(a =>
     !a.startsWith('--proxy-server=') &&
      !a.startsWith('--user-data-dir=') &&
      !a.startsWith('--remote-debugging-port=')
    );

  const extraEnvArgs = PUPPETEER_EXTRA_ARGS.split(' ').filter(Boolean);

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--window-size=1366,800',
    ...sanitizedEnvArgs,
    ...extraEnvArgs,
    // IMPORTANT: job-provided flags (proxy, user-data-dir) come last and win
    ...extraArgs,
    // small safety: keep proxy from bypassing anything local except loopback
    '--proxy-bypass-list=<-loopback>',
        `--user-data-dir=${makeRunProfile()}`,
    '--no-first-run',
    '--no-default-browser-check',
   ];

  const browser = await puppeteerExtra.launch({
    executablePath: PUPPETEER_EXECUTABLE_PATH,
    // Normalize to modern headless when env is truthy (your working repro)
    headless:
      (PPTR_HEADLESS === 'false' || PPTR_HEADLESS === false)
        ? false
        : (PPTR_HEADLESS === 'true' || PPTR_HEADLESS === true) ? 'new' : PPTR_HEADLESS,
    args,
    protocolTimeout: Number(PUPPETEER_PROTOCOL_TIMEOUT_MS),
  });

  return browser;
}

export async function newPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(45000);


  return page;
}

// Call this AFTER the first successful goto() behind the proxy
export async function enableLightInterception(page) {
  if (BOFA_BLOCK_MEDIA !== '1') return;
  try {
    await page.setRequestInterception(true);
    page.removeAllListeners('request');
    page.on('request', req => {
      const t = req.resourceType();
      if (['image', 'media', 'font'].includes(t)) return req.abort();
      req.continue();
    });
  } catch {}
}