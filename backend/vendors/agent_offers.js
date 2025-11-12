// backend/vendors/agent_offers.js
import connectDB from '../db/db.js';
import mongoose from 'mongoose';
import { sendOffer } from '../services/emailService.js';
import AgentSend from '../models/AgentSend.js';
import { log } from '../utils/logger.js';

// --- simple helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date();

async function toArraySafe(cursorOrArray) {
  if (!cursorOrArray) return [];
  if (Array.isArray(cursorOrArray)) return cursorOrArray;
  if (typeof cursorOrArray.toArray === 'function') {
    try { return await cursorOrArray.toArray(); } catch { /* fallthrough */ }
  }
  // Support async iterables (aggregate/find cursors in some drivers)
  const out = [];
  try {
    for await (const doc of cursorOrArray) out.push(doc);
    return out;
  } catch {
    return out; // empty on failure
  }
}

// --- env knobs (safe defaults) ---
const DEDUPE_DAYS = parseInt(process.env.AGENT_OFFERS_DEDUPE_DAYS || '14', 10);
const DAILY_CAP   = parseInt(process.env.SUBADMIN_DAILY_CAP || '200', 10);
const RATE_PER_MIN = parseInt(process.env.EMAIL_RATE_PER_MIN || '60', 10);
const CONCURRENCY  = parseInt(process.env.EMAIL_MAX_CONCURRENCY || '5', 10);

// token-bucket style pacing (very light): spread sends across the minute
const SPACING_MS = Math.floor(60000 / Math.max(RATE_PER_MIN, 1));

// We intentionally query raw collections to avoid requiring app-wide Mongoose models
function usersCol() { return mongoose.connection.collection('users'); }
function propsCol() { return mongoose.connection.collection('properties'); }

/**
 * Main worker
 * - Call this from your scheduler/runAutomation map under key "agent_offers"
 */
export default async function runAgentOffers() {
  await connectDB(); // no-op if already connected
  log.info('[agent_offers] start');

  // 1) Fetch subadmins and filter in JS (simple find + projection)
  let allUsers = [];
  try {
    const cursor = usersCol().find({}, { projection: { _id: 1, email: 1, name: 1, states: 1, role: 1, active: 1 } });
    allUsers = await toArraySafe(cursor);
  } catch (e) {
    log.error('[agent_offers] subadmin fetch failed', { err: String(e && e.message ? e.message : e) });
    return;
  }
  log.info('[agent_offers] users fetched', { count: Array.isArray(allUsers) ? allUsers.length : 0 });

  const truthy = (v) => v === true || v === 1 || v === 'true' || v === 'TRUE';
  const looksLikeSubadmin = (u) => /subadmin/i.test(String(u?.role || ''));
  const hasStates = (u) => Array.isArray(u?.states) && u.states.length > 0;

  const subadmins = (allUsers || []).filter((u) => looksLikeSubadmin(u) && hasStates(u) && truthy(u.active));

  log.info('[agent_offers] matched subadmins (JS filter)', { count: subadmins.length, emails: subadmins.map((u) => u.email) });

  if (!subadmins.length) {
    log.info('[agent_offers] no active subadmins found after JS filter', { totalUsers: (allUsers || []).length });
    return;
  }

  const dedupeCutoff = new Date(Date.now() - DEDUPE_DAYS * 24 * 60 * 60 * 1000);

  for (const s of subadmins) {
    const states = Array.isArray(s.states) ? s.states : [];
    if (!Array.isArray(states) || states.length === 0) {
      log.info(`[agent_offers] skipping ${s.email} — no states array`);
      continue;
    }

    log.info(`[agent_offers] subadmin ${s.name || s.email} states=${states.join(',')}`);

    // 2) Find candidate properties for this subadmin
    let candidates = [];
    try {
      const cursor = propsCol().find(
        {
          deal: true,
          state: { $in: states },
          $or: [
            { agent_email: { $exists: true, $ne: '' } },
            { agentEmail:  { $exists: true, $ne: '' } },
          ],
        },
        {
          projection: {
            _id: 1,
            fullAddress: 1,
            agent_email: 1,
            agentEmail: 1,
            agent: 1,
            agentName: 1,
            listPrice: 1,
            amv: 1,
            offerAmount: 1,
            state: 1,
          },
        }
      );
      // limit if supported; otherwise slice after materializing
      if (typeof cursor.limit === 'function') cursor.limit(DAILY_CAP);
      const arr = await toArraySafe(cursor);
      candidates = Array.isArray(arr) ? arr.slice(0, DAILY_CAP) : [];
    } catch (e) {
      log.error('[agent_offers] candidate fetch failed', { err: String(e && e.message ? e.message : e), states });
      candidates = [];
    }

    if (!candidates.length) {
      log.info(`[agent_offers] no candidate deals for ${s.email}`);
      continue;
    }

    // 3) Process with lightweight concurrency
    const queue = [...candidates];
    const workers = new Array(Math.min(CONCURRENCY, queue.length))
      .fill(null)
      .map(() => workerLoop(queue, s, dedupeCutoff));

    await Promise.all(workers);
  }

  log.info('[agent_offers] done');
}

// --- worker loop for concurrency slots ---
async function workerLoop(queue, subadmin, dedupeCutoff) {
  while (queue.length) {
    const property = queue.shift();
    try {
      await processOne(property, subadmin, dedupeCutoff);
      // pace out sends to meet RATE_PER_MIN
      await sleep(SPACING_MS);
    } catch (err) {
      // do not crash whole job; log and continue
      log.error('[agent_offers] processOne error', { err: err?.message, propertyId: property?._id?.toString() });
    }
  }
}

// --- per-property send with dedupe, logging, and stamping ---
async function processOne(property, subadmin, dedupeCutoff) {
  // normalize email + agent name from either schema
  const agentEmail = property.agentEmail || property.agent_email || '';
  const agentName  = property.agentName || property.agent || '';
  if (!agentEmail) return; // defensive guard

  // 3a) dedupe check (recent sent to SAME property by SAME subadmin)
  const dup = await AgentSend.findOne({
    propertyId: property._id,
    subadminId: subadmin._id || subadmin.id, // works whether you fetch _id as ObjectId or id as string
    status: 'sent',
    createdAt: { $gte: dedupeCutoff },
  }).lean();

  if (dup) {
    await AgentSend.create({
      propertyId: property._id,
      subadminId: subadmin._id || subadmin.id,
      agentEmail: agentEmail,
      status: 'skipped',
      reason: 'duplicate-within-window',
    });
    return;
  }

  // 3b) record queued first for traceability
  const record = await AgentSend.create({
    propertyId: property._id,
    subadminId: subadmin._id || subadmin.id,
    agentEmail: agentEmail,
    status: 'queued',
  });

  try {
    // 3c) send via offer service (handles price calc + template)
    const offerPrice =
      property?.offerAmount
      ?? (property?.listPrice ? Math.round(property.listPrice * 0.80) : null)
      ?? (property?.amv ? Math.round(property.amv * 0.39) : null);

    const result = await sendOffer({
      to: agentEmail,
      from: `${subadmin.name || subadmin.email} <${subadmin.email}>`,
      replyTo: subadmin.email,
      subject: `Offer to Purchase — ${property.fullAddress || ''}`,
      template: 'agent_offer_v1.html',
      variables: {
        date: new Date().toISOString().slice(0, 10),
        agent_name: agentName || '',
        property_address: property.fullAddress || '',
        offer_price: offerPrice != null ? `$${offerPrice.toLocaleString()}` : '',
        emd: '$5,000',
        terms: 'As-is, cash, 7–10 day close',
        reply_to: subadmin.email,
      },
      property,
      subadmin,
    });

    await AgentSend.findByIdAndUpdate(record._id, {
      status: 'sent',
      messageId: result?.messageId || null,
    });

    // 3d) stamp property.offerStatus for quick lookups
    await propsCol().updateOne(
      { _id: property._id },
      {
        $set: {
          offerStatus: {
            lastSentAt: now(),
            subadminId: subadmin._id || subadmin.id,
            lastResult: 'sent',
            lastMessageId: result?.messageId || null,
          },
          agentEmailNormalized: agentEmail,
        },
      }
    );
  } catch (e) {
    await AgentSend.findByIdAndUpdate(record._id, {
      status: 'failed',
      reason: e?.message || 'send-error',
    });
    throw e; // bubble to be logged by worker loop
  }
}