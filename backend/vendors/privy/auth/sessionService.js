import { dashboardUrl } from '../config/selection.js';
import { logPrivy } from '../../../utils/logger.js';
import { safeGoto } from '../../../utils/browser.js';
import * as sessionStore from './sessionStore.js';
 
const KEEPALIVE_SYMBOL = Symbol('privy_keepalive_interval');

const keepSessionAlive = async (page) => {
  const L = logPrivy.with({ step: 'keepalive' });
  L.info('[Keep-Alive] Refreshing session…');
  try {
    // If we are already on /dashboard, prefer a soft reload to avoid new auth flows.
    const onDashboard = await page.evaluate(() => /\/dashboard/.test(location.pathname)).catch(() => false);
    if (onDashboard) {
      try {
        await page.reload({ waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 45000 });
      } catch {
        // Fall back to gentle goto if reload hiccups
        await safeGoto(page, dashboardUrl, { waitUntil: ['domcontentloaded'], timeout: 45000 });
      }
    } else {
      await safeGoto(page, dashboardUrl, { waitUntil: ['domcontentloaded'], timeout: 45000 });
    }

    // Confirm routed to dashboard (not sign_in)
    try {
      await page.waitForFunction(() => /\/dashboard/.test(location.pathname), { timeout: 15000 });
    } catch {}

    const url = page.url();
    if (url.includes('sign_in')) {
      L.error('[Keep-Alive] Session expired! Please re-login.');
      return false;
    }

    // Persist cookies so subsequent runs can reuse the session without OTP.
    try { await sessionStore.saveSessionCookies(page); } catch {}

    const nextCheckMinutes = Number(process.env.PRIVY_KEEPALIVE_MINUTES || 25);
    L.success('[Keep-Alive] Session is active', { nextCheckMinutes });
    return true;
  } catch (error) {
    L.error('[Keep-Alive] Error refreshing session', { error: error.message });
    return false;
  }
}

const session = async (browser, page) => {
  const L = logPrivy.with({ step: 'session' });
  try {
    await safeGoto(page, dashboardUrl, { waitUntil: ['domcontentloaded'], timeout: 45000 });

    const currentUrl = page.url();
    if (!currentUrl.includes('sign_in')) {
      // Prevent multiple intervals on the same Page
      if (page[KEEPALIVE_SYMBOL]) {
        clearInterval(page[KEEPALIVE_SYMBOL]);
        page[KEEPALIVE_SYMBOL] = null;
      }

      const intervalMinutes = Number(process.env.PRIVY_KEEPALIVE_MINUTES || 25);
      const intervalMs = Math.max(5, intervalMinutes) * 60 * 1000;

      const keepAliveInterval = setInterval(async () => {
        if (page.isClosed()) {
          L.error('[Keep-Alive] Page was closed. Stopping keep-alive.');
          clearInterval(keepAliveInterval);
          page[KEEPALIVE_SYMBOL] = null;
          return;
        }
        const alive = await keepSessionAlive(page);
        if (!alive) {
          clearInterval(keepAliveInterval);
          page[KEEPALIVE_SYMBOL] = null;
        }
      }, intervalMs);

      page[KEEPALIVE_SYMBOL] = keepAliveInterval;
      L.info('Keep-alive loop started', { intervalMinutes });
      return;
    }
    L.warn('Not authenticated; keep-alive not started');
    return;
  } catch (e) {
    L.info('No active browser found or connection failed', { error: e.message });
    browser = null;
    return;
  }
}

export { keepSessionAlive, session };