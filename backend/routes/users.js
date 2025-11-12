import express from 'express';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { requireAuth, requireAdmin } from '../middleware/authMiddleware.js';

const router = express.Router();
router.use(requireAuth, requireAdmin);

// --- helpers ---
function toBool(x) {
  return x === true || x === 'true' || x === 1 || x === '1';
}

function parseStates(input) {
  if (!input) return [];
  const arr = Array.isArray(input)
    ? input
    : String(input)
        .split(/[,\n]/)
        .map(s => s.trim())
        .filter(Boolean);
  return arr.map(s => s.toUpperCase()).filter(Boolean);
}

const MASTER_EMAIL = String(process.env.MASTER_ADMIN_EMAIL || '').toLowerCase().trim();
const MASTER_ID = String(process.env.MASTER_ADMIN_USER_ID || '').trim();

function isMasterUser(u) {
  if (!u) return false;
  const emailMatch = (u.email || '').toLowerCase().trim() === MASTER_EMAIL && MASTER_EMAIL;
  const idMatch = (u.user_id || '').trim() === MASTER_ID && MASTER_ID;
  return !!(emailMatch || idMatch);
}


// GET /api/user  -> list users
router.get('/', async (req, res) => {
  try {
    const includeDeleted = String(req.query.include_deleted || '').toLowerCase() === '1' || String(req.query.include_deleted || '').toLowerCase() === 'true';
    const users = await User.find(includeDeleted ? {} : { deleted_at: { $exists: false } }).lean();
    // do not leak password hashes
    users.forEach(u => { if (u.password) delete u.password; });
    return res.json({ ok: true, data: users });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server Error' });
  }
});

// GET /api/user/:id  -> single user by id or user_id
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const lookup = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { user_id: id };
    const user = await User.findOne(lookup).lean();
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
    if (user.password) delete user.password;
    return res.json({ ok: true, data: user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Failed to retrieve user' });
  }
});

// POST /api/user/create  -> create new user
router.post('/create', async (req, res) => {
  try {
    const body = req.body || {};

    const full_name = String(body.full_name || body.fullName || '').trim();
    const email = String(body.email || '').toLowerCase().trim();
    const phone = String(body.phone || '').trim();
    const role = String(body.role || 'subadmin').trim();
    const allowedRoles = ['admin', 'subadmin'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ ok: false, error: 'Invalid role. Must be "admin" or "subadmin"' });
    }
    const states = parseStates(body.states);
    if (!Array.isArray(states)) {
      return res.status(400).json({ ok: false, error: 'Invalid states format' });
    }
    const user_id = String(body.user_id || '').trim();

    if (!full_name || !email || !phone || !role || !user_id) {
      return res.status(400).json({ ok: false, error: 'Missing required fields (full_name, email, phone, role, user_id)' });
    }

    if (!body.password || !body.password.trim()) {
      return res.status(400).json({ ok: false, error: 'Password is required' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ ok: false, error: 'Email address already exists' });
    }

    const existingById = await User.findOne({ user_id });
    if (existingById) {
      return res.status(400).json({ ok: false, error: 'User ID already exists' });
    }

    const user = new User({
      user_id,
      full_name,
      email,
      phone,
      role,
      password: body.password.trim(), // let schema pre('save') hash this
      is_admin: role === 'admin' || toBool(body.is_admin),
      states,
    });

    const saved = await user.save();
    const doc = saved.toObject();
    delete doc.password;
    return res.status(201).json({ ok: true, data: doc });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000 && err?.keyPattern?.email) {
      return res.status(400).json({ ok: false, error: 'Email address already exists' });
    }
    return res.status(500).json({ ok: false, error: 'Failed to create user' });
  }
});

// DELETE /api/user/delete/:id
router.delete('/delete/:id', async (req, res) => {
  try {
    const id = req.params.id;

    const lookup = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { user_id: id };
    const target = await User.findOne(lookup).lean();
    if (!target) return res.status(404).json({ ok: false, error: 'User not found' });

    if (isMasterUser(target)) {
      return res.status(403).json({ ok: false, error: 'Master admin cannot be deleted' });
    }

    if ((req.user?._id?.toString && req.user._id.toString()) === (target._id?.toString && target._id.toString())) {
      return res.status(400).json({ ok: false, error: 'You cannot delete your own account' });
    }

    const soft = String(req.query.soft || '').toLowerCase() === '1' || String(req.query.soft || '').toLowerCase() === 'true';
    let deletedUser = null;
    if (soft) {
      deletedUser = await User.findOneAndUpdate(lookup, { deleted_at: new Date() }, { new: true });
    } else {
      deletedUser = await User.findOneAndDelete(lookup);
    }
    return res.json({ ok: true, data: { id } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Failed to delete user' });
  }
});


// PATCH /api/user/update/:id  -> update by _id or user_id
router.patch('/update/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const updateData = { ...(req.body || {}) };

    // locate target first so we can enforce master-admin protections
    const lookup = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { user_id: id };
    const target = await User.findOne(lookup);
    if (!target) return res.status(404).json({ ok: false, error: 'User not found' });

    if (typeof updateData.email === 'string') updateData.email = updateData.email.toLowerCase().trim();
    if (typeof updateData.fullName === 'string') { updateData.full_name = updateData.fullName; delete updateData.fullName; }

    if (typeof updateData.role === 'string') {
      updateData.role = updateData.role.trim();
      const allowedRoles = ['admin', 'subadmin'];
      if (!allowedRoles.includes(updateData.role)) {
        return res.status(400).json({ ok: false, error: 'Invalid role. Must be "admin" or "subadmin"' });
      }
      updateData.is_admin = updateData.role === 'admin' || toBool(updateData.is_admin);
    }

    if (updateData.states !== undefined) {
      const parsed = parseStates(updateData.states);
      if (!Array.isArray(parsed)) {
        return res.status(400).json({ ok: false, error: 'Invalid states format' });
      }
      updateData.states = parsed;
    }

    // Master-admin may not be downgraded or email-changed
    if (isMasterUser(target)) {
      if (updateData.role && updateData.role !== 'admin') {
        return res.status(403).json({ ok: false, error: 'Master admin role cannot be changed' });
      }
      if (typeof updateData.email === 'string' && updateData.email !== target.email) {
        return res.status(403).json({ ok: false, error: 'Master admin email cannot be changed' });
      }
    }

    updateData.updated_at = new Date();

    const updatedUser = await User.findOneAndUpdate(lookup, updateData, { new: true });

    const doc = updatedUser.toObject();
    delete doc.password;
    return res.json({ ok: true, data: doc });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Failed to update user' });
  }
});


const userRoutes = router;
export default userRoutes;