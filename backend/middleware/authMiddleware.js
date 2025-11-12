// backend/middleware/authMiddleware.js
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const SECRET_KEY = process.env.JWT_SECRET || 'supersecretkey123!@#';

/**
 * Extract a bearer token from either the Authorization header
 * or common cookie names.
 */
function getToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.split(' ')[1];
  }
  // Fallback to cookies (if any middleware populated req.cookies)
  const c = req.cookies || {};
  return c.token || c.access_token || c.jwt || null;
}

/**
 * Compute a consistent admin flag from a user POJO (works with lean docs)
 */
function computeIsAdmin(user) {
  if (!user) return false;
  const role = String(user.role || '').toLowerCase();
  return role === 'admin' || user.is_admin === true;
}

/**
 * Require a valid JWT and attach req.user (lean object) + req.isAdmin boolean.
 * Rejects soft-deleted users.
 */
export async function requireAuth(req, res, next) {
  try {
    const token = getToken(req);
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'Unauthorized: no token' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, SECRET_KEY);
    } catch (err) {
      const msg = err?.name === 'TokenExpiredError' ? 'Unauthorized: jwt expired' : 'Unauthorized: invalid token';
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      return res.status(401).json({ ok: false, error: msg });
    }

    const userId =
      decoded?.id ||
      decoded?._id ||
      decoded?.userId ||
      decoded?.user_id ||
      decoded?.user?.id ||
      decoded?.user?._id;
    const email = decoded.email;

    let user = null;
    if (userId) {
      user = await User.findOne({ _id: userId, deleted_at: { $exists: false } }).lean();
    }
    if (!user && email) {
      user = await User.findOne({ email, deleted_at: { $exists: false } }).lean();
    }

    if (!user) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ ok: false, error: 'Unauthorized: user not found' });
    }

    if (user.password) delete user.password;
    req.user = user;
    req.isAdmin = computeIsAdmin(user);
    req.auth = decoded;

    return next();
  } catch (err) {
    console.error('requireAuth error:', err);
    res.set('WWW-Authenticate', 'Bearer error="server_error"');
    return res.status(401).json({ ok: false, error: 'Unauthorized: auth check failed' });
  }
}

/**
 * Simple gate that enforces admin role.
 */
export function requireAdmin(req, res, next) {
  try {
    const isAdmin = req.isAdmin ?? computeIsAdmin(req.user);
    if (!isAdmin) {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }
    return next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
}

/**
 * Attach a Mongo filter based on the user's allowed states.
 * Admins get no restriction.
 * Subadmins limited to their configured `states` (upper-cased).
 * If a subadmin has no states configured, force an empty filter.
 */
export function scopeByState() {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) {
      // requireAuth should run first; leave filter unset to avoid accidental exposure
      req.stateFilter = { _id: { $exists: false } };
      return next();
    }

    const isAdmin = req.isAdmin ?? computeIsAdmin(user);
    if (isAdmin) {
      req.stateFilter = {}; // no restriction
      return next();
    }

    const states = Array.isArray(user.states) ? user.states : [];
    // Normalize to 2–3 character uppercase (some states may be written long; keep defensive)
    const normalized = states
      .map((s) => String(s).trim().toUpperCase())
      .filter(Boolean);

    // If no states configured, force an empty result
    req.stateFilter = normalized.length ? { state: { $in: normalized } } : { _id: { $exists: false } };
    return next();
  };
}