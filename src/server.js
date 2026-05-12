import { app, activeStreamProcesses, hlsCleanup, dvrShutdown } from './app.js';
import { closeDb } from './db/index.js';
import { logger } from './config/logger.js';
import { env } from './config/index.js';

const port = env.PORT;

// --- Graceful shutdown ---
function shutdown(signal) {
  logger.info({ signal }, 'Shutting down gracefully');

  // Kill legacy stream processes (ffmpeg proxying)
  for (const [, info] of activeStreamProcesses) {
    try { info.process?.kill('SIGTERM'); } catch {}
  }

  // Kill HLS stream processes
  hlsCleanup();

  // Kill DVR ffmpeg processes and cancel scheduled jobs
  dvrShutdown();

  closeDb();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---
app.listen(port, () => {
  logger.info({ port, env: env.NODE_ENV }, 'ViniPlay server started');
});
