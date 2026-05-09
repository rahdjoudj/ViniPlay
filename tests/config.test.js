import { describe, it, expect } from 'vitest';
import { env } from '../src/config/index.js';

describe('Config', () => {
  it('has default port', () => {
    expect(env.PORT).toBeGreaterThan(0);
  });

  it('has valid NODE_ENV', () => {
    expect(['development', 'production', 'test']).toContain(env.NODE_ENV);
  });
});
