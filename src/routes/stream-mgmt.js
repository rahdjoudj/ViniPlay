import { Router } from 'express';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { broadcastAdminUpdate } from './_sse-utils.js';

export function createStreamMgmtRoutes({ db, activeStreamProcesses, activeRedirectStreams, sseClients }) {
  const router = Router();

  // Manually stop a transcoded stream
  router.post('/stream/stop', requireAuth, (req, res) => {
    const { url: streamUrl, profileId } = req.body;
    let streamKey;

    if (!streamUrl) {
      return res.status(400).json({ error: 'Stream URL is required to stop the stream.' });
    }

    if (profileId) {
      streamKey = `${req.session.userId}::${streamUrl}::${profileId}`;
    } else {
      const partialKey = `${req.session.userId}::${streamUrl}`;
      if (activeStreamProcesses.has(partialKey)) {
        streamKey = partialKey;
      } else {
        for (const key of activeStreamProcesses.keys()) {
          if (key.startsWith(partialKey + '::')) { streamKey = key; break; }
        }
      }
      if (!streamKey) streamKey = partialKey;
    }

    const info = activeStreamProcesses.get(streamKey);
    if (!info) {
      return res.json({ success: true, message: 'No active stream to stop.' });
    }

    if (info.references > 1) {
      return res.json({ success: true, message: 'Stream kept alive for other active clients.' });
    }

    logger.info({ streamKey, userId: req.session.userId }, 'Stopping stream');
    try {
      if (info.historyId) {
        const endTime = new Date().toISOString();
        const duration = Math.round((new Date(endTime).getTime() - new Date(info.startTime).getTime()) / 1000);
        db.prepare("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'").run(endTime, duration, info.historyId);
      }
      info.process.kill('SIGKILL');
      activeStreamProcesses.delete(streamKey);
      activeRedirectStreams.delete(streamKey);
      broadcastAdminUpdate(sseClients, activeStreamProcesses, activeRedirectStreams);
    } catch (e) {
      logger.warn({ streamKey, err: e }, 'Could not kill stream process');
    }
    res.json({ success: true, message: `Stream terminated.` });
  });

  // Log redirect stream start for admin tracking
  router.post('/activity/start-redirect', requireAuth, (req, res) => {
    const { streamUrl: _streamUrl, channelId, channelName, channelLogo } = req.body;
    const userId = req.session.userId;
    const username = req.session.username;
    const clientIp = req.clientIp;
    const startTime = new Date().toISOString();

    const result = db.prepare(
      "INSERT INTO stream_history (user_id, username, channel_id, channel_name, start_time, status, client_ip, channel_logo, stream_profile_name) VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?)"
    ).run(userId, username, channelId, channelName, startTime, clientIp, channelLogo, 'Redirect');

    const historyId = result.lastInsertRowid;
    const streamKey = `${userId}::${historyId}`;
    activeRedirectStreams.set(streamKey, {
      streamKey, userId, username, channelId, channelName, channelLogo,
      streamProfileName: 'Redirect', startTime, clientIp, isTranscoded: false, historyId,
    });
    broadcastAdminUpdate(sseClients, activeStreamProcesses, activeRedirectStreams);
    res.status(201).json({ success: true, historyId });
  });

  // Log redirect stream stop for admin tracking
  router.post('/activity/stop-redirect', requireAuth, (req, res) => {
    const { historyId } = req.body;
    if (!historyId) return res.status(400).json({ error: 'History ID is required.' });

    const streamKey = `${req.session.userId}::${historyId}`;
    if (activeRedirectStreams.has(streamKey)) {
      activeRedirectStreams.delete(streamKey);
      broadcastAdminUpdate(sseClients, activeStreamProcesses, activeRedirectStreams);
    }

    const row = db.prepare('SELECT start_time FROM stream_history WHERE id = ? AND user_id = ?').get(historyId, req.session.userId);
    if (!row) return res.status(200).json({ success: true, message: 'Stream stopped, history record not found.' });

    const endTime = new Date().toISOString();
    const duration = Math.round((new Date(endTime).getTime() - new Date(row.start_time).getTime()) / 1000);
    db.prepare("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND end_time IS NULL").run(endTime, duration, historyId);
    res.json({ success: true });
  });

  return router;
}
