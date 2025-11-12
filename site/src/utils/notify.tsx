// site/src/utils/notify.tsx
// Small helper module for desktop/mobile notifications + an audible "ping".
// - `ensureNotifPermission()` asks for notification permission if needed.
// - `showNotif()` shows a clickable notification (no-op if not granted).
// - `playPing()` plays /public/otp.mp3 with throttling and mobile-safe priming.
// - `notifyWithPing()` convenience: shows a notification and plays a ping.

type NotifPerm = NotificationPermission | 'denied';

export async function ensureNotifPermission(): Promise<NotifPerm> {
  try {
    if (typeof window === 'undefined') return 'denied';
    if (!('Notification' in window)) return 'denied';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    // Ask only if it's neither granted nor denied yet.
    try {
      const perm = await Notification.requestPermission();
      return perm ?? 'denied';
    } catch {
      return Notification.permission ?? 'denied';
    }
  } catch {
    return 'denied';
  }
}

export function showNotif(title: string, options?: NotificationOptions) {
  try {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    const n = new Notification(title, {
      requireInteraction: true, // stays until clicked/dismissed
      ...options,
    });

    // Best-effort focus when clicked
    n.onclick = () => {
      try { window.focus(); } catch {}
      try { n.close(); } catch {}
    };
  } catch {
    // ignore
  }
}

/** ──────────────────────────────────────────────────────────────────────────
 *  Ping sound (otp.mp3) with mobile-friendly priming & throttling
 *  NOTE: otp.mp3 must exist in /public (so it serves from /otp.mp3)
 *  ──────────────────────────────────────────────────────────────────────────
 */
let pingEl: HTMLAudioElement | null = null;
let lastPlayTs = 0;

/** Create (or reuse) the audio element and "unlock" it on first gesture. */
export function primePingAudio() {
  try {
    if (!pingEl) {
      pingEl = new Audio('/otp.mp3');
      pingEl.preload = 'auto';
      pingEl.volume = 1.0;
    }
    // Try to play silently to satisfy some browsers' policies (will no-op if blocked)
    // The real audible play will be triggered later by playPing().
    pingEl.play().then(() => {
      // Immediately pause so we don't actually hear this attempt.
      try { pingEl?.pause(); } catch {}
      if (pingEl) pingEl.currentTime = 0;
    }).catch(() => {});
  } catch {
    // ignore
  }
}

/** Attach one-time listeners to "unlock" audio after first user gesture. */
function autoPrimeOnce() {
  const primeOnce = () => {
    try { primePingAudio(); } catch {}
    window.removeEventListener('click', primeOnce, true);
    window.removeEventListener('keydown', primeOnce, true);
    window.removeEventListener('touchstart', primeOnce, true);
  };
  try {
    window.addEventListener('click', primeOnce, true);
    window.addEventListener('keydown', primeOnce, true);
    window.addEventListener('touchstart', primeOnce, true);
  } catch {
    // ignore
  }
}

// Install the priming listeners immediately on module import.
if (typeof window !== 'undefined') {
  autoPrimeOnce();
}

/**
 * Play the OTP ping sound. Throttled to avoid rapid overlaps.
 * @param volume number 0..1 (default 1)
 * @param minGapMs minimum gap between plays (default 1200ms)
 */
export function playPing(volume = 1.0, minGapMs = 1200) {
  try {
    const now = Date.now();
    if (now - lastPlayTs < minGapMs) return;

    if (!pingEl) primePingAudio();
    if (!pingEl) return;

    pingEl.volume = Math.max(0, Math.min(1, volume));
    // restart from the beginning for a crisp ping
    try { pingEl.currentTime = 0; } catch {}
    // Fire-and-forget; browsers may still block if no user gesture yet.
    void pingEl.play().catch(() => {});
    lastPlayTs = now;
  } catch {
    // ignore
  }
}

/**
 * Convenience: show a notification (if permitted) and optionally play a ping.
 * Returns nothing; both actions are best-effort.
 */
export function notifyWithPing(
  title: string,
  options?: NotificationOptions,
  { sound = true, volume = 1.0 }: { sound?: boolean; volume?: number } = {}
) {
  try {
    if (sound) playPing(volume);
    showNotif(title, options);
  } catch {
    // ignore
  }
}