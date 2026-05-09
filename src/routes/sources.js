import { Router } from 'express';
import multer from 'multer';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { SOURCES_DIR } from '../config/index.js';

const upload = multer({ dest: SOURCES_DIR });

export function createSourceRoutes({ db, getSettings, saveSettings }) {
  const router = Router();

  router.post('/fetch-groups', requireAuth, async (req, res) => {
    try {
      const { sourceType, sourceId } = req.body;
      const settings = getSettings();
      const sources = settings[sourceType] || [];
      const source = sources.find(s => s.id === sourceId);
      if (!source) return res.status(404).json({ error: 'Source not found.' });

      let url;
      if (source.url) {
        url = source.url;
      } else if (source.server_url && source.username && source.password) {
        const base = source.server_url.replace(/\/+$/, '');
        url = `${base}/player_api.php?username=${encodeURIComponent(source.username)}&password=${encodeURIComponent(source.password)}&action=get_live_categories`;
      }

      if (url) {
        const axios = (await import('axios')).default;
        const { data } = await axios.get(url, { timeout: 30000 });
        const groups = Array.isArray(data) ? data.map(g => g.category_name || g) : [];
        res.json({ groups: [...new Set(groups)].sort() });
      } else {
        res.json({ groups: [] });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to fetch groups');
      res.status(500).json({ error: 'Failed to fetch groups.' });
    }
  });

  router.post('/', requireAuth, upload.single('sourceFile'), (_req, res) => {
    res.status(501).json({ error: 'Source management not yet migrated. Use legacy endpoint.' });
  });

  router.put('/:sourceType/:id', requireAuth, (_req, res) => {
    res.status(501).json({ error: 'Source management not yet migrated.' });
  });

  router.delete('/:sourceType/:id', requireAuth, (_req, res) => {
    res.status(501).json({ error: 'Source management not yet migrated.' });
  });

  return router;
}
