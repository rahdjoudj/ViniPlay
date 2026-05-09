/**
 * player-core.js
 *
 * Shared video player abstraction over HLS.js (primary) and mpegts.js (fallback).
 * Handles stream type detection, player lifecycle, stats, Media Session API,
 * keyboard shortcuts, and buffer-stall recovery.
 */

import { getCodecName } from './codecs.js';

const HLS_EXTENSIONS = ['.m3u8'];
const TS_EXTENSIONS = ['.ts', '.m2ts'];
const VOD_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.mov', '.webm', '.m4v', '.flv', '.wmv', '.mpg', '.mpeg'];

export function detectStreamType(url) {
  const lower = url.toLowerCase();
  for (const ext of HLS_EXTENSIONS) {
    if (lower.includes(ext)) return { type: 'hls', extension: ext };
  }
  for (const ext of TS_EXTENSIONS) {
    if (lower.includes(ext)) return { type: 'ts', extension: ext };
  }
  for (const ext of VOD_EXTENSIONS) {
    if (lower.includes(ext)) return { type: 'vod', extension: ext };
  }
  if (lower.includes('/stream') || lower.includes('/hls')) {
    return { type: 'hls', extension: '.m3u8' };
  }
  return { type: 'ts', extension: 'unknown' };
}

/**
 * Resolves a /stream URL to an HLS playlist if the server supports it.
 * Falls back to the original URL if HLS is unavailable.
 */
async function resolveStreamUrl(url) {
  // Only negotiate HLS for server-transcoded /stream URLs (not /stream/hls ones)
  if (!url.includes('/stream') || url.includes('/stream/hls')) return url;

  try {
    const hlsUrl = url.replace('/stream?', '/stream/hls?');
    const res = await fetch(hlsUrl);
    if (res.ok) {
      const data = await res.json();
      if (data?.playlistUrl && data?.type === 'hls') {
        return data.playlistUrl;
      }
    }
  } catch {}
  return url;
}

/**
 * Creates the best available player for a given URL.
 */
export async function createPlayer({ url, video, isLive = true, onError, onRecovered, onStats }) {
  // Try HLS negotiation for server-transcoded streams
  const resolvedUrl = await resolveStreamUrl(url);
  const streamType = detectStreamType(resolvedUrl);

  if ((streamType.type === 'hls' || streamType.type === 'vod') && typeof Hls !== 'undefined' && Hls.isSupported()) {
    return createHlsPlayer({ url: resolvedUrl, video, isLive, streamType, onError, onRecovered, onStats });
  }

  if (typeof mpegts !== 'undefined' && mpegts.isSupported()) {
    return createMpegtsPlayer({ url, video, isLive, streamType, onError, onRecovered, onStats });
  }

  return createNativePlayer({ url, video, isLive, onError });
}

// --- HLS.js player (primary) ---

function createHlsPlayer({ url, video, isLive, streamType, onError, onRecovered, onStats }) {
  const hls = new Hls({
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 6,
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: isLive ? 30 : 90,
  });

  let statsInterval = null;
  let recoverAttempts = 0;
  const MAX_RECOVERY = 5;

  hls.loadSource(url);
  hls.attachMedia(video);

  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (recoverAttempts < MAX_RECOVERY) {
        recoverAttempts++;
        hls.recoverMediaError();
        return;
      }
    }
    // Let HLS.js internally retry network/manifest errors with backoff
    if (recoverAttempts >= MAX_RECOVERY) {
      onError?.(data.type, data.details, true);
    } else {
      recoverAttempts++;
    }
  });

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    video.play().catch(() => {});
    if (recoverAttempts > 0) {
      onRecovered?.();
      recoverAttempts = 0;
    }
  });

  if (onStats) {
    statsInterval = setInterval(() => {
      const buf = video.buffered.length > 0 ? video.buffered.end(0) - video.currentTime : 0;
      onStats({
        resolution: (video.videoWidth && video.videoHeight) ? `${video.videoWidth}x${video.videoHeight}` : 'N/A',
        buffer: buf.toFixed(2),
        fps: 'N/A',
        dropped: 'N/A',
        bandwidth: 'N/A',
        videoCodec: 'HLS',
        audioCodec: 'HLS',
      });
    }, 2000);
  }

  return {
    type: 'hls.js',
    play: () => { video.play().catch(() => {}); },
    stop: () => {
      if (statsInterval) clearInterval(statsInterval);
      hls.destroy();
      video.src = '';
      video.removeAttribute('src');
    },
    getStats: () => null,
    setVolume: (v) => { video.volume = v; },
  };
}

// --- mpegts.js player (fallback for raw TS) ---

function createMpegtsPlayer({ url, video, isLive, streamType, onError, onRecovered, onStats }) {
  const player = mpegts.createPlayer(
    { type: 'mse', isLive, url },
    {
      enableStashBuffer: true,
      stashInitialSize: 4096,
      liveBufferLatency: 2.0,
      liveSync: true,
      liveSyncMaxLatency: 6.0,
      liveSyncPlaybackRate: 1.05,
      enableWorkerForMSE: true,
      enableWorker: true,
    }
  );

  let statsInterval = null;
  let recoverAttempts = 0;
  const MAX_RECOVERY = 3;

  player.attachMediaElement(video);
  player.load();

  player.on(mpegts.Events.ERROR, (errorType, errorDetail) => {
    if (errorType === 'NetworkError' || errorType === 'MediaError') {
      if (recoverAttempts < MAX_RECOVERY) {
        recoverAttempts++;
        player.unload();
        player.load();
        player.play().catch(() => {});
        return;
      }
    }
    onError?.(errorType, errorDetail, true);
  });

  player.on(mpegts.Events.MEDIA_INFO, () => {
    if (recoverAttempts > 0) {
      onRecovered?.();
      recoverAttempts = 0;
    }
  });

  player.play().catch(() => {});

  if (onStats) {
    const mediaInfo = player.mediaInfo || {};
    statsInterval = setInterval(() => {
      const stats = player.statisticsInfo || {};
      const buf = video.buffered.length > 0 ? video.buffered.end(0) - video.currentTime : 0;
      onStats({
        resolution: (video.videoWidth && video.videoHeight) ? `${video.videoWidth}x${video.videoHeight}` : 'N/A',
        buffer: buf.toFixed(2),
        fps: mediaInfo.fps || 'N/A',
        dropped: stats.droppedFrames ?? 'N/A',
        bandwidth: stats.speed ? `${(stats.speed / 1024).toFixed(1)} MB/s` : 'N/A',
        videoCodec: getCodecName(mediaInfo.videoCodec),
        audioCodec: getCodecName(mediaInfo.audioCodec),
      });
    }, 2000);
  }

  return {
    type: 'mpegts.js',
    play: () => { player.play().catch(() => {}); },
    stop: () => {
      if (statsInterval) clearInterval(statsInterval);
      try { player.destroy(); } catch {}
      video.src = '';
      video.removeAttribute('src');
    },
    getStats: () => player.statisticsInfo,
    setVolume: (v) => { video.volume = v; },
  };
}

// --- Native player (last resort fallback) ---

function createNativePlayer({ url, video, isLive, onError }) {
  video.src = url;
  video.load();

  const onErr = () => {
    const err = video.error;
    const msg = err ? ['ABORTED', 'NETWORK', 'DECODE', 'SRC_NOT_SUPPORTED'][err.code] || 'UNKNOWN' : 'UNKNOWN';
    onError?.('NativeError', msg, true);
  };

  video.addEventListener('error', onErr, { once: true });
  video.play().catch(() => {});

  return {
    type: 'native',
    play: () => { video.play().catch(() => {}); },
    stop: () => {
      video.removeEventListener('error', onErr);
      video.src = '';
      video.removeAttribute('src');
    },
    getStats: () => null,
    setVolume: (v) => { video.volume = v; },
  };
}

// --- Media Session API ---

export function setupMediaSession({ title, artist = '', artwork = '' }) {
  if (!('mediaSession' in navigator)) return;

  const meta = { title };
  if (artist) meta.artist = artist;
  if (artwork) meta.artwork = [{ src: artwork, sizes: '96x96', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata(meta);
}

export function clearMediaSession() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = null;
  }
}

// --- Keyboard shortcuts ---

export function setupKeyboardShortcuts(video, onClose) {
  const handler = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    switch (e.key) {
      case ' ':
      case 'k':
        e.preventDefault();
        video.paused ? video.play().catch(() => {}) : video.pause();
        break;
      case 'm':
        e.preventDefault();
        video.muted = !video.muted;
        break;
      case 'f':
        e.preventDefault();
        document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen?.();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 10);
        break;
      case 'ArrowRight':
        e.preventDefault();
        video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 10);
        break;
      case 'ArrowUp':
        e.preventDefault();
        video.volume = Math.min(1, video.volume + 0.05);
        break;
      case 'ArrowDown':
        e.preventDefault();
        video.volume = Math.max(0, video.volume - 0.05);
        break;
      case 'Escape':
        if (!document.fullscreenElement) onClose?.();
        break;
    }
  };

  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}
