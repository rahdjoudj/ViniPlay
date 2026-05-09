import { Router } from 'express';
import fs from 'fs';
import https from 'https';
import http from 'http';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';

export function createMiscRoutes({ sseClients, detectedHardware }) {
  const router = Router();

  router.get('/version', requireAuth, (_req, res) => {
    try {
      const pkgPath = new URL('../../package.json', import.meta.url).pathname;
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return res.json({ version: pkg.version || 'Unknown' });
      }
      res.json({ version: 'Unknown' });
    } catch (err) {
      logger.error({ err }, 'Version check failed');
      res.status(500).json({ error: 'Could not determine version.' });
    }
  });

  router.get('/public-ip', requireAuth, (_req, res) => {
    https.get('https://ifconfig.me/ip', (ipRes) => {
      let data = '';
      ipRes.on('data', c => { data += c; });
      ipRes.on('end', () => res.json({ publicIp: data.trim() }));
    }).on('error', (err) => {
      logger.error({ err }, 'Public IP lookup failed');
      res.status(500).json({ error: 'Could not fetch public IP.' });
    });
  });

  router.get('/hardware', requireAuth, (_req, res) => {
    res.json(detectedHardware || {});
  });

  router.get('/events', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const clientId = Date.now();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    if (!sseClients.has(userId)) sseClients.set(userId, []);
    sseClients.get(userId).push({ id: clientId, res, isAdmin: req.session.isAdmin });
    res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected' })}\n\n`);
    req.on('close', () => {
      const c = sseClients.get(userId);
      if (c) {
        const idx = c.findIndex(x => x.id === clientId);
        if (idx !== -1) c.splice(idx, 1);
        if (c.length === 0) sseClients.delete(userId);
      }
    });
  });

  router.post('/validate-url', requireAuth, async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL is required.' });
    try {
      const mod = url.startsWith('https') ? https : http;
      await new Promise((resolve, reject) => {
        const r = mod.get(url, { timeout: 10000 }, (resp) => { resp.resume(); resolve(resp); });
        r.on('error', reject);
        r.on('timeout', () => { r.destroy(); reject(new Error('Timeout')); });
      });
      res.json({ success: true, message: 'URL is reachable.' });
    } catch (err) {
      res.status(400).json({ success: false, error: `URL not reachable: ${err.message}` });
    }
  });

  return router;
}
