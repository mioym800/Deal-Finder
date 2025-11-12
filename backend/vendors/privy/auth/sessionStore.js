import fs from 'fs';
import path from 'node:path';

const STORE = process.env.PRIVY_SESSION_FILE || path.join(process.cwd(), 'var/privy-session.json');

export function hasFreshPrivySession(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const st = fs.statSync(STORE);
    return (Date.now() - st.mtimeMs) < maxAgeMs;
  } catch {
    return false;
  }
}

export function readPrivySession() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveSessionCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(
      STORE,
      JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    // silently ignore errors
  }
}