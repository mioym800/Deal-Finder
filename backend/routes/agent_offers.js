// backend/routes/agent_offers.js
import express from 'express';
import { getSummary, getLogs, runNow, sendNow } from '../controllers/agentOffersController.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

/**
 * GET /api/agent-offers/summary?since=YYYY-MM-DD
 * Returns counts by subadmin and status, optionally since a given date.
 */
router.get('/summary', getSummary);

/**
 * GET /api/agent-offers/logs?subadminId=...&status=...&page=1&limit=50&since=YYYY-MM-DD
 * Returns paginated send logs from AgentSend.
 */
router.get('/logs', getLogs);

/**
 * POST /api/agent-offers/run
 * Triggers the Agent Offers automation (all subadmins).
 */
router.post('/run', runNow);

// NEW: save agent details and send email immediately (scoped to the caller)
router.post('/send/:propertyId', requireAuth, sendNow);

export default router;