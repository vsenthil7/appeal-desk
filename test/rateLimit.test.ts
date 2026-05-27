import { describe, it, expect } from 'vitest';
import {
  initialBucket,
  checkRateLimit,
  type RateLimitConfig,
} from '../src/core/concurrency/rateLimit.js';

const config: RateLimitConfig = { capacity: 5, refillPerHour: 2 };

describe('initialBucket', () => {
  it('starts full at the given time', () => {
    expect(initialBucket(config, 1000)).toEqual({ tokens: 5, lastRefill: 1000 });
  });
});

describe('checkRateLimit', () => {
  it('allows and spends a token when available', () => {
    const d = checkRateLimit(initialBucket(config, 0), config, 0);
    expect(d.allowed).toBe(true);
    expect(d.next.tokens).toBe(4);
    expect(d.retryAfterMs).toBe(0);
  });

  it('denies when the bucket is empty and computes a retry wait', () => {
    const empty = { tokens: 0, lastRefill: 0 };
    const d = checkRateLimit(empty, config, 0);
    expect(d.allowed).toBe(false);
    // 2 tokens/hour => 1 token in 30 min ≈ 1_800_000 ms (ceil may round up by 1).
    expect(d.retryAfterMs).toBeGreaterThanOrEqual(1_800_000);
    expect(d.retryAfterMs).toBeLessThanOrEqual(1_800_001);
    expect(d.next.tokens).toBe(0);
  });

  it('refills proportionally to elapsed time, capped at capacity', () => {
    const empty = { tokens: 0, lastRefill: 0 };
    // After 1 hour, 2 tokens have refilled.
    const d = checkRateLimit(empty, config, 60 * 60 * 1000);
    expect(d.allowed).toBe(true);
    expect(d.next.tokens).toBeCloseTo(1, 5); // 2 refilled - 1 spent
  });

  it('never exceeds capacity even after a long idle period', () => {
    const empty = { tokens: 0, lastRefill: 0 };
    const d = checkRateLimit(empty, config, 100 * 60 * 60 * 1000);
    // Would refill 200, but capped at 5, minus 1 spent = 4.
    expect(d.next.tokens).toBe(4);
  });

  it('treats a clock that went backwards as zero elapsed', () => {
    const state = { tokens: 1, lastRefill: 1000 };
    const d = checkRateLimit(state, config, 500);
    expect(d.allowed).toBe(true);
    expect(d.next.tokens).toBe(0);
  });

  it('supports a custom cost', () => {
    const d = checkRateLimit(initialBucket(config, 0), config, 0, 3);
    expect(d.allowed).toBe(true);
    expect(d.next.tokens).toBe(2);
  });

  it('returns Infinity retry when refill rate is zero and bucket is empty', () => {
    const noRefill: RateLimitConfig = { capacity: 1, refillPerHour: 0 };
    const d = checkRateLimit({ tokens: 0, lastRefill: 0 }, noRefill, 1000);
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(Infinity);
  });
});
