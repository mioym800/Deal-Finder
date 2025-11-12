import express from 'express';
import { enrichAgentForProperty } from '../services/enrichAgentService.js';

const router = express.Router();

// Thin wrapper route: delegates enrichment to the service layer
router.post('/:id/enrich-agent', async (req, res) => {
  try {
    const { id } = req.params;
    const { fullAddress } = req.body || {};
    if (!fullAddress) {
      return res.status(400).json({ error: 'fullAddress is required' });
    }

    const result = await enrichAgentForProperty({ id, fullAddress });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('enrich-agent(chatgpt-only) error', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to enrich agent info (chatgpt-only)' });
  }
});

export default router;