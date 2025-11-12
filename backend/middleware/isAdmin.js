// backend/middlewares/isAdmin.js
export default function isAdmin(req, res, next) {
    try {
      // support either `isAdmin` (frontend) or `is_admin` (db)
      const admin = req.user?.isAdmin === true || req.user?.is_admin === true || req.user?.role === 'admin';
      if (!admin) return res.status(403).json({ error: 'Admin only' });
      next();
    } catch (e) {
      res.status(401).json({ error: 'Unauthorized' });
    }
  }