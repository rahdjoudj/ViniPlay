import { Router } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { logger } from '../config/logger.js';
import { IMAGE_CACHE_DIR } from '../config/index.js';
import { requireAuth } from '../middleware/auth.js';

export function createImageProxyRoutes() {
  const router = Router();

  router.get('/image-proxy', requireAuth, (req, res) => {
    const imageUrl = req.query.url;

    if (!imageUrl) return res.status(400).send('Missing url parameter');

    try { new URL(imageUrl); } catch {
      return res.status(400).send('Invalid URL');
    }

    const urlHash = crypto.createHash('sha256').update(imageUrl).digest('hex');
    const cacheFilePath = path.join(IMAGE_CACHE_DIR, urlHash);
    const cacheMetaPath = path.join(IMAGE_CACHE_DIR, `${urlHash}.meta`);

    if (fs.existsSync(cacheFilePath) && fs.existsSync(cacheMetaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(cacheMetaPath, 'utf-8'));
        res.setHeader('Content-Type', meta.contentType);
        res.setHeader('Cache-Control', 'public, max-age=2592000');
        res.setHeader('X-Cache', 'HIT');
        const fileStream = fs.createReadStream(cacheFilePath);
        fileStream.pipe(res);
        fileStream.on('error', () => {
          try { fs.unlinkSync(cacheFilePath); fs.unlinkSync(cacheMetaPath); } catch {}
          if (!res.headersSent) res.status(500).send('Cache read error');
        });
        return;
      } catch {
        // fall through to fetch
      }
    }

    logger.info({ url: imageUrl.slice(0, 80) }, 'Fetching and caching image');

    function fetchImage(targetUrl, redirects = 0) {
      if (redirects > 5) return res.status(400).send('Too many redirects');

      const proto = targetUrl.startsWith('https') ? https : http;
      const parsed = new URL(targetUrl);

      proto.get({
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'ViniPlay/1.0' },
      }, (imgRes) => {
        if ([301, 302, 307, 308].includes(imgRes.statusCode)) {
          const loc = imgRes.headers.location;
          if (!loc) return res.status(400).send('Redirect without location');
          return fetchImage(new URL(loc, targetUrl).toString(), redirects + 1);
        }

        const contentType = imgRes.headers['content-type'];
        if (!contentType?.startsWith('image/')) {
          return res.status(400).send('URL does not point to an image');
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=2592000');
        res.setHeader('X-Cache', 'MISS');

        const fileStream = fs.createWriteStream(cacheFilePath);
        imgRes.pipe(fileStream);
        imgRes.pipe(res);

        fileStream.on('finish', () => {
          const meta = { url: imageUrl, contentType, cachedAt: new Date().toISOString() };
          fs.writeFileSync(cacheMetaPath, JSON.stringify(meta));
        });

        fileStream.on('error', (err) => {
          logger.error({ err }, 'Cache write error');
        });
      }).on('error', (err) => {
        logger.error({ err }, 'Image fetch error');
        if (!res.headersSent) res.status(502).send('Failed to fetch image');
      });
    }

    fetchImage(imageUrl);
  });

  return router;
}
