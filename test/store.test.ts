import { describe, it, expect, beforeEach } from 'vitest';
import { FakeRedis } from './helpers/fakeRedis.js';
import { AppealStore, summarise, type NewAppealInput } from '../src/core/store.js';
import { DEFAULT_CONFIG, type Appeal } from '../src/core/types.js';
import { keys } from '../src/core/keys.js';

function input(overrides: Partial<NewAppealInput> = {}): NewAppealInput {
  return {
    subreddit: 'aww',
    actionType: 'ban',
    targetId: 't2_alice',
    authorId: 't2_alice',
    authorName: 'alice',
    reason: 'please unban me this was unfair',
    acknowledged: true,
    originalContent: '(account ban)',
    originalReason: 'spam',
    ...overrides,
  };
}

describe('AppealStore.config', () => {
  let redis: FakeRedis;
  let store: AppealStore;
  beforeEach(() => {
    redis = new FakeRedis();
    store = new AppealStore(redis as never);
  });

  it('returns defaults when no config is stored', async () => {
    expect(await store.getConfig('aww')).toEqual(DEFAULT_CONFIG);
  });

  it('persists and merges config over defaults', async () => {
    await store.setConfig('aww', { ...DEFAULT_CONFIG, slaHours: 12 });
    const cfg = await store.getConfig('aww');
    expect(cfg.slaHours).toBe(12);
    expect(cfg.templates.upheld).toBe(DEFAULT_CONFIG.templates.upheld);
  });

  it('returns defaults when stored config is corrupt JSON', async () => {
    await redis.set(keys.config('aww'), '{not json');
    expect(await store.getConfig('aww')).toEqual(DEFAULT_CONFIG);
  });
});

describe('AppealStore.create & reads', () => {
  let redis: FakeRedis;
  let store: AppealStore;
  beforeEach(() => {
    redis = new FakeRedis();
    store = new AppealStore(redis as never);
  });

  it('creates an appeal, indexes it, and seeds the action lock', async () => {
    const a = await store.create(input());
    expect(a).not.toBeNull();
    expect(a!.status).toBe('open');

    // Stored and retrievable.
    expect(await store.get('aww', a!.id)).toMatchObject({ id: a!.id });

    // Open queue contains it.
    const queue = await store.openQueue('aww');
    expect(queue.map((q) => q.id)).toContain(a!.id);

    // History contains it.
    expect(await store.historyIds('aww', 'alice')).toContain(a!.id);

    // Action lock points at it.
    expect(await redis.get(keys.actionLock('aww', 't2_alice'))).toBe(a!.id);
  });

  it('computes repeatCount and a duplicate flag across appeals', async () => {
    // Distinct targetIds so the one-appeal-per-action lock doesn't block the
    // second create; we're testing dedup of the user's history, not the lock.
    await store.create(
      input({ targetId: 't3_a', reason: 'please unban me this was so unfair' }),
    );
    const second = await store.create(
      input({
        targetId: 't3_b',
        reason: 'please unban me this was very unfair indeed',
      }),
    );
    expect(second).not.toBeNull();
    expect(second!.triage.repeatCount).toBe(1);
    expect(second!.triage.duplicateOfAppealId).toBeDefined();
  });

  it('blocks a second OPEN appeal for the same action when oneAppealPerAction', async () => {
    const first = await store.create(input());
    expect(first).not.toBeNull();
    const blocked = await store.create(input());
    expect(blocked).toBeNull();
  });

  it('allows a new appeal once the prior one for the action is resolved', async () => {
    const first = await store.create(input());
    await store.decide('aww', first!.id, 'upheld', {
      modId: 'm',
      modName: 'mod',
      note: '',
      replyText: 'no',
    });
    const again = await store.create(input());
    expect(again).not.toBeNull();
  });

  it('allows multiple open appeals when oneAppealPerAction is off', async () => {
    await store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    const a = await store.create(input());
    const b = await store.create(input());
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('does not block when the lock points at a missing appeal', async () => {
    // Seed a dangling lock with no backing appeal record.
    await redis.set(keys.actionLock('aww', 't2_alice'), 'ap_ghost');
    const a = await store.create(input());
    expect(a).not.toBeNull();
  });

  it('get returns null for a missing or corrupt record', async () => {
    expect(await store.get('aww', 'nope')).toBeNull();
    await redis.set(keys.appeal('aww', 'bad'), '{broken');
    expect(await store.get('aww', 'bad')).toBeNull();
  });

  it('priorAppeals skips ids whose records are missing', async () => {
    const a = await store.create(input());
    // Add a dangling id to history.
    await redis.zAdd(keys.history('aww', 'alice'), {
      member: 'ap_missing',
      score: 1,
    });
    const prior = await store.priorAppeals('aww', 'alice');
    expect(prior.map((p) => p.id)).toContain(a!.id);
    expect(prior.map((p) => p.id)).not.toContain('ap_missing');
  });

  it('openQueue skips dangling index entries and respects the limit', async () => {
    const a = await store.create(input());
    await redis.zAdd(keys.openIndex('aww'), { member: 'ap_dangling', score: 5 });
    const queue = await store.openQueue('aww', 50);
    expect(queue.map((q) => q.id)).toContain(a!.id);
    expect(queue.map((q) => q.id)).not.toContain('ap_dangling');
  });
});

describe('AppealStore.markInReview', () => {
  let store: AppealStore;
  beforeEach(() => {
    store = new AppealStore(new FakeRedis() as never);
  });

  it('moves an open appeal to in_review', async () => {
    const a = await store.create(input());
    const r = await store.markInReview('aww', a!.id);
    expect(r!.status).toBe('in_review');
  });

  it('is idempotent for non-open appeals and returns null for missing', async () => {
    const a = await store.create(input());
    await store.markInReview('aww', a!.id); // now in_review
    const again = await store.markInReview('aww', a!.id);
    expect(again!.status).toBe('in_review');
    expect(await store.markInReview('aww', 'missing')).toBeNull();
  });
});

describe('AppealStore.decide', () => {
  let redis: FakeRedis;
  let store: AppealStore;
  beforeEach(() => {
    redis = new FakeRedis();
    store = new AppealStore(redis as never);
  });

  const rec = { modId: 'm1', modName: 'mod', note: 'n', replyText: 'r' };

  it('returns null for a missing appeal', async () => {
    expect(await store.decide('aww', 'missing', 'upheld', rec)).toBeNull();
  });

  it('resolving removes it from the open queue and releases the lock', async () => {
    const a = await store.create(input());
    const decided = await store.decide('aww', a!.id, 'overturned', rec);
    expect(decided!.status).toBe('resolved');
    expect(decided!.decisions).toHaveLength(1);

    const queue = await store.openQueue('aww');
    expect(queue.map((q) => q.id)).not.toContain(a!.id);
    expect(await redis.get(keys.actionLock('aww', 't2_alice'))).toBeUndefined();
  });

  it('more_info keeps it in the queue as awaiting_user', async () => {
    const a = await store.create(input());
    const decided = await store.decide('aww', a!.id, 'more_info', rec);
    expect(decided!.status).toBe('awaiting_user');
    const queue = await store.openQueue('aww');
    expect(queue.map((q) => q.id)).toContain(a!.id);
  });

  it('appends to the audit trail across multiple decisions', async () => {
    const a = await store.create(input());
    await store.decide('aww', a!.id, 'more_info', rec);
    const final = await store.decide('aww', a!.id, 'upheld', rec);
    expect(final!.decisions).toHaveLength(2);
  });
});

describe('AppealStore.setAiLabel', () => {
  let store: AppealStore;
  beforeEach(() => {
    store = new AppealStore(new FakeRedis() as never);
  });

  it('attaches an AI label to an existing appeal', async () => {
    const a = await store.create(input());
    await store.setAiLabel('aww', a!.id, {
      label: 'likely_genuine',
      confidence: 0.7,
      rationale: 'sincere',
    });
    const reloaded = await store.get('aww', a!.id);
    expect(reloaded!.triage.model?.label).toBe('likely_genuine');
  });

  it('is a no-op for a missing appeal', async () => {
    await expect(
      store.setAiLabel('aww', 'missing', {
        label: 'likely_genuine',
        confidence: 0.5,
        rationale: 'x',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('summarise', () => {
  it('reduces an appeal to its list summary', () => {
    const appeal: Appeal = {
      id: 'ap_1',
      subreddit: 'aww',
      actionType: 'comment_removal',
      targetId: 't1_c',
      authorId: 't2_u',
      authorName: 'bob',
      reason: 'r',
      acknowledged: false,
      originalContent: 'c',
      originalReason: 'rule',
      status: 'open',
      triage: { repeatCount: 3 },
      decisions: [],
      createdAt: 42,
      updatedAt: 42,
    };
    expect(summarise(appeal)).toEqual({
      id: 'ap_1',
      authorName: 'bob',
      actionType: 'comment_removal',
      status: 'open',
      repeatCount: 3,
      createdAt: 42,
    });
  });
});
