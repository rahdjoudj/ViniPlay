// A Node.js server for the VINI PLAY IPTV Player. 
// Implements server-side EPG parsing, secure environment variables, and improved logging.

// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('./src/db/compat.cjs');
let SQLiteStore; // Lazy-init inside isMainModule guard, avoids requiring connect-sqlite3 when loaded as module
const xmlJS = require('xml-js');
const zlib = require('zlib');
const webpush = require('web-push');
const schedule = require('node-schedule');
const disk = require('diskusage');
const si = require('systeminformation'); // NEW: For system health monitoring
//vod processor
const { refreshVodContent, processM3uVod } = require('./vodProcessor.cjs');
const XtreamClient = require('./xtreamClient.cjs');

const isMainModule = require.main === module;

// --- NEW: Live Activity Tracking for Redirects ---
const activeRedirectStreams = new Map(); // Tracks live redirect streams for the admin UI

const app = express();
const port = 8998;
const saltRounds = 10;
// Initialize global variables at the top-level scope
let notificationCheckInterval = null;
const sourceRefreshTimers = new Map();
let detectedHardware = { nvidia: null, intel_qsv: null, intel_vaapi: null, radeon_vaapi: null }; // MODIFIED: To store specific Intel GPU info

// Used to validate settings.
const validFFmpegLogLevels = ["debug", "verbose", "info", "warning", "error"];

// --- ENHANCEMENT: For Server-Sent Events (SSE) ---
// This map will store active client connections for real-time updates.
const sseClients = new Map();

// --- CAST: Token-based authentication ---
// Stores short-lived tokens for Chromecast authentication
const activeCastTokens = new Map(); // token -> { userId, streamUrl, expiresAt }

// --- NEW: DVR State ---
const activeDvrJobs = new Map(); // Stores active node-schedule jobs
const runningFFmpegProcesses = new Map(); // Stores PIDs of running ffmpeg recordings

// --- MODIFIED: Active Stream Management ---
// Now maps a unique stream key (URL + UserID) to its process info
const activeStreamProcesses = new Map();
const STREAM_INACTIVITY_TIMEOUT = 30000; // 30 seconds to kill an inactive stream process

// --- Configuration ---
const DATA_DIR = process.env.DATA_DIR || '/data';
const DVR_DIR = process.env.DVR_DIR || '/dvr';
const LOGS_DIR = path.join(DATA_DIR, 'logs'); // NEW: Log management directory
const VAPID_KEYS_PATH = path.join(DATA_DIR, 'vapid.json');
const SOURCES_DIR = path.join(DATA_DIR, 'sources');
const RAW_CACHE_DIR = path.join(SOURCES_DIR, 'raw_cache');
const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image_cache'); // NEW: VOD poster image cache
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_PATH = path.join(DATA_DIR, 'viniplay.db');
const LIVE_CHANNELS_M3U_PATH = path.join(DATA_DIR, 'live_channels.m3u'); // Renamed
const LIVE_EPG_JSON_PATH = path.join(DATA_DIR, 'epg.json'); // Renamed
const VOD_MOVIES_JSON_PATH = path.join(DATA_DIR, 'vod_movies.json'); // New
const VOD_SERIES_JSON_PATH = path.join(DATA_DIR, 'vod_series.json'); // New
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

if (isMainModule) {
console.log(`[INIT] Application starting. Data directory: ${DATA_DIR}, Public directory: ${PUBLIC_DIR}`);

// --- Automatic VAPID Key Generation ---
let vapidKeys = {};
try {
    if (fs.existsSync(VAPID_KEYS_PATH)) {
        console.log('[Push] Loading existing VAPID keys...');
        vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_PATH, 'utf-8'));
    } else {
        console.log('[Push] VAPID keys not found. Generating new keys...');
        vapidKeys = webpush.generateVAPIDKeys();
        fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2));
        console.log('[Push] New VAPID keys generated and saved.');
    }
    const vapidContactEmail = process.env.VAPID_CONTACT_EMAIL || 'mailto:admin@example.com';
    console.log(`[Push] Setting VAPID contact to: ${vapidContactEmail}`);
    webpush.setVapidDetails(vapidContactEmail, vapidKeys.publicKey, vapidKeys.privateKey);
} catch (error) {
    console.error('[Push] FATAL: Could not load or generate VAPID keys.', error);
}

// Ensure the data and dvr directories exist.
try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    if (!fs.existsSync(SOURCES_DIR)) fs.mkdirSync(SOURCES_DIR, { recursive: true });
    if (!fs.existsSync(DVR_DIR)) fs.mkdirSync(DVR_DIR, { recursive: true });
    if (!fs.existsSync(RAW_CACHE_DIR)) fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    if (!fs.existsSync(IMAGE_CACHE_DIR)) fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
    console.log(`[INIT] All required directories checked/created.`);
} catch (mkdirError) {
    console.error(`[INIT] FATAL: Failed to create necessary directories: ${mkdirError.message}`);
    process.exit(1);
}
} // end isMainModule


// --- Database Setup ---
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error("[DB] Error opening database:", err.message);
        process.exit(1);
    } else {
        console.log("[DB] Connected to the SQLite database.");
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, isAdmin INTEGER DEFAULT 0, canUseDvr INTEGER DEFAULT 0, allowed_sources TEXT)`, (err) => {
                if (err) {
                    console.error("[DB] Error creating 'users' table:", err.message);
                } else {
                    // DB Migrations for existing tables
                    db.run("ALTER TABLE users ADD COLUMN canUseDvr INTEGER DEFAULT 0", () => { });
                    db.run("ALTER TABLE users ADD COLUMN allowed_sources TEXT", () => { });
                }
            });
            db.run(`CREATE TABLE IF NOT EXISTS user_settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (user_id, key))`);
            db.run(`CREATE TABLE IF NOT EXISTS multiview_layouts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL, layout_data TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, channelLogo TEXT, programTitle TEXT NOT NULL, programDesc TEXT, programStart TEXT NOT NULL, programStop TEXT NOT NULL, notificationTime TEXT NOT NULL, programId TEXT NOT NULL, status TEXT DEFAULT 'pending', triggeredAt TEXT, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS push_subscriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS notification_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER NOT NULL, subscription_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', updatedAt TEXT NOT NULL, FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE, FOREIGN KEY (subscription_id) REFERENCES push_subscriptions(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS dvr_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channelId TEXT NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, startTime TEXT NOT NULL, endTime TEXT NOT NULL, status TEXT NOT NULL, ffmpeg_pid INTEGER, filePath TEXT, profileId TEXT, userAgentId TEXT, preBufferMinutes INTEGER, postBufferMinutes INTEGER, errorMessage TEXT, isConflicting INTEGER DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
            db.run(`CREATE TABLE IF NOT EXISTS dvr_recordings (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER, user_id INTEGER NOT NULL, channelName TEXT NOT NULL, programTitle TEXT NOT NULL, startTime TEXT NOT NULL, durationSeconds INTEGER, fileSizeBytes INTEGER, filePath TEXT UNIQUE NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY (job_id) REFERENCES dvr_jobs(id) ON DELETE SET NULL)`);

            // --- NEW: VOD Tables ---
            db.run(`CREATE TABLE IF NOT EXISTS movies (
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
			)`, (err) => { if (err) console.error("[DB] Error creating 'movies' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS series (
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
			)`, (err) => { if (err) console.error("[DB] Error creating 'series' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS episodes (
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
			)`, (err) => { if (err) console.error("[DB] Error creating 'episodes' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS vod_categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id TEXT UNIQUE NOT NULL,
                category_name TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )`, (err) => { if (err) console.error("[DB] Error creating 'vod_categories' table:", err.message); });

            // --- NEW: VOD Relation Tables (Linking Providers to Content) ---
            // Note: Assuming 'provider_id' refers to the ID of the M3U source entry in settings
            // We'll store the source ID (e.g., 'src-12345678') as TEXT for flexibility
            db.run(`CREATE TABLE IF NOT EXISTS provider_movie_relations (
                provider_id TEXT NOT NULL,
                movie_id INTEGER NOT NULL,
                stream_id TEXT NOT NULL,
                container_extension TEXT,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (movie_id) REFERENCES movies(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, stream_id)
            )`, (err) => { if (err) console.error("[DB] Error creating 'provider_movie_relations' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS provider_series_relations (
                provider_id TEXT NOT NULL,
                series_id INTEGER NOT NULL,
                external_series_id TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (series_id) REFERENCES series(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, external_series_id)
            )`, (err) => { if (err) console.error("[DB] Error creating 'provider_series_relations' table:", err.message); });

            db.run(`CREATE TABLE IF NOT EXISTS provider_episode_relations (
                provider_id TEXT NOT NULL,
                episode_id INTEGER NOT NULL,
                provider_stream_id TEXT NOT NULL, -- The stream ID for the episode from XC
                container_extension TEXT,
                last_seen TEXT NOT NULL,
                FOREIGN KEY (episode_id) REFERENCES episodes(id) ON DELETE CASCADE,
                PRIMARY KEY (provider_id, episode_id)
             )`, (err) => {
                if (err) {
                    console.error("[DB] Error creating 'provider_episode_relations' table:", err.message);
                } else {
                    // Add new column non-destructively
                    db.run("ALTER TABLE provider_episode_relations ADD COLUMN container_extension TEXT", () => { });
                }
            });
            // --- END NEW VOD TABLES ---

            //-- ENHANCEMENT: Modify stream history table to include more data for the admin panel.
            db.run(`CREATE TABLE IF NOT EXISTS stream_history (
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
            )`, (err) => {
                if (!err) {
                    // Add new columns non-destructively if the table already exists
                    db.run("ALTER TABLE stream_history ADD COLUMN channel_logo TEXT", () => { });
                    db.run("ALTER TABLE stream_history ADD COLUMN stream_profile_name TEXT", () => { });
                }
            });
            // --- DVR Job Loading and Scheduling (Moved from main execution flow) ---
            console.log('[DVR] Loading and scheduling all pending DVR jobs from database...');
            db.run("UPDATE dvr_jobs SET status = 'error', errorMessage = 'Server restarted during recording.' WHERE status = 'recording'", [], (err) => {
                if (err) {
                    console.error('[DVR] Error updating recording jobs status on startup:', err.message);
                }
            });

            db.all("SELECT * FROM dvr_jobs WHERE status = 'scheduled'", [], (err, jobs) => {
                if (err) {
                    console.error('[DVR] Error fetching pending DVR jobs:', err);
                    return;
                }
                jobs.forEach(job => {
                    scheduleDvrJob(job);
                });
                console.log(`[DVR] Loaded and scheduled ${jobs.length} pending DVR jobs.`);
            });
            // --- End DVR Job Loading and Scheduling ---
        });
    }
});

if (isMainModule) {
// --- Middleware (only when running standalone) ---
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'private, no-cache, must-revalidate');
    next();
});
app.use(express.static(PUBLIC_DIR, {
    setHeaders: (res, path) => {
        if (path.endsWith('index.html') || path.endsWith('.js')) {
            res.set('Cache-Control', 'public, no-cache, must-revalidate');
        }
    }
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
}

const updateAndScheduleSourceRefreshes = () => {
    console.log('[SCHEDULER] Updating and scheduling all source refreshes...');
    const settings = getSettings();
    const allSources = [...(settings.m3uSources || []), ...(settings.epgSources || [])];
    const activeUrlSources = new Set();

    allSources.forEach(source => {
        if (source.type === 'url' && source.isActive && source.refreshHours > 0) {
            activeUrlSources.add(source.id);
            if (sourceRefreshTimers.has(source.id)) {
                clearTimeout(sourceRefreshTimers.get(source.id));
            }

            console.log(`[SCHEDULER] Scheduling refresh for "${source.name}" (ID: ${source.id}) every ${source.refreshHours} hours.`);

            const scheduleNext = () => {
                const timeoutId = setTimeout(async () => {
                    console.log(`[SCHEDULER_RUN] Auto-refresh triggered for "${source.name}".`);
                    try {
                        const result = await processAndMergeSources();
                        if (result.success) {
                            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(result.updatedSettings, null, 2));
                            console.log(`[SCHEDULER_RUN] Successfully refreshed and processed sources for "${source.name}".`);
                        }
                    } catch (error) {
                        console.error(`[SCHEDULER_RUN] Auto-refresh for "${source.name}" failed:`, error.message);
                    }
                    scheduleNext();
                }, source.refreshHours * 3600 * 1000);

                sourceRefreshTimers.set(source.id, timeoutId);
            };

            scheduleNext();
        }
    });

    for (const [sourceId, timeoutId] of sourceRefreshTimers.entries()) {
        if (!activeUrlSources.has(sourceId)) {
            console.log(`[SCHEDULER] Clearing obsolete refresh timer for source ID: ${sourceId}`);
            clearTimeout(timeoutId);
            sourceRefreshTimers.delete(sourceId);
        }
    }
    console.log(`[SCHEDULER] Finished scheduling. Active timers: ${sourceRefreshTimers.size}`);
};

function saveSettings(settings) {
    if (app._saveSettings) {
        app._saveSettings(settings);
    } else {
        try {
            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
            console.log('[SETTINGS] Settings saved successfully.');
        } catch (e) {
            console.error("[SETTINGS] Error saving settings:", e);
        }
    }
    updateAndScheduleSourceRefreshes();
}

if (isMainModule) {
// --- Session Management (only when running standalone) ---
SQLiteStore = require('connect-sqlite3')(session);
let sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
    console.log('[SECURITY] SESSION_SECRET not found in environment. Checking settings.json...');
    let settings = getSettings();
    if (settings.generatedSessionSecret) {
        console.log('[SECURITY] Found existing session secret in settings.json.');
        sessionSecret = settings.generatedSessionSecret;
    } else {
        console.log('[SECURITY] No secret in settings.json. Generating a new one...');
        sessionSecret = crypto.randomBytes(64).toString('hex');
        settings.generatedSessionSecret = sessionSecret;
        saveSettings(settings);
        console.log('[SECURITY] New session secret generated and saved to settings.json.');
    }
} else {
    console.log('[SECURITY] Loaded SESSION_SECRET from environment variable.');
}

if (sessionSecret.includes('replace_this')) {
    console.warn('[SECURITY] Using a weak or default SESSION_SECRET. Please replace it.');
}

app.use(
    session({
        store: new SQLiteStore({ db: 'viniplay.db', dir: DATA_DIR, table: 'sessions' }),
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, secure: process.env.NODE_ENV === 'production' },
    })
);

app.use((req, res, next) => {
    req.clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (req.path === '/api/events') return next();
    const user_info = req.session.userId ? `User ID: ${req.session.userId}, Admin: ${req.session.isAdmin}, DVR: ${req.session.canUseDvr}` : 'No session';
    console.log(`[HTTP_TRACE] ${req.method} ${req.originalUrl} - IP: ${req.clientIp} - Session: [${user_info}]`);
    next();
});
} // end isMainModule

// MODIFIED: requireAuth now checks if the user still exists in the database on every request.
const requireAuth = (req, res, next) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Authentication required.' });
    }

    db.get("SELECT id FROM users WHERE id = ?", [req.session.userId], (err, user) => {
        if (err) {
            console.error('[AUTH_MIDDLEWARE] DB error checking user existence:', err);
            return res.status(500).json({ error: 'Server error during authentication.' });
        }
        if (!user) {
            console.warn(`[AUTH_MIDDLEWARE] User ID ${req.session.userId} from session not found in DB. Destroying session.`);
            req.session.destroy();
            res.clearCookie('connect.sid');
            return res.status(401).json({ error: 'User account no longer exists. Please log in again.' });
        }
        // User exists, proceed.
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.session && req.session.isAdmin) return next();
    return res.status(403).json({ error: 'Administrator privileges required.' });
};
const requireDvrAccess = (req, res, next) => {
    if (req.session && (req.session.canUseDvr || req.session.isAdmin)) return next();
    return res.status(403).json({ error: 'DVR access required.' });
};

// *** FIX: DVR Playback Access ***
// When running as a module, the parent app handles /dvr static serving.
if (isMainModule) {
app.get('/dvr/*', requireAuth, (req, res) => {
  const filePath = path.resolve(DVR_DIR, req.params[0]);
  if (!filePath.startsWith(DVR_DIR + path.sep) && filePath !== DVR_DIR) {
    return res.status(403).send('Forbidden');
  }
  if (!req.session.canUseDvr && !req.session.isAdmin) {
    return res.status(403).send('Forbidden');
  }
  if (!req.session.isAdmin) {
    db.get('SELECT filePath FROM dvr_recordings WHERE filePath = ? AND user_id = ?', [filePath, req.session.userId], (err, row) => {
      if (err || !row) return res.status(404).send('Recording not found');
      res.sendFile(filePath);
    });
    return;
  }
  res.sendFile(filePath);
});
}

// --- Helper Functions ---
/**
 * NEW: Sends a real-time status update to the client during source processing.
 * @param {object} req - The Express request object, used to identify the user.
 * @param {string} message - The status message to send.
 * @param {string} type - The type of message (e.g., 'info', 'success', 'error').
 */
function sendProcessingStatus(req, message, type = 'info') {
    if (req && req.session && req.session.userId) {
        sendSseEvent(req.session.userId, 'processing-status', { message, type });
    }
}

// --- Database Helper Functions ---
/**
 * Promisified version of db.run
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<object>} - { lastID, changes }
 */
const dbRun = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
};

/**
 * Promisified version of db.get
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<object|null>} - The first row found.
 */
const dbGet = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row);
        });
    });
};

/**
 * Promisified version of db.all
 * @param {sqlite3.Database} db - The database instance.
 * @param {string} sql - The SQL query.
 * @param {Array} params - Query parameters.
 * @returns {Promise<Array>} - An array of rows.
 */
const dbAll = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
        });
    });
};
// --- End Database Helper Functions ---


/**
 * NEW: Extracts GPU details from vainfo output.
 */
function extractVainfoGPUDetails(vainfo_stdout) {
    const start_tag = "Driver version: ";
    const end_tag = "vainfo: Supported profile";

    let vainfo_gpu_details = vainfo_stdout.substring(
        vainfo_stdout.indexOf(start_tag) + start_tag.length,
        vainfo_stdout.lastIndexOf(end_tag) - 1
    );
    // If we can't find the relevant GPU info section, return all to debug.
    // Likely means the output format of vainfo has been changed.
    if (vainfo_gpu_details === "") {
        vainfo_gpu_details = vainfo_stdout;
    } else {
        console.log(`[HW] Detected: ${vainfo_gpu_details}`)
    }
    return vainfo_gpu_details;
}

/**
 * NEW: Detects available hardware for transcoding.
 */
async function detectHardwareAcceleration() {

    // When a new unhandled GPU is found, add the driver name to the appropriate
    // array of gpu drivers for detection.
    const vaapi_radeon_gpu_drivers = ["r600_drv_video.so", "radeonsi_drv_video.so"];
    const intel_qsv_gpu_drivers = ["iHD_drv_video.so"];
    const intel_vaapi_gpu_drivers = ["i965_drv_video.so"];

    console.log('[HW] Detecting hardware acceleration capabilities...');
    // Detect NVIDIA GPU
    exec('nvidia-smi --query-gpu=gpu_name --format=csv,noheader', (err, stdout, stderr) => {
        if (err || stderr) {
            console.log('[HW] NVIDIA GPU not detected or nvidia-smi failed.');
        } else {
            const gpuName = stdout.trim();
            detectedHardware.nvidia = gpuName;
            console.log(`[HW] NVIDIA GPU detected: ${gpuName}`);
        }
    });

    // MODIFIED: Use 'vainfo' for more robust detection of AMD, Intel VA-API
    // and QSV GPUs. vainfo gives driver detection info on stderr and full
    // detected GPU detail on stdout.
    exec('vainfo', (err, stdout, stderr) => {
        if (stderr) {
            let found = false;
            const trimmed_stdout = stdout.trim()

            // Intel qsv driver is for modern Intel GPUs (Gen9+) and is preferred for QSV
            if (intel_qsv_gpu_drivers.some(substring => stderr.includes(substring))) {
                detectedHardware.intel_qsv = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }
            // AMD Radeon detection
            if (vaapi_radeon_gpu_drivers.some(substring => stderr.includes(substring))) {
                detectedHardware.radeon_vaapi = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }
            // Intel vaapi driver is for older Intel GPUs (pre-Gen9)
            if (intel_vaapi_gpu_drivers.some(substring => stderr.includes(substring))) {
                detectedHardware.intel_vaapi = extractVainfoGPUDetails(trimmed_stdout);
                found = true;
            }

            if (!found) {
                // Show full vainfo output for info/debug purposes.
                console.log("[HW] vainfo did not detect any recognized GPU");
                if (stderr) {
                    console.log(`[HW] vainfo init (stderr): ${stderr.trim()}`);
                }
                if (stdout) {
                    console.log(`[HW] vainfo GPU info (stdout): ${stdout.trim()}`);
                }
            }
        }
    });
}

// MODIFIED: This function is now mostly for multi-view scenarios.
// Single-user streams are handled more directly.
function cleanupInactiveStreams() {
    const now = Date.now();
    console.log(`[JANITOR] Running cleanup for inactive streams. Current active processes: ${activeStreamProcesses.size}`);

    activeStreamProcesses.forEach((streamInfo, streamKey) => {
        if (streamInfo.references <= 0 && (now - streamInfo.lastAccess > STREAM_INACTIVITY_TIMEOUT)) {
            console.log(`[JANITOR] Found stale stream process for key: ${streamKey}. Terminating PID: ${streamInfo.process.pid}.`);
            try {
                // Also update the history entry if it exists
                if (streamInfo.historyId) {
                    const endTime = new Date().toISOString();
                    const duration = Math.round((new Date(endTime).getTime() - new Date(streamInfo.startTime).getTime()) / 1000);
                    db.run("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'",
                        [endTime, duration, streamInfo.historyId]);
                }
                streamInfo.process.kill('SIGKILL');
                activeStreamProcesses.delete(streamKey);
                //-- ENHANCEMENT: Notify admins that a stream has ended.
                broadcastAdminUpdate();
            } catch (e) {
                console.warn(`[JANITOR] Error killing stale process for ${streamKey}: ${e.message}`);
                activeStreamProcesses.delete(streamKey);
                //-- ENHANCEMENT: Notify admins even if the process kill fails, to keep UI in sync.
                broadcastAdminUpdate();
            }
        }
    });
}

function sendSseEvent(userId, eventName, data) {
    const clients = sseClients.get(userId);
    if (clients && clients.length > 0) {
        console.log(`[SSE] Sending event '${eventName}' to ${clients.length} client(s) for user ID ${userId}.`);
        const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        clients.forEach(client => client.res.write(message));
    }
}

//-- ENHANCEMENT: New function to broadcast activity updates to all connected admins.
function broadcastAdminUpdate() {
    // Combine transcoded and redirect streams into one list for the live view
    const transcodedLive = Array.from(activeStreamProcesses.values()).map(info => ({
        streamKey: info.streamKey,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: true,
    }));

    const redirectLive = Array.from(activeRedirectStreams.values()).map(info => ({
        // Use historyId for redirect streamKey to ensure it's unique per session
        streamKey: `${info.userId}::${info.historyId}`,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: false,
    }));

    const combinedLiveActivity = [...transcodedLive, ...redirectLive];

    for (const clients of sseClients.values()) {
        clients.forEach(client => {
            if (client.isAdmin) {
                const message = `event: activity-update\ndata: ${JSON.stringify({ live: combinedLiveActivity })}\n\n`;
                client.res.write(message);
            }
        });
    }
    console.log(`[SSE_ADMIN] Broadcasted combined activity update (${combinedLiveActivity.length} live streams) to all connected admins.`);
}

// NEW: Broadcasts an event to ALL connected clients, regardless of user.
function broadcastSseToAll(eventName, data) {
    const message = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    let clientCount = 0;
    for (const clients of sseClients.values()) {
        clients.forEach(client => {
            client.res.write(message);
            clientCount++;
        });
    }
    console.log(`[SSE_BROADCAST] Broadcasted event '${eventName}' to ${clientCount} total clients.`);
}

function getSettings() {
    if (app._getSettings) return app._getSettings();
    const defaultSettings = {
        m3uSources: [],
        epgSources: [],
        userAgents: [{ id: `default-ua-1724778434000`, name: 'ViniPlay Default', value: 'VLC/3.0.20 (Linux; x86_64)', isDefault: true }],
        streamProfiles: [
            { id: 'redirect', name: 'Redirect (No Transcoding)', command: 'redirect', isDefault: true },
            { id: 'ffmpeg-default', name: 'ffmpeg (Built in)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-fmp4', name: 'ffmpeg fMP4 (CPU)', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v libx264 -preset ultrafast -c:a aac -b:a 192k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'ffmpeg-fmp4-nvidia', name: 'ffmpeg fMP4 (NVIDIA)', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 192k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'ffmpeg-nvidia', name: 'ffmpeg (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -re -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-nvidia-reconnect', name: 'ffmpeg (NVIDIA reconnect)', command: '-user_agent "{userAgent}" -re -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-intel', name: 'ffmpeg (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-vaapi', name: 'ffmpeg (VA-API) Intel', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false },
            { id: 'ffmpeg-vaapi-amd', name: 'ffmpeg (VA-API) Radeon/AMD', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false }
        ],
        dvr: {
            preBufferMinutes: 1,
            postBufferMinutes: 2,
            maxConcurrentRecordings: 1,
            autoDeleteDays: 0,
            activeRecordingProfileId: 'dvr-ts-default', // **MODIFIED: Point to the new default profile**
            recordingProfiles: [
                // The primary default for timeshifting, uses almost no CPU.
                { id: 'dvr-ts-default', name: 'Default TS (Stream Copy, Timeshiftable)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c copy -f mpegts "{filePath}"', isDefault: true },

                // The new GPU-accelerated option for timeshifting.
                { id: 'dvr-ts-nvidia', name: 'NVIDIA NVENC TS (Timeshiftable)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts "{filePath}"', isDefault: false },
                { id: 'dvr-ts-nvidia-reconnect', name: 'NVIDIA NVENC TS reconnect', command: '-user_agent "{userAgent}" -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5 -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts "{filePath}"', isDefault: false },

                // Legacy MP4 profiles, no longer default.
                { id: 'dvr-mp4-default', name: 'Legacy MP4 (H.264/AAC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-nvidia', name: 'NVIDIA NVENC MP4 (H.264/AAC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-intel', name: 'Intel QSV MP4 (H.264/AAC)', command: '-hwaccel qsv -hwaccel_output_format qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -vf scale_qsv=format=nv12 -c:a aac -ac 2 -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                // NEW: Add this line for VA-API recording
                { id: 'dvr-mp4-vaapi', name: 'VA-API MP4 (H.264/AAC)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf \'format=nv12,hwupload\' -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
                { id: 'dvr-mp4-radeon-vaapi', name: 'Radeon/AMD VA-API MP4 (H.264/AAC)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -preset medium -vf scale_vaapi=format=nv12 -c:a aac -ac 2 -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false }
            ]
        },
        castProfiles: [
            { id: 'cast-default', name: 'Cast Default (CPU)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: true },
            { id: 'cast-nvidia', name: 'Cast (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-intel', name: 'Cast (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-vaapi', name: 'Cast (VA-API Intel)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false },
            { id: 'cast-vaapi-amd', name: 'Cast (VA-API Radeon/AMD)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false }
        ],
        activeCastProfileId: 'cast-default',
        activeUserAgentId: `default-ua-1724778434000`,
        activeStreamProfileId: 'redirect',
        playerLogLevel: 'warning',
        dvrLogLevel: 'warning',
        searchScope: 'all_channels_unfiltered',
        notificationLeadTime: 10,
        sourcesLastUpdated: null,
        logs: {
            maxFiles: 5,
            maxFileSizeBytes: 5 * 1024 * 1024, // 5MB
            autoDeleteDays: 7
        }
    };

    if (!fs.existsSync(SETTINGS_PATH)) {
        console.log('[SETTINGS] settings.json not found, creating default settings.');
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(defaultSettings, null, 2));
        return defaultSettings;
    }
    try {
        let settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));

        // --- SETTINGS MIGRATION LOGIC ---
        // This is the correct place to handle/validate newly added settings during startup.
        // Otherwise users will potentially have errors when migrating to new viniplay
        // versions that expect new settings.
        let needsSave = false;

        defaultSettings.streamProfiles.forEach(defaultProfile => {
            const existingProfile = settings.streamProfiles.find(p => p.id === defaultProfile.id);
            if (!existingProfile) {
                console.log(`[SETTINGS_MIGRATE] Adding missing stream profile: ${defaultProfile.name}`);
                settings.streamProfiles.push(defaultProfile);
                needsSave = true;
            } else if (existingProfile.isDefault) {
                // FINAL FIX: Forcibly update the command of default profiles to ensure users get the latest fixes.
                if (existingProfile.command !== defaultProfile.command) {
                    console.log(`[SETTINGS_MIGRATE] Updating outdated default stream profile command for: ${defaultProfile.name}`);
                    existingProfile.command = defaultProfile.command;
                    needsSave = true;
                }
            }
        });

        if (!settings.dvr) {
            console.log(`[SETTINGS_MIGRATE] Initializing DVR settings block.`);
            settings.dvr = defaultSettings.dvr;
            needsSave = true;
        } else {
            defaultSettings.dvr.recordingProfiles.forEach(defaultProfile => {
                const existingProfile = settings.dvr.recordingProfiles.find(p => p.id === defaultProfile.id);
                if (!existingProfile) {
                    console.log(`[SETTINGS_MIGRATE] Adding missing DVR recording profile: ${defaultProfile.name}`);
                    settings.dvr.recordingProfiles.push(defaultProfile);
                    needsSave = true;
                } else if (existingProfile.isDefault) {
                    // FINAL FIX: Forcibly update the command of default DVR profiles.
                    if (existingProfile.command !== defaultProfile.command) {
                        console.log(`[SETTINGS_MIGRATE] Updating outdated default DVR profile command for: ${defaultProfile.name}`);
                        existingProfile.command = defaultProfile.command;
                        needsSave = true;
                    }
                }
            });
        }

        // Cast profiles migration
        if (!settings.castProfiles) {
            console.log(`[SETTINGS_MIGRATE] Initializing Cast profiles block.`);
            settings.castProfiles = defaultSettings.castProfiles;
            needsSave = true;
        } else {
            defaultSettings.castProfiles.forEach(defaultProfile => {
                const existingProfile = settings.castProfiles.find(p => p.id === defaultProfile.id);
                if (!existingProfile) {
                    console.log(`[SETTINGS_MIGRATE] Adding missing Cast profile: ${defaultProfile.name}`);
                    settings.castProfiles.push(defaultProfile);
                    needsSave = true;
                } else if (existingProfile.isDefault) {
                    // Update default cast profile commands
                    if (existingProfile.command !== defaultProfile.command) {
                        console.log(`[SETTINGS_MIGRATE] Updating outdated default Cast profile command for: ${defaultProfile.name}`);
                        existingProfile.command = defaultProfile.command;
                        needsSave = true;
                    }
                }
            });
        }

        if (!settings.activeCastProfileId) {
            console.log(`[SETTINGS_MIGRATE] Initializing missing activeCastProfileId to ${defaultSettings.activeCastProfileId}.`);
            settings.activeCastProfileId = defaultSettings.activeCastProfileId;
            needsSave = true;
        }

        if (!settings.playerLogLevel) {
            // There is no playerLogLevel setting.  Add it with default setting.
            console.log(`[SETTINGS_MIGRATE] Initializing missing player Log Level setting to ${defaultSettings.playerLogLevel}.`);
            settings.playerLogLevel = defaultSettings.playerLogLevel;
            needsSave = true;
        } else if (!validFFmpegLogLevels.includes(settings.playerLogLevel)) {
            // There is a playerLogLevel setting but the value is not recognized.  Set to default.
            console.log(`[SETTINGS_MIGRATE_ERROR] player Log Level setting: ${settings.playerLogLevel} is invalid, set to default: ${defaultSettings.playerLogLevel}.`);
            settings.playerLogLevel = defaultSettings.playerLogLevel;
            needsSave = true;
        }

        if (!settings.dvrLogLevel) {
            // There is no dvrLogLevel setting.  Add it with default setting.
            console.log(`[SETTINGS_MIGRATE] Initializing missing dvr Log Level setting to ${defaultSettings.dvrLogLevel}.`);
            settings.dvrLogLevel = defaultSettings.dvrLogLevel;
            needsSave = true;
        } else if (!validFFmpegLogLevels.includes(settings.dvrLogLevel)) {
            // There is a dvrLogLevel setting but the value is not recognized.  Set to default.
            console.log(`[SETTINGS_MIGRATE_ERROR] dvr Log Level setting: ${settings.dvrLogLevel} is invalid, set to default: ${defaultSettings.dvrLogLevel}.`);
            settings.dvrLogLevel = defaultSettings.dvrLogLevel;
            needsSave = true;
        }

        // NEW: Logs settings migration
        if (!settings.logs) {
            console.log(`[SETTINGS_MIGRATE] Initializing missing logs settings block.`);
            settings.logs = defaultSettings.logs;
            needsSave = true;
        } else {
            // Ensure all log sub-settings exist
            if (settings.logs.maxFiles === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.maxFiles setting.`);
                settings.logs.maxFiles = defaultSettings.logs.maxFiles;
                needsSave = true;
            }
            if (settings.logs.maxFileSizeBytes === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.maxFileSizeBytes setting.`);
                settings.logs.maxFileSizeBytes = defaultSettings.logs.maxFileSizeBytes;
                needsSave = true;
            }
            if (settings.logs.autoDeleteDays === undefined) {
                console.log(`[SETTINGS_MIGRATE] Adding missing logs.autoDeleteDays setting.`);
                settings.logs.autoDeleteDays = defaultSettings.logs.autoDeleteDays;
                needsSave = true;
            }
        }

        // Check that all expected settings are present and set and if not,
        // generate log to highlight missing setting(s) migration code. 
        if (!settings || typeof settings !== 'object') {
            console.log('[SETTINGS_MIGRATE_ERROR] Settings are not valid.');
        } else {
            let allSettingsValid = true;
            for (const key of Object.keys(defaultSettings)) {
                if (!(key in settings) || settings[key] === undefined) {
                    console.log(`[SETTINGS_MIGRATE_ERROR] Expected setting ${key} is missing. server.js:getSettings() needs updating.`);
                    allSettingsValid = false;
                }
            }
            if (allSettingsValid) {
                console.log('[SETTINGS_MIGRATE] Settings are all valid.');
                if (needsSave) {
                    console.log('[SETTINGS_MIGRATE] Saving updated settings file after migration.');
                    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
                }
            } else {
                console.log('[SETTINGS_MIGRATE_ERROR] Settings are not all valid.');
            }
        }

        return settings;

    } catch (e) {
        console.error("[SETTINGS] Could not parse settings.json, returning default. Error:", e.message);
        return defaultSettings;
    }
}

// --- LOG ROTATION SYSTEM ---
let currentLogStream = null;
let currentLogFilePath = null;
let currentLogSize = 0;
let cachedLogSettings = {
    maxFiles: 5,
    maxFileSizeBytes: 5 * 1024 * 1024,
    autoDeleteDays: 7
};

/**
 * Updates the cached log settings. Call this after settings are changed.
 */
function refreshLogSettings() {
    try {
        const settings = getSettings();
        if (settings.logs) {
            cachedLogSettings = settings.logs;
        }
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Gets the current active log file path.
 * @returns {string} Path to the current log file.
 */
function getCurrentLogFilePath() {
    if (!currentLogFilePath) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentLogFilePath = path.join(LOGS_DIR, `viniplay-${timestamp}.log`);
    }
    return currentLogFilePath;
}

/**
 * Rotates the log file when size limit is reached.
 */
function rotateLogFile() {
    try {
        if (currentLogStream) {
            currentLogStream.end();
            currentLogStream = null;
        }

        // Create new log file
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        currentLogFilePath = path.join(LOGS_DIR, `viniplay-${timestamp}.log`);
        currentLogSize = 0;

        // Use original console.log to avoid recursion
        const originalLog = console.log.__original || console.log;
        originalLog.call(console, `[LOG_ROTATE] Created new log file: ${path.basename(currentLogFilePath)}`);

        // Clean up old log files based on maxFiles setting
        cleanupOldLogsByCount();
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Cleans up old log files based on the maxFiles setting.
 */
function cleanupOldLogsByCount() {
    try {
        const maxFiles = cachedLogSettings.maxFiles || 5;

        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'))
            .map(file => ({
                name: file,
                path: path.join(LOGS_DIR, file),
                mtime: fs.statSync(path.join(LOGS_DIR, file)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime); // Sort by newest first

        // Delete files beyond maxFiles limit
        if (logFiles.length > maxFiles) {
            const filesToDelete = logFiles.slice(maxFiles);
            filesToDelete.forEach(file => {
                try {
                    fs.unlinkSync(file.path);
                    const originalLog = console.log.__original || console.log;
                    originalLog.call(console, `[LOG_CLEANUP] Deleted old log file: ${file.name}`);
                } catch (err) {
                    // Silently fail
                }
            });
        }
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Cleans up log files older than the configured autoDeleteDays.
 */
function cleanupOldLogsByAge() {
    try {
        const autoDeleteDays = cachedLogSettings.autoDeleteDays || 0;

        if (autoDeleteDays === 0) {
            return; // Auto-delete disabled
        }

        const cutoffTime = Date.now() - (autoDeleteDays * 24 * 60 * 60 * 1000);

        const logFiles = fs.readdirSync(LOGS_DIR)
            .filter(file => file.startsWith('viniplay-') && file.endsWith('.log'));

        logFiles.forEach(file => {
            const filePath = path.join(LOGS_DIR, file);
            const stats = fs.statSync(filePath);

            if (stats.mtime.getTime() < cutoffTime) {
                try {
                    fs.unlinkSync(filePath);
                    const originalLog = console.log.__original || console.log;
                    originalLog.call(console, `[LOG_CLEANUP] Deleted old log file (age): ${file}`);
                } catch (err) {
                    // Silently fail
                }
            }
        });
    } catch (error) {
        // Silently fail to avoid recursion
    }
}

/**
 * Writes a log message to the current log file.
 * @param {string} message - The log message to write.
 */
function writeToLogFile(message) {
    try {
        const maxSize = cachedLogSettings.maxFileSizeBytes || (5 * 1024 * 1024);

        // Check if we need to rotate
        if (currentLogSize >= maxSize) {
            rotateLogFile();
        }

        // Create stream if it doesn't exist
        if (!currentLogStream) {
            const logPath = getCurrentLogFilePath();
            currentLogStream = fs.createWriteStream(logPath, { flags: 'a' });

            // Get current file size if file exists
            if (fs.existsSync(logPath)) {
                currentLogSize = fs.statSync(logPath).size;
            }
        }

        const logLine = `${message}\n`;
        currentLogStream.write(logLine);
        currentLogSize += Buffer.byteLength(logLine);

    } catch (error) {
        // Silently fail to avoid infinite loop
    }
}

/**
 * Initializes the log system by overriding console methods.
 */
function initializeLogSystem() {
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;

    // Store original functions for internal use
    console.log.__original = originalLog;
    console.error.__original = originalError;
    console.warn.__original = originalWarn;

    console.log = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalLog.apply(console, args);
        writeToLogFile(`[LOG] ${new Date().toISOString()} ${message}`);
    };

    console.error = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalError.apply(console, args);
        writeToLogFile(`[ERROR] ${new Date().toISOString()} ${message}`);
    };

    console.warn = function (...args) {
        const message = args.map(arg =>
            typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');
        originalWarn.apply(console, args);
        writeToLogFile(`[WARN] ${new Date().toISOString()} ${message}`);
    };

    // Refresh settings cache initially
    refreshLogSettings();

    // Run age-based cleanup on startup and then every 24 hours
    cleanupOldLogsByAge();
    setInterval(cleanupOldLogsByAge, 24 * 60 * 60 * 1000);

    console.log('[LOG_SYSTEM] Log rotation system initialized.');
}

// Initialize the log system
initializeLogSystem();

/**
 * Initiates the VOD refresh process for a given XC provider.
 * @param {object} provider - The M3U source object (must be type 'xc').
 * @param {sqlite3.Database} dbInstance - The active database connection.
 * @param {function} sendStatus - Function to send status updates.
 */
async function triggerVodRefreshForProvider(provider, dbInstance, sendStatus = () => { }) {
    if (!provider || provider.type !== 'xc' || !provider.xc_data) {
        console.error(`[VOD Trigger] Invalid provider object passed for VOD refresh. ID: ${provider?.id}`);
        return;
    }

    console.log(`[VOD Trigger] Starting VOD refresh for provider: ${provider.name} (ID: ${provider.id})`);
    sendStatus(`Triggering VOD refresh for ${provider.name}...`, 'info');

    try {
        const settings = getSettings();
        const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
        // Call the main processing function from vodProcessor.js
        await refreshVodContent(dbInstance, dbGet, dbAll, dbRun, provider, sendStatus, activeUserAgent);

        console.log(`[VOD Trigger] Successfully finished VOD refresh for provider: ${provider.name}`);

    } catch (error) {
        console.error(`[VOD Trigger] Error during VOD refresh for ${provider.name}: ${error.message}`);
        sendStatus(`VOD refresh FAILED for ${provider.name}: ${error.message}`, 'error');
    }
}


// ... existing helper functions (fetchUrlContent, parseEpgTime, processAndMergeSources) remain the same ...

function fetchUrlContent(url, options = {}, asBuffer = false) { // <-- MODIFIED
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        const TIMEOUT_DURATION = 60000;
        console.log(`[FETCH] Attempting to fetch URL content: ${url} (Timeout: ${TIMEOUT_DURATION / 1000}s)`);

        const request = protocol.get(url, { timeout: TIMEOUT_DURATION, ...options }, (res) => { // <-- MODIFIED
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                console.log(`[FETCH] Redirecting to: ${res.headers.location}`);
                request.abort();
                // Pass the asBuffer flag through redirects
                return fetchUrlContent(new URL(res.headers.location, url).href, options, asBuffer).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                console.error(`[FETCH] Failed to fetch ${url}: Status Code ${res.statusCode}`);
                return reject(new Error(`Failed to fetch: Status Code ${res.statusCode}`));
            }

            if (asBuffer) {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    console.log(`[FETCH] Successfully fetched content as buffer from: ${url}`);
                    resolve(Buffer.concat(chunks));
                });
            } else {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    console.log(`[FETCH] Successfully fetched content from: ${url}`);
                    resolve(data);
                });
            }
        });

        request.on('timeout', () => {
            request.destroy();
            const timeoutError = new Error(`Request to ${url} timed out after ${TIMEOUT_DURATION / 1000} seconds.`);
            console.error(`[FETCH] ${timeoutError.message}`);
            reject(timeoutError);
        });

        request.on('error', (err) => {
            console.error(`[FETCH] Network error fetching ${url}: ${err.message}`);
            reject(err);
        });
    });
}


// --- EPG Parsing and Caching Logic ---
const parseEpgTime = (timeStr, offsetHours = 0) => {
    const match = timeStr.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(([+-])(\d{2})(\d{2}))?/);
    if (!match) {
        console.warn(`[EPG_PARSE] Invalid time format encountered: ${timeStr}`);
        return new Date();
    }

    const [, year, month, day, hours, minutes, seconds, , sign, tzHours, tzMinutes] = match;
    let date;
    if (sign && tzHours && tzMinutes) {
        const epgOffsetMinutes = (parseInt(tzHours) * 60 + parseInt(tzMinutes)) * (sign === '+' ? 1 : -1);
        date = new Date(Date.UTC(year, parseInt(month) - 1, day, hours, minutes, seconds));
        date.setUTCMinutes(date.getUTCMinutes() - epgOffsetMinutes);
    } else {
        date = new Date(Date.UTC(year, parseInt(month) - 1, day, hours, minutes, seconds));
        date.setUTCHours(date.getUTCHours() - offsetHours);
    }
    return date;
};

async function processAndMergeSources(req) {
    console.log('[PROCESS] Starting to process and merge all active sources.');
    sendProcessingStatus(req, 'Starting to process sources...', 'info');
    const settings = getSettings();

    // --- NEW: Data holders for separated content ---
    let mergedLiveM3uContent = '#EXTM3U\n';
    //let mergedVodMovies = [];
    //let mergedVodSeries = [];
    let liveChannelIdSet = new Set(); // To track which channels need EPG
    const groupTitleRegex = /group-title="([^"]*)"/;
    // ---

    const activeM3uSources = settings.m3uSources.filter(s => s.isActive);
    const activeEpgSources = settings.epgSources.filter(s => s.isActive);

    if (activeM3uSources.length === 0) {
        console.log('[PROCESS] No active M3U sources found.');
        sendProcessingStatus(req, 'No active M3U sources found.', 'info');
    }

    for (const source of activeM3uSources) {
        console.log(`[M3U] Processing source: "${source.name}" (ID: ${source.id}, Type: ${source.type}, Path: ${source.path})`);
        sendProcessingStatus(req, `Processing M3U source: "${source.name}"...`, 'info');

        // --- NEW: Group Filter Logic ---
        const selectedGroups = source.selectedGroups || [];
        const isGroupFilteringActive = selectedGroups.length > 0;
        if (isGroupFilteringActive) {
            sendProcessingStatus(req, ` -> Applying group filter. ${selectedGroups.length} groups selected.`, 'info');
        }
        // ---

        try {
            let content = '';
            let sourcePathForLog = source.path;
            let m3uFetchOptions = {}; // NEW: For XC User-Agent

            if (source.type === 'file') {
                const sourceFilePath = path.join(SOURCES_DIR, path.basename(source.path));
                if (fs.existsSync(sourceFilePath)) {
                    content = fs.readFileSync(sourceFilePath, 'utf-8');
                    sourcePathForLog = sourceFilePath;
                } else {
                    const errorMsg = `File not found for source "${source.name}". Skipping.`;
                    sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
                    source.status = 'Error';
                    source.statusMessage = 'File not found.';
                    continue;
                }
            } else if (source.type === 'url') {
                sendProcessingStatus(req, ` -> Fetching content from URL...`, 'info');
                content = await fetchUrlContent(source.path);
                // Save raw content to cache (URL) ---
                try {
                    // Define cache path (ensure it's unique per source)
                    const cacheFileName = `raw_${source.id}.m3u_cache`; // Use a distinct extension
                    const cacheFilePath = path.join(RAW_CACHE_DIR, cacheFileName);

                    // Write the fetched content to the cache file
                    fs.writeFileSync(cacheFilePath, content);
                    console.log(`[PROCESS_CACHE] Saved raw content for source "${source.name}" to ${cacheFilePath}`);

                    // Store the path in the source object (this will be saved later when settings are saved)
                    source.cachedRawPath = cacheFilePath;

                } catch (cacheWriteError) {
                    console.error(`[PROCESS_CACHE] Failed to write raw cache for source "${source.name}" (URL):`, cacheWriteError.message);
                    // Clear any potentially stale cache path if writing failed
                    delete source.cachedRawPath;
                }
                sendProcessingStatus(req, ` -> Successfully fetched M3U content.`, 'info');
            } else if (source.type === 'xc') {
                if (!source.xc_data) {
                    throw new Error("XC source is missing credential data (xc_data).");
                }
                const xcInfo = JSON.parse(source.xc_data);
                const { server, username, password } = xcInfo;

                if (!server || !username || !password) {
                    throw new Error("XC source is missing server, username, or password.");
                }

                const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
                m3uFetchOptions = { headers: { 'User-Agent': activeUserAgent } };

                // Fetch live streams from XC API
                const liveStreamsUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_streams`;
                try {
                    sendProcessingStatus(req, ` -> Fetching live categories from XC server...`, 'info');
                    const liveCategoriesUrl = `${server}/player_api.php?username=${username}&password=${password}&action=get_live_categories`;
                    console.log(`[M3U] Constructed XC Categories URL for "${source.name}": ${liveCategoriesUrl}`);
                    const liveCategoriesResponse = await fetchUrlContent(liveCategoriesUrl, m3uFetchOptions);
                    const liveCategories = JSON.parse(liveCategoriesResponse);

                    sendProcessingStatus(req, ` -> Fetching live streams from XC server...`, 'info');
                    console.log(`[M3U] Constructed XC Streams URL for "${source.name}": ${liveCategoriesUrl}`);
                    const liveStreamsResponse = await fetchUrlContent(liveStreamsUrl, m3uFetchOptions);
                    const liveStreams = JSON.parse(liveStreamsResponse);

                    // Filter and convert live streams to M3U format
                    let liveM3uContent = '';
                    let liveStreamCount = 0;

                    if (Array.isArray(liveStreams)) {
                        for (const stream of liveStreams) {
                            if (stream.stream_type === 'live') {
                                liveStreamCount++;
                                const streamUrl = `${server}/live/${username}/${password}/${stream.stream_id}.ts`;

                                // Find category name from categories array
                                const categoryName = Array.isArray(liveCategories)
                                    ? liveCategories.find(cat => cat.category_id == stream.category_id)?.category_name || 'Live'
                                    : 'Live';

                                // Use epg_channel_id if available, otherwise use stream_id
                                const tvgId = stream.epg_channel_id || stream.stream_id;

                                liveM3uContent += `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${stream.name}" tvg-logo="${stream.stream_icon || ''}" group-title="${categoryName}",${stream.name}\n`;
                                liveM3uContent += `${streamUrl}\n`;
                            }
                        }
                    }

                    if (liveStreamCount > 0) {
                        content += '\n' + liveM3uContent;
                        sendProcessingStatus(req, ` -> Added ${liveStreamCount} live streams to content.`, 'info');
                    } else {
                        sendProcessingStatus(req, ` -> No live streams found with stream_type = 'live'.`, 'info');
                    }
                } catch (liveError) {
                    console.error(`[XC Live] Error fetching live streams for "${source.name}": ${liveError.message}`);
                    sendProcessingStatus(req, ` -> Warning: Could not fetch live streams: ${liveError.message}`, 'warning');
                }

                // Save raw content to cache (XC) ---
                try {
                    // Define cache path (ensure it's unique per source)
                    const cacheFileName = `raw_${source.id}.m3u_cache`; // Use a distinct extension
                    const cacheFilePath = path.join(RAW_CACHE_DIR, cacheFileName);

                    // Write the fetched content to the cache file
                    fs.writeFileSync(cacheFilePath, content);
                    console.log(`[PROCESS_CACHE] Saved raw content for source "${source.name}" to ${cacheFilePath}`);

                    // Store the path in the source object (this will be saved later when settings are saved)
                    source.cachedRawPath = cacheFilePath;

                } catch (cacheWriteError) {
                    console.error(`[PROCESS_CACHE] Failed to write raw cache for source "${source.name}" (XC):`, cacheWriteError.message);
                    // Clear any potentially stale cache path if writing failed
                    delete source.cachedRawPath;
                }

                sourcePathForLog = liveStreamsUrl;
                sendProcessingStatus(req, ` -> Successfully fetched M3U content from XC server.`, 'info');
            }

            // --- NEW: Trigger VOD Refresh for all non-XC Sources ---
            if (source.type === 'file' || source.type === 'url') {
                console.log(`[PROCESS] Source "${source.name}" is a non-XC M3U. Triggering VOD processing.`);
                sendProcessingStatus(req, ` -> Triggering VOD content processing for M3U source "${source.name}"...`, 'info');
                await processM3uVod(db, dbGet, dbAll, dbRun, content, source, (msg, type) => sendProcessingStatus(req, msg, type));
            }
            // --- END VOD Trigger ---

            const lines = content.split('\n');
            let currentExtInf = '';
            let liveStreamCount = 0;
            let movieCount = 0;
            let seriesCount = 0;

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                if (line.startsWith('#EXTINF:')) {
                    currentExtInf = line;
                    continue;
                }

                if (line.startsWith('http') && currentExtInf) {
                    const streamUrl = line;



                    // --- GROUP FILTER LOGIC ---
                    const groupMatch = currentExtInf.match(groupTitleRegex);
                    const groupTitle = (groupMatch && groupMatch[1]) ? groupMatch[1] : 'Uncategorized';
                    if (isGroupFilteringActive && !selectedGroups.includes(groupTitle)) {
                        currentExtInf = ''; // Reset for next entry
                        continue; // Skip this entry - not in selected groups
                    }
                    // --- END GROUP FILTER ---

                    // --- LIVE CHANNEL PROCESSING (Only Live Channels here now) ---
                    liveStreamCount++;
                    let processedExtInf = currentExtInf;
                    const idMatch = currentExtInf.match(/tvg-id="([^"]*)"/); // Still needed for unique ID
                    const nameMatch = line.match(/tvg-name="([^"]*)"/); // Get name if available
                    const commaIndex = currentExtInf.lastIndexOf(',');
                    const name = nameMatch ? nameMatch[1] : ((commaIndex !== -1) ? currentExtInf.substring(commaIndex + 1).trim() : 'Unknown');

                    // Consistent Unique Channel ID Generation
                    const originalTvgId = idMatch ? idMatch[1] : `no-tvg-id-${name.replace(/[^a-zA-Z0-9]/g, '')}`;
                    const finalUniqueChannelId = `${source.id}_${originalTvgId}`;

                    // Inject the *corrected* unique ID into the #EXTINF line
                    if (idMatch) {
                        processedExtInf = processedExtInf.replace(/tvg-id="[^"]*"/, `tvg-id="${finalUniqueChannelId}"`);
                    } else {
                        const extinfEnd = processedExtInf.indexOf(':') + 1;
                        processedExtInf = processedExtInf.slice(0, extinfEnd) + ` tvg-id="${finalUniqueChannelId}"` + processedExtInf.slice(extinfEnd);
                    }

                    // Inject source name
                    const tvgIdAttrEnd = processedExtInf.indexOf(`tvg-id="${finalUniqueChannelId}"`) + `tvg-id="${finalUniqueChannelId}"`.length;
                    processedExtInf = processedExtInf.slice(0, tvgIdAttrEnd) + ` vini-source="${source.name}"` + processedExtInf.slice(tvgIdAttrEnd);

                    mergedLiveM3uContent += processedExtInf + '\n' + streamUrl + '\n';
                    liveChannelIdSet.add(finalUniqueChannelId);
                    // --- END LIVE CHANNEL PROCESSING ---

                    currentExtInf = ''; // Reset for next entry
                }
            }

            source.status = 'Success';
            source.statusMessage = `Processed ${liveStreamCount} Live channels.`;
            console.log(`[M3U] Source "${source.name}" processed successfully from ${sourcePathForLog}.`);
            sendProcessingStatus(req, ` -> Processed ${liveStreamCount} Live channels from "${source.name}".`, 'info');

            // --- NEW: Trigger VOD Refresh for XC Sources ---
            if (source.type === 'xc') {
                console.log(`[PROCESS] Source "${source.name}" is XC. Triggering VOD refresh.`);
                sendProcessingStatus(req, ` -> Triggering VOD content refresh for XC source "${source.name}"...`, 'info');
                // Use setImmediate to run the VOD refresh *after* the current M3U processing finishes
                // Pass the source object and the global db instance
                await triggerVodRefreshForProvider(source, db, (msg, type) => sendProcessingStatus(req, msg, type));
            }
            // --- END VOD Trigger ---

        } catch (error) {
            const errorMsg = `Failed to process source "${source.name}" from ${source.path}: ${error.message}`;
            console.error(`[M3U] ${errorMsg}`);
            sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
            source.status = 'Error';
            source.statusMessage = `Processing failed: ${error.message.substring(0, 100)}...`;
        }
        source.lastUpdated = new Date().toISOString();
    }

    // --- Save the new separated files ---
    try { // Try block for saving LIVE M3U
        fs.writeFileSync(LIVE_CHANNELS_M3U_PATH, mergedLiveM3uContent);
        console.log(`[M3U] Merged LIVE CHANNELS content saved to ${LIVE_CHANNELS_M3U_PATH}.`);
        sendProcessingStatus(req, `Successfully merged all live channels.`, 'success');
    } catch (writeErr) { // Catch block for saving LIVE M3U
        console.error(`[PROCESS] Error writing LIVE M3U file: ${writeErr.message}`);
        sendProcessingStatus(req, `Error writing live channels file: ${writeErr.message}`, 'error');
    }

    // --- EPG Processing (now filtered) ---
    const mergedProgramData = {};
    const timezoneOffset = settings.timezoneOffset || 0;

    if (activeEpgSources.length === 0) {
        console.log('[PROCESS] No active EPG sources found.');
        sendProcessingStatus(req, 'No active EPG sources found.', 'info');
    }

    for (const source of activeEpgSources) {
        console.log(`[EPG] Processing source: "${source.name}" (ID: ${source.id}, Type: ${source.type}, Path: ${source.path})`);
        sendProcessingStatus(req, `Processing EPG source: "${source.name}"...`, 'info');
        try {
            let xmlString = '';
            let epgFilePath = path.join(SOURCES_DIR, `epg_${source.id}.xml`);

            if (source.type === 'file') {
                if (fs.existsSync(source.path)) {
                    xmlString = fs.readFileSync(source.path, 'utf-8');
                } else {
                    const errorMsg = `File not found for source "${source.name}". Skipping.`;
                    sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
                    source.status = 'Error';
                    source.statusMessage = 'File not found.';
                    continue;
                }
            } else if (source.type === 'url') {
                sendProcessingStatus(req, ` -> Fetching content from URL...`, 'info');

                // Use a different function to fetch raw buffer for compressed files
                if (source.path.endsWith('.gz')) {
                    const buffer = await fetchUrlContent(source.path, source.fetchOptions || {}, true); // Fetch as buffer
                    xmlString = zlib.gunzipSync(buffer).toString('utf-8');
                    sendProcessingStatus(req, ` -> Successfully fetched and decompressed EPG content.`, 'info');
                } else {
                    xmlString = await fetchUrlContent(source.path, source.fetchOptions || {});
                    sendProcessingStatus(req, ` -> Successfully fetched EPG content.`, 'info');
                }

                try {
                    fs.writeFileSync(epgFilePath, xmlString);
                    console.log(`[EPG] Downloaded EPG for "${source.name}" saved to ${epgFilePath}.`);
                } catch (writeErr) {
                    console.error(`[EPG] Error saving EPG file from URL for "${source.name}": ${writeErr.message}`);
                }
            }

            const epgJson = xmlJS.xml2js(xmlString, { compact: true });
            const programs = epgJson.tv && epgJson.tv.programme ? [].concat(epgJson.tv.programme) : [];
            let programCount = 0;
            let epgAddedCount = 0; // NEW: Count only added programs

            if (programs.length === 0) {
                sendProcessingStatus(req, `Warning: No programs found in "${source.name}".`, 'info');
            }

            const m3uSourceProviders = settings.m3uSources.filter(m3u => m3u.isActive);

            for (const prog of programs) {
                const originalChannelId = prog._attributes?.channel;
                if (!originalChannelId) continue;
                programCount++;

                for (const m3uSource of m3uSourceProviders) {
                    const uniqueChannelId = `${m3uSource.id}_${originalChannelId}`;

                    // --- NEW: EPG FILTERING ---
                    // Only add EPG data if the channel is in our live channel list
                    if (!liveChannelIdSet.has(uniqueChannelId)) {
                        continue;
                    }
                    // ---

                    if (!mergedProgramData[uniqueChannelId]) {
                        mergedProgramData[uniqueChannelId] = [];
                    }

                    epgAddedCount++; // Increment count of *added* programs

                    const titleNode = prog.title && prog.title._cdata ? prog.title._cdata : (prog.title?._text || 'No Title');
                    const descNode = prog.desc && prog.desc._cdata ? prog.desc._cdata : (prog.desc?._text || '');

                    mergedProgramData[uniqueChannelId].push({
                        start: parseEpgTime(prog._attributes.start, timezoneOffset).toISOString(),
                        stop: parseEpgTime(prog._attributes.stop, timezoneOffset).toISOString(),
                        title: titleNode.trim(),
                        desc: descNode.trim()
                    });
                }
            }
            if (!source.isXcEpg) {
                source.status = 'Success';
                source.statusMessage = `Processed ${programCount} programs, added ${epgAddedCount} to live guide.`;
                console.log(`[EPG] Source "${source.name}" processed successfully from ${source.path}.`);
            }
            sendProcessingStatus(req, ` -> Processed ${programCount} programs, added ${epgAddedCount} to live guide from "${source.name}".`, 'info');

        } catch (error) {
            const errorMsg = `Failed to process source "${source.name}" from ${source.path}: ${error.message}`;
            console.error(`[EPG] ${errorMsg}`);
            sendProcessingStatus(req, `Error: ${errorMsg}`, 'error');
            if (!source.isXcEpg) {
                source.status = 'Error';
                source.statusMessage = `Processing failed: ${error.message.substring(0, 100)}...`;
            }
        }
        if (!source.isXcEpg) {
            source.lastUpdated = new Date().toISOString();
        }
    }
    for (const channelId in mergedProgramData) {
        mergedProgramData[channelId].sort((a, b) => new Date(a.start) - new Date(b.start));
    }
    try { // Try block for saving EPG JSON
        fs.writeFileSync(LIVE_EPG_JSON_PATH, JSON.stringify(mergedProgramData));
        console.log(`[EPG] Merged EPG JSON content saved to ${LIVE_EPG_JSON_PATH}.`);
        sendProcessingStatus(req, `Successfully merged all EPG data for live channels.`, 'success');
    } catch (writeErr) { // Catch block for saving EPG JSON
        console.error(`[EPG] Error writing merged EPG JSON file: ${writeErr.message}`);
        sendProcessingStatus(req, `Error writing merged EPG JSON file: ${writeErr.message}`, 'error');
    }

    settings.sourcesLastUpdated = new Date().toISOString();
    console.log(`[PROCESS] Finished processing. New 'sourcesLastUpdated' timestamp: ${settings.sourcesLastUpdated}`);
    sendProcessingStatus(req, 'All sources processed successfully!', 'final_success');

    return { success: true, message: 'Sources merged successfully.', updatedSettings: settings };
}

// ... existing helper functions ...

// --- Authentication API Endpoints ---
app.get('/api/auth/needs-setup', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/needs-setup');
    db.get("SELECT COUNT(*) as count FROM users WHERE isAdmin = 1", [], (err, row) => {
        if (err) {
            console.error('[AUTH_API] Error checking admin user count:', err.message);
            return res.status(500).json({ error: err.message });
        }
        const needsSetup = row.count === 0;
        console.log(`[AUTH_API] Admin user count: ${row.count}. Needs setup: ${needsSetup}`);
        res.json({ needsSetup });
    });
});

app.post('/api/auth/setup-admin', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/setup-admin');
    db.get("SELECT COUNT(*) as count FROM users", [], (err, row) => {
        if (err) {
            console.error('[AUTH_API] Error checking user count during admin setup:', err.message);
            return res.status(500).json({ error: err.message });
        }
        if (row.count > 0) {
            console.warn('[AUTH_API] Setup attempted but users already exist. Denying setup.');
            return res.status(403).json({ error: "Setup has already been completed." });
        }

        const { username, password } = req.body;
        if (!username || !password) {
            console.warn('[AUTH_API] Admin setup failed: Username and/or password missing.');
            return res.status(400).json({ error: "Username and password are required." });
        }

        bcrypt.hash(password, saltRounds, (err, hash) => {
            if (err) {
                console.error('[AUTH_API] Error hashing password during admin setup:', err);
                return res.status(500).json({ error: 'Error hashing password.' });
            }
            db.run("INSERT INTO users (username, password, isAdmin, canUseDvr) VALUES (?, ?, 1, 1)", [username, hash], function (err) {
                if (err) {
                    console.error('[AUTH_API] Error inserting admin user:', err.message);
                    return res.status(500).json({ error: err.message });
                }
                req.session.userId = this.lastID;
                req.session.username = username;
                req.session.isAdmin = true;
                req.session.canUseDvr = true;
                console.log(`[AUTH_API] Admin user "${username}" created successfully (ID: ${this.lastID}). Session set.`);
                res.json({ success: true, user: { id: this.lastID, username: req.session.username, isAdmin: req.session.isAdmin, canUseDvr: req.session.canUseDvr } });
            });
        });
    });
});

app.post('/api/auth/login', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/login');
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, user) => {
        if (err) {
            console.error('[AUTH_API] Error querying user during login:', err.message);
            return res.status(500).json({ error: err.message });
        }
        if (!user) {
            console.warn(`[AUTH_API] Login failed for username "${username}": User not found.`);
            return res.status(401).json({ error: "Invalid username or password." });
        }

        bcrypt.compare(password, user.password, (err, result) => {
            if (err) {
                console.error('[AUTH_API] Error comparing password hash:', err);
                return res.status(500).json({ error: 'Authentication error.' });
            }
            if (result) {
                req.session.userId = user.id;
                req.session.username = user.username;
                req.session.isAdmin = user.isAdmin === 1;
                req.session.canUseDvr = user.canUseDvr === 1;
                console.log(`[AUTH_API] User "${username}" (ID: ${user.id}) logged in successfully. Session set.`);
                res.json({
                    success: true,
                    user: { id: user.id, username: user.username, isAdmin: user.isAdmin === 1, canUseDvr: user.canUseDvr === 1 }
                });
            } else {
                console.warn(`[AUTH_API] Login failed for username "${username}": Incorrect password.`);
                res.status(401).json({ error: "Invalid username or password." });
            }
        });
    });
});

app.post('/api/auth/logout', (req, res) => {
    console.log('[AUTH_API] Received request for /api/auth/logout');
    const username = req.session.username || 'unknown';
    req.session.destroy(err => {
        if (err) {
            console.error(`[AUTH_API] Error destroying session for user ${username}:`, err);
            return res.status(500).json({ error: 'Could not log out.' });
        }
        res.clearCookie('connect.sid');
        console.log(`[AUTH_API] User ${username} logged out. Session destroyed.`);
        res.json({ success: true });
    });
});

// --- NEW/OPTIMIZED ENDPOINT FOR GROUP FILTERING (with Caching & Refresh) ---
app.post('/api/sources/fetch-groups', requireAuth, async (req, res) => {
    // --- ADDITION: Get refresh flag from query or body ---
    const forceRefresh = req.query.refresh === 'true' || req.body.refresh === true;
    const { type, url, xc, sourceId } = req.body; // Added sourceId
    // --- END ADDITION ---

    let fetchUrl;
    let fetchOptions = {};
    let content = '';
    let usedCache = false; // Flag to track if cache was used

    console.log(`[API_GROUPS] Fetching groups for type: ${type}, SourceID: ${sourceId}, Refresh: ${forceRefresh}`);

    try {
        let sourceToUse = null;
        if (sourceId) {
            const settings = getSettings();
            // Try finding in M3U sources first, then EPG (though unlikely for M3U groups)
            sourceToUse = settings.m3uSources.find(s => s.id === sourceId) || settings.epgSources.find(s => s.id === sourceId);
        }

        // --- START CACHE CHECK ---
        if (!forceRefresh && sourceToUse && sourceToUse.cachedRawPath && fs.existsSync(sourceToUse.cachedRawPath)) {
            try {
                console.log(`[API_GROUPS] Using cached raw file: ${sourceToUse.cachedRawPath}`);
                content = fs.readFileSync(sourceToUse.cachedRawPath, 'utf-8');
                usedCache = true;
            } catch (cacheReadError) {
                console.warn(`[API_GROUPS] Failed to read cache file ${sourceToUse.cachedRawPath}. Will fetch fresh. Error:`, cacheReadError.message);
                usedCache = false; // Ensure we fetch fresh if cache read fails
            }
        }
        // --- END CACHE CHECK ---

        // --- Fetch if cache wasn't used or refresh was forced ---
        if (type === 'xc' && xc) {
            const xcInfo = JSON.parse(xc);
            if (!xcInfo.server || !xcInfo.username || !xcInfo.password) {
                return res.status(400).json({ error: 'XC source requires server, username, and password.' });
            }
            console.log('[API_GROUPS] Source is XC type. Using XtreamClient to fetch all categories.');
            const settings = getSettings();
            const activeUserAgent = settings.userAgents.find(ua => ua.id === settings.activeUserAgentId)?.value || 'VLC/3.0.20 (Linux; x86_64)';
            const client = new XtreamClient(xcInfo.server, xcInfo.username, xcInfo.password, activeUserAgent);
            const allCategories = await client.getAllCategories();
            return res.json({ success: true, groups: allCategories, usedCache: false });
        }

        if (!usedCache) {
            console.log(`[API_GROUPS] ${forceRefresh ? 'Refresh forced' : 'Cache not used/found'}. Fetching from original source.`);
            if (type === 'url' && url) {
                fetchUrl = url;
                content = await fetchUrlContent(fetchUrl, fetchOptions);
            } else if (type === 'file' && url) { // Assuming url holds file path for type file
                const filePath = sourceToUse?.path || path.join(SOURCES_DIR, path.basename(url)); // Prefer path from settings if available
                if (fs.existsSync(filePath)) {
                    content = fs.readFileSync(filePath, 'utf-8');
                } else {
                    return res.status(400).json({ error: 'File source path not found or invalid.' });
                }
            } else {
                return res.status(400).json({ error: 'Valid source details (URL, XC, or File path) are required.' });
            }
        }
        // --- End Fetch Logic ---


        // --- Efficiently Extract Groups (Handles JSON for XC and Regex for M3U) ---
        const groups = new Set();
        try {
            // First, try to parse as JSON (for XC sources which return a JSON array of categories)
            const groupJsonArray = JSON.parse(content);
            console.log(`[API_GROUPS] Successfully parsed content as JSON. Scanning for group titles.`);
            if (Array.isArray(groupJsonArray)) {
                for (const category of groupJsonArray) {
                    if (category && typeof category.category_name === 'string') {
                        const groupName = category.category_name.trim();
                        if (groupName) groups.add(groupName);
                    }
                }
            }
        } catch (jsonError) {
            // If JSON parsing fails, assume it's a plain M3U file and use regex
            console.log(`[API_GROUPS] Content is not valid JSON, attempting to parse as plain M3U.`);
            const groupTitleRegex = /group-title=\"([^\"]+)\"/g;
            let match;
            while ((match = groupTitleRegex.exec(content)) !== null) {
                const groupName = match[1].trim();
                if (groupName) {
                    groups.add(groupName);
                }
            }
        }

        const sortedGroups = Array.from(groups).sort((a, b) => a.localeCompare(b));
        console.log(`[API_GROUPS] Found ${sortedGroups.length} unique groups.`);
        res.json({ success: true, groups: sortedGroups, usedCache: usedCache }); // Optionally tell frontend if cache was used

    } catch (error) {
        console.error(`[API_GROUPS] Failed to fetch or parse M3U for groups: ${error.message}`);
        res.status(500).json({ error: `Failed to fetch or process groups: ${error.message}` });
    }
});

app.get('/api/auth/status', (req, res) => {
    console.log(`[AUTH_API] GET /api/auth/status - Checking session ID: ${req.sessionID}`);
    if (req.session && req.session.userId) {
        console.log(`[AUTH_API_STATUS] Valid session found for user "${req.session.username}" (ID: ${req.session.userId}). Responding with isLoggedIn: true.`);
        res.json({ isLoggedIn: true, user: { id: req.session.userId, username: req.session.username, isAdmin: req.session.isAdmin, canUseDvr: req.session.canUseDvr } });
    } else {
        console.log('[AUTH_API_STATUS] No valid session found. Responding with isLoggedIn: false.');
        res.json({ isLoggedIn: false });
    }
});
// ... existing User Management API Endpoints ...
app.get('/api/users', requireAdmin, (req, res) => {
    console.log('[USER_API] Fetching all users.');
    db.all("SELECT id, username, isAdmin, canUseDvr, allowed_sources FROM users ORDER BY username", [], (err, rows) => {
        if (err) {
            console.error('[USER_API] Error fetching users:', err.message);
            return res.status(500).json({ error: err.message });
        }
        console.log(`[USER_API] Found ${rows.length} users.`);
        res.json(rows);
    });
});

app.post('/api/users', requireAdmin, (req, res) => {
    console.log('[USER_API] Adding new user.');
    const { username, password, isAdmin, canUseDvr, allowed_sources } = req.body;
    if (!username || !password) {
        console.warn('[USER_API] Add user failed: Username and/or password missing.');
        return res.status(400).json({ error: "Username and password are required." });
    }

    bcrypt.hash(password, saltRounds, (err, hash) => {
        if (err) {
            console.error('[USER_API] Error hashing password for new user:', err);
            return res.status(500).json({ error: 'Error hashing password' });
        }
        const allowedSourcesStr = allowed_sources ? JSON.stringify(allowed_sources) : null;
        db.run("INSERT INTO users (username, password, isAdmin, canUseDvr, allowed_sources) VALUES (?, ?, ?, ?, ?)", [username, hash, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, allowedSourcesStr], function (err) {
            if (err) {
                console.error('[USER_API] Error inserting new user:', err.message);
                return res.status(400).json({ error: "Username already exists." });
            }
            console.log(`[USER_API] User "${username}" added successfully (ID: ${this.lastID}).`);
            res.json({ success: true, id: this.lastID });
        });
    });
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
    const { id } = req.params;
    const { username, password, isAdmin, canUseDvr, allowed_sources } = req.body;
    console.log(`[USER_API] Updating user ID: ${id}. Username: ${username}, IsAdmin: ${isAdmin}, CanUseDvr: ${canUseDvr}`);

    const allowedSourcesStr = allowed_sources ? JSON.stringify(allowed_sources) : null;

    const updateUser = () => {
        if (password) {
            bcrypt.hash(password, saltRounds, (err, hash) => {
                if (err) {
                    console.error('[USER_API] Error hashing password during user update:', err);
                    return res.status(500).json({ error: 'Error hashing password' });
                }
                db.run("UPDATE users SET username = ?, password = ?, isAdmin = ?, canUseDvr = ?, allowed_sources = ? WHERE id = ?", [username, hash, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, allowedSourcesStr, id], (err) => {
                    if (err) {
                        console.error(`[USER_API] Error updating user ${id} with new password:`, err.message);
                        return res.status(500).json({ error: err.message });
                    }
                    if (req.session.userId == id) {
                        req.session.username = username;
                        req.session.isAdmin = isAdmin;
                        req.session.canUseDvr = canUseDvr;
                        console.log(`[USER_API] Current user's session (ID: ${id}) updated.`);
                    }
                    console.log(`[USER_API] User ${id} updated successfully (with password change).`);
                    res.json({ success: true });
                });
            });
        } else {
            db.run("UPDATE users SET username = ?, isAdmin = ?, canUseDvr = ?, allowed_sources = ? WHERE id = ?", [username, isAdmin ? 1 : 0, canUseDvr ? 1 : 0, allowedSourcesStr, id], (err) => {
                if (err) {
                    console.error(`[USER_API] Error updating user ${id} without password change:`, err.message);
                    return res.status(500).json({ error: err.message });
                }
                if (req.session.userId == id) {
                    req.session.username = username;
                    req.session.isAdmin = isAdmin;
                    req.session.canUseDvr = canUseDvr;
                    console.log(`[USER_API] Current user's session (ID: ${id}) updated.`);
                }
                console.log(`[USER_API] User ${id} updated successfully (without password change).`);
                res.json({ success: true });
            });
        }
    };

    if (req.session.userId == id && !isAdmin) {
        console.log(`[USER_API] Attempting to demote current admin user ${id}. Checking if last admin.`);
        db.get("SELECT COUNT(*) as count FROM users WHERE isAdmin = 1", [], (err, row) => {
            if (err) {
                console.error('[USER_API] Error checking admin count for demotion:', err.message);
                return res.status(500).json({ error: err.message });
            }
            if (row.count <= 1) {
                console.warn(`[USER_API] Cannot demote user ${id}: They are the last administrator.`);
                return res.status(403).json({ error: "Cannot remove the last administrator." });
            }
            updateUser();
        });
    } else {
        updateUser();
    }
});

// MODIFIED: User deletion now terminates active streams and forces logout.
app.delete('/api/users/:id', requireAdmin, (req, res) => {
    const idToDelete = parseInt(req.params.id, 10);
    console.log(`[USER_API] Deleting user ID: ${idToDelete}`);
    if (req.session.userId == idToDelete) {
        console.warn(`[USER_API] Attempted to delete own account for user ${idToDelete}.`);
        return res.status(403).json({ error: "You cannot delete your own account." });
    }

    // --- NEW: Terminate active streams for the deleted user ---
    let streamsKilled = 0;
    for (const [streamKey, streamInfo] of activeStreamProcesses.entries()) {
        if (streamInfo.userId === idToDelete) {
            console.log(`[USER_DELETION] Found active stream for deleted user ${idToDelete}. Terminating PID: ${streamInfo.process.pid}.`);
            try {
                streamInfo.process.kill('SIGKILL');
                activeStreamProcesses.delete(streamKey);
                streamsKilled++;
            } catch (e) {
                console.warn(`[USER_DELETION] Error killing stream process for user ${idToDelete}: ${e.message}`);
            }
        }
    }
    if (streamsKilled > 0) {
        console.log(`[USER_DELETION] Terminated ${streamsKilled} active stream(s) for deleted user ${idToDelete}.`);
    }

    // --- NEW: Force logout via SSE ---
    sendSseEvent(idToDelete, 'force-logout', { reason: 'Your account has been deleted by an administrator.' });

    db.run("DELETE FROM users WHERE id = ?", idToDelete, function (err) {
        if (err) {
            console.error(`[USER_API] Error deleting user ${idToDelete}:`, err.message);
            return res.status(500).json({ error: err.message });
        }
        if (this.changes === 0) {
            console.warn(`[USER_API] User ${idToDelete} not found for deletion.`);
            return res.status(404).json({ error: 'User not found.' });
        }
        console.log(`[USER_API] User ${idToDelete} deleted successfully from database.`);
        res.json({ success: true });
    });
});
// --- Protected IPTV API Endpoints ---
app.get('/api/config', requireAuth, async (req, res) => {
    try {
        // ADDED vodMovies and vodSeries
        let config = { m3uContent: null, epgContent: null, settings: {}, vodMovies: [], vodSeries: [] };
        let globalSettings = getSettings();
        config.settings = globalSettings;

        // FETCH USER PERMISSIONS
        let allowedSources = null;
        try {
            const user = await dbGet(db, "SELECT allowed_sources, username FROM users WHERE id = ?", [req.session.userId]);
            if (user) {
                console.log(`[DEBUG_API_CONFIG] Fetching config for UserID: ${req.session.userId} (Session: ${req.sessionID})`);
                if (user.allowed_sources) {
                    allowedSources = JSON.parse(user.allowed_sources);
                    console.log(`[DEBUG_API_CONFIG] DB allowed_sources for user '${user.username}':`, JSON.stringify(allowedSources, null, 2));
                } else {
                    console.log(`[DEBUG_API_CONFIG] No allowed_sources found for user '${user.username}' (admin/full access).`);
                }
            }
        } catch (dbErr) {
            console.error("[API] Error fetching user permissions:", dbErr);
        }

        // LOAD M3U
        if (fs.existsSync(LIVE_CHANNELS_M3U_PATH)) {
            let m3uRaw = fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8');

            // FILTER M3U
            if (allowedSources) {
                const lines = m3uRaw.split('\n');
                let filteredLines = [];
                if (lines.length > 0 && lines[0].startsWith('#EXTM3U')) {
                    filteredLines.push(lines[0]);
                }

                let currentExtInf = null;
                const groupTitleRegex = /group-title="([^"]*)"/;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.startsWith('#EXTINF:')) {
                        currentExtInf = line;

                        // Extract Source ID we injected earlier: tvg-id="sourceId_..."
                        const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
                        let isAllowed = false;

                        if (tvgIdMatch) {
                            const fullId = tvgIdMatch[1];
                            const underscoreIndex = fullId.indexOf('_');
                            if (underscoreIndex !== -1) {
                                const sourceId = fullId.substring(0, underscoreIndex);
                                // Check if this source is in allowedSources
                                if (allowedSources[sourceId]) {
                                    // Check if specifically allowed (if we use { allowed: true }) or just presence
                                    // Assuming format: { "sourceId": { allowed: true, groups: [] } }
                                    if (allowedSources[sourceId].allowed) {
                                        isAllowed = true;
                                        // Check Group Restrictions
                                        const groups = allowedSources[sourceId].groups;
                                        if (groups && groups.length > 0) {
                                            const groupMatch = line.match(groupTitleRegex);
                                            const group = groupMatch ? groupMatch[1] : 'Uncategorized';
                                            if (!groups.includes(group)) {
                                                isAllowed = false;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if (!isAllowed) {
                            currentExtInf = null;
                        }

                    } else if (line.startsWith('http') || (line.startsWith('/') && !line.startsWith('//'))) { // URL or local path
                        if (currentExtInf) {
                            filteredLines.push(currentExtInf);
                            filteredLines.push(line);
                        }
                        currentExtInf = null;
                    }
                }
                config.m3uContent = filteredLines.join('\n');
                console.log(`[API] Loaded and FILTERED M3U content for user ${req.session.username}.`);
            } else {
                config.m3uContent = m3uRaw;
                console.log(`[API] Loaded M3U content from ${LIVE_CHANNELS_M3U_PATH}.`);
            }
        } else {
            console.log(`[API] No merged M3U file found at ${LIVE_CHANNELS_M3U_PATH}.`);
        }

        // LOAD EPG
        if (fs.existsSync(LIVE_EPG_JSON_PATH)) {
            try {
                const fullEpg = JSON.parse(fs.readFileSync(LIVE_EPG_JSON_PATH, 'utf-8'));
                if (allowedSources) {
                    const filteredEpg = {};
                    for (const channelId in fullEpg) {
                        const underscoreIndex = channelId.indexOf('_');
                        if (underscoreIndex !== -1) {
                            const sourceId = channelId.substring(0, underscoreIndex);
                            if (allowedSources[sourceId] && allowedSources[sourceId].allowed) {
                                // For EPG, we can't easily filter by group unless we look up the channel's group from M3U
                                // But EPG entries don't have group info. 
                                // However, the frontend matches EPG to M3U channels. 
                                // If M3U channel is hidden, EPG doesn't matter much, but good to filter for payload size.
                                // Limiting factor: We don't know the group here easily without re-parsing M3U or having a mapping.
                                // DECISION: Filter EPG by Source ID only. Granular group filtering happens naturally because the M3U won't have the channel.
                                filteredEpg[channelId] = fullEpg[channelId];
                            }
                        }
                    }
                    config.epgContent = filteredEpg;
                    console.log(`[API] Loaded and FILTERED EPG content for user ${req.session.username}.`);
                } else {
                    config.epgContent = fullEpg;
                    console.log(`[API] Loaded EPG content from ${LIVE_EPG_JSON_PATH}.`);
                }
            } catch (parseError) {
                console.error(`[API] Error parsing merged EPG JSON from ${LIVE_EPG_JSON_PATH}: ${parseError.message}`);
                config.epgContent = {};
            }
        } else {
            console.log(`[API] No merged EPG JSON file found at ${LIVE_EPG_JSON_PATH}.`);
        }

        // --- NEW: Load VOD Files (Legacy) ---
        // VOD filtering is complex here as it uses legacy JSON files. 
        // We will assume VOD is handled by the new /api/vod/library endpoint properly.
        // But to be safe, we can clear these if legacy mode is active and user is restricted.
        // For now, loading as is, but frontend uses the library endpoint.

        if (fs.existsSync(VOD_MOVIES_JSON_PATH)) {
            // ... legacy code kept simple
            try {
                config.vodMovies = JSON.parse(fs.readFileSync(VOD_MOVIES_JSON_PATH, 'utf-8'));
            } catch (e) { }
        }
        if (fs.existsSync(VOD_SERIES_JSON_PATH)) {
            try {
                config.vodSeries = JSON.parse(fs.readFileSync(VOD_SERIES_JSON_PATH, 'utf-8'));
            } catch (e) { }
        }
        // --- END NEW VOD ---

        db.all(`SELECT key, value FROM user_settings WHERE user_id = ?`, [req.session.userId], (err, rows) => {
            if (err) {
                console.error("[API] Error fetching user settings:", err);
                return res.status(200).json(config);
            }
            if (rows) {
                const userSettings = {};
                rows.forEach(row => {
                    try {
                        userSettings[row.key] = JSON.parse(row.value);
                    } catch (e) {
                        userSettings[row.key] = row.value;
                        console.warn(`[API] User setting key "${row.key}" could not be parsed as JSON. Storing as raw string.`);
                    }
                });

                config.settings = { ...config.settings, ...userSettings };
                console.log(`[API] Merged user settings for user ID: ${req.session.userId}`);
            }

            // --- CACHE INVALIDATION LOGIC ---
            // Calculate a signature for the user's permissions to force cache updates
            let userPermissionsSignature = 'default';
            if (allowedSources) {
                const str = JSON.stringify(allowedSources);
                let hash = 0;
                for (let i = 0; i < str.length; i++) {
                    const char = str.charCodeAt(i);
                    hash = ((hash << 5) - hash) + char;
                    hash = hash & hash; // Convert to 32bit integer
                }
                userPermissionsSignature = 'v1_' + hash;
            }
            config.settings.userPermissionsSignature = userPermissionsSignature;
            console.log(`[API] Serving config with permissions signature: ${userPermissionsSignature}`);
            // --------------------------------

            res.status(200).json(config);
        });

    } catch (error) {
        console.error("[API] Error reading config or related files:", error);
        res.status(500).json({ error: "Could not load configuration from server." });
    }
});

// [ROUTES MOVED TO ESM: /api/vod/* — library, series, categories]

// [ROUTES MOVED TO ESM: /api/dvr/* — engine + all 14 routes]
// [ROUTES MOVED TO ESM: /api/events, /api/validate-url, /api/hardware, /api/public-ip]

// [ROUTES MOVED TO ESM: /api/image-proxy, /api/settings/export, /api/settings/import, /api/logs/*]

// --- CAST endpoint moved to src/routes/cast.js ---
// --- IMAGE_PROXY endpoint moved to src/routes/image-proxy.js ---
// --- SETTINGS import/export moved to src/routes/settings-io.js ---
// --- LOGS endpoints moved to src/routes/logs.js ---
// --- MULTIVIEW endpoints moved to src/routes/multiview.js ---

// --- Server Start ---
// When loaded as a module, export the app and skip listen.
// When run directly (node server.js), start the full server.
if (isMainModule) {
detectHardwareAcceleration().then(() => {
    app.listen(port, () => {
        console.log(`\n======================================================`);
        console.log(` VINI PLAY server listening at http://localhost:${port}`);
        console.log(`======================================================\n`);

        processAndMergeSources().then((result) => {
            console.log('[INIT] Initial source processing complete.');
            if (result.success) fs.writeFileSync(SETTINGS_PATH, JSON.stringify(result.updatedSettings, null, 2));
            updateAndScheduleSourceRefreshes();
        }).catch(error => console.error('[INIT] Initial source processing failed:', error.message));

        if (notificationCheckInterval) clearInterval(notificationCheckInterval);
        notificationCheckInterval = setInterval(checkAndSendNotifications, 60000);
        console.log('[Push] Notification checker started.');

        setInterval(cleanupInactiveStreams, 60000);
        console.log('[JANITOR] Inactive stream cleanup process started.');

        schedule.scheduleJob('0 2 * * *', autoDeleteOldRecordings);
        console.log('[DVR_STORAGE] Scheduled daily cleanup of old recordings.');


    });
});
} // end if (isMainModule)

module.exports = app;
app._parseM3U = parseM3U;
app._shutdownDvr = function () {
  for (const [jobId, info] of activeDvrJobs) {
    try { info.startJob?.cancel(); } catch {}
    try { info.stopJob?.cancel(); } catch {}
    activeDvrJobs.delete(jobId);
  }
  for (const [jobId, pid] of runningFFmpegProcesses) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  console.log('[SHUTDOWN] DVR cleanup: cancelled scheduled jobs and signalled ffmpeg processes');
};

// --- Helper Functions (Full Implementation) ---
function parseM3U(data) {
    if (!data) return [];
    const lines = data.split('\n');
    const channels = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXTINF:')) {
            const nextLine = lines[i + 1]?.trim();
            // Ensure the next line is a valid URL
            if (nextLine && (nextLine.startsWith('http') || nextLine.startsWith('rtp'))) {
                const idMatch = line.match(/tvg-id="([^"]*)"/);
                const logoMatch = line.match(/tvg-logo="([^"]*)"/);
                const nameMatch = line.match(/tvg-name="([^"]*)"/);
                const groupMatch = line.match(/group-title="([^"]*)"/);
                const chnoMatch = line.match(/tvg-chno="([^"]*)"/);
                const sourceMatch = line.match(/vini-source="([^"]*)"/);
                const commaIndex = line.lastIndexOf(',');
                const displayName = (commaIndex !== -1) ? line.substring(commaIndex + 1).trim() : 'Unknown';

                channels.push({
                    id: idMatch ? idMatch[1] : `unknown-${Math.random()}`,
                    logo: logoMatch ? logoMatch[1] : '',
                    name: nameMatch ? nameMatch[1] : displayName,
                    group: groupMatch ? groupMatch[1] : 'Uncategorized',
                    chno: chnoMatch ? chnoMatch[1] : null,
                    source: sourceMatch ? sourceMatch[1] : 'Default',
                    displayName: displayName,
                    url: nextLine
                });
                i++; // Skip the URL line in the next iteration
            }
        }
    }
    return channels;
}
