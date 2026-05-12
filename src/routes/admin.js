import { Router } from 'express';
import si from 'systeminformation';
import { logger } from '../config/logger.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { sendSseEvent, broadcastAdminUpdate, broadcastSseToAll } from './_sse-utils.js';

export function createAdminRoutes({ db, activeStreamProcesses, activeRedirectStreams, sseClients }) {
  const router = Router();

  router.get('/admin/activity', requireAuth, requireAdmin, (req, res) => {
    try {
      const liveActivity = [
        ...Array.from(activeStreamProcesses.values()).map(info => ({
          streamKey: info.streamKey,
          userId: info.userId,
          username: info.username,
          channelName: info.channelName,
          channelLogo: info.channelLogo,
          streamProfileName: info.streamProfileName,
          startTime: info.startTime,
          clientIp: info.clientIp,
          isTranscoded: true,
        })),
        ...Array.from(activeRedirectStreams.values()).map(info => ({
          streamKey: `${info.userId}::${info.historyId}`,
          userId: info.userId,
          username: info.username,
          channelName: info.channelName,
          channelLogo: info.channelLogo,
          streamProfileName: info.streamProfileName,
          startTime: info.startTime,
          clientIp: info.clientIp,
          isTranscoded: false,
        })),
      ];

      const page = parseInt(req.query.page, 10) || 1;
      const pageSize = parseInt(req.query.pageSize, 10) || 25;
      const search = req.query.search || '';
      const dateFilter = req.query.dateFilter || 'all';
      const customStart = req.query.startDate;
      const customEnd = req.query.endDate;
      const offset = (page - 1) * pageSize;

      const clauses = [];
      const params = [];

      if (search) {
        clauses.push('(username LIKE ? OR channel_name LIKE ? OR client_ip LIKE ? OR stream_profile_name LIKE ?)');
        const s = `%${search}%`;
        params.push(s, s, s, s);
      }

      const now = new Date();
      if (dateFilter === '24h') { clauses.push('start_time >= ?'); params.push(new Date(now.getTime() - 86400000).toISOString()); }
      else if (dateFilter === '7d') { clauses.push('start_time >= ?'); params.push(new Date(now.getTime() - 604800000).toISOString()); }
      else if (dateFilter === 'custom' && customStart && customEnd) {
        clauses.push('start_time BETWEEN ? AND ?');
        params.push(new Date(customStart).toISOString(), new Date(customEnd).toISOString());
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

      const totalRow = db.prepare(`SELECT COUNT(*) as total FROM stream_history ${where}`).get(...params);
      const totalItems = totalRow.total;

      const items = db.prepare(`SELECT * FROM stream_history ${where} ORDER BY start_time DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset);

      res.json({
        live: liveActivity,
        history: { items, totalItems, totalPages: Math.ceil(totalItems / pageSize), currentPage: page, pageSize },
      });
    } catch (err) {
      logger.error({ err }, 'Admin activity fetch failed');
      res.status(500).json({ error: 'Could not retrieve stream activity.' });
    }
  });

  router.post('/admin/stop-stream', requireAuth, requireAdmin, (req, res) => {
    const { streamKey } = req.body;
    if (!streamKey) return res.status(400).json({ error: 'A streamKey is required.' });

    const info = activeStreamProcesses.get(streamKey);
    if (!info) return res.status(404).json({ error: 'Active stream not found.' });

    logger.info({ admin: req.session.username, streamKey, targetUser: info.username }, 'Admin stopping stream');
    try {
      if (info.historyId) {
        const endTime = new Date().toISOString();
        const duration = Math.round((new Date(endTime).getTime() - new Date(info.startTime).getTime()) / 1000);
        db.prepare("UPDATE stream_history SET end_time = ?, duration_seconds = ?, status = 'stopped' WHERE id = ? AND status = 'playing'").run(endTime, duration, info.historyId);
      }
      info.process.kill('SIGKILL');
      activeStreamProcesses.delete(streamKey);
      broadcastAdminUpdate(sseClients, activeStreamProcesses, activeRedirectStreams);
      res.json({ success: true, message: `Stream terminated for user ${info.username}.` });
    } catch (e) {
      logger.error({ err: e }, 'Admin stop stream failed');
      res.status(500).json({ error: 'Failed to terminate stream process.' });
    }
  });

  router.post('/admin/change-stream', requireAuth, requireAdmin, (req, res) => {
    const { userId: userIdString, streamKey, channel } = req.body;
    const userId = parseInt(userIdString, 10);
    if (!userId || !streamKey || !channel) {
      return res.status(400).json({ error: 'User ID, stream key, and channel data are required.' });
    }

    const info = activeStreamProcesses.get(streamKey);
    if (!info || info.userId !== userId) {
      return res.status(404).json({ error: 'The specified stream is not active for this user.' });
    }

    logger.info({ admin: req.session.username, targetUser: info.username, channel: channel.name }, 'Admin changing channel');
    sendSseEvent(sseClients, userId, 'change-channel', { channel });
    res.json({ success: true, message: `Change channel command sent to user ${info.username}.` });
  });

  router.get('/admin/system-health', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const [cpu, mem, fs] = await Promise.all([si.currentLoad(), si.mem(), si.fsSize()]);
      const dataDisk = fs.find(d => d.mount === '/data') || {};
      const dvrDisk = fs.find(d => d.mount === '/dvr') || {};
      res.json({
        cpu: { load: cpu.currentLoad.toFixed(2) },
        memory: { total: mem.total, used: mem.active, percent: ((mem.active / mem.total) * 100).toFixed(2) },
        disks: {
          data: { total: dataDisk.size || 0, used: dataDisk.used || 0, percent: dataDisk.use || 0 },
          dvr: { total: dvrDisk.size || 0, used: dvrDisk.used || 0, percent: dvrDisk.use || 0 },
        },
      });
    } catch (e) {
      logger.error({ err: e }, 'System health fetch failed');
      res.status(500).json({ error: 'Could not retrieve system health.' });
    }
  });

  router.get('/admin/analytics', requireAuth, requireAdmin, (_req, res) => {
    try {
      const topChannels = db.prepare(
        'SELECT channel_name, SUM(duration_seconds) as total_duration FROM stream_history WHERE channel_name IS NOT NULL AND duration_seconds IS NOT NULL GROUP BY channel_name ORDER BY total_duration DESC LIMIT 5'
      ).all();
      const topUsers = db.prepare(
        'SELECT username, SUM(duration_seconds) as total_duration FROM stream_history WHERE duration_seconds IS NOT NULL GROUP BY username ORDER BY total_duration DESC LIMIT 5'
      ).all();
      res.json({ topChannels, topUsers });
    } catch (e) {
      logger.error({ err: e }, 'Analytics fetch failed');
      res.status(500).json({ error: 'Could not retrieve analytics.' });
    }
  });

  router.post('/admin/broadcast', requireAuth, requireAdmin, (req, res) => {
    const { message } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
    broadcastSseToAll(sseClients, 'broadcast-message', { message: message.trim(), sender: req.session.username });
    logger.info({ admin: req.session.username }, 'Broadcast sent');
    res.json({ success: true, message: 'Broadcast sent successfully.' });
  });

  return router;
}
