import session from 'express-session';
import { getDb } from './index.js';
import { logger } from '../config/logger.js';

// Custom better-sqlite3-backed session store. Extends session.Store so
// createSession (which assigns req.session) is inherited — overriding it
// without setting req.session breaks every request's session handling.
export class SessionStore extends session.Store {
  constructor() {
    super();

    const db = getDb();
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      expires INTEGER,
      data TEXT
    )`);
    db.prepare('CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)').run();

    this._get = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this._set = db.prepare('INSERT OR REPLACE INTO sessions (sid, expires, data) VALUES (?, ?, ?)');
    this._del = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this._touch = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ? AND expires > ?');
    this._prune = db.prepare('DELETE FROM sessions WHERE expires < ?');

    this._pruneTimer = setInterval(() => {
      try {
        this._prune.run(Date.now());
      } catch (err) {
        // Can fire after closeDb() in shutdown/embedding scenarios — don't crash.
        logger.warn({ err }, 'Session prune failed');
      }
    }, 60_000);
    this._pruneTimer.unref();
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid, Date.now());
      if (!row) return process.nextTick(() => cb(null, null));
      try {
        const data = JSON.parse(row.data);
        process.nextTick(() => cb(null, data));
      } catch (err) {
        // Corrupt row: treat as no session so a fresh one is generated
        // instead of 500ing every request for this sid.
        logger.warn({ sid }, 'Corrupt session data discarded');
        this._del.run(sid);
        process.nextTick(() => cb(null, null));
      }
    } catch (err) { process.nextTick(() => cb(err)); }
  }

  set(sid, session, cb) {
    try {
      const maxAge = session.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000;
      this._set.run(sid, Date.now() + maxAge, JSON.stringify(session));
      process.nextTick(() => cb(null));
    } catch (err) { process.nextTick(() => cb(err)); }
  }

  destroy(sid, cb) {
    try { this._del.run(sid); process.nextTick(() => cb(null)); } catch (err) { process.nextTick(() => cb(err)); }
  }

  touch(sid, session, cb) {
    try {
      const maxAge = session.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000;
      this._touch.run(Date.now() + maxAge, sid, Date.now());
      process.nextTick(() => cb(null));
    } catch (err) { process.nextTick(() => cb(err)); }
  }
}
