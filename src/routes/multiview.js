import { Router } from 'express';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';

export function createMultiviewRoutes({ db }) {
  const router = Router();

  router.get('/layouts', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT id, name, layout_data FROM multiview_layouts WHERE user_id = ?').all(req.session.userId);
    const layouts = rows.map(row => ({ ...row, layout_data: JSON.parse(row.layout_data) }));
    res.json(layouts);
  });

  router.post('/layouts', requireAuth, (req, res) => {
    const { name, layout_data } = req.body;
    if (!name || !layout_data) {
      return res.status(400).json({ error: 'Layout name and data are required.' });
    }
    const layoutJson = JSON.stringify(layout_data);
    const result = db.prepare('INSERT INTO multiview_layouts (user_id, name, layout_data) VALUES (?, ?, ?)').run(req.session.userId, name, layoutJson);
    logger.info({ userId: req.session.userId, layoutId: result.lastInsertRowid, name }, 'Layout saved');
    res.status(201).json({ success: true, id: result.lastInsertRowid, name, layout_data });
  });

  router.delete('/layouts/:id', requireAuth, (req, res) => {
    const result = db.prepare('DELETE FROM multiview_layouts WHERE id = ? AND user_id = ?').run(req.params.id, req.session.userId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Layout not found or not authorized.' });
    }
    logger.info({ userId: req.session.userId, layoutId: req.params.id }, 'Layout deleted');
    res.json({ success: true });
  });

  return router;
}
