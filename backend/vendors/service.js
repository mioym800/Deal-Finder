import 'dotenv/config';
import express from 'express';
import { runMovotoAgent, runZillowAgent } from './agent.js';

const app = express();
app.use(express.json());

function safeParseAgentJSON(s) {
  if (!s) return null;
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const t = (m ? m[1] : s).trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a !== -1 && b !== -1 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch {}
  }
  return null;
}

// Old endpoint: Movoto only
app.get('/price', async (req, res) => {
  const address = (req.query.address || '').toString();
  if (!address) return res.status(400).json({ error: 'Missing address' });
  try {
    const out = await runMovotoAgent(address);
    const parsed = safeParseAgentJSON(out);
    if (parsed) return res.json(parsed);
    return res.json({ price: null, address, confidence: 0, notes: 'Unparseable agent output', raw: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// New endpoint: Movoto + Zillow in parallel
app.get('/price-plus', async (req, res) => {
  const address = (req.query.address || '').toString();
  if (!address) return res.status(400).json({ error: 'Missing address' });
  try {
    const [movotoRaw, zillowRaw] = await Promise.allSettled([
      runMovotoAgent(address),
      runZillowAgent(address)
    ]);

    const movoto = movotoRaw.status === 'fulfilled' ? safeParseAgentJSON(movotoRaw.value) : null;
    const zillow = zillowRaw.status === 'fulfilled' ? safeParseAgentJSON(zillowRaw.value) : null;

    res.json({
      address,
      movoto: movoto || { price: null, confidence: 0, notes: movotoRaw.reason?.message || 'Failed' },
      zillow: zillow || { zestimate: null, confidence: 0, notes: zillowRaw.reason?.message || 'Failed' }
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.use(express.static('public'));

const port = process.env.PORT || 5057;
app.listen(port, () => {
  console.log(`\nMovoto/Zillow Agent server  ->  http://localhost:${port}`);
  console.log(`Try Movoto only:  curl "http://localhost:${port}/price?address=1144%20E%20Whittier%20St%2C%20Columbus%2C%20OH%2043206"`);
  console.log(`Try Both:         curl "http://localhost:${port}/price-plus?address=1144%20E%20Whittier%20St%2C%20Columbus%2C%20OH%2043206"`);
});
