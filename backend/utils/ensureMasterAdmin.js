// backend/utils/ensureMasterAdmin.js
import User from '../models/User.js';

export async function ensureMasterAdmin() {
  const email   = (process.env.MASTER_ADMIN_EMAIL || '').toLowerCase().trim();
  const pwd     = String(process.env.MASTER_ADMIN_PASSWORD || '').trim();
  const user_id = String(process.env.MASTER_ADMIN_USER_ID || 'admin-root').trim();
  const full_name = process.env.MASTER_ADMIN_FULL_NAME || 'Site Administrator';
  const phone = process.env.MASTER_ADMIN_PHONE || '0000000000';
  const statesEnv = process.env.MASTER_ADMIN_STATES || '';
  const states = statesEnv.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

  if (!email || !pwd) {
    console.warn('[ensureMasterAdmin] Skipping: MASTER_ADMIN_EMAIL or MASTER_ADMIN_PASSWORD missing');
    return;
  }

  let admin = await User.findOne({ email });
  if (!admin) {
    admin = new User({
      user_id,
      full_name,
      email,
      phone,
      role: 'admin',
      is_admin: true,
      password: pwd,      // hashed by pre('save')
      states,
      deleted_at: undefined,
    });
    await admin.save();
    console.log(`[ensureMasterAdmin] Created master admin ${email}`);
  } else {
    // revive if soft-deleted, and make sure they stay admin
    const updates = { deleted_at: undefined, role: 'admin', is_admin: true };
    // only set password if user has no password (rare) or env changed
    // (we won’t auto-rotate silently; comment in next line if you want forced sync)
    // updates.password = pwd; // pre('findOneAndUpdate') will hash
    await User.findByIdAndUpdate(admin._id, { $set: updates });
    console.log(`[ensureMasterAdmin] Master admin present: ${email}`);
  }
}