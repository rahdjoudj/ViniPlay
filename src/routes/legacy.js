/**
 * Legacy route compatibility layer.
 *
 * Routes not yet extracted from the original server.js (5,135 lines).
 * Each migration removes a route from the original and adds it to a proper module.
 *
 * Still in original server.js:
 * /api/config, /api/vod/*, /api/process-sources, /api/hardware,
 * /api/public-ip, /api/version, /api/logs/*, /api/data,
 * /api/cast/*, /api/dvr/*, /api/processing/status, /stream, /api/events
 */

import { logger } from '../config/logger.js';

export function registerLegacyRoutes(_app, _shared) {
  logger.info('Legacy route placeholder — original server.js handles remaining endpoints');
}
