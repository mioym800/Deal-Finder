// routes/auth.js
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const router = express.Router();

// --- Config & helpers ---
const DISABLE_AUTH = String(process.env.DISABLE_AUTH || 'false').toLowerCase() === 'true';
const SECRET_KEY = process.env.JWT_SECRET || 'supersecretkey123!@#';

function buildDevUser(payload = {}) {
  const user = {
    email: (payload.email || 'dev@example.com').toLowerCase(),
    isAdmin: true,
    id: 'dev-id',
    fullName: payload.fullName || 'Developer',
    message: payload.message || '',
    states: payload.states || ['NY', 'NJ', 'CT'],
  };
  const token = jwt.sign(
    { email: user.email, isAdmin: user.isAdmin, id: user.id, fullName: user.fullName, message: user.message, states: user.states },
    SECRET_KEY,
    { expiresIn: '7d' }
  );
  return { user, token };
}

// POST /api/auth/login  (supports email OR user_id in the "email" field)
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  // Bypass path for development
  if (DISABLE_AUTH) {
    const { user, token } = buildDevUser({ email });
    return res.status(200).json({ success: true, message: '[DEV] Auth bypass enabled', token, user });
  }

  try {
    const identifier = String(email || '').trim();
    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'Email or user_id and password are required' });
    }

    // Allow email OR user_id; also ensure user is not soft-deleted
    const query = identifier.includes('@')
      ? { email: identifier.toLowerCase(), deleted_at: { $exists: false } }
      : {
          $and: [
            { $or: [{ user_id: identifier }, { email: identifier.toLowerCase() }] },
            { deleted_at: { $exists: false } },
          ],
        };

    // Must fetch a full document (not lean) so instance methods are available
    const user = await User.findOne(query);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Use the model's instance method correctly
    const ok = await user.checkPassword(password);
    if (!ok) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { email: user.email, isAdmin: user.is_admin, id: user._id, fullName: user.full_name, message: user.message, states: user.states },
      SECRET_KEY,
      { expiresIn: '7d' }
    );

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        email: user.email,
        isAdmin: user.is_admin || false,
        id: user._id,
        fullName: user.full_name,
        message: user.message,
        states: user.states,
      },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/auth/verify
router.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;

  // If bypass is enabled and no token provided, return a dev session automatically
  if (DISABLE_AUTH && (!authHeader || !authHeader.startsWith('Bearer '))) {
    const { user } = buildDevUser();
    return res.json({ success: true, user });
  }

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ success: false });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    res.json({ success: true, user: decoded });
  } catch (err) {
    res.status(401).json({ success: false });
  }
});

// Optional: quick token mint in dev
router.get('/dev/token', (req, res) => {
  if (!DISABLE_AUTH) return res.status(404).json({ success: false });
  const { user, token } = buildDevUser({ email: req.query.email });
  return res.json({ success: true, token, user });
});

export default router;
