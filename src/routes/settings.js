import { Router } from 'express';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';

export function createSettingsRoutes({ db, getSettings, saveSettings }) {
  const router = Router();

  router.post('/save/settings', requireAuth, (req, res) => {
    try {
      saveSettings(req.body);
      const settings = getSettings();
      logger.info({ userId: req.session.userId }, 'Global settings saved');
      res.json({ success: true, settings });
    } catch (err) {
      logger.error({ err }, 'Failed to save settings');
      res.status(500).json({ error: 'Failed to save settings.' });
    }
  });

  router.post('/user/settings', requireAuth, (req, res) => {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'Key is required.' });
    db.prepare('INSERT OR REPLACE INTO user_settings (user_id, key, value) VALUES (?, ?, ?)').run(
      req.session.userId, key, JSON.stringify(value)
    );
    const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(req.session.userId);
    const userSettings = {};
    for (const r of rows) {
      try { userSettings[r.key] = JSON.parse(r.value); } catch { userSettings[r.key] = r.value; }
    }
    res.json({ success: true, settings: { ...getSettings(), ...userSettings } });
  });

  return router;
}
