import express from 'express';
import { progressTracker } from '../../vendors/runAutomation.js';
import { logBus, getRecentLogs } from '../../utils/logger.js';
import { getOtpState, onOtpChange } from '../../state/otpState.js';

const router = express.Router();

// Helper to include additional dynamic fields with the tracker snapshot
// function buildSnapshot() {
//   return { ...progressTracker, otp: getOtpState() };
// }

async function buildSnapshot() {
     const otp = await getOtpStateDB();
     return { ...progressTracker, otp };
   }


// JSON snapshot for polling (what your dashboard calls frequently)
router.get('/', (req, res) => {
  res.json(buildSnapshot());
});

// Live logs / progress via Server-Sent Events (SSE)
router.get('/logs', (req, res) => {
  // CORS for cross-origin dashboards
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  // SSE essentials
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // Helpful for proxies
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const send = (payload) => {
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {}
  };

  // Advise the client how fast to retry
  res.write('retry: 2000\n\n');

  // Initial snapshot (progress)
  // send({
  //   type: 'status',
  //   ts: Date.now(),
  //   status: progressTracker.status,
  //   stats: progressTracker.stats,
  //   isRunning: progressTracker.isRunning,
  //   lastRun: progressTracker.lastRun,
  //   jobs: progressTracker.jobs,
  //   otp: getOtpState(),
  // });

  (async () => {
       const otp = await getOtpStateDB();
       send({
         type: 'status',
         ts: Date.now(),
        status: progressTracker.status,
         stats: progressTracker.stats,
         isRunning: progressTracker.isRunning,
         lastRun: progressTracker.lastRun,
         jobs: progressTracker.jobs,
         otp,
       });
     })();


  // Send recent logger backlog (so the panel isn't empty on open)
  const backlog = getRecentLogs(200);
  if (backlog && backlog.length) {
    send({ type: 'logs', ts: Date.now(), logs: backlog });
  }

  // Heartbeat every 15s (keeps connections alive)
  const hb = setInterval(() => {
    send({ type: 'heartbeat', ts: Date.now(), status: progressTracker.status });
  }, 15000);

  // Diff-push progress every 1s
  let prev = '';
  const tick = setInterval(async () => {
    try {
      const snapshot = await buildSnapshot();
      const snap = JSON.stringify(snapshot);
      if (snap !== prev) {
        prev = snap;
        send({ type: 'update', ts: Date.now(), ...snapshot });
      }
    } catch {}
  }, 1000);

  // Subscribe to live logger events
  const onLog = (evt) => send({ type: 'log', ...evt });
  logBus.on('log', onLog);

  const onOtp = () => send({ type: 'otp', ts: Date.now(), otp: getOtpState() });
  const removeOtpListener = onOtpChange(onOtp);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(hb);
    clearInterval(tick);
    logBus.off('log', onLog);
    removeOtpListener();
    try { res.end(); } catch {}
  });
});

const automationStatusRoutes = router;
export default automationStatusRoutes;
