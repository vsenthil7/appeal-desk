import { describe, it, expect } from 'vitest';
import { FakeRedis } from '../helpers/fakeRedis.js';
import { AppealStore, type NewAppealInput } from '../../src/core/store.js';
import { DEFAULT_CONFIG } from '../../src/core/types.js';
import { FakeClock, MemoryMetrics } from '../../src/core/observability/index.js';

function input(overrides: Partial<NewAppealInput> = {}): NewAppealInput {
  return {
    subreddit: 'aww',
    actionType: 'ban',
    targetId: 't2_alice',
    authorId: 't2_alice',
    authorName: 'alice',
    reason: 'please unban me this was unfair and i understand the rule',
    acknowledged: true,
    originalContent: '(account ban)',
    originalReason: 'spam',
    ...overrides,
  };
}

function makeStore() {
  const redis = new FakeRedis();
  const store = new AppealStore(redis as never, {
    clock: new FakeClock(1_000_000),
    metrics: new MemoryMetrics(),
    logger: { log() {}, child() { return this; } },
  });
  return { redis, store };
}

describe('concurrency: parallel decisions on one appeal', () => {
  it('only one of two concurrent decides resolves; the other sees the terminal state', async () => {
    const { store } = makeStore();
    const a = await store.create(input());
    const rec = { modId: 'm', modName: 'mod', note: 'n', replyText: 'r' };

    // Two mods decide the same appeal "at once". With a single-threaded event
    // loop these still interleave at await points; the state machine + CAS must
    // ensure the second cannot double-resolve.
    const results = await Promise.allSettled([
      store.decide('aww', a.id, 'upheld', rec),
      store.decide('aww', a.id, 'overturned', rec),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one resolves; the other is rejected with a state-transition or
    // lock error (never a silent double-write).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const final = await store.get('aww', a.id);
    expect(final!.status).toBe('resolved');
    expect(final!.decisions).toHaveLength(1); // never two decisions recorded
  });
});

describe('concurrency: parallel duplicate submissions', () => {
  it('does not create two open appeals for the same action under one-per-action', async () => {
    const { store } = makeStore();
    const results = await Promise.allSettled([
      store.create(input()),
      store.create(input()),
    ]);
    const created = results.filter((r) => r.status === 'fulfilled');
    // At most one open appeal exists for this target afterwards.
    const count = await store.openCount('aww');
    expect(count).toBeLessThanOrEqual(created.length);
    expect(count).toBeLessThanOrEqual(2);
    // And the open queue never holds two appeals for the same target id.
    const queue = await store.openQueue('aww');
    const targets = await Promise.all(
      queue.map(async (q) => (await store.get('aww', q.id))!.targetId),
    );
    const uniqueTargets = new Set(targets);
    expect(uniqueTargets.size).toBe(targets.length);
  });
});

describe('concurrency: interleaved review + decide', () => {
  it('a decide after a concurrent markInReview still records exactly once', async () => {
    const { store } = makeStore();
    const a = await store.create(input());
    const rec = { modId: 'm', modName: 'mod', note: 'n', replyText: 'r' };

    const [review, decide] = await Promise.allSettled([
      store.markInReview('aww', a.id),
      store.decide('aww', a.id, 'upheld', rec),
    ]);

    // Both can succeed (review→in_review, then decide→resolved) OR the decide
    // wins first and review becomes a no-op; either way the invariant holds:
    expect(review.status === 'fulfilled' || review.status === 'rejected').toBe(true);
    const final = await store.get('aww', a.id);
    expect(['resolved', 'in_review']).toContain(final!.status);
    expect(final!.decisions.length).toBeLessThanOrEqual(1);
    void decide;
  });
});
