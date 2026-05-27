import { describe, it, expect, beforeEach } from 'vitest';
import { FakeRedis } from './helpers/fakeRedis.js';
import { AppealStore, type NewAppealInput } from '../src/core/store.js';
import { DEFAULT_CONFIG } from '../src/core/types.js';
import { keys } from '../src/core/keys.js';
import { FakeClock, MemoryMetrics, MemoryLogger } from '../src/core/observability/index.js';

function input(overrides: Partial<NewAppealInput> = {}): NewAppealInput {
  return {
    subreddit: 'aww',
    actionType: 'ban',
    targetId: 't2_alice',
    authorId: 't2_alice',
    authorName: 'alice',
    reason: 'please unban me this was unfair and i understand now',
    acknowledged: true,
    originalContent: '(account ban)',
    originalReason: 'spam',
    ...overrides,
  };
}

function makeStore() {
  const redis = new FakeRedis();
  const clock = new FakeClock(1_000_000);
  const metrics = new MemoryMetrics();
  const logger = new MemoryLogger();
  const store = new AppealStore(redis as never, { clock, metrics, logger });
  return { redis, clock, metrics, logger, store };
}

describe('store: rate limiting', () => {
  it('blocks a user after the burst capacity is exhausted', async () => {
    const { store, redis } = makeStore();
    // Default capacity 5, refill 2/hr, but one-appeal-per-action would block
    // re-use of the same target — so disable that and vary targets.
    await store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    for (let i = 0; i < 5; i++) {
      await store.create(input({ targetId: `t3_${i}` }));
    }
    await expect(store.create(input({ targetId: 't3_x' }))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    // Bucket state was persisted.
    expect(await redis.get(keys.rateLimit('aww', 'alice'))).toBeDefined();
  });

  it('allows again after enough time refills a token', async () => {
    const { store, clock } = makeStore();
    await store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      oneAppealPerAction: false,
      rateLimitCapacity: 1,
      rateLimitRefillPerHour: 1,
    });
    await store.create(input({ targetId: 't3_a' }));
    await expect(store.create(input({ targetId: 't3_b' }))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    clock.advance(60 * 60 * 1000 + 1000); // just over one hour → ≥1 token
    const ok = await store.create(input({ targetId: 't3_c' }));
    expect(ok.status).toBe('open');
  });

  it('recovers from a corrupt bucket by resetting to full', async () => {
    const { store, redis } = makeStore();
    await redis.set(keys.rateLimit('aww', 'alice'), '{corrupt');
    const a = await store.create(input());
    expect(a.status).toBe('open');
  });
});

describe('store: optimistic concurrency (CAS)', () => {
  it('retries when a competing write lands between watch and exec, then succeeds', async () => {
    const { store, redis, metrics } = makeStore();
    const a = await store.create(input());

    // Fire once: while the appeal is WATCHed (after read, before exec), a
    // competing writer mutates the key. The watched value changes, so the first
    // exec aborts (returns null) and mutate retries. The hook is spent, so the
    // retry commits.
    redis.onWatchedRead = async (key) => {
      if (key === keys.appeal('aww', a.id)) {
        const raw = await redis.get(key);
        const obj = JSON.parse(raw!);
        obj.version += 1;
        await redis.set(key, JSON.stringify(obj));
      }
    };

    const updated = await store.markInReview('aww', a.id);
    expect(updated.status).toBe('in_review');
    expect(metrics.counter('store.cas_retry')).toBeGreaterThanOrEqual(1);
  });

  it('throws OPTIMISTIC_LOCK_CONFLICT if conflicts never clear', async () => {
    const { store, redis } = makeStore();
    const a = await store.create(input());

    // Re-arm the competing write on every watched read, so every attempt's
    // exec aborts and the retry budget is exhausted.
    const bump = async (key: string) => {
      if (key === keys.appeal('aww', a.id)) {
        const raw = await redis.get(key);
        const obj = JSON.parse(raw!);
        obj.version += 1;
        await redis.set(key, JSON.stringify(obj));
        redis.onWatchedRead = bump; // re-arm for the next attempt
      }
    };
    redis.onWatchedRead = bump;

    await expect(store.markInReview('aww', a.id)).rejects.toMatchObject({
      code: 'OPTIMISTIC_LOCK_CONFLICT',
    });
  });

  it('mutate aborts cleanly when the mutator returns null', async () => {
    const { store } = makeStore();
    const a = await store.create(input());
    // markInReview on an already-in_review appeal is a null-mutator no-op.
    await store.markInReview('aww', a.id);
    const again = await store.markInReview('aww', a.id);
    expect(again.status).toBe('in_review');
    expect(again.version).toBe(a.version + 1); // only the first one bumped it
  });

  it('bumps the version on each successful mutation', async () => {
    const { store } = makeStore();
    const a = await store.create(input());
    expect(a.version).toBe(1);
    const reviewed = await store.markInReview('aww', a.id);
    expect(reviewed.version).toBe(2);
  });
});

describe('store: decide state machine', () => {
  const rec = { modId: 'm', modName: 'mod', note: 'n', replyText: 'r' };

  it('rejects deciding an already-resolved appeal', async () => {
    const { store } = makeStore();
    const a = await store.create(input());
    await store.decide('aww', a.id, 'upheld', rec); // resolves
    await expect(store.decide('aww', a.id, 'overturned', rec)).rejects.toMatchObject(
      { code: 'INVALID_STATE_TRANSITION' },
    );
  });

  it('schedules a resolved appeal for purge', async () => {
    const { store, redis } = makeStore();
    const a = await store.create(input());
    await store.decide('aww', a.id, 'upheld', rec);
    const purgeEntries = await redis.zRange(keys.purgeIndex('aww'), 0, -1);
    expect(purgeEntries.map((e) => e.member)).toContain(a.id);
  });

  it('does not schedule purge when retention is disabled', async () => {
    const { store, redis } = makeStore();
    await store.setConfig('aww', { ...DEFAULT_CONFIG, retentionDays: 0 });
    const a = await store.create(input());
    await store.decide('aww', a.id, 'upheld', rec);
    const purgeEntries = await redis.zRange(keys.purgeIndex('aww'), 0, -1);
    expect(purgeEntries).toHaveLength(0);
  });
});

describe('store: pagination', () => {
  it('pages through the open queue newest-first with a cursor', async () => {
    const { store, clock } = makeStore();
    await store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false, rateLimitCapacity: 100 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      const a = await store.create(input({ targetId: `t3_${i}` }));
      ids.push(a.id);
    }
    const page1 = await store.openQueuePage('aww', 2);
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first: last created appears first.
    expect(page1.items[0]!.id).toBe(ids[4]);

    const page2 = await store.openQueuePage('aww', 2, page1.nextCursor!);
    expect(page2.items).toHaveLength(2);
    expect(page2.items[0]!.id).toBe(ids[2]);

    const page3 = await store.openQueuePage('aww', 2, page2.nextCursor!);
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
  });

  it('reports the open count', async () => {
    const { store } = makeStore();
    await store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false, rateLimitCapacity: 100 });
    await store.create(input({ targetId: 't3_a' }));
    await store.create(input({ targetId: 't3_b' }));
    expect(await store.openCount('aww')).toBe(2);
  });

  it('skips corrupt records within a page without failing', async () => {
    const { store, redis, metrics } = makeStore();
    const a = await store.create(input());
    await redis.zAdd(keys.openIndex('aww'), { member: 'ap_corrupt', score: 99 });
    await redis.set(keys.appeal('aww', 'ap_corrupt'), '{bad');
    const page = await store.openQueuePage('aww', 10);
    expect(page.items.map((i) => i.id)).toContain(a.id);
    expect(page.items.map((i) => i.id)).not.toContain('ap_corrupt');
    expect(metrics.counter('store.skip_corrupt')).toBeGreaterThanOrEqual(1);
  });

  it('does not skip entries that share the same millisecond (Finding 2)', async () => {
    // All five appeals created at the SAME clock value: identical scores. With
    // a bare-score cursor (the old bug) the `cursor - 1` boundary dropped every
    // other co-scored entry. Paging at limit=2 must still surface all five,
    // each exactly once.
    const { store } = makeStore();
    await store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      oneAppealPerAction: false,
      rateLimitCapacity: 100,
    });
    const created = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const a = await store.create(input({ targetId: `t3_${i}` }));
      created.add(a.id);
    }

    const seen: string[] = [];
    let cursor = undefined as Awaited<ReturnType<typeof store.openQueuePage>>['nextCursor'];
    // Bounded loop guard so a regression can't spin forever.
    for (let guard = 0; guard < 10; guard++) {
      const page = await store.openQueuePage('aww', 2, cursor ?? undefined);
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // Every appeal appears exactly once, none skipped, none duplicated.
    expect(seen.slice().sort()).toEqual([...created].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it('reads only a bounded window from Redis per page, not the whole index (Finding 3)', async () => {
    const { store, redis } = makeStore();
    await store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      oneAppealPerAction: false,
      rateLimitCapacity: 1000,
    });
    for (let i = 0; i < 40; i++) {
      await store.create(input({ targetId: `t3_${i}` }));
    }

    // Spy on the open-index zRange calls and capture the requested count.
    const realZRange = redis.zRange.bind(redis);
    const counts: number[] = [];
    redis.zRange = (async (key, start, stop, options) => {
      if (key === keys.openIndex('aww') && options?.limit) {
        counts.push(options.limit.count);
      }
      return realZRange(key, start, stop, options);
    }) as typeof redis.zRange;

    const page = await store.openQueuePage('aww', 5);
    expect(page.items).toHaveLength(5);
    // The read was bounded to ~one page (limit + 1), NOT all 40 entries.
    expect(counts.length).toBeGreaterThan(0);
    for (const c of counts) expect(c).toBeLessThanOrEqual(6 + 5); // limit+1 (+ at most one overlap grow)
    expect(Math.max(...counts)).toBeLessThan(40);
  });
});

describe('store: lifecycle operations', () => {
  const rec = { modId: 'm', modName: 'mod', note: 'note', replyText: 'reply' };

  it('redacts an appeal and is idempotent', async () => {
    const { store } = makeStore();
    const a = await store.create(input());
    const redacted = await store.redactAppeal('aww', a.id);
    expect(redacted.authorName).toBe('[redacted]');
    const again = await store.redactAppeal('aww', a.id);
    // No further version bump on the second (no-op) redaction.
    expect(again.version).toBe(redacted.version);
  });

  it('purges appeals past their retention window and cleans indexes', async () => {
    const { store, redis, clock } = makeStore();
    const a = await store.create(input());
    await store.decide('aww', a.id, 'upheld', rec);
    // Jump well past the retention window.
    clock.advance(DEFAULT_CONFIG.retentionDays * 24 * 60 * 60 * 1000 + 1000);
    const purged = await store.purgeExpired('aww');
    expect(purged).toContain(a.id);
    expect(await store.get('aww', a.id)).toBeNull();
    expect(await redis.zRange(keys.history('aww', 'alice'), 0, -1)).toHaveLength(0);
  });

  it('purges nothing before the window elapses', async () => {
    const { store } = makeStore();
    const a = await store.create(input());
    await store.decide('aww', a.id, 'upheld', rec);
    const purged = await store.purgeExpired('aww');
    expect(purged).toHaveLength(0);
  });

  it('deletes the action snapshot when an appeal resolves (no leak)', async () => {
    const { store, redis } = makeStore();
    // Seed a snapshot the way the menu/trigger would.
    await redis.set(
      keys.actionSeed('aww', 't2_alice'),
      JSON.stringify({ actionType: 'ban', originalContent: 'x', originalReason: 'y' }),
    );
    const a = await store.create(input());
    expect(await redis.get(keys.actionSeed('aww', 't2_alice'))).toBeDefined();
    await store.decide('aww', a.id, 'upheld', rec);
    // Resolution clears the snapshot alongside the action lock.
    expect(await redis.get(keys.actionSeed('aww', 't2_alice'))).toBeUndefined();
  });

  it('deletes the action snapshot on erasure (PII residual)', async () => {
    const { store, redis } = makeStore();
    await redis.set(
      keys.actionSeed('aww', 't2_alice'),
      JSON.stringify({ actionType: 'ban', originalContent: 'sensitive', originalReason: 'y' }),
    );
    const a = await store.create(input());
    await store.redactAppeal('aww', a.id);
    expect(await redis.get(keys.actionSeed('aww', 't2_alice'))).toBeUndefined();
  });
});

describe('store: storage errors', () => {
  it('wraps a Redis get failure in STORAGE_UNAVAILABLE', async () => {
    const { store, redis } = makeStore();
    redis.failNext = { op: 'get', key: keys.config('aww') };
    await expect(store.getConfig('aww')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('wraps a Redis set failure in STORAGE_UNAVAILABLE', async () => {
    const { store, redis } = makeStore();
    redis.failNext = { op: 'set', key: keys.config('aww') };
    await expect(
      store.setConfig('aww', DEFAULT_CONFIG),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('emits metrics and counts created appeals', async () => {
    const { store, metrics } = makeStore();
    await store.create(input());
    expect(metrics.counter('appeal.created')).toBe(1);
  });

  it('wraps a transaction exec failure in STORAGE_UNAVAILABLE', async () => {
    const { store, redis } = makeStore();
    const a = await store.create(input());
    redis.failNext = { op: 'exec' };
    await expect(store.markInReview('aww', a.id)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('wraps a watch failure in STORAGE_UNAVAILABLE', async () => {
    const { store, redis } = makeStore();
    const a = await store.create(input());
    redis.failNext = { op: 'watch' };
    await expect(store.markInReview('aww', a.id)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('reports persistent CAS contention on the lock as OPTIMISTIC_LOCK_CONFLICT (M2)', async () => {
    const { store, redis } = makeStore();
    await store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      rateLimitCapacity: 100,
    });
    // Two resolved appeals; alternate the lock between their ids each round.
    // Both pass the holder-check (resolved => reclaimable), but because the
    // watched lock value changes between watch and exec every time, each claim
    // transaction aborts. With the M2 fix, exhausting the retry budget with no
    // CONFIRMED open holder surfaces OPTIMISTIC_LOCK_CONFLICT (retryable),
    // NOT DUPLICATE_OPEN_APPEAL (which is non-retryable and would mislead the
    // user into thinking they already filed an appeal).
    const seedResolved = async (target: string) => {
      const a = await store.create(input({ targetId: target }));
      await store.decide('aww', a.id, 'overturned', {
        modId: 'm',
        modName: 'mod',
        note: '',
        replyText: 'r',
      });
      return a.id;
    };
    const idA = await seedResolved('t3_seedA');
    const idB = await seedResolved('t3_seedB');

    const lockKey = keys.actionLock('aww', 't2_alice');
    let toggle = 0;
    const bump = async (key: string) => {
      // Re-arm unconditionally — `consumeRateToken` now WATCH-guards the rate-
      // limit bucket too (M1), so the *first* watched read on a `create` call
      // is on the bucket key, not the lock. We let that one no-op and stay
      // armed so the subsequent lock-watch fires the contention.
      redis.onWatchedRead = bump;
      if (key === lockKey) {
        await redis.set(lockKey, toggle++ % 2 === 0 ? idB : idA);
      }
    };
    await redis.set(lockKey, idA); // resolved holder => reclaimable
    redis.onWatchedRead = bump;

    await expect(
      store.create(input({ targetId: 't2_alice' })),
    ).rejects.toMatchObject({ code: 'OPTIMISTIC_LOCK_CONFLICT' });
  });

  it('wraps a lock-claim exec failure in STORAGE_UNAVAILABLE', async () => {
    const { store, redis } = makeStore();
    await store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: true });
    // Fail the very next exec, which will be the lock-claim transaction's exec.
    redis.failNext = { op: 'exec' };
    await expect(store.create(input())).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('wraps a lock-claim watch failure in STORAGE_UNAVAILABLE', async () => {
    const { store, redis } = makeStore();
    await store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: true });
    redis.failNext = { op: 'watch' };
    await expect(store.create(input())).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('wraps an openCount (zCard) failure in STORAGE_UNAVAILABLE', async () => {
    const { store, redis } = makeStore();
    redis.failNext = { op: 'zCard' };
    await expect(store.openCount('aww')).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('surfaces a post-resolve index-batch failure as STORAGE_UNAVAILABLE', async () => {
    const { store, redis } = makeStore();
    const a = await store.create(input());
    // After D2's tx batching, releasing the action lock + dropping the snapshot
    // + scheduling the purge entry all run inside one MULTI/EXEC instead of
    // four sequential `del`/`zRem`/`zAdd` calls. To assert that the failure
    // still surfaces as STORAGE_UNAVAILABLE, we inject on the SECOND exec the
    // operation issues (the first is mutate's own write; the second is the
    // post-mutate index batch).
    redis.failNext = { op: 'exec', skip: 1 };
    await expect(
      store.decide('aww', a.id, 'upheld', {
        modId: 'm',
        modName: 'mod',
        note: '',
        replyText: 'r',
      }),
    ).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});
