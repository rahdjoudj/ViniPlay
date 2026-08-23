import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.dirname(path.dirname(__dirname));

const envSchema = z.object({
  SESSION_SECRET: z.string().min(32).optional(),
  VAPID_CONTACT_EMAIL: z.string().default('mailto:admin@example.com'),
  PORT: z.coerce.number().int().default(8998),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  FFMPEG_INPUT_TIMEOUT_MS: z.coerce.number().int().default(10_000),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errors = result.error.flatten();
    logger.error({ errors }, 'Invalid environment variables');
    throw new Error(`Environment validation failed: ${JSON.stringify(errors)}`);
  }
  return result.data;
}

export const env = validateEnv();

// --- Data Paths ---
// Overridable via env vars for testing; default to /data and /dvr for Docker
export const DATA_DIR = process.env.DATA_DIR || '/data';
export const DVR_DIR = process.env.DVR_DIR || '/dvr';
export const LOGS_DIR = path.join(DATA_DIR, 'logs');
export const VAPID_KEYS_PATH = path.join(DATA_DIR, 'vapid.json');
export const SOURCES_DIR = path.join(DATA_DIR, 'sources');
export const RAW_CACHE_DIR = path.join(SOURCES_DIR, 'raw_cache');
export const IMAGE_CACHE_DIR = path.join(DATA_DIR, 'image_cache');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DB_PATH = path.join(DATA_DIR, 'viniplay.db');
export const LIVE_CHANNELS_M3U_PATH = path.join(DATA_DIR, 'live_channels.m3u');
export const LIVE_EPG_JSON_PATH = path.join(DATA_DIR, 'epg.json');
export const VOD_MOVIES_JSON_PATH = path.join(DATA_DIR, 'vod_movies.json');
export const VOD_SERIES_JSON_PATH = path.join(DATA_DIR, 'vod_series.json');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

// --- Constants ---
export const SALT_ROUNDS = 10;
export const STREAM_INACTIVITY_TIMEOUT = 30_000;
export const VALID_FFMPEG_LOG_LEVELS = ['debug', 'verbose', 'info', 'warning', 'error'];

logger.info({ dataDir: DATA_DIR, publicDir: PUBLIC_DIR }, 'Configuration loaded');
