import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { logger } from '../config/logger.js';
import { DATA_DIR, SETTINGS_PATH } from '../config/index.js';
import { requireAdmin } from '../middleware/auth.js';

const settingsUpload = multer({ dest: DATA_DIR });

export function createSettingsIoRoutes() {
  const router = Router();

  router.get('/settings/export', requireAdmin, (_req, res) => {
    if (fs.existsSync(SETTINGS_PATH)) {
      res.download(SETTINGS_PATH, 'viniplay-settings-backup.json');
    } else {
      res.status(404).json({ error: 'Settings file not found.' });
    }
  });

  router.post('/settings/import', requireAdmin, settingsUpload.single('settingsFile'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No settings file was uploaded.' });
    }
    const tempPath = path.join(DATA_DIR, 'settings.tmp.json');
    try {
      const fileContent = fs.readFileSync(req.file.path, 'utf-8');
      JSON.parse(fileContent);
      fs.renameSync(req.file.path, SETTINGS_PATH);
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      logger.info('Settings imported successfully');
      res.json({ success: true, message: 'Settings imported. The application will use them on next load.' });
    } catch (err) {
      logger.error({ err }, 'Failed to import settings');
      try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
      res.status(400).json({ error: `Invalid settings file: ${err.message}` });
    }
  });

  return router;
}
