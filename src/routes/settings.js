import { Router } from 'express';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';

export function createSettingsRoutes({ db, getSettings, saveSettings }) {
  const router = Router();

  router.post('/save/settings', requireAuth, (req, res) => {
    try {
      saveSettings(req.body);
      logger.info({ userId: req.session.userId }, 'Global settings saved');
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, 'Failed to save settings');
      res.status(500).json({ error: 'Failed to save settings.' });
    }
  });

  router.post('/user/settings', requireAuth, (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key is required.' });
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(
      req.session.userId, key, String(value)
    );
    res.json({ success: true });
  });

  return router;
}
