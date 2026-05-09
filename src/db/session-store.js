import { getDb } from './index.js';

export class SessionStore {
  constructor() {
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

    this._pruneTimer = setInterval(() => this._prune.run(Date.now()), 60_000);
  }

  get(sid, cb) {
    try {
      const row = this._get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) { cb(err); }
  }

  set(sid, session, cb) {
    try {
      const maxAge = session.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000;
      this._set.run(sid, Date.now() + maxAge, JSON.stringify(session));
      cb(null);
    } catch (err) { cb(err); }
  }

  destroy(sid, cb) {
    try { this._del.run(sid); cb(null); } catch (err) { cb(err); }
  }

  touch(sid, session, cb) {
    try {
      const maxAge = session.cookie?.maxAge ?? 30 * 24 * 60 * 60 * 1000;
      this._touch.run(Date.now() + maxAge, sid, Date.now());
      cb(null);
    } catch (err) { cb(err); }
  }
}
