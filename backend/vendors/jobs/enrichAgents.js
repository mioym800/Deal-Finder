// backend/vendors/jobs/enrichAgents.js
import connectDB from '../../db/db.js';
import { getPropertiesWithNoEmails } from '../../controllers/propertyController.js';
import { enrichAgentForProperty } from '../../services/enrichAgentService.js';
import pLimit from 'p-limit';

const CONCURRENCY = Number(process.env.ENRICH_AGENT_CONCURRENCY || 2);
const LIMIT_COUNT = Number(process.env.ENRICH_AGENT_BATCH || 25);

export async function runEnrichAgentsJob() {
  await connectDB().catch(()=>{});
  const candidates = await getPropertiesWithNoEmails();
  const batch = candidates.slice(0, LIMIT_COUNT);

  if (!batch.length) {
    console.log('[enrich_agents] nothing to do');
    return { scanned: 0, done: 0 };
  }

  const limit = pLimit(CONCURRENCY);
  let done = 0;

  await Promise.all(batch.map((p) =>
    limit(async () => {
      const fullAddress = p.fullAddress || p.full_address || p.address;
      if (!fullAddress) {
        console.warn('[enrich_agents] skip – missing fullAddress on doc', String(p._id));
        return;
      }
      try {
        await enrichAgentForProperty({ id: String(p._id), fullAddress });
        done++;
        console.log('[enrich_agents] ok', fullAddress, String(p._id));
      } catch (e) {
        const msg = e?.response?.data || e?.message || e;
        console.warn('[enrich_agents] failed', fullAddress || p.fullAddress, msg);
      }
    })
  ));

  console.log(`[enrich_agents] finished batch`, { scanned: batch.length, done });
  return { scanned: batch.length, done };
}

export default runEnrichAgentsJob;