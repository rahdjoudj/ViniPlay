import Database from 'better-sqlite3';
import { DB_PATH } from '../config/index.js';
import { logger } from '../config/logger.js';
import { runMigrations } from './migrations.js';

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    logger.info({ path: DB_PATH }, 'Database connected');
    runMigrations(db);
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}
