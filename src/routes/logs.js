import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger.js';
import { LOGS_DIR } from '../config/index.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

export function createLogRoutes() {
  const router = Router();

  router.get('/info', requireAuth, requireAdmin, (_req, res) => {
    try {
      const logFiles = fs.readdirSync(LOGS_DIR)
        .filter(f => f.startsWith('viniplay-') && f.endsWith('.log'))
        .map(f => {
          const fp = path.join(LOGS_DIR, f);
          const s = fs.statSync(fp);
          return { name: f, size: s.size, mtime: s.mtime };
        })
        .sort((a, b) => b.mtime - a.mtime);

      const totalSize = logFiles.reduce((sum, f) => sum + f.size, 0);
      const oldestFile = logFiles.length > 0 ? logFiles[logFiles.length - 1] : null;

      res.json({ fileCount: logFiles.length, totalSize, oldestDate: oldestFile?.mtime || null, files: logFiles });
    } catch (err) {
      logger.error({ err }, 'Failed to read log info');
      res.status(500).json({ error: 'Failed to get log information.' });
    }
  });

  router.get('/download', requireAuth, requireAdmin, (req, res) => {
    try {
      const logFiles = fs.readdirSync(LOGS_DIR)
        .filter(f => f.startsWith('viniplay-') && f.endsWith('.log'))
        .map(f => ({ name: f, path: path.join(LOGS_DIR, f), mtime: fs.statSync(path.join(LOGS_DIR, f)).mtime }))
        .sort((a, b) => a.mtime - b.mtime);

      if (logFiles.length === 0) return res.status(404).json({ error: 'No log files found.' });

      let combined = `ViniPlay Application Logs\nGenerated: ${new Date().toISOString()}\nTotal Files: ${logFiles.length}\n${'='.repeat(80)}\n\n`;
      for (const f of logFiles) {
        combined += `\n${'='.repeat(80)}\nFile: ${f.name}\nModified: ${f.mtime.toISOString()}\n${'='.repeat(80)}\n\n`;
        try { combined += fs.readFileSync(f.path, 'utf-8') + '\n\n'; } catch {}
      }

      const filename = `viniplay-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(combined);
      logger.info({ userId: req.session.userId }, 'Logs downloaded');
    } catch (err) {
      logger.error({ err }, 'Failed to download logs');
      res.status(500).json({ error: 'Failed to download logs.' });
    }
  });

  router.post('/cleanup', requireAuth, requireAdmin, (_req, res) => {
    try {
      const files = fs.readdirSync(LOGS_DIR).filter(f => f.startsWith('viniplay-') && f.endsWith('.log'));
      for (const f of files) fs.unlinkSync(path.join(LOGS_DIR, f));
      logger.info('All log files deleted by admin');
      res.json({ success: true, message: `Deleted ${files.length} log files.` });
    } catch (err) {
      logger.error({ err }, 'Failed to clean up logs');
      res.status(500).json({ error: 'Failed to clean up logs.' });
    }
  });

  return router;
}
