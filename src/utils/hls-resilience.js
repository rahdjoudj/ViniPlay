/**
 * hls-resilience.js
 *
 * Pure decision helpers for the HLS pipeline's stall recovery:
 * ffmpeg input resilience flags, watchdog kill decisions, and
 * auto-respawn gating. Kept free of I/O so the logic is unit-testable
 * and stream.js stays focused on process orchestration.
 */

const RESILIENCE_FLAGS = [
  '-rw_timeout', '', // microseconds — filled from timeoutMs
  '-reconnect', '1',
  '-reconnect_streamed', '1',
  '-reconnect_delay_max', '5',
];

const SEGMENT_NAME_RE = /^[A-Za-z0-9_.-]+\.ts$/;

/**
 * Inserts HTTP input resilience flags (read timeout + reconnect) before the
 * first `-i` whose input is http(s). Leaves args untouched when there is no
 * HTTP input or a custom profile already carries its own flags.
 *
 * @param {string[]} args ffmpeg argument tokens (already tokenized)
 * @param {number} timeoutMs read timeout in milliseconds
 * @returns {string[]} a new args array when flags were inserted, otherwise the input array
 */
export function injectInputFlags(args, timeoutMs) {
  if (args.some(a => a === '-rw_timeout' || a === '-reconnect')) return args;

  const inputIndex = args.findIndex(
    (a, i) => a === '-i' && args[i + 1] && /^https?:\/\//.test(args[i + 1])
  );
  if (inputIndex === -1) return args;

  const flags = [...RESILIENCE_FLAGS];
  flags[1] = String(timeoutMs * 1000);
  return [...args.slice(0, inputIndex), ...flags, ...args.slice(inputIndex)];
}

/**
 * Decides whether a stalled/dead HLS entry should be respawned now.
 *
 * @param {object} params
 * @param {boolean} params.dead entry was tombstoned (process exited or was killed)
 * @param {number} params.lastRespawnAttemptAt timestamp of the previous respawn attempt
 * @param {number} params.now current timestamp
 * @param {number} params.respawnCooldownMs minimum delay between respawn attempts
 * @param {number} params.playlistAgeMs age of the playlist file (Infinity when missing)
 * @param {number} params.staleAgeMs playlist age above which the entry counts as stalled
 * @returns {boolean}
 */
export function shouldRespawn({ dead, lastRespawnAttemptAt, now, respawnCooldownMs, playlistAgeMs, staleAgeMs }) {
  const needsRespawn = dead || playlistAgeMs > staleAgeMs;
  return needsRespawn && (now - lastRespawnAttemptAt >= respawnCooldownMs);
}

/**
 * @param {object} params
 * @param {number} params.ticksWithoutProgress consecutive watchdog ticks with no output
 * @param {number} params.killAfterTicks threshold at which ffmpeg is killed
 * @returns {boolean}
 */
export function shouldKill({ ticksWithoutProgress, killAfterTicks }) {
  return ticksWithoutProgress >= killAfterTicks;
}

/**
 * @param {object} params
 * @param {boolean} params.playlistSizeChanged playlist byte size changed since last tick
 * @param {boolean} params.newestSegmentChanged newest segment name changed since last tick
 * @returns {boolean}
 */
export function isProgressing({ playlistSizeChanged, newestSegmentChanged }) {
  return playlistSizeChanged || newestSegmentChanged;
}

/**
 * Returns the last segment filename in an HLS playlist, or null when the
 * playlist contains no segments (stub, comments only, or empty).
 *
 * @param {string|null} playlistContent raw m3u8 content
 * @returns {string|null}
 */
export function extractNewestSegment(playlistContent) {
  const lines = String(playlistContent || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (SEGMENT_NAME_RE.test(line)) return line;
  }
  return null;
}
