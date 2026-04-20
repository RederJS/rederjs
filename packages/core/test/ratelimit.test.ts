import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';

describe('RateLimiter', () => {
  it('allows up to the limit within the window', () => {
    const rl = new RateLimiter(3, 60_000);
    for (let i = 0; i < 3; i++) expect(rl.check('u').allowed).toBe(true);
    expect(rl.check('u').allowed).toBe(false);
  });

  it('isolates different keys', () => {
    const rl = new RateLimiter(2, 60_000);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    expect(rl.check('b').allowed).toBe(true);
  });

  it('reports resetInMs when throttled', () => {
    const rl = new RateLimiter(1, 60_000);
    rl.check('u', 1_000);
    const res = rl.check('u', 2_000);
    expect(res.allowed).toBe(false);
    expect(res.resetInMs).toBe(59_000);
  });

  it('rolls the window forward as old entries expire', () => {
    const rl = new RateLimiter(2, 1000);
    rl.check('u', 0);
    rl.check('u', 500);
    expect(rl.check('u', 800).allowed).toBe(false);
    expect(rl.check('u', 1200).allowed).toBe(true); // first at 0 rolled off
  });

  it('reset removes all state for a key', () => {
    const rl = new RateLimiter(1, 60_000);
    rl.check('u');
    rl.reset('u');
    expect(rl.check('u').allowed).toBe(true);
  });
});
