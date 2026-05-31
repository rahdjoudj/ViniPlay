import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { SOURCES_DIR } from '../config/index.js';

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      if (!fs.existsSync(SOURCES_DIR)) fs.mkdirSync(SOURCES_DIR, { recursive: true });
      cb(null, SOURCES_DIR);
    },
    filename: (_req, file, cb) => {
      cb(null, `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`);
    },
  }),
});

export function createSourceRoutes({ db, getSettings, saveSettings }) {
  const router = Router();

  router.post('/fetch-groups', requireAuth, async (req, res) => {
    try {
      const { sourceType, sourceId, url: bodyUrl, xc } = req.body;
      const settings = getSettings();
      const sources = settings[sourceType] || [];

      // Resolve source: either from existing settings (by ID) or from request body (new source)
      let fetchUrl;
      const source = sources.find(s => s.id === sourceId);

      if (source) {
        // Existing source — use its stored config
        if (source.url) {
          fetchUrl = source.url;
        } else if (source.path && source.type === 'url') {
          fetchUrl = source.path;
        } else if (source.xc_data) {
          try {
            const xd = typeof source.xc_data === 'string' ? JSON.parse(source.xc_data) : source.xc_data;
            fetchUrl = `${xd.server.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(xd.username)}&password=${encodeURIComponent(xd.password)}&action=get_live_categories`;
          } catch {}
        }
      } else if (bodyUrl) {
        // New source — URL provided directly
        fetchUrl = bodyUrl;
      } else if (xc) {
        // New source — XC credentials provided directly
        try {
          const xd = typeof xc === 'string' ? JSON.parse(xc) : xc;
          fetchUrl = `${xd.server.replace(/\/+$/, '')}/player_api.php?username=${encodeURIComponent(xd.username)}&password=${encodeURIComponent(xd.password)}&action=get_live_categories`;
        } catch (parseErr) {
          return res.status(400).json({ error: 'Invalid XC data format.' });
        }
      }

      if (!fetchUrl) {
        return res.status(400).json({ error: 'No fetch URL could be determined. Provide a URL, XC credentials, or a valid source ID.' });
      }

      logger.info({ fetchUrl: fetchUrl.replace(/[?&]password=[^&]+/, '?password=***').replace(/username=[^&]+/, 'username=***') }, '[sources] Fetching groups');
      const axios = (await import('axios')).default;
      const { data } = await axios.get(fetchUrl, { timeout: 30000 });
      const groups = Array.isArray(data) ? data.map(g => g.category_name || g) : [];
      res.json({ groups: [...new Set(groups)].sort() });
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to fetch groups');
      res.status(500).json({ error: err.message || 'Failed to fetch groups.' });
    }
  });

  // Sources CRUD — add or update (full)
  router.post('/', requireAuth, upload.single('sourceFile'), (req, res) => {
    const { sourceType, name, url, isActive, id, refreshHours, xc, selectedGroups } = req.body;

    if (!sourceType || !name) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Source type and name are required.' });
    }

    const settings = getSettings();
    const sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;

    if (id) {
      const sourceIndex = sourceList.findIndex(s => s.id === id);
      if (sourceIndex === -1) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(404).json({ error: 'Source not found.' });
      }

      const s = sourceList[sourceIndex];
      s.name = name;
      s.isActive = isActive === 'true';
      s.refreshHours = parseInt(refreshHours, 10) || 0;
      s.lastUpdated = new Date().toISOString();
      try { s.selectedGroups = JSON.parse(selectedGroups || '[]'); } catch { s.selectedGroups = []; }

      if (req.file) {
        if (s.type === 'file' && fs.existsSync(s.path)) try { fs.unlinkSync(s.path); } catch {}
        const ext = sourceType === 'm3u' ? '.m3u' : '.xml';
        const newPath = path.join(SOURCES_DIR, `${sourceType}_${id}${ext}`);
        fs.renameSync(req.file.path, newPath);
        s.path = newPath;
        s.type = 'file';
        delete s.xc_data;
      } else if (url !== undefined && url !== null) {
        if (s.type === 'file' && fs.existsSync(s.path)) try { fs.unlinkSync(s.path); } catch {}
        s.path = url;
        s.type = 'url';
        delete s.xc_data;
      } else if (xc) {
        if (s.type === 'file' && fs.existsSync(s.path)) try { fs.unlinkSync(s.path); } catch {}
        s.xc_data = xc;
        s.type = 'xc';
        try { s.path = JSON.parse(xc).server || 'Xtream Codes Source'; } catch { s.path = 'Xtream Codes Source'; }
      } else if (s.type === 'file' && !req.file && (!s.path || !fs.existsSync(s.path))) {
        return res.status(400).json({ error: 'Existing file source requires a file if original is missing.' });
      }

      // XC EPG sync
      const wasXc = s.type === 'xc';
      const isNowXc = (xc !== undefined && xc !== null);
      if (wasXc && !isNowXc) {
        settings.epgSources = settings.epgSources.filter(e => e.id !== `epg_for_${id}`);
      }
      if (isNowXc) {
        const epgId = `epg_for_${id}`;
        try {
          const xd = JSON.parse(xc);
          const epgUrl = `${xd.server}/xmltv.php?username=${xd.username}&password=${xd.password}`;
          const epg = settings.epgSources.find(e => e.id === epgId);
          if (epg) { epg.name = `${name} (EPG)`; epg.path = epgUrl; epg.refreshHours = parseInt(refreshHours, 10) || 0; }
          else settings.epgSources.push({ id: epgId, name: `${name} (EPG)`, type: 'url', path: epgUrl, isActive: true, isXcEpg: true, refreshHours: parseInt(refreshHours, 10) || 0, lastUpdated: new Date().toISOString(), status: 'Pending', statusMessage: 'Managed by XC source.' });
        } catch {}
      }

      // Cache cleanup
      if (s.cachedRawPath) {
        let del = false;
        if (req.file) del = true;
        else if (url !== undefined && url !== null && s.path !== url) del = true;
        else if (xc && s.xc_data !== xc) del = true;
        if (del && fs.existsSync(s.cachedRawPath)) { try { fs.unlinkSync(s.cachedRawPath); } catch {}; delete s.cachedRawPath; }
      }

      saveSettings(settings);
      res.json({ success: true, message: 'Source updated.', settings: getSettings() });
    } else {
      let newSource;
      let parsedSelectedGroups = [];
      try { parsedSelectedGroups = JSON.parse(selectedGroups || '[]'); } catch {}

      if (xc) {
        let xcData;
        try { xcData = JSON.parse(xc); } catch { return res.status(400).json({ error: 'Invalid XC data.' }); }
        newSource = { id: `src-${Date.now()}`, name, type: 'xc', path: xcData.server || 'Xtream Codes Source', xc_data: xc, isActive: isActive === 'true', refreshHours: parseInt(refreshHours, 10) || 0, lastUpdated: new Date().toISOString(), status: 'Pending', statusMessage: 'Source added.', selectedGroups: parsedSelectedGroups };
      } else {
        if (!req.file && !url) return res.status(400).json({ error: 'URL or file required.' });
        newSource = { id: `src-${Date.now()}`, name, type: req.file ? 'file' : 'url', path: req.file ? req.file.path : url, isActive: isActive === 'true', refreshHours: parseInt(refreshHours, 10) || 0, lastUpdated: new Date().toISOString(), status: 'Pending', statusMessage: 'Source added.', selectedGroups: parsedSelectedGroups };
      }

      if (req.file) {
        const ext = sourceType === 'm3u' ? '.m3u' : '.xml';
        const newPath = path.join(SOURCES_DIR, `${sourceType}_${newSource.id}${ext}`);
        fs.renameSync(req.file.path, newPath);
        newSource.path = newPath;
      }

      sourceList.push(newSource);

      if (newSource.type === 'xc') {
        try {
          const xd = JSON.parse(newSource.xc_data);
          settings.epgSources.push({ id: `epg_for_${newSource.id}`, name: `${newSource.name} (EPG)`, type: 'url', path: `${xd.server}/xmltv.php?username=${xd.username}&password=${xd.password}`, isActive: true, isXcEpg: true, refreshHours: newSource.refreshHours, lastUpdated: new Date().toISOString(), status: 'Pending', statusMessage: 'Managed by XC source.' });
        } catch {}
      }

      saveSettings(settings);
      res.json({ success: true, message: 'Source added.', settings: getSettings() });
    }
  });

  // Partial source update
  router.put('/:sourceType/:id', requireAuth, (req, res) => {
    const { sourceType, id } = req.params;
    const { name, path: newPath, isActive } = req.body;
    const settings = getSettings();
    const sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;
    const source = sourceList.find(s => s.id === id);
    if (!source) return res.status(404).json({ error: 'Source not found.' });

    source.name = name ?? source.name;
    source.isActive = isActive ?? source.isActive;
    if (source.type === 'url' && newPath !== undefined) source.path = newPath;
    source.lastUpdated = new Date().toISOString();

    saveSettings(settings);
    res.json({ success: true, message: 'Source updated.', settings: getSettings() });
  });

  // Delete source
  router.delete('/:sourceType/:id', requireAuth, (req, res) => {
    const { sourceType, id } = req.params;
    const settings = getSettings();
    const sourceList = sourceType === 'm3u' ? settings.m3uSources : settings.epgSources;
    const source = sourceList.find(s => s.id === id);

    if (source?.type === 'file' && fs.existsSync(source.path)) try { fs.unlinkSync(source.path); } catch {}
    if (source?.cachedRawPath && fs.existsSync(source.cachedRawPath)) try { fs.unlinkSync(source.cachedRawPath); } catch {}

    const newList = sourceList.filter(s => s.id !== id);
    if (sourceType === 'm3u') settings.m3uSources = newList;
    else settings.epgSources = newList;

    if (newList.length === sourceList.length) return res.status(404).json({ error: 'Source not found.' });

    // Delete managed EPG for XC sources
    if (sourceType === 'm3u' && source?.type === 'xc') {
      settings.epgSources = settings.epgSources.filter(e => e.id !== `epg_for_${id}`);
    }

    // VOD cleanup for XC provider deletion
    if (sourceType === 'm3u' && source?.type === 'xc') {
      try {
        db.prepare('BEGIN TRANSACTION').run();
        db.prepare('DELETE FROM provider_movie_relations WHERE provider_id = ?').run(id);
        db.prepare('DELETE FROM provider_series_relations WHERE provider_id = ?').run(id);
        db.prepare('DELETE FROM provider_episode_relations WHERE provider_id = ?').run(id);
        db.prepare('DELETE FROM movies WHERE id NOT IN (SELECT DISTINCT movie_id FROM provider_movie_relations)').run();
        db.prepare('DELETE FROM series WHERE id NOT IN (SELECT DISTINCT series_id FROM provider_series_relations)').run();
        db.prepare('DELETE FROM episodes WHERE id NOT IN (SELECT DISTINCT episode_id FROM provider_episode_relations)').run();
        db.prepare('COMMIT').run();
      } catch (dbErr) {
        db.prepare('ROLLBACK').run();
        logger.error({ err: dbErr, sourceId: id }, 'VOD cleanup failed');
      }
    }

    saveSettings(settings);
    res.json({ success: true, message: 'Source deleted.', settings: getSettings() });
  });

  return router;
}
