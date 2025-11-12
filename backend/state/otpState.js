import mongoose from 'mongoose';
import { EventEmitter } from 'node:events';
import { log } from '../utils/logger.js';

const L = log.child('otpState');

// --- Mongo-backed single-record store (works across multiple processes) ---
const OtpStateSchema = new mongoose.Schema({
  id: { type: String },
  service: { type: String },
  prompt: { type: String },
  requestedAt: { type: String }, // ISO string
  timeoutMs: { type: Number },
  meta: { type: mongoose.Schema.Types.Mixed },
  submittedCode: String,
  submittedAt: String,
}, { collection: 'otp_state' });

const OtpStateModel = mongoose.models.OtpState || mongoose.model('OtpState', OtpStateSchema);

async function dbGet() {
  const doc = await OtpStateModel.findOne({}).lean();
  if (!doc) return null;

  // auto-expire check
  const start = Date.parse(doc.requestedAt || '') || 0;
  const ttl = Number(doc.timeoutMs || 0);
  if (ttl > 0 && Date.now() > start + ttl) {
    try { await OtpStateModel.deleteMany({}); } catch {}
    return null;
  }
  return doc;
}

async function dbSet(state) {
  await OtpStateModel.updateOne({}, { $set: state }, { upsert: true });
  return dbGet();
}

async function dbClear() {
  await OtpStateModel.deleteMany({});
  return null;
}

const emitter = new EventEmitter();
let pending = null;

function snapshot() {
  if (!pending) return null;
  const { id, service, prompt, requestedAt, meta, timeoutMs } = pending;
  return { id, service, prompt, requestedAt, timeoutMs, meta };
}

function notify() {
  emitter.emit('change', snapshot());
}

export function getOtpState() {
  return snapshot();
}

export function onOtpChange(listener) {
  emitter.on('change', listener);
  return () => emitter.off('change', listener);
}

export function cancelOtpRequest(reason = 'OTP request cancelled') {
  if (!pending) return;
  const { reject, timeout, service, id } = pending;
  clearTimeout(timeout);
  pending = null;
  notify();
  try {
    reject(new Error(reason));
  } catch {}
  L.warn('OTP request cancelled', { service, id, reason });
}

export function resetOtpState() {
  cancelOtpRequest('OTP state reset');
}

/**
 * In-memory OTP state (single-process).
 * Use only when the worker and API share the same Node process (local dev).
 * For multi-process deploys (Render web + worker), prefer the *DB variants* below.
 */
export function requestOtpCode({
  service = 'unknown',
  prompt = 'Enter verification code',
  timeoutMs = Number(process.env.OTP_REQUEST_TIMEOUT_MS || 120000),
  meta = null,
} = {}) {
  if (pending) {
    L.warn('Replacing existing OTP request', { existingService: pending.service, newService: service });
    cancelOtpRequest('Replaced by new OTP request');
  }

  return new Promise((resolve, reject) => {
    const id = `otp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const requestedAt = new Date().toISOString();
    const timeout = setTimeout(() => {
      if (!pending || pending.id !== id) return;
      pending = null;
      notify();
      reject(new Error('OTP request timed out'));
      L.error('OTP request timed out', { service, id });
    }, timeoutMs);

    pending = {
      id,
      service,
      prompt,
      requestedAt,
      timeoutMs,
      meta,
      resolve,
      reject,
      timeout,
    };

    notify();
    L.warn('OTP code required', { service, id, timeoutMs });
  });
}

export function submitOtpCode({ id, code }) {
  if (!pending) {
    throw new Error('No OTP request pending');
  }
  const trimmed = String(code || '').trim();
  if (!trimmed) {
    throw new Error('OTP code is empty');
  }

  // ⚠️ Accept even if ids differ; log for observability
  if (id && pending.id !== id) {
    L.warn('OTP id mismatch — accepting for in-memory active request', { submitted: id, active: pending.id, service: pending.service });
  }

  const { resolve, timeout, service } = pending;
  clearTimeout(timeout);
  const effectiveId = pending.id;
  pending = null;
  notify();
  L.info('OTP code submitted', { service, id: effectiveId });
  resolve(trimmed);
}

// ---------------------------------------------------------------------------
// Cross-process safe (Mongo-backed) variants
// These allow worker and API (different processes) to share the same OTP state.
// Keep the original in-memory API for local/same-process use, but prefer these
// in routes/controllers when deployed on Render/Railway/etc.
// ---------------------------------------------------------------------------

/**
 * Get current OTP state from the shared DB.
 * @returns {Promise<{id, service, prompt, requestedAt, timeoutMs, meta} | null>}
 */
export async function getOtpStateDB() {
  try {
    return await dbGet();
  } catch (e) {
    L.error('getOtpStateDB failed', { error: e?.message });
    return null;
  }
}

/**
 * Request an OTP code (shared DB). Returns the generated request id.
 * Use this from the worker process.
 */
export async function requestOtpCodeDB({
  service = 'unknown',
  prompt = 'Enter verification code',
  timeoutMs = Number(process.env.OTP_REQUEST_TIMEOUT_MS || 120000),
  meta = null,
} = {}) {
  try {
    // 🔒 ensure only one active OTP exists — cancel/clear older one
    try { await dbClear(); } catch {}

    const id = `otp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const requestedAt = new Date().toISOString();
    const state = { id, service, prompt, requestedAt, timeoutMs, meta };

    await dbSet(state);
    L.warn('OTP code required (DB)', { service, id, timeoutMs });
    return { id };
  } catch (e) {
    L.error('requestOtpCodeDB failed', { error: e?.message });
    throw e;
  }
}

/**
 * Submit an OTP code (shared DB).
 * Note: If the resolver lives in another process, that process should poll
 * the DB for state changes keyed by id (or you can wire a queue/pubsub).
 */
export async function submitOtpCodeDB({ id, code }) {
  const trimmed = String(code || '').trim();
  if (!trimmed) throw new Error('OTP code is empty');

  const cur = await dbGet();
  if (!cur) throw new Error('No OTP request pending');

  // ⚠️ Be lenient: if a different id is sent, accept against the active one
  const mismatch = id && cur.id && id !== cur.id;
  if (mismatch) {
    L.warn('OTP id mismatch — accepting for active request', { submitted: id, active: cur.id, service: cur.service });
  }

  try {
    await dbSet({ ...cur, submittedCode: trimmed, submittedAt: new Date().toISOString() });
    L.info('OTP code submitted (DB)', { service: cur.service, id: cur.id });
    // Resolve any same-process waiter too (best-effort)
    try {
      const entry = global.__otpResolvers && global.__otpResolvers.get(cur.id);
      if (entry) {
        clearTimeout(entry.timeout);
        entry.resolve(trimmed);
        global.__otpResolvers.delete(cur.id);
      }
    } catch {}

    return { ok: true };
  } catch (e) {
    L.error('submitOtpCodeDB failed', { error: e?.message });
    throw e;
  }
}

export async function consumeOtpCodeDB(id) {
  const cur = await dbGet();
  if (!cur) return null;
  if (id && cur.id !== id) return null;
  if (!cur.submittedCode) return null;
  const code = cur.submittedCode;
  await dbClear(); // clear after the worker takes it
  return code;
}
/**
 * Cancel the current OTP request (shared DB).
 */
export async function cancelOtpRequestDB(reason = 'OTP request cancelled') {
  const cur = await dbGet();
  await dbClear();
  try {
    // resolve any same-process waiter, if present
    const entry = cur && global.__otpResolvers && global.__otpResolvers.get(cur.id);
    if (entry) {
      clearTimeout(entry.timeout);
      entry.reject(new Error(reason));
      global.__otpResolvers.delete(cur.id);
    }
  } catch {}
  L.warn('OTP request cancelled (DB)', { id: cur?.id, service: cur?.service, reason });
  return { ok: true };
}
