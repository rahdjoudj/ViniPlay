import { Router } from 'express';
import fs from 'fs';
import { logger } from '../config/logger.js';
import {
  LIVE_CHANNELS_M3U_PATH, LIVE_EPG_JSON_PATH,
  VOD_MOVIES_JSON_PATH, VOD_SERIES_JSON_PATH,
} from '../config/index.js';
import { requireAuth } from '../middleware/auth.js';

export function createConfigRoutes({ db, getSettings }) {
  const router = Router();

  router.get('/config', requireAuth, (req, res) => {
    try {
      const globalSettings = getSettings();
      const config = {
        m3uContent: null,
        epgContent: {},
        settings: globalSettings,
        vodMovies: [],
        vodSeries: [],
      };

      // User permissions
      let allowedSources = null;
      const user = db.prepare('SELECT allowed_sources FROM users WHERE id = ?').get(req.session.userId);
      if (user?.allowed_sources) {
        try { allowedSources = JSON.parse(user.allowed_sources); } catch {}
      }

      // Load M3U
      if (fs.existsSync(LIVE_CHANNELS_M3U_PATH)) {
        const m3uRaw = fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8');

        if (allowedSources) {
          const lines = m3uRaw.split('\n');
          const filtered = [];
          if (lines[0]?.startsWith('#EXTM3U')) filtered.push(lines[0]);

          let extinf = null;
          const gre = /group-title="([^"]*)"/;
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith('#EXTINF:')) {
              extinf = t;
              const m = t.match(/tvg-id="([^"]*)"/);
              let ok = false;
              if (m) {
                const idx = m[1].indexOf('_');
                if (idx !== -1) {
                  const sid = m[1].substring(0, idx);
                  const perm = allowedSources[sid];
                  if (perm?.allowed) {
                    ok = true;
                    const groups = perm.groups;
                    if (groups?.length) {
                      const gm = t.match(gre);
                      if (!groups.includes(gm?.[1] || 'Uncategorized')) ok = false;
                    }
                  }
                }
              }
              if (!ok) extinf = null;
            } else if (t.startsWith('http') || (t.startsWith('/') && !t.startsWith('//'))) {
              if (extinf) { filtered.push(extinf, t); }
              extinf = null;
            }
          }
          config.m3uContent = filtered.join('\n');
        } else {
          config.m3uContent = m3uRaw;
        }
      }

      // Load EPG
      if (fs.existsSync(LIVE_EPG_JSON_PATH)) {
        try {
          const full = JSON.parse(fs.readFileSync(LIVE_EPG_JSON_PATH, 'utf-8'));
          if (allowedSources) {
            const f = {};
            for (const ch in full) {
              const idx = ch.indexOf('_');
              if (idx !== -1 && allowedSources[ch.substring(0, idx)]?.allowed) {
                f[ch] = full[ch];
              }
            }
            config.epgContent = f;
          } else {
            config.epgContent = full;
          }
        } catch (e) { logger.error({ err: e }, 'EPG parse error'); }
      }

      // Legacy VOD files
      for (const [p, k] of [[VOD_MOVIES_JSON_PATH, 'vodMovies'], [VOD_SERIES_JSON_PATH, 'vodSeries']]) {
        if (fs.existsSync(p)) {
          try { config[k] = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch {}
        }
      }

      // Merge user settings
      const rows = db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(req.session.userId);
      if (rows?.length) {
        const us = {};
        for (const r of rows) {
          try { us[r.key] = JSON.parse(r.value); } catch { us[r.key] = r.value; }
        }
        config.settings = { ...config.settings, ...us };
      }

      // Permission signature
      let sig = 'default';
      if (allowedSources) {
        const s = JSON.stringify(allowedSources);
        let h = 0;
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
        sig = 'v1_' + (h & h);
      }
      config.settings.userPermissionsSignature = sig;

      res.json(config);
    } catch (err) {
      logger.error({ err }, '/api/config failed');
      res.status(500).json({ error: 'Could not load configuration.' });
    }
  });

  return router;
}
