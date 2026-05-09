import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import fs from 'fs';
import { createRequire } from 'module';
import webpush from 'web-push';
import { getDb } from './db/index.js';
import { logger } from './config/logger.js';
import { env, DATA_DIR, DVR_DIR, PUBLIC_DIR, SOURCES_DIR, RAW_CACHE_DIR, LOGS_DIR, IMAGE_CACHE_DIR, VAPID_KEYS_PATH, SETTINGS_PATH } from './config/index.js';
import { applySecurityMiddleware } from './middleware/security.js';
import { requireAuth } from './middleware/auth.js';

const require = createRequire(import.meta.url);
const app = express();
app.set('trust proxy', true);

// --- Ensure directories exist ---
for (const dir of [PUBLIC_DIR, SOURCES_DIR, DVR_DIR, RAW_CACHE_DIR, LOGS_DIR, IMAGE_CACHE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
logger.info('Required directories ensured');

// --- Security middleware (helmet, rate limiting) ---
applySecurityMiddleware(app);

// --- Static files ---
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-cache');
  next();
});
app.use(express.static(PUBLIC_DIR, {
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
}));

// --- Body parsing ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Settings helpers ---
function getSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch (e) {
    logger.error({ err: e }, 'Failed to read settings');
  }
  return {};
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// --- Session management ---
let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  logger.warn('SESSION_SECRET not in env, checking settings.json');
  const settings = getSettings();
  if (settings.generatedSessionSecret) {
    sessionSecret = settings.generatedSessionSecret;
    logger.info('Using existing session secret from settings.json');
  } else {
    sessionSecret = crypto.randomBytes(64).toString('hex');
    settings.generatedSessionSecret = sessionSecret;
    saveSettings(settings);
    logger.info('New session secret generated and saved');
  }
}

const SQLiteStore = require('connect-sqlite3')(session);

app.use(
  session({
    store: new SQLiteStore({ db: 'viniplay.db', dir: DATA_DIR, table: 'http_sessions' }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  })
);

// --- HTTP request logging ---
app.use((req, res, next) => {
  if (req.path === '/api/events') return next();
  req.clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  logger.debug({ method: req.method, url: req.originalUrl, ip: req.clientIp }, 'request');
  next();
});

// --- DVR static files ---
app.use('/dvr', requireAuth, express.static(DVR_DIR));

// --- Initialize database ---
const db = getDb();

// Reset DVR jobs that were recording when server stopped
db.prepare("UPDATE dvr_jobs SET status = 'error', errorMessage = 'Server restarted during recording.' WHERE status = 'recording'").run();

// --- VAPID key setup ---
let vapidKeys = {};
try {
  if (fs.existsSync(VAPID_KEYS_PATH)) {
    vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_PATH, 'utf-8'));
    logger.info('Existing VAPID keys loaded');
  } else {
    vapidKeys = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2));
    logger.info('New VAPID keys generated');
  }
  webpush.setVapidDetails(env.VAPID_CONTACT_EMAIL, vapidKeys.publicKey, vapidKeys.privateKey);
} catch (error) {
  logger.error({ err: error }, 'Failed to setup VAPID keys');
}

// --- Shared state ---
const sseClients = new Map();
const activeStreamProcesses = new Map();
const activeCastTokens = new Map();
const activeDvrJobs = new Map();
const detectedHardware = {};

const shared = { db, getSettings, saveSettings, sseClients, activeStreamProcesses, activeCastTokens, activeDvrJobs, vapidKeys, webpush, detectedHardware };

// --- Mount new modular routes (take priority) ---
const { createAuthRoutes } = await import('./routes/auth.js');
const { createUserRoutes } = await import('./routes/users.js');
const { createNotificationRoutes } = await import('./routes/notifications.js');
const { createSettingsRoutes } = await import('./routes/settings.js');
const { createConfigRoutes } = await import('./routes/config.js');
const { createMiscRoutes } = await import('./routes/misc.js');
const { createStreamRoutes } = await import('./routes/stream.js');

app.use('/api/auth', createAuthRoutes(shared));
app.use('/api/users', createUserRoutes(shared));
app.use('/api/notifications', createNotificationRoutes(shared));
app.use('/api', createSettingsRoutes(shared));
app.use('/api', createConfigRoutes(shared));
app.use('/api', createMiscRoutes(shared));
app.use('/stream', createStreamRoutes(shared));

// --- Health check (before legacy mount so it's reachable) ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.12.0', uptime: process.uptime() });
});

// --- Mount legacy server.js routes (everything not yet extracted) ---
// Mounted after new routes so our handlers take priority.
const legacyApp = require('../server.cjs');
app.use(legacyApp);

// --- SPA fallback ---
app.get('*', (req, res) => {
  const filePath = `${PUBLIC_DIR}${req.path}`;
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
    return res.sendFile(filePath);
  }
  res.sendFile(`${PUBLIC_DIR}/index.html`);
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: env.NODE_ENV === 'development' ? err.message : 'Internal server error' });
});

export { app, db, activeStreamProcesses };
