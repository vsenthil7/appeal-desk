import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { jaccard, tokenSet, computeDedup } from '../../src/core/dedup.js';
import {
  checkRateLimit,
  initialBucket,
  type RateLimitConfig,
} from '../../src/core/concurrency/rateLimit.js';
import { sanitiseText, LIMITS } from '../../src/core/validation/index.js';
import { renderTemplate } from '../../src/core/templates.js';

describe('property: jaccard similarity', () => {
  it('is symmetric', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const sa = tokenSet(a);
        const sb = tokenSet(b);
        expect(jaccard(sa, sb)).toBeCloseTo(jaccard(sb, sa), 10);
      }),
    );
  });

  it('is always within [0, 1]', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const j = jaccard(tokenSet(a), tokenSet(b));
        expect(j).toBeGreaterThanOrEqual(0);
        expect(j).toBeLessThanOrEqual(1);
      }),
    );
  });

  it('a set is identical to itself', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 3 }), (a) => {
        const s = tokenSet(a + ' meaningful words here');
        expect(jaccard(s, s)).toBe(1);
      }),
    );
  });
});

describe('property: computeDedup', () => {
  it('repeatCount always equals the number of prior appeals', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(fc.record({ id: fc.string(), reason: fc.string() })),
        (reason, prior) => {
          const r = computeDedup(reason, prior);
          expect(r.repeatCount).toBe(prior.length);
        },
      ),
    );
  });

  it('any flagged duplicate id always exists in the prior set', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.array(
          fc.record({ id: fc.string({ minLength: 1 }), reason: fc.string() }),
          { minLength: 1 },
        ),
        (reason, prior) => {
          const r = computeDedup(reason, prior);
          if (r.duplicateOfAppealId !== undefined) {
            expect(prior.map((p) => p.id)).toContain(r.duplicateOfAppealId);
          }
        },
      ),
    );
  });
});

describe('property: rate limiter', () => {
  const configArb: fc.Arbitrary<RateLimitConfig> = fc.record({
    capacity: fc.integer({ min: 1, max: 100 }),
    refillPerHour: fc.integer({ min: 1, max: 100 }),
  });

  it('never lets token balance go negative or exceed capacity', () => {
    fc.assert(
      fc.property(
        configArb,
        fc.array(fc.integer({ min: 0, max: 10_000_000 }), { maxLength: 30 }),
        (config, deltas) => {
          let state = initialBucket(config, 0);
          let t = 0;
          for (const d of deltas) {
            t += d;
            const decision = checkRateLimit(state, config, t);
            state = decision.next;
            expect(state.tokens).toBeGreaterThanOrEqual(0);
            expect(state.tokens).toBeLessThanOrEqual(config.capacity + 1e-9);
          }
        },
      ),
    );
  });

  it('a denied request always reports a positive retry wait', () => {
    fc.assert(
      fc.property(configArb, fc.integer({ min: 0, max: 1_000_000 }), (config, t) => {
        const empty = { tokens: 0, lastRefill: 0 };
        const d = checkRateLimit(empty, config, t);
        if (!d.allowed) {
          expect(d.retryAfterMs).toBeGreaterThan(0);
        }
      }),
    );
  });
});

describe('property: sanitiseText', () => {
  it('never exceeds the cap and never contains stripped control chars', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 200 }), (s, max) => {
        const out = sanitiseText(s, max);
        expect(out.length).toBeLessThanOrEqual(max);
        // eslint-disable-next-line no-control-regex
        expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(out)).toBe(
          false,
        );
      }),
    );
  });

  it('is idempotent under the same cap', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = sanitiseText(s, LIMITS.reasonMax);
        const twice = sanitiseText(once, LIMITS.reasonMax);
        expect(twice).toBe(once);
      }),
    );
  });
});

describe('property: renderTemplate', () => {
  it('leaves output free of known tokens once substituted', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.string(),
        fc.string(),
        (user, subreddit, action) => {
          const out = renderTemplate('{{user}}|{{subreddit}}|{{action}}', {
            user,
            subreddit,
            action,
          });
          // The literal token markers for known keys are gone.
          expect(out).not.toContain('{{user}}');
          expect(out).not.toContain('{{subreddit}}');
          expect(out).not.toContain('{{action}}');
        },
      ),
    );
  });

  it('preserves unknown tokens verbatim', () => {
    fc.assert(
      fc.property(fc.constant('x'), () => {
        const out = renderTemplate('{{unknown}}', {
          user: 'a',
          subreddit: 'b',
          action: 'c',
        });
        expect(out).toBe('{{unknown}}');
      }),
    );
  });
});
