import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../db/db.js';
import Property from '../models/Property.js';

const AMV_INTERVAL_MS = Number(process.env.AMV_INTERVAL_MS || 3 * 60 * 1000); // default 3 minutes

const args = process.argv.slice(2);

// --- simple arg parser ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getFlag(name, def = false) {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  if (hit.includes('=')) {
    const val = hit.split('=').slice(1).join('=');
    if (val === '' || val === 'true') return true;
    if (val === 'false') return false;
    const n = Number(val);
    if (Number.isFinite(n)) return n;
    try { return JSON.parse(val); } catch { return val; }
  }
  return true;
}

const ONLY_MISSING   = !!getFlag('only-missing', false);
const LIMIT          = Number(getFlag('limit', 0)) || 0;          // 0 = no limit
const CONCURRENCY    = Math.max(1, Number(getFlag('concurrency', 4)) || 4);
const DRY_RUN        = !!getFlag('dry-run', false);
const WHERE_RAW      = getFlag('where', null);

// optional additional query via --where='{"state":"CA"}'
let WHERE = {};
if (WHERE_RAW && typeof WHERE_RAW === 'object') WHERE = WHERE_RAW;

// Only recompute where amv is missing?
if (ONLY_MISSING) WHERE = { ...WHERE, $or: [{ amv: { $exists: false } }, { amv: null }] };

const BATCH_SIZE = 2000000000000; // bulkWrite batch flush size

function cleanNumber(n) {
  if (typeof n === 'number') return Number.isFinite(n) ? n : null;
  if (typeof n === 'string') {
    const v = Number(n.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

function computeAMVFromDoc(doc) {
  // Prefer the model’s static if present; fall back to simple mean
  const bofa = cleanNumber(doc.bofa_value);
  const redf = cleanNumber(doc.redfin_avm_value);

  if (typeof Property.computeAMV === 'function') {
    return Property.computeAMV({ bofa_value: bofa, redfin_avm_value: redf });
  }
  // Fallback: mean of available sources
  const vals = [bofa, redf].filter(v => Number.isFinite(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function computeDealFromDoc({ amv, price, doc }) {
  if (typeof Property.computeDealFlag === 'function') {
    return Property.computeDealFlag({ amv, price });
  }
  // Fallback heuristic: mark deal if price <= 0.8 * amv
  const p = cleanNumber(price);
  const a = cleanNumber(amv);
  if (!Number.isFinite(p) || !Number.isFinite(a)) return undefined;
  return p <= 0.8 * a;
}

class ConcurrencyLimiter {
  constructor(limit = 1) { this.limit = limit; this.active = 0; this.queue = []; }
  run(task) {
    return new Promise((resolve, reject) => {
      const exec = async () => {
        this.active++;
        try { resolve(await task()); }
        catch (e) { reject(e); }
        finally { this.active--; this._next(); }
      };
      if (this.active < this.limit) exec();
      else this.queue.push(exec);
    });
  }
  _next() { if (this.active >= this.limit) return; const n = this.queue.shift(); if (n) n(); }
}

async function main() {
  await connectDB();

  const projection = {
    _id: 1,
    fullAddress: 1,
    price: 1,
    amv: 1,
    bofa_value: 1,
    redfin_avm_value: 1,
  };

  const total = await Property.countDocuments(WHERE).exec();
  if (LIMIT > 0 && LIMIT < total) {
    console.log(`[amv] Scoping to first ${LIMIT} of ${total} docs by LIMIT.`);
  } else {
    console.log(`[amv] Will process ${total} documents.`);
  }

  const cursor = Property.find(WHERE, projection)
    .sort({ _id: 1 }) // stable order for resumability
    .cursor();

  const limiter = new ConcurrencyLimiter(CONCURRENCY);
  const ops = [];
  let scanned = 0, changed = 0, skipped = 0, written = 0, inFlight = 0;

  async function flush(force = false) {
    if (!ops.length) return;
    if (!force && ops.length < BATCH_SIZE) return;
    const batch = ops.splice(0, ops.length);
    if (DRY_RUN) {
      written += batch.length;
      return;
    }
    const res = await Property.bulkWrite(batch, { ordered: false });
    written += (res?.nModified || res?.modifiedCount || 0) + (res?.nUpserted || 0);
  }

  function queueUpdate(_id, set) {
    ops.push({ updateOne: { filter: { _id }, update: { $set: set } } });
  }

  for await (const doc of cursor) {
    if (LIMIT && scanned >= LIMIT) break;
    scanned++;

    await limiter.run(async () => {
      inFlight++;
      try {
        const currentAMV = cleanNumber(doc.amv);
        const newAMV = computeAMVFromDoc(doc);

        // If nothing to compute, skip
        if (newAMV == null && currentAMV == null) { skipped++; return; }

        const amvToUse = (newAMV != null ? newAMV : currentAMV);
        const newDeal = computeDealFromDoc({ amv: amvToUse, price: doc.price, doc });

        const set = {};
        // Update AMV if changed or if only-missing wanted and it was null
        if (newAMV != null && newAMV !== currentAMV) set.amv = newAMV;

        // Always re-evaluate deal if we computed/retained a valid amv
        if (newDeal !== undefined) set.deal = !!newDeal;

        if (Object.keys(set).length) {
          changed++;
          queueUpdate(doc._id, set);
          await flush(false); // flush when batch fills
        } else {
          skipped++;
        }
      } finally {
        inFlight--;
      }
    });

    if (scanned % 1000 === 0) {
      console.log(`[amv] progress: scanned=${scanned}/${LIMIT || total} changed=${changed} skipped=${skipped} queued=${ops.length} inFlight=${inFlight}`);
    }
  }

  // wait for any in-flight tasks to finish (limiter drains naturally)
  while (inFlight > 0) {
    await new Promise(r => setTimeout(r, 50));
  }

  // final flush
  await flush(true);

  console.log(`[amv] DONE — scanned=${scanned} changed=${changed} written=${written} skipped=${skipped} dryRun=${DRY_RUN}`);
  await mongoose.connection.close();
}

// --- Continuous daemon loop ---
async function loopForever() {
  // graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[amv] Received ${signal}. Shutting down gracefully…`);
    try { await mongoose.connection.close(); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  while (true) {
    try {
      console.log(`[amv] Starting recompute cycle at ${new Date().toISOString()}`);
      await main();
      console.log(`[amv] Cycle complete. Sleeping ${AMV_INTERVAL_MS}ms before next run…`);
    } catch (e) {
      console.error('[amv] Error during recompute cycle:', e);
      // small extra delay on error to avoid hot loop
    }
    await sleep(AMV_INTERVAL_MS);
  }
}

// Boot the persistent loop instead of one-shot main()
loopForever().catch(async (e) => {
  console.error('[amv] Fatal daemon error:', e);
  try { await mongoose.connection.close(); } catch {}
  process.exit(1);
});