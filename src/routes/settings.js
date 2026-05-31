import { Router } from 'express';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';

// Deep-merge `patch` into `base` — arrays at same key replace entirely
function deepMerge(base, patch) {
  const result = { ...base };
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    const bv = result[key];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      result[key] = deepMerge(bv, pv);
    } else {
      result[key] = pv;
    }
  }
  return result;
}

export function createSettingsRoutes({ db, getSettings, saveSettings }) {
  const router = Router();

  router.post('/save/settings', requireAuth, (req, res) => {
    try {
      // Merge with existing settings to prevent partial saves from clobbering other keys
      const existing = getSettings();
      const merged = deepMerge(existing, req.body);
      saveSettings(merged);
      logger.info({ userId: req.session.userId, keys: Object.keys(req.body) }, 'Global settings saved');
      res.json({ success: true, settings: merged });
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
