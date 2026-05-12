import { Router } from 'express';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger.js';
import { DATA_DIR } from '../config/index.js';

const HLS_DIR = path.join(DATA_DIR, 'hls');
const HLS_SEGMENT_TIME = 2;
const HLS_LIST_SIZE = 5;

// Track active HLS streams: streamKey -> { ffmpeg, url, userId, createdAt, references }
const hlsStreams = new Map();

export function createStreamRoutes({ getSettings, activeStreamProcesses, db, sseClients }) {
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

    logger.info({ streamKey, url: url.slice(0, 80), args: ffmpegArgs.join(' ') }, 'Starting HLS stream');

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ffmpeg.stderr.on('data', (data) => {
      logger.info({ streamKey, msg: data.toString().trim().slice(0, 200) }, 'ffmpeg');
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

    ffmpeg.on('close', (code) => {
      logger.info({ streamKey, code }, 'HLS stream ended');
      hlsStreams.delete(streamKey);
      activeStreamProcesses.delete(streamKey);
      broadcastAdminActivity(sseClients);
      // Clean up segments
      try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch {}
    });

    ffmpeg.on('error', (err) => {
      logger.error({ streamKey, err }, 'HLS stream error');
      // close handler will fire next and clean up
    });

    res.json({ playlistUrl: `/stream/hls/${streamId}/stream.m3u8`, type: 'hls' });
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
      info.stopped = true;
      info.ffmpeg.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (info.ffmpeg.exitCode === null) {
          try { info.ffmpeg.kill('SIGKILL'); } catch {}
        }
      }, 5000);
      timer.unref();
    }
  }

  // Singleton cleanup interval — runs once at module level, not per request
  setInterval(() => {
    const now = Date.now();
    for (const [key, info] of hlsStreams) {
      if (info.references <= 0 && (now - info.lastAccess > 300_000)) {
        logger.info({ streamKey: key }, 'Cleaning up inactive HLS stream');
        killHls(info, key);
      }
    }
  }, 300_000).unref();

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
  return router;
}
