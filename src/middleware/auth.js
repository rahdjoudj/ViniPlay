import { getDb } from '../db/index.js';
import { logger } from '../config/logger.js';

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);

  if (!user) {
    logger.warn({ userId: req.session.userId }, 'User from session not found in DB');
    req.session.destroy();
    res.clearCookie('connect.sid');
    return res.status(401).json({ error: 'User account no longer exists. Please log in again.' });
  }

  next();
}

export function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(403).json({ error: 'Administrator privileges required.' });
}

export function requireDvrAccess(req, res, next) {
  if (req.session?.canUseDvr || req.session?.isAdmin) return next();
  return res.status(403).json({ error: 'DVR access required.' });
}
