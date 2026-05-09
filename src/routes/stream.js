import { Router } from 'express';
import { spawn } from 'child_process';
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

  // Ensure HLS directory exists
  if (!fs.existsSync(HLS_DIR)) fs.mkdirSync(HLS_DIR, { recursive: true });

  // Serve HLS playlist (.m3u8)
  router.get('/hls/:streamId/stream.m3u8', (req, res) => {
    const playlistPath = path.join(HLS_DIR, req.params.streamId, 'stream.m3u8');
    if (!fs.existsSync(playlistPath)) {
      return res.status(404).send('Stream not found or has ended.');
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(playlistPath);
  });

  // Serve HLS segments (.ts)
  router.get('/hls/:streamId/:segment', (req, res) => {
    const segPath = path.join(HLS_DIR, req.params.streamId, req.params.segment);
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
    const streamId = `${userId}_${Buffer.from(url).toString('base64').slice(0, 64)}`;
    const streamKey = `${userId}::${streamId}`;
    const streamDir = path.join(HLS_DIR, streamId);

    // If already streaming, return playlist URL
    const existing = hlsStreams.get(streamKey);
    if (existing) {
      existing.references++;
      existing.lastAccess = Date.now();
      return res.json({ playlistUrl: `/stream/hls/${streamId}/stream.m3u8`, type: 'hls' });
    }

    // Create stream directory
    if (!fs.existsSync(streamDir)) fs.mkdirSync(streamDir, { recursive: true });

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
      ...profileArgs,
      '-f', 'hls',
      '-hls_time', String(HLS_SEGMENT_TIME),
      '-hls_list_size', String(HLS_LIST_SIZE),
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', path.join(streamDir, 'segment_%05d.ts'),
      path.join(streamDir, 'stream.m3u8'),
    ];

    logger.info({ streamKey, url: url.slice(0, 80) }, 'Starting HLS stream');

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'ignore', 'pipe'],
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

    ffmpeg.stderr.on('data', (data) => {
      logger.debug({ streamKey, msg: data.toString().trim() }, 'ffmpeg:hls');
    });

    ffmpeg.on('close', (code) => {
      logger.info({ streamKey, code }, 'HLS stream ended');
      hlsStreams.delete(streamKey);
      // Clean up segments
      try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch {}
    });

    ffmpeg.on('error', (err) => {
      logger.error({ streamKey, err }, 'HLS stream error');
      hlsStreams.delete(streamKey);
      try { fs.rmSync(streamDir, { recursive: true, force: true }); } catch {}
    });

    // Cleanup stale streams every 5 minutes
    setInterval(() => {
      const now = Date.now();
      for (const [key, info] of hlsStreams) {
        if (info.references <= 0 && (now - info.lastAccess > 300_000)) {
          logger.info({ streamKey: key }, 'Cleaning up inactive HLS stream');
          info.ffmpeg.kill('SIGTERM');
          hlsStreams.delete(key);
          try { fs.rmSync(info.streamDir, { recursive: true, force: true }); } catch {}
        }
      }
    }, 300_000).unref();

    res.json({ playlistUrl: `/stream/hls/${streamId}/stream.m3u8`, type: 'hls' });
  });

  // Stop an HLS stream
  router.post('/hls/stop', (req, res) => {
    const { streamKey } = req.body;
    const info = hlsStreams.get(streamKey);
    if (info) {
      info.references = Math.max(0, info.references - 1);
      if (info.references <= 0) {
        info.ffmpeg.kill('SIGTERM');
        hlsStreams.delete(streamKey);
        try { fs.rmSync(info.streamDir, { recursive: true, force: true }); } catch {}
      }
    }
    res.json({ success: true });
  });

  return router;
}
