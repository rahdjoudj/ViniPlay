import { Router } from 'express';
import { createRequire } from 'module';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';

const require = createRequire(import.meta.url);
const XtreamClient = require('../../xtreamClient.cjs');

export function createVodRoutes({ db, getSettings }) {
  const router = Router();

  router.get('/vod/library', requireAuth, (req, res) => {
    try {
      const userRow = db.prepare('SELECT allowed_sources FROM users WHERE id = ?').get(req.session.userId);
      let allowedSources = null;
      if (userRow?.allowed_sources) {
        try { allowedSources = JSON.parse(userRow.allowed_sources); } catch {}
      }

      const settings = getSettings();
      let providers = settings.m3uSources.filter(s => s.isActive && s.type === 'xc');

      if (allowedSources) {
        providers = providers.filter(p => allowedSources[p.id]?.allowed);
      }

      const providerMap = new Map();
      providers.forEach(p => {
        try {
          const xc = JSON.parse(p.xc_data);
          const url = new URL(xc.server);
          providerMap.set(p.id, { baseUrl: `${url.protocol}//${url.host}`, username: xc.username, password: xc.password });
        } catch {}
      });

      const providerIds = Array.from(providerMap.keys());
      if (providerIds.length === 0) return res.json({ movies: [], series: [], categories: [] });

      const placeholders = providerIds.map(() => '?').join(',');

      const movies = db.prepare(
        `SELECT m.provider_unique_id, m.name, m.year, m.description, m.logo, m.tmdb_id, m.imdb_id, m.category_name, r.stream_id, r.container_extension, r.provider_id
         FROM movies m JOIN provider_movie_relations r ON m.id = r.movie_id
         WHERE r.provider_id IN (${placeholders}) ORDER BY m.name`
      ).all(...providerIds);

      const processedMovies = movies.map(m => {
        const p = providerMap.get(m.provider_id);
        if (!p) return null;
        if (allowedSources?.[m.provider_id]?.allowed) {
          const groups = allowedSources[m.provider_id].groups || [];
          if (groups.length > 0 && !groups.includes(m.category_name)) return null;
        }
        const ext = m.container_extension || 'mp4';
        return { id: m.provider_unique_id, name: m.name, year: m.year, description: m.description, logo: m.logo, tmdb_id: m.tmdb_id, imdb_id: m.imdb_id, url: `${p.baseUrl}/movie/${p.username}/${p.password}/${m.stream_id}.${ext}`, type: 'movie', group: m.category_name };
      }).filter(Boolean);

      const seriesList = db.prepare(
        `SELECT DISTINCT s.provider_unique_id, s.name, s.year, s.description, s.logo, s.tmdb_id, s.imdb_id, s.category_name, r.provider_id
         FROM series s JOIN provider_series_relations r ON s.id = r.series_id
         WHERE r.provider_id IN (${placeholders}) ORDER BY s.name`
      ).all(...providerIds);

      const processedSeries = seriesList.map(s => {
        if (allowedSources?.[s.provider_id]?.allowed) {
          const groups = allowedSources[s.provider_id].groups || [];
          if (groups.length > 0 && !groups.includes(s.category_name)) return null;
        }
        return { ...s, type: 'series', id: s.provider_unique_id, group: s.category_name };
      }).filter(Boolean);

      const categories = [...new Set([...processedMovies.map(m => m.group), ...processedSeries.map(s => s.group)].filter(Boolean))].sort();

      res.json({ movies: processedMovies, series: processedSeries, categories });
    } catch (err) {
      logger.error({ err }, 'VOD library fetch failed');
      res.status(500).json({ error: 'Could not retrieve VOD library.' });
    }
  });

  router.get('/vod/series/:seriesId', requireAuth, async (req, res) => {
    try {
      const seriesInfo = db.prepare('SELECT * FROM series WHERE provider_unique_id = ?').get(req.params.seriesId);
      if (!seriesInfo) return res.status(404).json({ error: 'Series not found.' });

      const numericId = seriesInfo.id;

      let episodes = db.prepare(
        `SELECT e.*, r.provider_id, r.provider_stream_id, r.container_extension
         FROM episodes e JOIN provider_episode_relations r ON e.id = r.episode_id
         WHERE e.series_id = ? ORDER BY e.season_num, e.episode_num`
      ).all(numericId);

      if (episodes.length === 0) {
        const relation = db.prepare('SELECT provider_id, external_series_id FROM provider_series_relations WHERE series_id = ? LIMIT 1').get(numericId);
        if (!relation) return res.status(404).json({ error: 'Provider info not found.' });

        const userRow = db.prepare('SELECT allowed_sources FROM users WHERE id = ?').get(req.session.userId);
        if (userRow?.allowed_sources) {
          const perms = JSON.parse(userRow.allowed_sources);
          if (perms[relation.provider_id] && !perms[relation.provider_id].allowed) return res.status(403).json({ error: 'Access denied.' });
          if (!perms[relation.provider_id]) return res.status(403).json({ error: 'Access denied.' });
        }

        const settings = getSettings();
        const cfg = settings.m3uSources.find(s => s.id === relation.provider_id);
        if (!cfg?.xc_data) return res.status(500).json({ error: 'Provider config not found.' });
        const xcInfo = JSON.parse(cfg.xc_data);
        const ua = settings.userAgents.find(u => u.id === settings.activeUserAgentId)?.value || 'VLC/3.0';

        const client = new XtreamClient(xcInfo.server, xcInfo.username, xcInfo.password, ua);
        let details;
        try { details = await client.getSeriesInfo(relation.external_series_id); } catch {
          return res.status(504).json({ error: 'Provider timeout.' });
        }

        if (details?.episodes) {
          const insertEp = db.prepare('INSERT OR IGNORE INTO episodes (series_id, season_num, episode_num, name, description, air_date, tmdb_id, imdb_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          const insertRel = db.prepare('INSERT OR IGNORE INTO provider_episode_relations (provider_id, episode_id, provider_stream_id, container_extension, last_seen) VALUES (?, ?, ?, ?, ?)');
          const lastSeen = new Date().toISOString();

          db.prepare('BEGIN TRANSACTION').run();
          try {
            for (const snum in details.episodes) {
              for (const ep of details.episodes[snum]) {
                let eid = db.prepare('SELECT id FROM episodes WHERE series_id = ? AND season_num = ? AND episode_num = ?').get(numericId, ep.season || snum, ep.episode_num)?.id;
                if (!eid) {
                  eid = insertEp.run(numericId, ep.season || snum, ep.episode_num, ep.title, ep.info?.plot, ep.info?.releasedate, null, null).lastInsertRowid;
                }
                insertRel.run(relation.provider_id, eid, ep.id, ep.container_extension || 'mp4', lastSeen);
              }
            }
            db.prepare('COMMIT').run();
          } catch { db.prepare('ROLLBACK').run(); throw new Error('Failed to save episodes'); }

          episodes = db.prepare(
            `SELECT e.*, r.provider_id, r.provider_stream_id, r.container_extension
             FROM episodes e JOIN provider_episode_relations r ON e.id = r.episode_id
             WHERE e.series_id = ? ORDER BY e.season_num, e.episode_num`
          ).all(numericId);
        }
      }

      const settings = getSettings();
      const providerMap = new Map();
      settings.m3uSources.filter(s => s.isActive && s.type === 'xc').forEach(p => {
        try { const x = JSON.parse(p.xc_data); const u = new URL(x.server); providerMap.set(p.id, { baseUrl: `${u.protocol}//${u.host}`, username: x.username, password: x.password }); } catch {}
      });

      const seasons = new Map();
      episodes.forEach(ep => {
        const p = providerMap.get(ep.provider_id);
        if (!p) return;
        const url = `${p.baseUrl}/series/${p.username}/${p.password}/${ep.provider_stream_id}.${ep.container_extension || 'mp4'}`;
        if (!seasons.has(ep.season_num)) seasons.set(ep.season_num, []);
        seasons.get(ep.season_num).push({ id: String(ep.id), name: ep.name, description: ep.description, air_date: ep.air_date, season: ep.season_num, episode: ep.episode_num, url });
      });

      res.json({ ...seriesInfo, id: seriesInfo.provider_unique_id, type: 'series', group: seriesInfo.category_name, seasons: Object.fromEntries(seasons) });
    } catch (err) {
      logger.error({ err }, 'VOD series fetch failed');
      res.status(500).json({ error: 'Could not retrieve series details.' });
    }
  });

  router.get('/vod/categories', requireAuth, (req, res) => {
    try {
      const rows = db.prepare('SELECT category_name FROM vod_categories ORDER BY category_name').all();
      res.json({ success: true, categories: rows.map(r => r.category_name) });
    } catch (err) {
      logger.error({ err }, 'VOD categories fetch failed');
      res.status(500).json({ error: 'Could not retrieve categories.' });
    }
  });

  return router;
}
