import { Router } from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import schedule from 'node-schedule';
import { logger } from '../config/logger.js';
import { DVR_DIR, LIVE_CHANNELS_M3U_PATH } from '../config/index.js';
import { requireAuth, requireDvrAccess } from '../middleware/auth.js';

export function createDvrRoutes({ db, getSettings, activeDvrJobs, parseM3U }) {
  const router = Router();
  const runningFFmpegProcesses = new Map();

  // --- DVR Engine ---
  function stopRecording(jobId) {
    const pid = runningFFmpegProcesses.get(jobId);
    if (!pid) return;
    logger.info({ jobId, pid }, 'Stopping DVR recording');
    try { process.kill(pid, 'SIGINT'); } catch {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  }

  async function startRecording(job) {
    logger.info({ jobId: job.id, title: job.programTitle }, 'Starting DVR recording');
    const settings = getSettings();
    const m3uContent = fs.existsSync(LIVE_CHANNELS_M3U_PATH) ? fs.readFileSync(LIVE_CHANNELS_M3U_PATH, 'utf-8') : '';
    const allChannels = parseM3U(m3uContent);
    const channel = allChannels.find(c => c.id === job.channelId);

    const fail = (msg) => {
      logger.error({ jobId: job.id, msg }, 'DVR recording failed to start');
      db.prepare("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?").run(msg, job.id);
    };

    if (!channel) return fail(`Channel ID ${job.channelId} not found in M3U.`);

    const recProfile = (settings.dvr?.recordingProfiles || []).find(p => p.id === job.profileId);
    if (!recProfile) return fail(`Recording profile ID "${job.profileId}" not found.`);

    const userAgent = (settings.userAgents || []).find(ua => ua.id === job.userAgentId);
    if (!userAgent) return fail('User agent not found.');

    const streamUrlToRecord = channel.url;
    if (!/^https?:\/\/.+/.test(streamUrlToRecord)) return fail(`Invalid stream URL: ${streamUrlToRecord}`);

    const fileExtension = recProfile.command.includes('-f mp4') ? '.mp4' : '.ts';
    const safeFilename = `${job.id}_${job.programTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}${fileExtension}`;
    const fullFilePath = path.join(DVR_DIR, safeFilename);

    const commandTemplate = `-v level+${settings.dvrLogLevel} ` + recProfile.command
      .replace(/{streamUrl}/g, streamUrlToRecord)
      .replace(/{userAgent}/g, userAgent.value)
      .replace(/{filePath}/g, fullFilePath);

    const args = (commandTemplate.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(a => a.replace(/^"|"$/g, ''));

    logger.info({ jobId: job.id, args: args.join(' ') }, 'Spawning ffmpeg for DVR');
    const ffmpeg = spawn('ffmpeg', args);
    runningFFmpegProcesses.set(job.id, ffmpeg.pid);
    db.prepare("UPDATE dvr_jobs SET status = 'recording', ffmpeg_pid = ?, filePath = ? WHERE id = ?").run(ffmpeg.pid, fullFilePath, job.id);

    let ffmpegErrorOutput = '';
    ffmpeg.stderr.on('data', (data) => {
      const line = data.toString().trim();
      logger.debug({ jobId: job.id, line: line.slice(0, 200) }, 'ffmpeg dvr');
      ffmpegErrorOutput += line + '\n';
    });

    ffmpeg.on('close', (code) => {
      runningFFmpegProcesses.delete(job.id);
      const wasStoppedIntentionally = ffmpegErrorOutput.includes('Exiting normally, received signal 2') || code === 255;
      const logMessage = (code === 0 || wasStoppedIntentionally) ? 'finished gracefully' : `exited with error code ${code}`;
      logger.info({ jobId: job.id, code, wasStoppedIntentionally }, logMessage);

      try { if (fs.existsSync(fullFilePath)) fs.chmodSync(fullFilePath, 0o666); } catch {}

      try {
        const stats = fs.statSync(fullFilePath);
        if ((code === 0 || wasStoppedIntentionally) && stats.size > 1024) {
          const durationSeconds = (new Date(job.endTime) - new Date(job.startTime)) / 1000;
          db.prepare(
            `INSERT INTO dvr_recordings (job_id, user_id, channelName, programTitle, startTime, durationSeconds, fileSizeBytes, filePath) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(job.id, job.user_id, job.channelName, job.programTitle, job.startTime, Math.round(durationSeconds), stats.size, fullFilePath);
          db.prepare("UPDATE dvr_jobs SET status = 'completed', ffmpeg_pid = NULL WHERE id = ?").run(job.id);
        } else {
          const errMsg = `Recording failed. FFmpeg exit code: ${code}. FFmpeg output: ${ffmpegErrorOutput.slice(-1000)}`;
          db.prepare("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?").run(errMsg, job.id);
          if (stats.size <= 1024) try { fs.unlinkSync(fullFilePath); } catch {}
        }
      } catch (statErr) {
        db.prepare("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?").run(`File stat error: ${statErr.message}`, job.id);
      }
    });

    ffmpeg.on('error', (err) => {
      const msg = `Failed to spawn ffmpeg process: ${err.message}`;
      logger.error({ jobId: job.id, err }, msg);
      runningFFmpegProcesses.delete(job.id);
      db.prepare("UPDATE dvr_jobs SET status = 'error', ffmpeg_pid = NULL, errorMessage = ? WHERE id = ?").run(msg, job.id);
    });
  }

  function scheduleDvrJob(job) {
    if (activeDvrJobs.has(job.id)) {
      const existing = activeDvrJobs.get(job.id);
      existing.startJob?.cancel();
      existing.stopJob?.cancel();
      activeDvrJobs.delete(job.id);
    }

    const startTime = new Date(job.startTime);
    const endTime = new Date(job.endTime);
    const now = new Date();

    if (endTime <= now) {
      logger.info({ jobId: job.id }, 'DVR job is in the past, skipping');
      if (job.status === 'scheduled') {
        db.prepare("UPDATE dvr_jobs SET status = 'error', errorMessage = 'Job was scheduled for a time in the past.' WHERE id = ?").run(job.id);
      }
      return;
    }

    const info = {};
    if (startTime > now) {
      info.startJob = schedule.scheduleJob(startTime, () => startRecording(job));
    } else {
      startRecording(job);
    }
    info.stopJob = schedule.scheduleJob(endTime, () => stopRecording(job.id));
    activeDvrJobs.set(job.id, info);
  }

  function checkForConflicts(newJob, userId) {
    const settings = getSettings();
    const maxConcurrent = settings.dvr?.maxConcurrentRecordings || 1;
    const scheduledJobs = db.prepare("SELECT * FROM dvr_jobs WHERE user_id = ? AND status = 'scheduled'").all(userId);
    const newStart = new Date(newJob.startTime).getTime();
    const newEnd = new Date(newJob.endTime).getTime();
    const conflicting = scheduledJobs.filter(j => {
      return newStart < new Date(j.endTime).getTime() && newEnd > new Date(j.startTime).getTime();
    });
    return conflicting.length >= maxConcurrent ? conflicting : [];
  }

  function autoDeleteOldRecordings() {
    logger.info('Running daily DVR auto-delete check');
    const users = db.prepare('SELECT id FROM users').all();
    for (const user of users) {
      const row = db.prepare("SELECT value FROM user_settings WHERE user_id = ? AND key = 'dvr'").get(user.id);
      const settings = getSettings();
      const userDvrSettings = row ? { ...settings.dvr, ...JSON.parse(row.value) } : settings.dvr;
      const deleteDays = userDvrSettings?.autoDeleteDays;
      if (!deleteDays || deleteDays <= 0) continue;

      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - deleteDays);

      const recordings = db.prepare('SELECT id, filePath FROM dvr_recordings WHERE user_id = ? AND startTime < ?').all(user.id, cutoff.toISOString());
      for (const rec of recordings) {
        if (fs.existsSync(rec.filePath)) {
          try { fs.unlinkSync(rec.filePath); } catch {}
        }
        db.prepare('DELETE FROM dvr_recordings WHERE id = ?').run(rec.id);
      }
    }
  }

  // --- DVR API Routes ---

  router.get('/dvr/timeshift/:jobId', requireAuth, requireDvrAccess, (req, res) => {
    const jobId = req.params.jobId;
    const userId = req.session.userId;
    const job = db.prepare('SELECT filePath, status FROM dvr_jobs WHERE id = ? AND user_id = ?').get(jobId, userId);
    if (!job) return res.status(404).send('Recording job not found or not authorized.');
    if (job.status !== 'recording') return res.status(400).send('Cannot timeshift a recording that is not in progress.');
    if (!job.filePath || !fs.existsSync(job.filePath)) return res.status(404).send('Recording file not found on disk.');

    const stat = fs.statSync(job.filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'bytes');

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
      res.setHeader('Content-Length', (end - start) + 1);
      fs.createReadStream(job.filePath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', fileSize);
      fs.createReadStream(job.filePath).pipe(res);
    }
  });

  router.post('/dvr/schedule', requireAuth, requireDvrAccess, (req, res) => {
    const { channelId, channelName, programTitle, programStart, programStop } = req.body;
    const settings = getSettings();
    const dvrSettings = settings.dvr || {};
    const preBuffer = (dvrSettings.preBufferMinutes || 0) * 60 * 1000;
    const postBuffer = (dvrSettings.postBufferMinutes || 0) * 60 * 1000;

    const newJob = {
      user_id: req.session.userId, channelId, channelName, programTitle,
      startTime: new Date(new Date(programStart).getTime() - preBuffer).toISOString(),
      endTime: new Date(new Date(programStop).getTime() + postBuffer).toISOString(),
      status: 'scheduled', profileId: dvrSettings.activeRecordingProfileId,
      userAgentId: settings.activeUserAgentId,
      preBufferMinutes: dvrSettings.preBufferMinutes || 0,
      postBufferMinutes: dvrSettings.postBufferMinutes || 0,
    };

    const conflicting = checkForConflicts(newJob, req.session.userId);
    if (conflicting.length > 0) return res.status(409).json({ error: 'Recording conflict detected.', newJob, conflictingJobs: conflicting });

    const result = db.prepare(
      `INSERT INTO dvr_jobs (user_id, channelId, channelName, programTitle, startTime, endTime, status, profileId, userAgentId, preBufferMinutes, postBufferMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newJob.user_id, newJob.channelId, newJob.channelName, newJob.programTitle, newJob.startTime, newJob.endTime, newJob.status, newJob.profileId, newJob.userAgentId, newJob.preBufferMinutes, newJob.postBufferMinutes);

    const jobWithId = { ...newJob, id: result.lastInsertRowid };
    scheduleDvrJob(jobWithId);
    res.status(201).json({ success: true, job: jobWithId });
  });

  router.post('/dvr/schedule/manual', requireAuth, requireDvrAccess, (req, res) => {
    const { channelId, channelName, startTime, endTime } = req.body;
    const settings = getSettings();
    const dvrSettings = settings.dvr || {};

    const newJob = {
      user_id: req.session.userId, channelId, channelName,
      programTitle: `Manual Recording: ${channelName}`,
      startTime, endTime, status: 'scheduled',
      profileId: dvrSettings.activeRecordingProfileId,
      userAgentId: settings.activeUserAgentId,
      preBufferMinutes: 0, postBufferMinutes: 0,
    };

    const conflicting = checkForConflicts(newJob, req.session.userId);
    if (conflicting.length > 0) return res.status(409).json({ error: 'Recording conflict detected.', newJob, conflictingJobs: conflicting });

    const result = db.prepare(
      `INSERT INTO dvr_jobs (user_id, channelId, channelName, programTitle, startTime, endTime, status, profileId, userAgentId, preBufferMinutes, postBufferMinutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newJob.user_id, newJob.channelId, newJob.channelName, newJob.programTitle, newJob.startTime, newJob.endTime, newJob.status, newJob.profileId, newJob.userAgentId, newJob.preBufferMinutes, newJob.postBufferMinutes);

    const jobWithId = { ...newJob, id: result.lastInsertRowid };
    scheduleDvrJob(jobWithId);
    res.status(201).json({ success: true, job: jobWithId });
  });

  router.get('/dvr/jobs', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
      res.json(db.prepare('SELECT j.*, u.username FROM dvr_jobs j JOIN users u ON j.user_id = u.id ORDER BY j.startTime DESC').all());
    } else if (req.session.canUseDvr) {
      const rows = db.prepare('SELECT * FROM dvr_jobs WHERE user_id = ? ORDER BY startTime DESC').all(req.session.userId);
      res.json(rows.map(r => ({ ...r, username: req.session.username })));
    } else {
      res.json([]);
    }
  });

  router.get('/dvr/recordings', requireAuth, (req, res) => {
    if (req.session.isAdmin) {
      const rows = db.prepare('SELECT r.*, u.username FROM dvr_recordings r JOIN users u ON r.user_id = u.id ORDER BY r.startTime DESC').all();
      res.json(rows.map(r => ({ ...r, filename: path.basename(r.filePath) })));
    } else if (req.session.canUseDvr) {
      const rows = db.prepare('SELECT r.*, u.username FROM dvr_recordings r JOIN users u ON r.user_id = u.id WHERE r.user_id = ? ORDER BY r.startTime DESC').all(req.session.userId);
      res.json(rows.map(r => ({ ...r, filename: path.basename(r.filePath) })));
    } else {
      res.json([]);
    }
  });

  router.get('/dvr/storage', requireAuth, (req, res) => {
    if (!req.session.canUseDvr && !req.session.isAdmin) return res.json({ total: 0, used: 0, percentage: 0 });
    try {
      fs.statfs(DVR_DIR, (err, statfs) => {
        if (err) return res.status(500).json({ error: 'Could not get storage information.' });
        const blockSize = statfs.frsize || statfs.bsize;
        const total = statfs.blocks * blockSize;
        const free = statfs.bfree * blockSize;
        const used = total - free;
        res.json({ total, used, percentage: Math.round((used / total) * 100) });
      });
    } catch (e) {
      res.status(500).json({ error: 'Server error checking storage.' });
    }
  });

  router.delete('/dvr/jobs/all', requireAuth, requireDvrAccess, (req, res) => {
    const userId = req.session.userId;
    const jobs = db.prepare("SELECT id FROM dvr_jobs WHERE user_id = ? AND status = 'scheduled'").all(userId);
    for (const j of jobs) {
      if (activeDvrJobs.has(j.id)) {
        const info = activeDvrJobs.get(j.id);
        info.startJob?.cancel();
        info.stopJob?.cancel();
        activeDvrJobs.delete(j.id);
      }
    }
    const result = db.prepare('DELETE FROM dvr_jobs WHERE user_id = ?').run(userId);
    res.json({ success: true, deletedCount: result.changes });
  });

  router.delete('/dvr/recordings/all', requireAuth, requireDvrAccess, (req, res) => {
    const userId = req.session.userId;
    const recordings = db.prepare('SELECT id, filePath FROM dvr_recordings WHERE user_id = ?').all(userId);
    for (const rec of recordings) {
      if (fs.existsSync(rec.filePath)) try { fs.unlinkSync(rec.filePath); } catch {}
    }
    const result = db.prepare('DELETE FROM dvr_recordings WHERE user_id = ?').run(userId);
    res.json({ success: true, deletedCount: result.changes });
  });

  router.delete('/dvr/jobs/:id', requireAuth, requireDvrAccess, (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    if (activeDvrJobs.has(jobId)) {
      const info = activeDvrJobs.get(jobId);
      info.startJob?.cancel();
      info.stopJob?.cancel();
      activeDvrJobs.delete(jobId);
    }
    const params = req.session.isAdmin ? [jobId] : [jobId, req.session.userId];
    const query = req.session.isAdmin ? "UPDATE dvr_jobs SET status = 'cancelled' WHERE id = ?" : "UPDATE dvr_jobs SET status = 'cancelled' WHERE id = ? AND user_id = ?";
    const result = db.prepare(query).run(...params);
    if (result.changes === 0) return res.status(404).json({ error: 'Job not found or not authorized.' });
    res.json({ success: true });
  });

  router.delete('/dvr/recordings/:id', requireAuth, requireDvrAccess, (req, res) => {
    const params = req.session.isAdmin ? [req.params.id] : [req.params.id, req.session.userId];
    const query = req.session.isAdmin ? 'SELECT filePath FROM dvr_recordings WHERE id = ?' : 'SELECT filePath FROM dvr_recordings WHERE id = ? AND user_id = ?';
    const row = db.prepare(query).get(...params);
    if (!row) return res.status(404).json({ error: 'Recording not found or not authorized.' });
    if (fs.existsSync(row.filePath)) try { fs.unlinkSync(row.filePath); } catch {}
    db.prepare('DELETE FROM dvr_recordings WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  router.post('/dvr/jobs/:id/stop', requireAuth, requireDvrAccess, (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    stopRecording(jobId);
    const params = req.session.isAdmin ? [jobId] : [jobId, req.session.userId];
    const query = req.session.isAdmin ? "UPDATE dvr_jobs SET status = 'completed' WHERE id = ?" : "UPDATE dvr_jobs SET status = 'completed' WHERE id = ? AND user_id = ?";
    const result = db.prepare(query).run(...params);
    if (result.changes === 0) return res.status(404).json({ error: 'Job not found or not authorized.' });
    res.json({ success: true });
  });

  router.put('/dvr/jobs/:id', requireAuth, requireDvrAccess, (req, res) => {
    const { startTime, endTime } = req.body;
    if (!startTime || !endTime) return res.status(400).json({ error: 'Both startTime and endTime are required.' });
    const params = req.session.isAdmin ? [req.params.id] : [req.params.id, req.session.userId];
    const query = req.session.isAdmin ? 'SELECT * FROM dvr_jobs WHERE id = ?' : 'SELECT * FROM dvr_jobs WHERE id = ? AND user_id = ?';
    const job = db.prepare(query).get(...params);
    if (!job) return res.status(404).json({ error: 'Job not found or unauthorized.' });
    if (job.status !== 'scheduled') return res.status(400).json({ error: 'Only scheduled jobs can be modified.' });
    db.prepare('UPDATE dvr_jobs SET startTime = ?, endTime = ? WHERE id = ?').run(startTime, endTime, req.params.id);
    scheduleDvrJob({ ...job, startTime, endTime });
    res.json({ success: true, job: { ...job, startTime, endTime } });
  });

  router.delete('/dvr/jobs/:id/history', requireAuth, requireDvrAccess, (req, res) => {
    const params = req.session.isAdmin ? [req.params.id] : [req.params.id, req.session.userId];
    const query = req.session.isAdmin ? 'SELECT status FROM dvr_jobs WHERE id = ?' : 'SELECT status FROM dvr_jobs WHERE id = ? AND user_id = ?';
    const job = db.prepare(query).get(...params);
    if (!job) return res.status(404).json({ error: 'Job not found or unauthorized.' });
    if (!['error', 'cancelled', 'completed'].includes(job.status)) return res.status(400).json({ error: 'Can only delete jobs in final status.' });
    db.prepare('DELETE FROM dvr_jobs WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  });

  // Expose engine for external use
  router.engine = {
    stopRecording, startRecording, scheduleDvrJob,
    runningFFmpegProcesses, activeDvrJobs, autoDeleteOldRecordings,
  };

  return router;
}
