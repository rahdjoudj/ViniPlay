import { app, activeStreamProcesses, hlsCleanup, dvrShutdown, getSettings, saveSettings, sseClients } from './app.js';
import { closeDb } from './db/index.js';
import { logger } from './config/logger.js';
import { env } from './config/index.js';
import { processAndMergeSources, updateAndScheduleSourceRefreshes } from './services/source-processor.js';

const port = env.PORT;

// --- Graceful shutdown ---
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully');

  for (const [, info] of activeStreamProcesses) {
    try { info.process?.kill('SIGTERM'); } catch {}
  }

  hlsCleanup();
  dvrShutdown();
  closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---
app.listen(port, async () => {
  logger.info({ port, env: env.NODE_ENV }, 'ViniPlay server started');

  // Initial source processing on startup
  try {
    const result = await processAndMergeSources({ getSettings, sseClients, userId: null });
    if (result?.success) {
      saveSettings(result.updatedSettings);
      logger.info('Initial source processing complete');
    }
  } catch (err) {
    logger.error({ err }, 'Initial source processing failed');
  }

  // Schedule periodic source refreshes
  updateAndScheduleSourceRefreshes({ getSettings, saveSettings, sseClients });
});
