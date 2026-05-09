import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { logger } from '../config/logger.js';
import { SALT_ROUNDS } from '../config/index.js';
import { requireAdmin } from '../middleware/auth.js';

export function createUserRoutes({ db, activeStreamProcesses }) {
  const router = Router();

  router.get('/', requireAdmin, (_req, res) => {
    const rows = db.prepare('SELECT id, username, isAdmin, canUseDvr, allowed_sources FROM users ORDER BY username').all();
    res.json(rows);
  });

  router.post('/', requireAdmin, (req, res) => {
    const { username, password, isAdmin, canUseDvr, allowedSources } = req.body;
    if (!username?.trim() || !password?.trim()) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    const sources = Array.isArray(allowedSources) ? allowedSources.join(',') : '';
    db.prepare('INSERT INTO users (username, password, isAdmin, canUseDvr, allowed_sources) VALUES (?, ?, ?, ?, ?)').run(
      username, hash, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, sources
    );
    logger.info({ username }, 'User created');
    res.json({ success: true });
  });

  router.put('/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { username, password, isAdmin, canUseDvr, allowedSources } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const sources = Array.isArray(allowedSources) ? allowedSources.join(',') : '';
    if (password) {
      const hash = bcrypt.hashSync(password, SALT_ROUNDS);
      db.prepare('UPDATE users SET username=?, password=?, isAdmin=?, canUseDvr=?, allowed_sources=? WHERE id=?').run(
        username, hash, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, sources, id
      );
    } else {
      db.prepare('UPDATE users SET username=?, isAdmin=?, canUseDvr=?, allowed_sources=? WHERE id=?').run(
        username, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, sources, id
      );
    }

    const { count } = db.prepare('SELECT COUNT(*) as count FROM users WHERE isAdmin = 1').get();
    if (count === 0) return res.status(400).json({ error: 'Cannot remove the last admin.' });

    logger.info({ userId: id, username }, 'User updated');
    res.json({ success: true });
  });

  router.delete('/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    if (Number(id) === req.session.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account.' });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (activeStreamProcesses) {
      for (const [key, info] of activeStreamProcesses) {
        if (key.startsWith(`${id}::`)) {
          try { info.process?.kill('SIGTERM'); } catch {}
          activeStreamProcesses.delete(key);
        }
      }
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    logger.info({ userId: id, username: user.username }, 'User deleted');
    res.json({ success: true });
  });

  return router;
}
