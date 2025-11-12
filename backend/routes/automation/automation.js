import express from 'express';
import runAutomation, { progressTracker } from '../../vendors/runAutomation.js';
import { getOtpStateDB, submitOtpCodeDB, cancelOtpRequestDB } from '../../state/otpState.js';

const router = express.Router();

// Start the automation run (non-blocking)
router.post('/start', async (req, res) => {
  try {
    // Optional jobs selection: array or comma-separated string (privy,home_valuations,current_listings)
    const jobs = req.body?.jobs ?? undefined;

    if (progressTracker.isRunning) {
      return res.status(409).json({ ok: false, message: 'Automation already running', status: progressTracker.status });
    }

    // Fire-and-forget; progress is visible via /api/automation/status and /api/automation/logs
    Promise.resolve().then(() => runAutomation(jobs));

    return res.status(202).json({ ok: true, message: 'Automation started', jobs: jobs || '(default)' });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Failed to start automation', error: err?.message || String(err) });
  }
});

// Backward-compatible endpoint
router.post('/run', async (req, res) => {
  if (progressTracker.isRunning) {
    return res.status(409).json({ ok: false, message: 'Automation already running', status: progressTracker.status });
  }
  Promise.resolve().then(() => runAutomation(req.body?.jobs));
  return res.status(202).json({ ok: true, message: 'Automation started (compat /run)' });
});

// Stop request — asks the automation to stop accepting new work and clears pending queue.
router.post('/stop', async (req, res) => {
  try {
    if (!progressTracker.isRunning && progressTracker.status !== 'running') {
      return res.status(200).json({ ok: true, message: 'Automation is not running' });
    }
    // Signal stop via the exported helper on runAutomation module
    if (typeof progressTracker._requestStop === 'function') {
      progressTracker._requestStop();
    }
    return res.status(202).json({ ok: true, message: 'Stop requested' });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Failed to request stop', error: err?.message || String(err) });
  }
});

router.get('/otp', async (_req, res) => {
  const otp = await getOtpStateDB();
  return res.json({ ok: true, otp });
});

// Back-compat alias for older frontends still polling /otp/state
router.get('/otp/state', async (_req, res) => {
  const otp = await getOtpStateDB();
  return res.json({ ok: true, otp });
});

// router.post('/otp', async (req, res) => {
//   try {
//     const rawId = req.body?.id;
//     const rawCode = req.body?.code;
//     const rawService = req.body?.service;

//     const id = typeof rawId === 'string' ? rawId.trim() : String(rawId || '').trim();
//     let code = typeof rawCode === 'string' ? rawCode : String(rawCode || '');
//     code = code.replace(/\D+/g, '').trim(); // keep digits only
//     const service = rawService ? String(rawService) : undefined;

//     if (!id || !code) {
//       return res.status(400).json({ ok: false, error: 'OTP id and code are required' });
//     }

//     await submitOtpCodeDB({ id, code, service });
//     return res.json({ ok: true, cleared: true, otp: null });
//   } catch (err) {
//     return res.status(400).json({ ok: false, error: err?.message || 'Failed to submit OTP' });
//   }
// });

// Back-compat alias for frontends posting to /api/automation/otp/submit


router.post('/otp', async (req, res) => {
     try {
       const rawId = req.body?.id;
       const rawCode = req.body?.code;
       let code = typeof rawCode === 'string' ? rawCode : String(rawCode || '');
       code = code.replace(/\D+/g, '').trim(); // digits only (handles spaces/dashes/paste)
  
       if (!code) {
         return res.status(400).json({ ok: false, error: 'OTP code is required' });
       }
  
       // If no id was sent, or if it’s stale, fall back to the active DB id.
       const cur = await getOtpStateDB();
       if (!cur) {
         return res.status(400).json({ ok: false, error: 'No OTP request pending' });
       }
       const id = (typeof rawId === 'string' ? rawId.trim() : String(rawId || '').trim()) || cur.id;
  
       await submitOtpCodeDB({ id, code });
       return res.json({ ok: true, cleared: true, otp: null });
     } catch (err) {
       return res.status(400).json({ ok: false, error: err?.message || 'Failed to submit OTP' });
     }
   });

// router.post('/otp/submit', async (req, res) => {
//   try {
//     const rawId = req.body?.id;
//     const rawCode = req.body?.code;
//     const rawService = req.body?.service;

//     const id = typeof rawId === 'string' ? rawId.trim() : String(rawId || '').trim();
//     let code = typeof rawCode === 'string' ? rawCode : String(rawCode || '');
//     // accept pasted codes with spaces/dashes; keep digits only
//     code = code.replace(/\D+/g, '').trim();
//     const service = rawService ? String(rawService) : undefined;

//     if (!id || !code) {
//       return res.status(400).json({ ok: false, error: 'OTP id and code are required' });
//     }

//     await submitOtpCodeDB({ id, code, service });
//     return res.json({ ok: true, cleared: true, otp: null });
//   } catch (err) {
//     return res.status(400).json({ ok: false, error: err?.message || 'Failed to submit OTP' });
//   }
// });

router.post('/otp/submit', async (req, res) => {
     try {
       const rawId = req.body?.id;
       const rawCode = req.body?.code;
       let code = typeof rawCode === 'string' ? rawCode : String(rawCode || '');
       code = code.replace(/\D+/g, '').trim();
       if (!code) {
        return res.status(400).json({ ok: false, error: 'OTP code is required' });
       }
       const cur = await getOtpStateDB();
       if (!cur) {
         return res.status(400).json({ ok: false, error: 'No OTP request pending' });
       }
       const id = (typeof rawId === 'string' ? rawId.trim() : String(rawId || '').trim()) || cur.id;
  
       await submitOtpCodeDB({ id, code });
       return res.json({ ok: true, cleared: true, otp: null });
     } catch (err) {
       return res.status(400).json({ ok: false, error: err?.message || 'Failed to submit OTP' });
     }
   });


router.post('/otp/cancel', async (req, res) => {
  const reason = req.body?.reason || 'Cancelled via API';
  await cancelOtpRequestDB(reason);
  const otp = await getOtpStateDB();
  return res.json({ ok: true, cancelled: true, otp });
});

const automationRoutes = router;
export default automationRoutes;
