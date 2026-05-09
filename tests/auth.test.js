import { describe, it, expect } from 'vitest';
import bcrypt from 'bcryptjs';
import { SALT_ROUNDS } from '../src/config/index.js';

describe('Auth utilities', () => {
  it('bcrypt hash matches', () => {
    const password = 'test-password';
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    expect(bcrypt.compareSync(password, hash)).toBe(true);
    expect(bcrypt.compareSync('wrong', hash)).toBe(false);
  });
});
