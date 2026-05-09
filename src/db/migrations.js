import { logger } from '../config/logger.js';

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE,
          password TEXT,
          isAdmin INTEGER DEFAULT 0,
          canUseDvr INTEGER DEFAULT 0,
          allowed_sources TEXT
        );

        CREATE TABLE IF NOT EXISTS user_settings (
          user_id INTEGER NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY (user_id, key)
        );

        CREATE TABLE IF NOT EXISTS multiview_layouts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          layout_data TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          channelId TEXT NOT NULL,
          channelName TEXT NOT NULL,
          channelLogo TEXT,
          programTitle TEXT NOT NULL,
          programDesc TEXT,
          programStart TEXT NOT NULL,
          programStop TEXT NOT NULL,
          notificationTime TEXT NOT NULL,
          programId TEXT NOT NULL,
          status TEXT DEFAULT 'pending',
          triggeredAt TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          endpoint TEXT UNIQUE NOT NULL,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS notification_deliveries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          notification_id INTEGER NOT NULL,
          subscription_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          updatedAt TEXT NOT NULL,
          FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
          FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS dvr_jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          channelId TEXT NOT NULL,
          channelName TEXT NOT NULL,
          programTitle TEXT NOT NULL,
          startTime TEXT NOT NULL,
          endTime TEXT NOT NULL,
          status TEXT NOT NULL,
          ffmpeg_pid INTEGER,
          filePath TEXT,
          profileId TEXT,
          userAgentId TEXT,
          preBufferMinutes INTEGER,
          postBufferMinutes INTEGER,
          errorMessage TEXT,
          isConflicting INTEGER DEFAULT 0,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS dvr_recordings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER,
          user_id INTEGER NOT NULL,
          channelName TEXT NOT NULL,
          programTitle TEXT NOT NULL,
          startTime TEXT NOT NULL,
          durationSeconds INTEGER,
          fileSizeBytes INTEGER,
          filePath TEXT UNIQUE NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id) REFERENCES dvr_jobs(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS movies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          year INTEGER,
          description TEXT,
          logo TEXT,
          tmdb_id TEXT,
          imdb_id TEXT,
          category_name TEXT,
          provider_unique_id TEXT UNIQUE,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS series (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          year INTEGER,
          description TEXT,
          logo TEXT,
          tmdb_id TEXT,
          imdb_id TEXT,
          category_name TEXT,
          provider_unique_id TEXT UNIQUE,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS episodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          series_id INTEGER NOT NULL,
          season_num INTEGER NOT NULL,
          episode_num INTEGER NOT NULL,
          name TEXT,
          description TEXT,
          air_date TEXT,
          tmdb_id TEXT,
          imdb_id TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS vod_categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id TEXT UNIQUE NOT NULL,
          category_name TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS provider_movie_relations (
          provider_id TEXT NOT NULL,
          movie_id INTEGER NOT NULL,
          stream_id TEXT NOT NULL,
          container_extension TEXT,
          last_seen TEXT NOT NULL,
          FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
          PRIMARY KEY (provider_id, stream_id)
        );

        CREATE TABLE IF NOT EXISTS provider_series_relations (
          provider_id TEXT NOT NULL,
          series_id INTEGER NOT NULL,
          external_series_id TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
          PRIMARY KEY (provider_id, external_series_id)
        );

        CREATE TABLE IF NOT EXISTS provider_episode_relations (
          provider_id TEXT NOT NULL,
          episode_id INTEGER NOT NULL,
          provider_stream_id TEXT NOT NULL,
          container_extension TEXT,
          last_seen TEXT NOT NULL,
          FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
          PRIMARY KEY (provider_id, episode_id)
        );

        CREATE TABLE IF NOT EXISTS stream_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          channel_id TEXT,
          channel_name TEXT,
          start_time TEXT NOT NULL,
          end_time TEXT,
          duration_seconds INTEGER,
          status TEXT NOT NULL,
          client_ip TEXT,
          channel_logo TEXT,
          stream_profile_name TEXT
        );

        CREATE TABLE IF NOT EXISTS schema_versions (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    version: 2,
    name: 'replace_connect_sqlite3_sessions',
    up: (db) => {
      // connect-sqlite3 created a sessions table with incompatible schema.
      // Drop it so the new better-sqlite3 session store recreates it cleanly.
      db.exec('DROP TABLE IF EXISTS sessions');
    },
  },
];

export function runMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  const current = db.prepare('SELECT MAX(version) as v FROM schema_versions').get();

  for (const migration of MIGRATIONS) {
    if (migration.version > (current?.v || 0)) {
      logger.info({ version: migration.version, name: migration.name }, 'Applying migration');
      migration.up(db);
      db.prepare('INSERT INTO schema_versions (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      );
      logger.info({ version: migration.version }, 'Migration applied');
    }
  }
}
