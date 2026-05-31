import { Router } from 'express';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger.js';
import { DATA_DIR, LIVE_CHANNELS_M3U_PATH } from '../config/index.js';
import { broadcastAdminUpdate } from './_sse-utils.js';

const HLS_DIR = path.join(DATA_DIR, 'hls');
const HLS_SEGMENT_TIME = 2;
const HLS_LIST_SIZE = 5;
const HLS_INACTIVITY_TIMEOUT = 30_000;
const HLS_CLEANUP_INTERVAL = 30_000;

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

  // Serve HLS playlist (.m3u8)
  router.get('/hls/:streamId/stream.m3u8', (req, res) => {
    const playlistPath = path.resolve(HLS_DIR, req.params.streamId, 'stream.m3u8');
    if (!playlistPath.startsWith(HLS_DIR + path.sep)) return res.status(403).send('Forbidden');
    if (!fs.existsSync(playlistPath)) {
      return res.status(404).send('Stream not found or has ended.');
    }

    const streamKey = hlsStreamByDir.get(req.params.streamId);
    const info = streamKey ? hlsStreams.get(streamKey) : null;
    if (info) info.lastAccess = Date.now();

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(playlistPath);
  });

  // Serve HLS segments (.ts)
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
    res.sendFile(segPath);
  });

  // Start or get an HLS stream
  router.get('/hls', (req, res) => {
    const { url, profileId, userAgentId } = req.query;
    const userId = req.session?.userId;
    const username = req.session?.username;

    if (!url) return res.status(400).json({ error: 'url query parameter is required.' });
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });

    const settings = getSettings();
    const profile = (settings.streamProfiles || []).find(p => p.id === profileId);
    const userAgent = (settings.userAgents || []).find(ua => ua.id === userAgentId);

    // Build ffmpeg args — copy codecs to avoid re-encode, output HLS
    const ua = userAgent?.value || 'VLC/3.0';
    const urlHash = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const streamId = `${userId}_${urlHash}`;
    const streamKey = `${userId}::${streamId}`;
    const streamDir = path.join(HLS_DIR, streamId);

    // If already streaming, return playlist URL
    const existing = hlsStreams.get(streamKey);
    if (existing) {
      existing.references++;
      existing.lastAccess = Date.now();
      logger.debug({ streamKey, references: existing.references }, '[hls] Reusing existing stream');
      return res.json({ playlistUrl: `/stream/hls/${streamId}/stream.m3u8`, type: 'hls' });
    }

    // Create stream directory and an initial empty playlist so HLS.js never gets 404
    if (!fs.existsSync(streamDir)) fs.mkdirSync(streamDir, { recursive: true });
    const playlistPath = path.join(streamDir, 'stream.m3u8');
    // Minimal live playlist so HLS.js keeps polling until ffmpeg writes the real one
    fs.writeFileSync(playlistPath, '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n');

    // Build ffmpeg HLS command
    // Build ffmpeg HLS command using the user's profile template
    let cmdTemplate = (profile?.command || '-i {streamUrl} -c copy')
      .replace(/{streamUrl}/g, url)
      .replace(/{userAgent}|{clientUserAgent}/g, ua);
    // Strip old output directives (pipe, file) — we replace with HLS
    cmdTemplate = cmdTemplate.replace(/-f\s+\S+\s+pipe:\d?\s*$/, '').trim();
    cmdTemplate = cmdTemplate.replace(/-f\s+\S+\s+\S+\s*$/, '').trim();
    const profileArgs = (cmdTemplate.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(a => a.replace(/^"|"$/g, ''));

    const ffmpegArgs = [
      '-v', 'level+error',
      ...profileArgs,
      '-f', 'hls',
      '-hls_time', String(HLS_SEGMENT_TIME),
      '-hls_list_size', String(HLS_LIST_SIZE),
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', path.join(streamDir, 'segment_%05d.ts'),
      path.join(streamDir, 'stream.m3u8'),
    ];

    logger.info({ streamKey, url: url.slice(0, 80), profile: profile?.name || 'default', args: ffmpegArgs.join(' ') }, '[hls] Starting ffmpeg');

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const startTime = Date.now();
    let lastStderrLog = 0;
    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (!msg) return;
      const now = Date.now();
      // Rate-limit non-error stderr to once per 5s; always log errors immediately
      const isError = /error|fail|invalid|unable|cannot|refused|timed?out/i.test(msg);
      if (isError || now - lastStderrLog > 5000) {
        lastStderrLog = now;
        logger[isError ? 'warn' : 'info']({ streamKey, msg: msg.slice(0, 300) }, isError ? '[hls] ffmpeg stderr (warning)' : '[hls] ffmpeg');
      }
    });

    const streamInfo = {
      ffmpeg,
      url,
      userId,
      username,
      streamKey,
      streamId,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      references: 1,
      streamDir,
    };

    hlsStreams.set(streamKey, streamInfo);
    hlsStreamByDir.set(streamId, streamKey);

    // Register in shared activeStreamProcesses so admins/janitor can see HLS activity
    const activeInfo = {
      process: ffmpeg,
      references: 1,
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
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info({ streamKey, code, signal, durationSec: duration }, '[hls] ffmpeg process exited');
      hlsStreams.delete(streamKey);
      hlsStreamByDir.delete(streamId);
      activeStreamProcesses.delete(streamKey);
      broadcastAdminActivity(sseClients);
      try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch {}
    });

    ffmpeg.on('error', (err) => {
      logger.error({ streamKey, err: err.message }, '[hls] ffmpeg spawn error');
    });

    ffmpeg.on('spawn', () => {
      logger.debug({ streamKey, pid: ffmpeg.pid }, '[hls] ffmpeg process spawned');
    });

    res.json({ playlistUrl: `/stream/hls/${streamId}/stream.m3u8`, type: 'hls' });

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
    const args = (commandTemplate.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(a => a.replace(/^"|"$/g, ''));

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
