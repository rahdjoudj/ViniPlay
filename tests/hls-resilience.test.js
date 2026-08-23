import { describe, it, expect } from 'vitest';
import {
  injectInputFlags,
  shouldRespawn,
  shouldKill,
  isProgressing,
  extractNewestSegment,
} from '../src/utils/hls-resilience.js';

describe('injectInputFlags', () => {
  const BASE_ARGS = ['-user_agent', '"VLC/3.0"', '-re', '-i', 'http://example.com/live.ts', '-c', 'copy'];

  it('inserts resilience flags before the -i token for HTTP URLs', () => {
    const result = injectInputFlags(BASE_ARGS, 10_000);
    const i = result.indexOf('-i');
    expect(i).toBeGreaterThan(0);
    expect(result.slice(i - 8, i)).toEqual([
      '-rw_timeout', String(10_000 * 1000),
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
    ]);
    expect(result[i + 1]).toBe('http://example.com/live.ts');
    expect(result[result.length - 1]).toBe('copy');
  });

  it('inserts flags for HTTPS URLs', () => {
    const args = ['-i', 'https://secure.example.com/stream.ts', '-c', 'copy'];
    const result = injectInputFlags(args, 10_000);
    expect(result.indexOf('-rw_timeout')).toBe(0);
    expect(result[result.indexOf('-i') + 1]).toBe('https://secure.example.com/stream.ts');
  });

  it('does not modify the original array', () => {
    const before = [...BASE_ARGS];
    injectInputFlags(BASE_ARGS, 10_000);
    expect(BASE_ARGS).toEqual(before);
  });

  it('skips non-HTTP inputs (e.g. rtp://)', () => {
    const args = ['-i', 'rtp://127.0.0.1:5000', '-c', 'copy'];
    expect(injectInputFlags(args, 10_000)).toBe(args);
  });

  it('skips when no -i token is present', () => {
    const args = ['-version'];
    expect(injectInputFlags(args, 10_000)).toBe(args);
  });

  it('skips when -rw_timeout is already present (custom profile wins)', () => {
    const args = ['-rw_timeout', '5000000', '-i', 'http://example.com/live.ts'];
    expect(injectInputFlags(args, 10_000)).toBe(args);
  });

  it('skips when -reconnect is already present (custom profile wins)', () => {
    const args = ['-reconnect', '1', '-i', 'http://example.com/live.ts'];
    expect(injectInputFlags(args, 10_000)).toBe(args);
  });

  it('uses the custom timeout in microseconds', () => {
    const result = injectInputFlags(BASE_ARGS, 15_000);
    const rwIndex = result.indexOf('-rw_timeout');
    expect(result[rwIndex + 1]).toBe(String(15_000 * 1000));
  });
});

describe('shouldRespawn', () => {
  const base = {
    dead: false,
    lastRespawnAttemptAt: 0,
    now: 100_000,
    respawnCooldownMs: 10_000,
    playlistAgeMs: 1_000,
    staleAgeMs: 15_000,
  };

  it('returns true when entry is dead and cooldown elapsed', () => {
    expect(shouldRespawn({ ...base, dead: true })).toBe(true);
  });

  it('returns false when entry is dead but cooldown has not elapsed', () => {
    expect(shouldRespawn({ ...base, dead: true, lastRespawnAttemptAt: 95_000 })).toBe(false);
  });

  it('returns true when cooldown elapsed exactly (inclusive)', () => {
    expect(shouldRespawn({ ...base, dead: true, lastRespawnAttemptAt: 90_000 })).toBe(true);
  });

  it('returns false when alive and playlist is fresh', () => {
    expect(shouldRespawn(base)).toBe(false);
  });

  it('returns true when alive but playlist is older than stale age', () => {
    expect(shouldRespawn({ ...base, playlistAgeMs: 16_000 })).toBe(true);
  });

  it('returns false when playlist is stale but within cooldown', () => {
    expect(shouldRespawn({ ...base, playlistAgeMs: 16_000, lastRespawnAttemptAt: 95_000 })).toBe(false);
  });
});

describe('shouldKill', () => {
  it('returns false below the threshold', () => {
    expect(shouldKill({ ticksWithoutProgress: 4, killAfterTicks: 5 })).toBe(false);
  });

  it('returns true at the threshold', () => {
    expect(shouldKill({ ticksWithoutProgress: 5, killAfterTicks: 5 })).toBe(true);
  });

  it('returns true above the threshold', () => {
    expect(shouldKill({ ticksWithoutProgress: 9, killAfterTicks: 5 })).toBe(true);
  });
});

describe('isProgressing', () => {
  it('returns true when playlist size changed', () => {
    expect(isProgressing({ playlistSizeChanged: true, newestSegmentChanged: false })).toBe(true);
  });

  it('returns true when newest segment changed', () => {
    expect(isProgressing({ playlistSizeChanged: false, newestSegmentChanged: true })).toBe(true);
  });

  it('returns false when neither changed', () => {
    expect(isProgressing({ playlistSizeChanged: false, newestSegmentChanged: false })).toBe(false);
  });
});

describe('extractNewestSegment', () => {
  it('returns the last segment name from a normal playlist', () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MEDIA-SEQUENCE:10',
      '#EXTINF:2.0,',
      'segment_00012.ts',
      '#EXTINF:2.0,',
      'segment_00013.ts',
    ].join('\n');
    expect(extractNewestSegment(playlist)).toBe('segment_00013.ts');
  });

  it('returns null for the stub playlist', () => {
    const stub = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n';
    expect(extractNewestSegment(stub)).toBeNull();
  });

  it('returns null for comment-only content', () => {
    expect(extractNewestSegment('#EXTM3U\n#EXT-X-VERSION:3\n')).toBeNull();
  });

  it('returns null for empty content', () => {
    expect(extractNewestSegment('')).toBeNull();
    expect(extractNewestSegment(null)).toBeNull();
  });

  it('detects segment-name rotation when size is unchanged', () => {
    const a = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\nsegment_00010.ts\n';
    const b = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:11\nsegment_00011.ts\n';
    expect(extractNewestSegment(a)).toBe('segment_00010.ts');
    expect(extractNewestSegment(b)).toBe('segment_00011.ts');
  });
});
