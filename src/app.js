import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import webpush from 'web-push';
import { getDb } from './db/index.js';
import { SessionStore } from './db/session-store.js';
import { logger } from './config/logger.js';
import { env, DATA_DIR, DVR_DIR, PUBLIC_DIR, SOURCES_DIR, RAW_CACHE_DIR, LOGS_DIR, IMAGE_CACHE_DIR, VAPID_KEYS_PATH, SETTINGS_PATH } from './config/index.js';
import { applySecurityMiddleware } from './middleware/security.js';
import { requireAuth, requireAdmin } from './middleware/auth.js';
import { parseM3U } from './utils/m3u.js';
import { processAndMergeSources, updateAndScheduleSourceRefreshes } from './services/source-processor.js';

const require = createRequire(import.meta.url);
const app = express();
app.set('trust proxy', true);
app.set('etag', false);

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
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    // JS bundles have content hash in filename — cache aggressively
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      res.set('Cache-Control', 'no-cache');
    }
  },
}));

// --- Body parsing ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Settings helpers ---
function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// --- Hardware detection (must run before getSettings / session setup) ---
function detectHardware() {
  const hardware = {};
  try {
    // Step 1: scan /dev/dri for render devices
    const driDevices = [];
    try {
      const driDir = '/dev/dri';
      if (fs.existsSync(driDir)) {
        const entries = fs.readdirSync(driDir);
        for (const e of entries) {
          if (e.startsWith('renderD')) driDevices.push(path.join(driDir, e));
        }
        logger.info({ driDir, entries, renderDevices: driDevices }, '[hw-detect] /dev/dri scan');
      } else {
        logger.info('[hw-detect] /dev/dri does not exist — no DRM devices');
      }
    } catch (e) {
      logger.warn({ err: e }, '[hw-detect] Could not scan /dev/dri');
    }

    if (driDevices.length > 0) {
      // Step 2: run vainfo to identify GPU vendor
      try {
        const out = execSync('vainfo 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
        const outLower = out.toLowerCase();
        logger.info({ vainfoFirstLine: out.trim().split('\n')[0] }, '[hw-detect] vainfo output');
        if (outLower.includes('intel') || outLower.includes('i965') || outLower.includes('i915')) {
          hardware.intel_qsv = 'Intel Quick Sync Video';
          hardware.intel_vaapi = 'Intel VA-API';
          logger.info('[hw-detect] Identified Intel GPU via vainfo');
        } else if (outLower.includes('amd') || outLower.includes('radeon') || outLower.includes('amdgpu')) {
          hardware.radeon_vaapi = 'AMD Radeon VA-API';
          logger.info('[hw-detect] Identified AMD/Radeon GPU via vainfo');
        } else {
          hardware.intel_vaapi = 'Intel VA-API (detected)';
          logger.info({ outFirstChars: out.slice(0, 120) }, '[hw-detect] DRM device present but unknown vendor — defaulting to Intel VA-API');
        }
      } catch (vainfoErr) {
        // Step 3: vainfo failed — try lsmod for driver names
        logger.warn({ err: vainfoErr.message }, '[hw-detect] vainfo failed, trying lsmod fallback');
        try {
          const mods = execSync('lsmod 2>/dev/null', { encoding: 'utf-8', timeout: 3000 });
          if (mods.includes('i915') || mods.includes('i965')) {
            hardware.intel_qsv = 'Intel Quick Sync Video';
            hardware.intel_vaapi = 'Intel VA-API';
            logger.info('[hw-detect] Identified Intel GPU via lsmod (i915/i965)');
          } else if (mods.includes('amdgpu') || mods.includes('radeon')) {
            hardware.radeon_vaapi = 'AMD Radeon VA-API';
            logger.info('[hw-detect] Identified AMD GPU via lsmod (amdgpu/radeon)');
          } else {
            hardware.intel_vaapi = 'Intel VA-API';
            logger.info('[hw-detect] DRM render node exists but unknown vendor — defaulting to Intel VA-API');
          }
        } catch (lsmodErr) {
          hardware.intel_vaapi = 'Intel VA-API';
          logger.warn({ err: lsmodErr.message }, '[hw-detect] lsmod also failed — defaulting to Intel VA-API');
        }
      }
    } else {
      logger.info('[hw-detect] No DRM render devices found — no VAAPI/QSV hardware');
    }

    // Step 4: check for NVIDIA
    try {
      const nvidiaSmi = execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (nvidiaSmi) {
        hardware.nvidia = nvidiaSmi;
        logger.info({ gpu: nvidiaSmi }, '[hw-detect] NVIDIA GPU detected via nvidia-smi');
      }
    } catch {
      logger.debug('[hw-detect] nvidia-smi not found or failed — no NVIDIA GPU');
    }
    if (!hardware.nvidia) {
      try {
        if (fs.existsSync('/dev/nvidia0') || fs.existsSync('/dev/nvidiactl')) {
          hardware.nvidia = 'NVIDIA GPU';
          logger.info('[hw-detect] NVIDIA GPU detected via /dev/nvidia* device files');
        }
      } catch {}
    }
  } catch (err) {
    logger.warn({ err }, '[hw-detect] Hardware detection encountered an unexpected error');
  }
  return hardware;
}

const detectedHardware = detectHardware();
const hwKeys = Object.keys(detectedHardware);
logger.info(hwKeys.length ? { detected: detectedHardware } : { detected: 'none' }, 'Hardware detection complete');

// --- Default settings ---
const DEFAULT_SETTINGS = {
  m3uSources: [],
  epgSources: [],
  streamProfiles: [
    { id: 'redirect', name: 'Redirect / Direct Play', command: 'redirect', isDefault: false },
    { id: 'ffmpeg-default', name: 'ffmpeg (Software — Copy Codecs)', command: '-user_agent "{userAgent}" -re -i "{streamUrl}" -c copy -f mpegts pipe:1', isDefault: true },
  ],
  userAgents: [
    { id: 'vlc', name: 'VLC/3.0', value: 'VLC/3.0', isDefault: true },
    { id: 'chrome', name: 'Chrome (Windows)', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', isDefault: false },
    { id: 'firefox', name: 'Firefox (Windows)', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0', isDefault: false },
  ],
  dvr: {
    recordingProfiles: [
      { id: 'dvr-ts-default', name: 'TS (Copy Codecs)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c copy -f mpegts "{filePath}"', isDefault: true },
      { id: 'dvr-mp4-default', name: 'MP4 (Re-encode H.264/AAC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false },
    ],
    activeRecordingProfileId: 'dvr-ts-default',
    preBufferMinutes: 1,
    postBufferMinutes: 2,
    maxConcurrentRecordings: 1,
    autoDeleteDays: 0,
  },
  castProfiles: [
    { id: 'cast-default', name: 'Cast (Software H.264/AAC fMP4)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v libx264 -preset medium -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: true },
  ],
};

function initializeSettings(existing, hardware) {
  const settings = { ...existing };

  const mergedProfiles = [...(settings.streamProfiles || [])];
  for (const dp of DEFAULT_SETTINGS.streamProfiles) {
    if (!mergedProfiles.some(p => p.id === dp.id)) mergedProfiles.push(dp);
  }
  if (hardware.nvidia) {
    if (!mergedProfiles.some(p => p.id === 'ffmpeg-nvidia')) {
      mergedProfiles.push({ id: 'ffmpeg-nvidia', name: 'ffmpeg (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -re -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a copy -f mpegts pipe:1', isDefault: true });
    }
  }
  if (hardware.intel_qsv) {
    if (!mergedProfiles.some(p => p.id === 'ffmpeg-intel')) {
      mergedProfiles.push({ id: 'ffmpeg-intel', name: 'ffmpeg (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false });
    }
  }
  if (hardware.intel_vaapi) {
    if (!mergedProfiles.some(p => p.id === 'ffmpeg-vaapi')) {
      mergedProfiles.push({ id: 'ffmpeg-vaapi', name: 'ffmpeg (VA-API) Intel', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false });
    }
  }
  if (hardware.radeon_vaapi) {
    if (!mergedProfiles.some(p => p.id === 'ffmpeg-vaapi-amd')) {
      mergedProfiles.push({ id: 'ffmpeg-vaapi-amd', name: 'ffmpeg (VA-API) Radeon/AMD', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -f mpegts pipe:1', isDefault: false });
    }
  }
  settings.streamProfiles = mergedProfiles;

  const mergedAgents = [...(settings.userAgents || [])];
  for (const da of DEFAULT_SETTINGS.userAgents) {
    if (!mergedAgents.some(a => a.id === da.id)) mergedAgents.push(da);
  }
  settings.userAgents = mergedAgents;

  if (!settings.activeStreamProfileId) {
    const def = mergedProfiles.find(p => p.isDefault) || mergedProfiles[0];
    if (def) settings.activeStreamProfileId = def.id;
  }
  if (!settings.activeUserAgentId) {
    const def = mergedAgents.find(a => a.isDefault) || mergedAgents[0];
    if (def) settings.activeUserAgentId = def.id;
  }

  // DVR defaults
  settings.dvr = { ...DEFAULT_SETTINGS.dvr, ...(settings.dvr || {}) };
  const mergedDvrProfiles = [...(settings.dvr.recordingProfiles || [])];
  for (const dp of DEFAULT_SETTINGS.dvr.recordingProfiles) {
    if (!mergedDvrProfiles.some(p => p.id === dp.id)) mergedDvrProfiles.push(dp);
  }
  if (hardware.nvidia) {
    if (!mergedDvrProfiles.some(p => p.id === 'dvr-mp4-nvidia')) {
      mergedDvrProfiles.push({ id: 'dvr-mp4-nvidia', name: 'NVIDIA NVENC MP4 (H.264/AAC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: true });
    }
  }
  if (hardware.intel_qsv) {
    if (!mergedDvrProfiles.some(p => p.id === 'dvr-mp4-intel')) {
      mergedDvrProfiles.push({ id: 'dvr-mp4-intel', name: 'Intel QSV MP4 (H.264/AAC)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false });
    }
  }
  if (hardware.intel_vaapi) {
    if (!mergedDvrProfiles.some(p => p.id === 'dvr-mp4-vaapi')) {
      mergedDvrProfiles.push({ id: 'dvr-mp4-vaapi', name: 'Intel VA-API MP4 (H.264/AAC)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf \'format=nv12,hwupload\' -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false });
    }
  }
  if (hardware.radeon_vaapi) {
    if (!mergedDvrProfiles.some(p => p.id === 'dvr-mp4-radeon-vaapi')) {
      mergedDvrProfiles.push({ id: 'dvr-mp4-radeon-vaapi', name: 'Radeon/AMD VA-API MP4 (H.264/AAC)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -preset medium -c:a aac -b:a 128k -movflags +faststart -f mp4 "{filePath}"', isDefault: false });
    }
  }
  settings.dvr.recordingProfiles = mergedDvrProfiles;
  if (!settings.dvr.activeRecordingProfileId) {
    const def = mergedDvrProfiles.find(p => p.isDefault) || mergedDvrProfiles[0];
    if (def) settings.dvr.activeRecordingProfileId = def.id;
  }

  // Cast defaults
  const mergedCastProfiles = [...(settings.castProfiles || [])];
  for (const cp of DEFAULT_SETTINGS.castProfiles) {
    if (!mergedCastProfiles.some(p => p.id === cp.id)) mergedCastProfiles.push(cp);
  }
  if (hardware.nvidia) {
    if (!mergedCastProfiles.some(p => p.id === 'cast-nvidia')) {
      mergedCastProfiles.push({ id: 'cast-nvidia', name: 'Cast (NVIDIA NVENC)', command: '-user_agent "{userAgent}" -i "{streamUrl}" -c:v h264_nvenc -preset p6 -tune hq -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false });
    }
  }
  if (hardware.intel_qsv) {
    if (!mergedCastProfiles.some(p => p.id === 'cast-intel')) {
      mergedCastProfiles.push({ id: 'cast-intel', name: 'Cast (Intel QSV)', command: '-hwaccel qsv -c:v h264_qsv -i "{streamUrl}" -c:v h264_qsv -preset medium -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false });
    }
  }
  if (hardware.intel_vaapi) {
    if (!mergedCastProfiles.some(p => p.id === 'cast-vaapi')) {
      mergedCastProfiles.push({ id: 'cast-vaapi', name: 'Cast (VA-API Intel)', command: '-hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -vf "format=nv12|vaapi,hwupload" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false });
    }
  }
  if (hardware.radeon_vaapi) {
    if (!mergedCastProfiles.some(p => p.id === 'cast-vaapi-amd')) {
      mergedCastProfiles.push({ id: 'cast-vaapi-amd', name: 'Cast (VA-API Radeon/AMD)', command: '-vaapi_device /dev/dri/renderD128 -hwaccel vaapi -hwaccel_output_format vaapi -i "{streamUrl}" -c:v h264_vaapi -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 pipe:1', isDefault: false });
    }
  }
  settings.castProfiles = mergedCastProfiles;
  if (!settings.activeCastProfileId) {
    const def = mergedCastProfiles.find(p => p.isDefault) || mergedCastProfiles[0];
    if (def) settings.activeCastProfileId = def.id;
  }

  return settings;
}

let _settingsBootstrapped = false;

function getSettings() {
  try {
    let raw = {};
    const fileExists = fs.existsSync(SETTINGS_PATH);
    if (fileExists) {
      raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
    // Ensure essential array keys always exist so routes don't crash on undefined
    if (!raw.m3uSources) raw.m3uSources = [];
    if (!raw.epgSources) raw.epgSources = [];
    if (!_settingsBootstrapped) {
      const hadProfiles = (raw.streamProfiles || []).length > 0;
      const hadAgents = (raw.userAgents || []).length > 0;
      const hadActiveProfile = !!raw.activeStreamProfileId;
      const hadActiveAgent = !!raw.activeUserAgentId;
      const bootstrapped = initializeSettings(raw, detectedHardware);
      if (JSON.stringify(bootstrapped) !== JSON.stringify(raw)) {
        saveSettings(bootstrapped);
        logger.info({
          fileExisted: fileExists,
          addedProfiles: bootstrapped.streamProfiles.length - (raw.streamProfiles || []).length,
          addedAgents: bootstrapped.userAgents.length - (raw.userAgents || []).length,
          fixedActiveProfile: !hadActiveProfile && !!bootstrapped.activeStreamProfileId,
          fixedActiveAgent: !hadActiveAgent && !!bootstrapped.activeUserAgentId,
          gpuProfiles: bootstrapped.streamProfiles.filter(p => ['ffmpeg-nvidia', 'ffmpeg-intel', 'ffmpeg-vaapi', 'ffmpeg-vaapi-amd'].includes(p.id)).map(p => p.id),
        }, 'Settings bootstrapped with defaults');
      } else {
        logger.info({ fileExisted: fileExists, profileCount: bootstrapped.streamProfiles.length, agentCount: bootstrapped.userAgents.length }, 'Settings already complete — no bootstrap needed');
      }
      _settingsBootstrapped = true;
      return bootstrapped;
    }
    return raw;
  } catch (e) {
    logger.error({ err: e }, 'Failed to read settings');
  }
  return {};
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

app.use(
  session({
    store: new SessionStore(),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: 'auto',
      sameSite: 'lax',
    },
  })
);

// --- HTTP request logging ---
app.use((req, res, next) => {
  req.clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (req.path === '/api/events') return next(); // SSE — too noisy

  const start = Date.now();
  const origEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: duration,
      ip: req.clientIp,
      userId: req.session?.userId,
      ua: (req.headers['user-agent'] || '').slice(0, 80) || undefined,
    }, 'request');
    origEnd.apply(this, args);
  };
  next();
});

// --- DVR static files (ownership-checked) ---
// Express 5 wildcard params capture as an array of segments — join them first.
app.get('/dvr/*splat', requireAuth, (req, res) => {
  const relativePath = Array.isArray(req.params.splat)
    ? req.params.splat.join('/')
    : req.params.splat;
  const filePath = path.resolve(DVR_DIR, relativePath);
  if (!filePath.startsWith(DVR_DIR + path.sep) && filePath !== DVR_DIR) {
    return res.status(403).send('Forbidden');
  }
  if (!req.session.canUseDvr && !req.session.isAdmin) {
    return res.status(403).send('Forbidden');
  }
  if (!req.session.isAdmin) {
    const recording = db.prepare('SELECT filePath FROM dvr_recordings WHERE filePath = ? AND user_id = ?').get(filePath, req.session.userId);
    if (!recording) return res.status(404).send('Recording not found');
  }
  res.sendFile(filePath);
});

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
const activeRedirectStreams = new Map();

const shared = { db, getSettings, saveSettings, sseClients, activeStreamProcesses, activeCastTokens, activeDvrJobs, activeRedirectStreams, vapidKeys, webpush, detectedHardware };

// --- Mount new modular routes (take priority) ---
const { createAuthRoutes } = await import('./routes/auth.js');
const { createUserRoutes } = await import('./routes/users.js');
const { createNotificationRoutes } = await import('./routes/notifications.js');
const { createSettingsRoutes } = await import('./routes/settings.js');
const { createConfigRoutes } = await import('./routes/config.js');
const { createMiscRoutes } = await import('./routes/misc.js');
const { createStreamRoutes } = await import('./routes/stream.js');
const { createCastRoutes } = await import('./routes/cast.js');
const { createImageProxyRoutes } = await import('./routes/image-proxy.js');
const { createLogRoutes } = await import('./routes/logs.js');
const { createSettingsIoRoutes } = await import('./routes/settings-io.js');
const { createMultiviewRoutes } = await import('./routes/multiview.js');
const { createStreamMgmtRoutes } = await import('./routes/stream-mgmt.js');
const { createAdminRoutes } = await import('./routes/admin.js');
const { createSourceRoutes } = await import('./routes/sources.js');

app.use('/api/auth', createAuthRoutes(shared));
app.use('/api/users', createUserRoutes(shared));
app.use('/api/notifications', createNotificationRoutes(shared));
app.use('/api', createSettingsRoutes(shared));
app.use('/api', createConfigRoutes(shared));
app.use('/api', createMiscRoutes(shared));
app.use('/api', createCastRoutes(shared));
app.use('/api', createImageProxyRoutes());
app.use('/api/logs', createLogRoutes());
app.use('/api', createSettingsIoRoutes());
app.use('/api/multiview', createMultiviewRoutes(shared));
app.use('/api', createStreamMgmtRoutes(shared));
app.use('/api', createAdminRoutes(shared));
app.use('/api/sources', createSourceRoutes(shared));
const streamRoutes = createStreamRoutes(shared);
app.use('/stream', streamRoutes);
app.use('/api/stream', streamRoutes);

// --- Health check (before legacy mount so it's reachable) ---
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '0.12.0', uptime: process.uptime() });
});

// --- Add parseM3U to shared state for route modules ---
shared.parseM3U = parseM3U;

// --- Mount DVR routes ---
const { createDvrRoutes } = await import('./routes/dvr.js');
const dvrRoutes = createDvrRoutes(shared);
app.use('/api', dvrRoutes);
app.use('/dvr', dvrRoutes);

// --- Mount VOD routes ---
const { createVodRoutes } = await import('./routes/vod.js');
app.use('/api', createVodRoutes(shared));

// Load and schedule pending DVR jobs on startup
db.prepare("UPDATE dvr_jobs SET status = 'error', errorMessage = 'Server restarted during recording.' WHERE status = 'recording'").run();
const pendingJobs = db.prepare("SELECT * FROM dvr_jobs WHERE status = 'scheduled'").all();
for (const job of pendingJobs) dvrRoutes.engine.scheduleDvrJob(job);
logger.info({ dvrJobs: pendingJobs.length }, 'DVR jobs loaded and scheduled');

// --- Admin utility routes ---
app.post('/api/process-sources', requireAuth, async (req, res) => {
  try {
    const result = await processAndMergeSources({ getSettings, sseClients, userId: req.session.userId });
    if (result?.success) {
      saveSettings(result.updatedSettings);
      updateAndScheduleSourceRefreshes({ getSettings, saveSettings, sseClients });
    }
    res.json(result || { success: false, message: 'Processing completed with no result.' });
  } catch (err) {
    logger.error({ err }, 'Source processing failed');
    res.status(500).json({ error: 'Source processing failed.' });
  }
});

app.delete('/api/data', requireAdmin, (_req, res) => {
  try {
    const tables = ['stream_history', 'dvr_recordings', 'dvr_jobs', 'notification_deliveries', 'notifications', 'push_subscriptions', 'multiview_layouts', 'user_settings', 'sessions'];
    for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    [SETTINGS_PATH, path.join(DATA_DIR, 'live_channels.m3u'), path.join(DATA_DIR, 'epg.json'), path.join(DATA_DIR, 'vapid.json')].forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
    [path.join(DATA_DIR, 'sources'), DVR_DIR].forEach(d => { try { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); } catch {} });
    res.json({ success: true, message: 'Hard reset complete.' });
  } catch (e) {
    logger.error({ err: e }, 'Data reset failed');
    res.status(500).json({ error: 'Reset failed.' });
  }
});

const hlsCleanup = streamRoutes.killAllHlsStreams;
const dvrShutdown = () => {
  for (const [, pid] of dvrRoutes.engine.runningFFmpegProcesses) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
};

// --- SPA fallback ---
app.get('/{*splat}', (req, res) => {
  const filePath = `${PUBLIC_DIR}${req.path}`;
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isFile()) {
    return res.sendFile(filePath, { lastModified: false });
  }
  res.sendFile(`${PUBLIC_DIR}/index.html`, { lastModified: false });
});

// --- Error handler ---
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'Unhandled error');
  if (res.headersSent) return;
  const status = Number.isInteger(err?.status) ? err.status : 500;
  res.status(status).json({ error: env.NODE_ENV === 'development' ? err.message : 'Internal server error' });
});

export { app, db, activeStreamProcesses, hlsCleanup, dvrShutdown, getSettings, saveSettings, sseClients };
