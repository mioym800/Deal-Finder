// backend/jobs/computeAmv.js
import mongoose from 'mongoose';
import Property from '../models/Property.js';
import { log } from '../utils/logger.js';
import connectDB from '../db/db.js';

// Small helpers
const toNum = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function computeAMVFromDoc(doc) {
  // prefer canonical redfin_value; fall back to legacy redfinPrice
  const bofa   = toNum(doc.bofa_value);
  const redfin = toNum(
    Number.isFinite(doc.redfin_value) ? doc.redfin_value : doc.redfinPrice
  );

  const vals = [];
  if (Number.isFinite(bofa))   vals.push(bofa);
  if (Number.isFinite(redfin)) vals.push(redfin);

  if (!vals.length) return null;
  const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  return avg;
  console.log(`[amv-debug] addr=${doc.fullAddress} bofa=${bofa} redfin=${redf}`);
}

function computeDealFlag(price, amv, threshold = 0.5) {
  const p = toNum(price);
  if (!Number.isFinite(p) || !Number.isFinite(amv)) return false;
  return p <= Math.round(threshold * amv);
}

/**
 * Recompute AMV for properties and update DB.
 * Env knobs:
 *   AMV_RECOMPUTE_ALL=1    → recompute for all docs (default: only where amv is null)
 *   AMV_BATCH_SIZE=500
 *   AMV_CONCURRENCY=8
 *   AMV_DEAL_THRESH=0.5
 */
export default async function runComputeAmvJob({
  recomputeAll = process.env.AMV_RECOMPUTE_ALL === '1',
  batchSize = Number(process.env.AMV_BATCH_SIZE || 500),
  concurrency = Math.max(1, Number(process.env.AMV_CONCURRENCY || 8)),
  dealThresh = Number(process.env.AMV_DEAL_THRESH || 0.5),
} = {}) {
  await connectDB();

  const baseQuery = recomputeAll
    ? {}
    : { $or: [{ amv: null }, { amv: { $exists: false } }] };

  const total = await Property.countDocuments(baseQuery);
  log.info('AMV: starting recompute', { total, recomputeAll, batchSize, concurrency });

  let processed = 0;
  let updated = 0;

  // Cursor → batched processing to avoid big memory spikes
  const cursor = Property.find(baseQuery).cursor();

  const queue = [];
  const runOne = async (doc) => {
    const amv = computeAMVFromDoc(doc);
    if (!Number.isFinite(amv)) return false;

    const deal = computeDealFlag(doc.price, amv, dealThresh);

    // Only write if changed to reduce write pressure
    const needUpdate = doc.amv !== amv || !!doc.deal !== !!deal;
    if (!needUpdate) return false;

    await Property.updateOne(
      { _id: doc._id },
      { $set: { amv, deal } }
    );

    return true;
  };

  for await (const doc of cursor) {
    // throttle by concurrency
    const job = runOne(doc)
      .then((changed) => { if (changed) updated++; })
      .catch((e) => log.warn('AMV: update failed', { id: String(doc._id), err: e.message }))
      .finally(() => { processed++; });

    queue.push(job);
    if (queue.length >= concurrency) {
      await Promise.race(queue);
      // prune settled
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].settled) queue.splice(i, 1);
      }
    }

    // lightweight progress
    if (processed % 500 === 0) {
      log.info('AMV progress', { processed, updated, total });
    }

    // mark settled on promise (for pruning)
    job.finally(() => { job.settled = true; });
  }

  // drain
  await Promise.allSettled(queue);

  log.success('AMV: recompute complete', { processed, updated, total });
}