import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmpDir;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'viniplay-smoke-'));
  process.env.DATA_DIR = tmpDir;
  process.env.DVR_DIR = join(tmpDir, 'dvr');
});

afterAll(async () => {
  delete process.env.DATA_DIR;
  delete process.env.DVR_DIR;
  // Give async sqlite3 callbacks time to complete before cleanup
  await new Promise(r => setTimeout(r, 100));
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('App startup smoke test', () => {
  it('loads without errors — all imports resolve, middleware and routes mount', async () => {
    const mod = await import('../src/app.js');
    expect(mod.app).toBeDefined();
    expect(typeof mod.app.listen).toBe('function');
    const routes = mod.app._router?.stack?.length || 0;
    expect(routes).toBeGreaterThan(5);
  });

  it('creates the database', () => {
    expect(existsSync(join(tmpDir, 'viniplay.db'))).toBe(true);
  });
});
