import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { logger } from '../config/logger.js';
import { SALT_ROUNDS } from '../config/index.js';

export function createAuthRoutes({ db }) {
  const router = Router();

  router.get('/needs-setup', (_req, res) => {
    const row = db.prepare('SELECT COUNT(*) as count FROM users WHERE isAdmin = 1').get();
    res.json({ needsSetup: row.count === 0 });
  });

  router.post('/setup-admin', (req, res) => {
    const { count } = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (count > 0) {
      return res.status(403).json({ error: 'Setup already completed.' });
    }
    const { username, password } = req.body;
    if (!username?.trim() || !password?.trim()) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    const result = db.prepare('INSERT INTO users (username, password, isAdmin, canUseDvr) VALUES (?, ?, 1, 1)').run(username, hash);
    const userId = result.lastInsertRowid;
    logger.info({ username, userId }, 'Admin user created');

    req.session.userId = userId;
    req.session.username = username;
    req.session.isAdmin = true;
    req.session.canUseDvr = true;

    res.json({
      isLoggedIn: true,
      user: { id: userId, username, isAdmin: true, canUseDvr: true },
    });
  });

  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = !!user.isAdmin;
    req.session.canUseDvr = !!user.canUseDvr || !!user.isAdmin;
    logger.info({ userId: user.id, username: user.username }, 'User logged in');
    res.json({
      isLoggedIn: true,
      user: {
        id: user.id,
        username: user.username,
        isAdmin: !!user.isAdmin,
        canUseDvr: !!user.canUseDvr || !!user.isAdmin,
      },
    });
  });

  router.post('/logout', (req, res) => {
    logger.info({ userId: req.session?.userId }, 'User logged out');
    req.session.destroy();
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });

  router.get('/status', (req, res) => {
    if (req.session?.userId) {
      const user = db.prepare('SELECT id, username, isAdmin, canUseDvr FROM users WHERE id = ?').get(req.session.userId);
      if (user) {
        return res.json({
          isLoggedIn: true,
          user: {
            id: user.id,
            username: user.username,
            isAdmin: !!user.isAdmin,
            canUseDvr: !!user.canUseDvr || !!user.isAdmin,
          },
        });
      }
    }
    res.json({ isLoggedIn: false });
  });

  return router;
}
