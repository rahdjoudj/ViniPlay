import { Router } from 'express';
import crypto from 'crypto';
import { logger } from '../config/logger.js';
import { requireAuth } from '../middleware/auth.js';

export function createCastRoutes({ activeCastTokens }) {
  const router = Router();

  router.post('/generate-token', requireAuth, (req, res) => {
    const { streamUrl } = req.body;
    const userId = req.session.userId;

    if (!streamUrl) {
      return res.status(400).json({ error: 'streamUrl is required' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + (5 * 60 * 1000);

    activeCastTokens.set(token, {
      userId,
      streamUrl,
      expiresAt,
      createdAt: Date.now(),
    });

    setTimeout(() => {
      activeCastTokens.delete(token);
      logger.info({ tokenPrefix: token.slice(0, 8) }, 'Cast token expired and removed');
    }, 5 * 60 * 1000);

    logger.info({ userId }, 'Generated cast token (expires in 5 minutes)');
    res.json({ token });
  });

  return router;
}
