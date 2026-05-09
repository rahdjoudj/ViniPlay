/**
 * compat.cjs — sqlite3 callback-API compatibility wrapper backed by better-sqlite3.
 *
 * Replaces `new sqlite3.Database(path, cb)` with better-sqlite3 so the legacy
 * server.cjs can drop the sqlite3 native dependency while keeping all its
 * callback-based route handlers unchanged.
 *
 * Usage from server.cjs:
 *   // const sqlite3 = require('sqlite3').verbose();
 *   const sqlite3 = require('./src/db/compat.cjs');
 */

const Database = require('better-sqlite3');

function CompatDatabase(path, callback) {
  let db;
  try {
    db = new Database(path);
    db.pragma('journal_mode = WAL');
  } catch (err) {
    if (callback) { process.nextTick(() => callback(err)); return; }
    throw err;
  }

  const self = this;

  this._db = db;

  // --- serialize / parallelize (no-op: better-sqlite3 is always synchronous) ---
  this.serialize = (fn) => fn();
  this.parallelize = (fn) => fn();

  // --- run(sql, [params], [cb]) ---
  this.run = function (sql, ...args) {
    let params = [];
    let cb = null;
    if (args.length === 1) {
      if (typeof args[0] === 'function') { cb = args[0]; }
      else { params = args[0]; }
    } else if (args.length >= 2) {
      params = args[0];
      cb = args[1];
    }
    try {
      const result = db.prepare(sql).run(...(Array.isArray(params) ? params : [params]));
      if (cb) {
        const ctx = { lastID: result.lastInsertRowid, changes: result.changes };
        cb.call(ctx, null);
      }
    } catch (err) {
      if (cb) cb(err);
      else throw err;
    }
  };

  // --- get(sql, [params], cb) ---
  this.get = function (sql, ...args) {
    let params = [];
    let cb;
    if (args.length === 1 && typeof args[0] === 'function') {
      cb = args[0];
    } else {
      params = args[0];
      cb = args[1];
    }
    try {
      const row = db.prepare(sql).get(...(Array.isArray(params) ? params : [params]));
      cb(null, row);
    } catch (err) {
      cb(err);
    }
  };

  // --- all(sql, [params], cb) ---
  this.all = function (sql, ...args) {
    let params = [];
    let cb;
    if (args.length === 1 && typeof args[0] === 'function') {
      cb = args[0];
    } else {
      params = args[0];
      cb = args[1];
    }
    try {
      const rows = db.prepare(sql).all(...(Array.isArray(params) ? params : [params]));
      cb(null, rows);
    } catch (err) {
      cb(err);
    }
  };

  // --- exec(sql) — used for multi-statement ---
  this.exec = function (sql) {
    db.exec(sql);
  };

  // --- prepare(sql) — returns a Statement-like object with run/get/all ---
  this.prepare = function (sql) {
    let stmt;
    try { stmt = db.prepare(sql); } catch (e) { stmt = null; }
    return {
      run: function (...args) {
        let cb;
        const params = args.filter(a => typeof a !== 'function');
        if (typeof args[args.length - 1] === 'function') cb = args[args.length - 1];
        try {
          if (!stmt) throw new Error('Invalid statement');
          const result = stmt.run(...params);
          if (cb) cb.call({ lastID: result.lastInsertRowid, changes: result.changes }, null);
        } catch (err) {
          if (cb) cb(err);
        }
      },
      get: function (...args) {
        let cb;
        const params = args.filter(a => typeof a !== 'function');
        if (typeof args[args.length - 1] === 'function') cb = args[args.length - 1];
        try {
          if (!stmt) throw new Error('Invalid statement');
          const row = stmt.get(...params);
          if (cb) cb(null, row);
        } catch (err) {
          if (cb) cb(err);
        }
      },
      all: function (...args) {
        let cb;
        const params = args.filter(a => typeof a !== 'function');
        if (typeof args[args.length - 1] === 'function') cb = args[args.length - 1];
        try {
          if (!stmt) throw new Error('Invalid statement');
          const rows = stmt.all(...params);
          if (cb) cb(null, rows);
        } catch (err) {
          if (cb) cb(err);
        }
      },
      finalize: () => {},
    };
  };

  // --- close() ---
  this.close = function () {
    db.close();
  };

  // --- on(event, handler) — no-op; better-sqlite3 doesn't emit db-level events ---
  this.on = function () {};

  // Fire the constructor callback (deferred to match old sqlite3 async behavior)
  if (callback) { process.nextTick(() => callback.call(self, null)); }
}

CompatDatabase.verbose = () => CompatDatabase;

module.exports = { Database: CompatDatabase };
