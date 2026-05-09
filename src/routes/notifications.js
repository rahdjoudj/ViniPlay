import { Router } from 'express';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';

export function createNotificationRoutes({ db, webpush, vapidKeys }) {
  const router = Router();

  router.get('/vapid-public-key', requireAuth, (_req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  router.post('/subscribe', requireAuth, (req, res) => {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription data.' });
    }
    const row = db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint);
    if (row) {
      db.prepare('UPDATE push_subscriptions SET user_id=?, p256dh=?, auth=? WHERE endpoint=?').run(
        req.session.userId, keys.p256dh, keys.auth, endpoint
      );
    } else {
      db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?,?,?,?)').run(
        req.session.userId, endpoint, keys.p256dh, keys.auth
      );
    }
    res.json({ success: true });
  });

  router.post('/unsubscribe', requireAuth, (req, res) => {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'Endpoint is required.' });
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?').run(endpoint, req.session.userId);
    res.json({ success: true });
  });

  router.post('/', requireAuth, (req, res) => {
    const { channelId, channelName, channelLogo, programTitle, programDesc, programStart, programStop, notificationTime, programId } = req.body;
    if (!channelId || !programTitle || !programStart || !notificationTime) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    db.prepare(`INSERT INTO notifications (user_id,channelId,channelName,channelLogo,programTitle,programDesc,programStart,programStop,notificationTime,programId) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      req.session.userId, channelId, channelName, channelLogo, programTitle, programDesc, programStart, programStop, notificationTime, programId
    );
    res.json({ success: true });
  });

  router.get('/', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY notificationTime DESC').all(req.session.userId);
    res.json(rows);
  });

  router.delete('/past', requireAuth, (req, res) => {
    db.prepare('DELETE FROM notifications WHERE user_id=? AND status=?').run(req.session.userId, 'triggered');
    res.json({ success: true });
  });

  router.delete('/:id', requireAuth, (req, res) => {
    db.prepare('DELETE FROM notifications WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
    res.json({ success: true });
  });

  return router;
}
