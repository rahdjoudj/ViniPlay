import { Router } from 'express';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { logger } from '../config/logger.js';
import { DATA_DIR, LIVE_CHANNELS_M3U_PATH, env } from '../config/index.js';
import { broadcastAdminUpdate } from './_sse-utils.js';
import { injectInputFlags, shouldRespawn, shouldKill, isProgressing, extractNewestSegment } from '../utils/hls-resilience.js';

const HLS_DIR = path.join(DATA_DIR, 'hls');
const HLS_SEGMENT_TIME = 2;
const HLS_LIST_SIZE = 5;
const HLS_INACTIVITY_TIMEOUT = 30_000;
const HLS_CLEANUP_INTERVAL = 30_000;
// Stall recovery: kill ffmpeg after ~10s of no playlist progress, treat a
// playlist older than 15s as stalled, and retry respawns at most every 10s.
const STALL_KILL_TICKS = 5;
const STALE_PLAYLIST_MS = 15_000;
const RESPAWN_COOLDOWN_MS = 10_000;

// Track active HLS streams: streamKey -> { ffmpeg, url, userId, createdAt, references }
const hlsStreams = new Map();
const hlsStreamByDir = new Map();

export function createStreamRoutes({ getSettings, activeStreamProcesses, db, sseClients, activeRedirectStreams, activeCastTokens, parseM3U }) {
  const router = Router();

  function broadcastAdminActivity() {
    const live = [];
    for (const info of activeStreamProcesses.values()) {
      live.push({
        streamKey: info.streamKey,
        userId: info.userId,
        username: info.username,
        channelName: info.channelName,
        channelLogo: info.channelLogo,
        streamProfileName: info.streamProfileName,
        startTime: info.startTime,
        clientIp: info.clientIp,
        isTranscoded: !!info.isTranscoded,
      });
    }
    const msg = `event: activity-update\ndata: ${JSON.stringify({ live })}\n\n`;
    for (const clients of sseClients.values()) {
      clients.forEach(c => { if (c.isAdmin) c.res.write(msg); });
    }
  }

  // Ensure HLS directory exists
  if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

  /**
   * Spawns ffmpeg for a HLS stream and registers it in hlsStreams. Also used
   * for respawns: it replaces the (tombstoned) entry for the same streamKey
   * and starts with a clean playlist so segment numbers stay monotonic
   * (hls_start_number_source epoch). Returns the streamInfo entry.
   */
  async function startHlsProcess({ streamKey, streamId, streamDir, playlistPath, url, userId, username, profile, userAgentValue, references, lastRespawnAttemptAt = 0 }) {
    // Clear any previous generation's playlist/segments so a respawned
    // ffmpeg never mixes old and new segment numbers in one playlist.
    if (!fs.existsSync(streamDir)) fs.mkdirSync(streamDir, { recursive: true });
    try {
      for (const f of fs.readdirSync(streamDir)) {
        if (f.endsWith('.ts') || f.endsWith('.m3u8')) fs.rmSync(path.join(streamDir, f), { force: true });
      }
    } catch {}

    // Build ffmpeg HLS command using the user's profile template
    let cmdTemplate = (profile?.command || '-i {streamUrl} -c copy')
      .replace(/{streamUrl}/g, url)
      .replace(/{userAgent}|{clientUserAgent}/g, userAgentValue);
    // Strip old output directives (pipe, file) — we replace with HLS
    cmdTemplate = cmdTemplate.replace(/-f\s+\S+\s+pipe:\d?\s*$/, '').trim();
    cmdTemplate = cmdTemplate.replace(/-f\s+\S+\s+\S+\s*$/, '').trim();
    let profileArgs = (cmdTemplate.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(a => a.replace(/^"|"$/g, ''));
    // HTTP input resilience: read timeout + reconnects so a stalled provider
    // socket kills ffmpeg instead of hanging it forever.
    profileArgs = injectInputFlags(profileArgs, env.FFMPEG_INPUT_TIMEOUT_MS);

    const isCopyMode = cmdTemplate.includes('-c copy') || cmdTemplate.includes('-c:v copy');
    const ffmpegArgs = [
      '-v', 'level+warning',
      ...profileArgs,
      // HEVC compatibility for Apple devices — only with copy mode
      ...(isCopyMode ? ['-tag:v', 'hvc1', '-bsf:v', 'hevc_mp4toannexb'] : []),
      '-f', 'hls',
      '-hls_time', String(HLS_SEGMENT_TIME),
      '-hls_list_size', String(HLS_LIST_SIZE),
      '-hls_flags', 'delete_segments+append_list',
      '-hls_start_number_source', 'epoch',
      '-hls_segment_filename', path.join(streamDir, 'segment_%05d.ts'),
      path.join(streamDir, 'stream.m3u8'),
    ];

    logger.info({ streamKey, url: url.slice(0, 80), profile: profile?.name || 'default', args: ffmpegArgs.join(' ') }, '[hls] Starting ffmpeg');

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const startTime = Date.now();
    let stderrLineCount = 0;
    let noOutputTimer;

    const streamInfo = {
      ffmpeg,
      url,
      userId,
      username,
      profile,
      userAgent: userAgentValue,
      streamKey,
      streamId,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      references,
      streamDir,
      dead: false,
      respawning: false,
      lastRespawnAttemptAt,
    };

    hlsStreams.set(streamKey, streamInfo);
    hlsStreamByDir.set(streamId, streamKey);

    ffmpeg.on('spawn', () => {
      logger.info({ streamKey, pid: ffmpeg.pid }, '[hls] ffmpeg process spawned');
      // If no stderr within 3s, log a diagnostic
      noOutputTimer = setTimeout(() => {
        if (stderrLineCount === 0) {
          logger.warn({ streamKey, pid: ffmpeg.pid, elapsedMs: Date.now() - startTime }, '[hls] No stderr from ffmpeg after 3s — process may be hung or binary missing');
        }
      }, 3000);
      noOutputTimer.unref();
    });

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (!msg) return;
      stderrLineCount++;
      const isError = /error|fail|invalid|unable|cannot|refused|timed?out|denied|not found|no such/i.test(msg);
      logger[isError ? 'warn' : 'info']({ streamKey, line: stderrLineCount, msg: msg.slice(0, 400) }, isError ? '[hls] ffmpeg stderr (warning)' : '[hls] ffmpeg');
    });

    // Also capture stdout — ffmpeg occasionally writes progress there
    ffmpeg.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) logger.debug({ streamKey, msg: msg.slice(0, 200) }, '[hls] ffmpeg stdout');
    });

    // Watchdog: monitor playlist file for segment production. Progress = new
    // bytes OR a new segment name; a stalled-but-alive ffmpeg produces neither.
    // -1 matches the "playlist missing" read below, so a not-yet-written
    // playlist is never mistaken for progress. hasProgressed gives slow
    // sources a grace period: the watchdog only counts silence AFTER the
    // pipeline has produced output at least once (dead-at-start HTTP feeds
    // are caught by -rw_timeout instead).
    let lastPlaylistSize = -1;
    let lastSegmentName = null;
    let ticksWithoutProgress = 0;
    let hasProgressed = false;
    try { lastPlaylistSize = fs.statSync(playlistPath).size; } catch {}
    const segmentWatchdog = setInterval(() => {
      if (streamInfo.dead || streamInfo.stopped) return;
      let playlistSize = -1;
      let newestSegment = null;
      try { playlistSize = fs.statSync(playlistPath).size; } catch {}
      try { newestSegment = extractNewestSegment(fs.readFileSync(playlistPath, 'utf-8')); } catch {}
      if (isProgressing({
        playlistSizeChanged: playlistSize !== lastPlaylistSize,
        newestSegmentChanged: newestSegment !== null && newestSegment !== lastSegmentName,
      })) {
        lastPlaylistSize = playlistSize;
        if (newestSegment !== null) lastSegmentName = newestSegment;
        ticksWithoutProgress = 0;
        hasProgressed = true;
        logger.info({ streamKey, playlistBytes: playlistSize, newestSegment, elapsedS: ((Date.now() - startTime) / 1000).toFixed(0) }, '[hls] Playlist updated — segments being produced');
      } else {
        if (!hasProgressed) return;
        ticksWithoutProgress++;
        if (shouldKill({ ticksWithoutProgress, killAfterTicks: STALL_KILL_TICKS })) {
          logger.warn({ streamKey, pid: ffmpeg.pid, elapsedS: ((Date.now() - startTime) / 1000).toFixed(0), stderrLines: stderrLineCount }, '[hls] No segments produced after ~10s — killing ffmpeg (auto-respawn on next poll)');
          streamInfo.dead = true;
          try { ffmpeg.kill('SIGKILL'); } catch {}
        }
      }
    }, 2000);
    segmentWatchdog.unref();

    const activeInfo = {
      process: ffmpeg,
      references,
      lastAccess: Date.now(),
      userId,
      username,
      channelId: null,
      channelName: `HLS: ${url.slice(0, 60)}`,
      channelLogo: null,
      streamProfileName: profile?.name || 'HLS (Built-in)',
      startTime: new Date().toISOString(),
      historyId: null,
      clientIp: null,
      streamKey,
      isTranscoded: true,
    };
    activeStreamProcesses.set(streamKey, activeInfo);
    broadcastAdminActivity(sseClients);

    ffmpeg.on('close', (code, signal) => {
      if (noOutputTimer) clearTimeout(noOutputTimer);
      clearInterval(segmentWatchdog);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger[code === 0 ? 'info' : 'warn']({
        streamKey, code, signal, durationSec: duration,
        stderrLines: stderrLineCount,
        hadOutput: stderrLineCount > 0,
      }, code === 0 ? '[hls] ffmpeg exited cleanly' : '[hls] ffmpeg exited with error');

      const info = hlsStreams.get(streamKey);
      // A previous generation's process closing after a respawn must not
      // touch the entry now owned by the new ffmpeg.
      if (!info || info.ffmpeg !== ffmpeg) return;

      if (info.stopped) {
        // Explicit stop or inactivity sweep — full cleanup
        hlsStreams.delete(streamKey);
        hlsStreamByDir.delete(streamId);
        activeStreamProcesses.delete(streamKey);
        broadcastAdminActivity(sseClients);
        try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch {}
        return;
      }

      // Unexpected exit or watchdog kill — tombstone: keep the entry and dir
      // so the next playlist poll can trigger a respawn.
      info.ffmpeg = null;
      info.dead = true;
      info.respawning = false;
      activeStreamProcesses.delete(streamKey);
      broadcastAdminActivity(sseClients);
    });

    ffmpeg.on('error', (err) => {
      if (noOutputTimer) clearTimeout(noOutputTimer);
      clearInterval(segmentWatchdog);
      logger.error({ streamKey, err: err.message, code: err.code, pid: ffmpeg.pid }, '[hls] ffmpeg spawn error (binary missing or not executable?)');
      const info = hlsStreams.get(streamKey);
      if (!info || info.ffmpeg !== ffmpeg) return;
      info.ffmpeg = null;
      info.dead = true;
      info.respawning = false;
      activeStreamProcesses.delete(streamKey);
      broadcastAdminActivity(sseClients);
    });

    return streamInfo;
  }

  // Serve HLS playlist (.m3u8)
  router.get('/hls/:streamId/stream.m3u8', (req, res) => {
    const streamId = req.params.streamId;
    const playlistPath = path.resolve(HLS_DIR, streamId, 'stream.m3u8');
    if (!playlistPath.startsWith(HLS_DIR + path.sep)) return res.status(403).send('Forbidden');

    const streamKey = hlsStreamByDir.get(streamId);
    const info = streamKey ? hlsStreams.get(streamKey) : null;
    if (info) info.lastAccess = Date.now();

    // Auto-respawn: a tombstoned (dead) entry or a playlist that stopped
    // updating means the pipeline stalled — start a fresh ffmpeg in the
    // background so the client's next polls pick up a live playlist again.
    if (info && !info.respawning) {
      // A missing playlist means the pipeline is still starting (fresh spawn
      // or in-flight respawn cleans the dir first) — never treat it as stale.
      let playlistAgeMs = 0;
      try { playlistAgeMs = Date.now() - fs.statSync(playlistPath).mtimeMs; } catch {}
      if (shouldRespawn({
        dead: info.dead,
        lastRespawnAttemptAt: info.lastRespawnAttemptAt,
        now: Date.now(),
        respawnCooldownMs: RESPAWN_COOLDOWN_MS,
        playlistAgeMs,
        staleAgeMs: STALE_PLAYLIST_MS,
      })) {
        info.respawning = true;
        info.lastRespawnAttemptAt = Date.now();
        startHlsProcess({
          streamKey: info.streamKey,
          streamId: info.streamId,
          streamDir: info.streamDir,
          playlistPath: path.join(info.streamDir, 'stream.m3u8'),
          url: info.url,
          userId: info.userId,
          username: info.username,
          profile: info.profile,
          userAgentValue: info.userAgent,
          references: info.references,
          lastRespawnAttemptAt: info.lastRespawnAttemptAt,
        })
          .then(() => logger.info({ streamKey }, '[hls] Auto-respawn started'))
          .catch((err) => {
            const current = hlsStreams.get(streamKey);
            if (current) current.respawning = false;
            logger.warn({ streamKey, err: err.message }, '[hls] Auto-respawn failed — will retry after cooldown');
          });
      }
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (!fs.existsSync(playlistPath)) {
      // Playlist not written yet — return a stub so HLS.js keeps polling
      // (404 would be fatal — HLS.js stops retrying)
      res.send('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n');
      return;
    }

    // Log playlist content on first serve for debugging
    if (info && !info._playlistLogged) {
      try {
        const content = fs.readFileSync(playlistPath, 'utf-8');
        logger.info({ streamKey, playlist: content.slice(0, 500) }, '[hls] Playlist content (first serve)');
        info._playlistLogged = true;
      } catch {}
    }

    res.sendFile(playlistPath, { cacheControl: false, lastModified: false, etag: false });
  });

  // Serve HLS segments (.ts) — can be cached briefly since they're immutable
  router.get('/hls/:streamId/:segment', (req, res) => {
    const segPath = path.resolve(HLS_DIR, req.params.streamId, req.params.segment);
    if (!segPath.startsWith(HLS_DIR + path.sep)) return res.status(403).send('Forbidden');
    if (!fs.existsSync(segPath)) {
      return res.status(404).send('Segment not found.');
    }

    const streamKey = hlsStreamByDir.get(req.params.streamId);
    const info = streamKey ? hlsStreams.get(streamKey) : null;
    if (info) info.lastAccess = Date.now();

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'max-age=10');
    res.sendFile(segPath, { cacheControl: false });
  });

  // Start or get an HLS stream
  router.get('/hls', async (req, res) => {
    const { url, profileId, userAgentId } = req.query;
    const userId = req.session?.userId;
    const username = req.session?.username;

    if (!url) return res.status(400).json({ error: 'url query parameter is required.' });
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    const settings = getSettings();
    // Use specified profile/userAgent, or fall back to the active ones from settings
    const effectiveProfileId = profileId || settings.activeStreamProfileId;
    const effectiveAgentId = userAgentId || settings.activeUserAgentId;
    const profile = (settings.streamProfiles || []).find(p => p.id === effectiveProfileId);
    const userAgent = (settings.userAgents || []).find(ua => ua.id === effectiveAgentId);

    // Build ffmpeg args — copy codecs to avoid re-encode, output HLS
    const ua = userAgent?.value || 'VLC/3.0';
    const urlHash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const streamId = `${userId}_${urlHash}`;
    const streamKey = `${userId}::${streamId}`;
    const streamDir = path.join(HLS_DIR, streamId);

    // Reuse only when the existing pipeline is healthy: alive, not mid-respawn,
    // and its playlist is still being updated. Anything else falls through to
    // a fresh start below (stale/dead pipelines are killed first).
    const existing = hlsStreams.get(streamKey);
    if (existing && !existing.dead && !existing.respawning) {
      // Missing playlist = pipeline still starting — fresh, not stale.
      let playlistAgeMs = 0;
      try { playlistAgeMs = Date.now() - fs.statSync(path.join(streamDir, 'stream.m3u8')).mtimeMs; } catch {}
      if (playlistAgeMs <= STALE_PLAYLIST_MS) {
        existing.references++;
        existing.lastAccess = Date.now();
        logger.debug({ streamKey, references: existing.references }, '[hls] Reusing existing stream');
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ playlistUrl: `/stream/hls/${streamId}/stream.m3u8`, type: 'hls' });
      }
      logger.warn({ streamKey, playlistAgeMs }, '[hls] Existing stream playlist stale — starting fresh');
    }

    // Stale or dead entry: make sure no lingering ffmpeg is still writing to
    // the stream dir before spawning a new one (prevents two ffmpegs).
    if (existing && existing.ffmpeg) {
      logger.warn({ streamKey }, '[hls] Killing stale ffmpeg before fresh start');
      existing.dead = true;
      try { existing.ffmpeg.kill('SIGKILL'); } catch {}
    }
    const startReferences = (existing?.references || 0) + 1;

    // Pre-flight: quick HEAD check to detect auth failures before spawning ffmpeg
    try {
      const mod = url.startsWith('https') ? https : http;
      await new Promise((resolve, reject) => {
        const u = new URL(url);
        const probe = mod.request({ host: u.hostname, port: u.port || (url.startsWith('https') ? 443 : 80), path: u.pathname + u.search, method: 'HEAD', timeout: 8000, headers: { 'User-Agent': ua } }, (r) => {
          logger.info({ streamKey, status: r.statusCode }, `[hls] Pre-flight: ${r.statusCode}`);
          r.resume();
          if (r.statusCode === 401 || r.statusCode === 403) {
            return reject(new Error(`Source returned ${r.statusCode} — authentication required`));
          }
          resolve();
        });
        probe.on('error', reject);
        probe.on('timeout', () => { probe.destroy(); reject(new Error('Source not reachable (timeout)')); });
        probe.end();
      });
    } catch (preflightErr) {
      logger.warn({ streamKey, err: preflightErr.message }, '[hls] Pre-flight check failed');
      return res.status(502).json({ error: `Cannot reach stream source: ${preflightErr.message}` });
    }

    // Another request (or a poll-triggered respawn) may have spawned a fresh
    // pipeline while the pre-flight was running — reuse it instead of
    // spawning a second ffmpeg into the same directory.
    const current = hlsStreams.get(streamKey);
    if (current && current.ffmpeg && !current.dead && current !== existing) {
      current.references++;
      current.lastAccess = Date.now();
      logger.debug({ streamKey, references: current.references }, '[hls] Reusing pipeline spawned during pre-flight');
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ playlistUrl: `/stream/hls/${streamId}/stream.m3u8`, type: 'hls' });
    }

    // Spawn ffmpeg and register the stream entry (also cleans any previous
    // generation's playlist/segments from the dir before starting).
    const playlistPath = path.join(streamDir, 'stream.m3u8');
    await startHlsProcess({
      streamKey,
      streamId,
      streamDir,
      playlistPath,
      url,
      userId,
      username,
      profile,
      userAgentValue: ua,
      references: startReferences,
    });

    // Wait for ffmpeg to write the first segment before returning the URL.
    // HLS.js gives up after ~3 empty polls — we must not hand it an empty playlist.
    const playlistUrl = `/stream/hls/${streamId}/stream.m3u8`;
    const maxWait = 15_000;
    const pollMs = 500;
    let waited = 0;
    const waitForPlaylist = () => new Promise((resolve) => {
      const check = () => {
        try {
          if (fs.existsSync(playlistPath) && fs.statSync(playlistPath).size > 60) return resolve();
        } catch {}
        waited += pollMs;
        if (waited >= maxWait) return resolve(); // give up, return stub
        setTimeout(check, pollMs);
      };
      check();
    });
    await waitForPlaylist();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ playlistUrl, type: 'hls' });

    req.on('close', () => {
      const info = hlsStreams.get(streamKey);
      if (info) {
        info.references = Math.max(0, info.references - 1);
        info.lastAccess = Date.now();
        logger.debug({ streamKey, references: info.references }, '[hls] Client disconnected (request close)');
      }
    });
  });

  // Stop an HLS stream — accepts both { streamKey } and { url } formats
  function stopHlsStream(lookup) {
    // Direct streamKey lookup
    if (lookup.streamKey) {
      const info = hlsStreams.get(lookup.streamKey);
      if (info) { killHls(info, lookup.streamKey); return true; }
    }
    // URL-based lookup: compute hash and try
    if (lookup.url) {
      const userId = lookup.userId || 1;
      const hash = crypto.createHash('sha256').update(lookup.url).digest('hex').slice(0, 16);
      const key = `${userId}::${userId}_${hash}`;
      const info = hlsStreams.get(key);
      if (info) { killHls(info, key); return true; }
    }
    return false;
  }

  function killHls(info, key) {
    info.references = Math.max(0, info.references - 1);
    if (info.references <= 0) {
      if (!info.ffmpeg || info.ffmpeg.exitCode !== null) {
        // Tombstoned entry (process already dead) — finish the cleanup the
        // tombstone close handler deliberately skipped.
        logger.info({ streamKey: key, reason: 'tombstone cleanup' }, '[hls] Removing dead stream entry');
        hlsStreams.delete(key);
        hlsStreamByDir.delete(info.streamId);
        activeStreamProcesses.delete(key);
        broadcastAdminActivity(sseClients);
        try { fs.rmSync(info.streamDir, { recursive: true, force: true }); } catch {}
        return;
      }
      const ageSec = ((Date.now() - info.createdAt) / 1000).toFixed(1);
      logger.info({ streamKey: key, ageSec, reason: info.stopped ? 'inactivity' : 'explicit stop' }, '[hls] Killing ffmpeg');
      info.stopped = true;
      info.ffmpeg.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (info.ffmpeg.exitCode === null) {
          logger.warn({ streamKey: key }, '[hls] SIGTERM timed out — sending SIGKILL');
          try { info.ffmpeg.kill('SIGKILL'); } catch {}
        }
      }, 5000);
      timer.unref();
    }
  }

  // Singleton cleanup interval — runs once at module level, not per request
  setInterval(() => {
    const now = Date.now();
    let inactiveCount = 0;
    for (const [key, info] of hlsStreams) {
      if (info.references <= 0 && (now - info.lastAccess > HLS_INACTIVITY_TIMEOUT)) {
        inactiveCount++;
        logger.info({ streamKey: key, idleSec: ((now - info.lastAccess) / 1000).toFixed(0) }, '[hls] Cleaning up inactive stream');
        killHls(info, key);
      }
    }
    if (inactiveCount > 0) {
      logger.info({ inactiveCount, totalTracked: hlsStreams.size }, '[hls] Cleanup tick complete');
    }
  }, HLS_CLEANUP_INTERVAL).unref();

  function killAllHlsStreams() {
    for (const [key, info] of hlsStreams) {
      logger.info({ streamKey: key }, 'Shutting down HLS stream');
      killHls(info, key);
    }
  }

  router.post('/hls/stop', (req, res) => {
    stopHlsStream(req.body);
    res.json({ success: true });
  });

  // Also handle the legacy /stream/stop path — the frontend sends this
  router.post('/stop', (req, res, next) => {
    const found = stopHlsStream({ url: req.body.url });
    if (!found) return next(); // fall through to legacy handler for old-style streams
    res.json({ success: true });
  });

  router.killAllHlsStreams = killAllHlsStreams;

  // --- Legacy ffmpeg stream proxy (GET /stream) ---
  router.get('/', (req, res, next) => {
    const { url: streamUrl, profileId, userAgentId, vodName, vodLogo, castToken } = req.query;

    // Allow cast token auth
    if (castToken) {
      const td = activeCastTokens?.get(castToken);
      if (!td || td.expiresAt < Date.now()) {
        if (td) activeCastTokens?.delete(castToken);
        return res.status(401).send('Invalid or expired cast token');
      }
      req.session = req.session || {};
      req.session.userId = td.userId;
      req.session.username = 'Cast User';
    }

    if (!req.session?.userId) {
      const ip = (req.clientIp || req.ip || '').split(',')[0].trim();
      const isLocal = ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.');
      if (!isLocal) return res.status(401).json({ error: 'Authentication required.' });
      req.session = req.session || {};
      req.session.userId = -1;
      req.session.username = 'Local';
    }

    const userId = req.session.userId;
    const username = req.session.username;
    const streamKey = `${userId}::${streamUrl}::${profileId}`;

    const existing = activeStreamProcesses.get(streamKey);
    if (existing) {
      existing.references++;
      existing.lastAccess = Date.now();
      existing.process.stdout.pipe(res);
      req.on('close', () => {
        existing.references--;
        existing.lastAccess = Date.now();
      });
      return;
    }

    if (!streamUrl) return res.status(400).send('Error: url query parameter is required.');

    const settings = getSettings();
    let profile = (settings.streamProfiles || []).find(p => p.id === profileId)
      || (settings.castProfiles || []).find(p => p.id === profileId);
    if (!profile) return res.status(404).send(`Stream profile "${profileId}" not found.`);

    if (profile.command === 'redirect') return res.redirect(302, streamUrl);

    const userAgent = (settings.userAgents || []).find(ua => ua.id === userAgentId);
    if (!userAgent) return res.status(404).send(`User agent "${userAgentId}" not found.`);

    let channelName, channelId, channelLogo;
    if (vodName) {
      channelName = vodName; channelLogo = vodLogo || null; channelId = null;
    } else {
      const m3uContent = fs.existsSync(LIVE_CHANNELS_M3U_PATH) ? fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8') : '';
      const allChannels = parseM3U(m3uContent);
      const ch = allChannels.find(c => c.url === streamUrl);
      channelName = ch ? (ch.displayName || ch.name) : 'Direct Stream';
      channelId = ch ? ch.id : null;
      channelLogo = ch ? ch.logo : null;
    }
    const streamProfileName = profile.name || 'Unknown Profile';

    const commandTemplate = `-v level+${settings.playerLogLevel} ` + profile.command
      .replace(/{streamUrl}/g, streamUrl)
      .replace(/{userAgent}|{clientUserAgent}/g, userAgent.value);
    const parsedArgs = (commandTemplate.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(a => a.replace(/^"|"$/g, ''));
    const args = injectInputFlags(parsedArgs, env.FFMPEG_INPUT_TIMEOUT_MS);

    logger.info({ streamKey, args: args.join(' ') }, 'Starting legacy ffmpeg stream');
    const ffmpeg = spawn('ffmpeg', args);
    const startTime = new Date().toISOString();

    // Log stream history (non-critical, fire and forget)
    try {
      const result = db.prepare(
        "INSERT INTO stream_history (user_id, username, channel_id, channel_name, start_time, status, client_ip, channel_logo, stream_profile_name) VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?)"
      ).run(userId, username, channelId, channelName, startTime, req.clientIp, channelLogo, streamProfileName);
      const historyId = result.lastInsertRowid;

      const info = {
        process: ffmpeg, references: 1, lastAccess: Date.now(),
        userId, username, channelId, channelName, channelLogo,
        streamProfileName, startTime, historyId,
        clientIp: req.clientIp, streamKey, isTranscoded: true,
      };
      activeStreamProcesses.set(streamKey, info);
      broadcastAdminUpdate(sseClients, activeStreamProcesses, activeRedirectStreams);
    } catch {}

    if (profile.command.includes('-f mp4')) res.setHeader('Content-Type', 'video/mp4');
    else res.setHeader('Content-Type', 'video/mp2t');

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', (data) => logger.debug({ streamKey, ffmpeg: data.toString().trim().slice(0, 200) }));

    const cleanup = () => {
      const info = activeStreamProcesses.get(streamKey);
      if (info?.historyId) {
        const endTime = new Date().toISOString();
        const duration = Math.round((new Date(endTime).getTime() - new Date(info.startTime).getTime()) / 1000);
        db.prepare("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'").run(endTime, duration, info.historyId);
      }
      activeStreamProcesses.delete(streamKey);
      broadcastAdminUpdate(sseClients, activeStreamProcesses, activeRedirectStreams);
    };

    ffmpeg.on('close', (code) => { cleanup(); if (!res.headersSent) res.status(500).send('FFmpeg ended unexpectedly.'); else res.end(); });
    ffmpeg.on('error', (err) => { logger.error({ streamKey, err }); cleanup(); if (!res.headersSent) res.status(500).send('Failed to start streaming.'); });

    req.on('close', () => {
      const info = activeStreamProcesses.get(streamKey);
      if (info) { info.references--; info.lastAccess = Date.now(); }
    });
  });

  // HEAD probe for Shaka Player
  router.head('/', (req, res) => {
    const { profileId } = req.query;
    const settings = getSettings();
    const profile = (settings.streamProfiles || []).find(p => p.id === profileId)
      || (settings.castProfiles || []).find(p => p.id === profileId);
    if (!profile) return res.status(404).end();
    if (profile.command.includes('-f mp4')) res.setHeader('Content-Type', 'video/mp4');
    else res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length');
    res.status(200).end();
  });
  return router;
}
