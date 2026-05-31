import { getDb } from '../db/index.js';
import { logger } from '../config/logger.js';

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    logger.debug({ url: req.originalUrl, ip: req.clientIp, hasSession: !!req.session }, '[auth] requireAuth — no session userId');
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const db = getDb();
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);

  if (!user) {
    logger.warn({ userId: req.session.userId, url: req.originalUrl }, '[auth] requireAuth — user from session not found in DB');
    req.session.destroy();
    res.clearCookie('connect.sid');
    return res.status(401).json({ error: 'User account no longer exists. Please log in again.' });
  }

  next();
}

export function allowLocalOrAuth({ activeCastTokens } = {}) {
  return (req, res, next) => {
    if (req.session?.userId) return next();

    const { castToken } = req.query;
    if (castToken) {
      const tokenData = activeCastTokens?.get(castToken);
      if (!tokenData) return res.status(401).send('Invalid cast token');
      if (tokenData.expiresAt < Date.now()) {
        activeCastTokens.delete(castToken);
        return res.status(401).send('Expired cast token');
      }
      req.session = req.session || {};
      req.session.userId = tokenData.userId;
      req.session.username = 'Cast User';
      activeCastTokens.delete(castToken);
      return next();
    }

    let clientIp = req.clientIp || req.ip;
    if (clientIp?.includes(',')) clientIp = clientIp.split(',')[0].trim();

    const isLocal = clientIp?.startsWith('192.168.') ||
      clientIp?.startsWith('10.') ||
      clientIp?.startsWith('172.16.');
    if (isLocal) {
      req.session = req.session || {};
      req.session.userId = -1;
      req.session.username = 'Local';
      return next();
    }

    return res.status(401).json({ error: 'Authentication required.' });
  };
}

export function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) return next();
  return res.status(403).json({ error: 'Administrator privileges required.' });
}

export function requireDvrAccess(req, res, next) {
  if (req.session?.canUseDvr || req.session?.isAdmin) return next();
  return res.status(403).json({ error: 'DVR access required.' });
}
