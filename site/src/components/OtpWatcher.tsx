// site/src/components/OtpWatcher.tsx
import { useEffect, useRef } from 'react';
import { getOtpState } from '../helpers';
import { ensureNotifPermission, showNotif, playPing } from '../utils/notify.tsx';

export default function OtpWatcher() {
  const lastIdRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: any;

    const tick = async () => {
      try {
        const { otp } = await getOtpState(); // expected shape { otp?: { id, service, ... } }
        if (!active) return;

        const currentId = otp?.id || null;

        // first run: just remember it
        if (lastIdRef.current === null) {
          lastIdRef.current = currentId;
        } else if (currentId && lastIdRef.current !== currentId) {
          // a brand-new OTP request arrived
          lastIdRef.current = currentId;

          const perm = await ensureNotifPermission();
          if (perm === 'granted') {
            showNotif('Privy OTP needed', {
              body: 'Open the app and enter the code to continue.',
              tag: `otp-${currentId}`,
              renotify: true,
            });
            playPing(); // 🔊 now it will play your otp.mp3
          }
          // Browser title nudge (optional)
          try {
            const base = document.title.replace(/^\(\d+\)\s*/, '');
            document.title = `(1) ${base}`;
            setTimeout(() => {
              document.title = base;
            }, 10000);
          } catch {}
        }
      } catch {
        // ignore
      } finally {
        timer = setTimeout(tick, 2000); // poll every 2s (same cadence as your screen)
      }
    };

    tick();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  return null; // headless component
}