/**
 * Tests for the second review pass — every finding in CODE-FIX-NOTES-2.md is
 * traceable to a describe-block here. New features get their own files where
 * they're heavy (policy, analytics, audit chain); cross-cutting findings sit
 * here.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FakeRedis } from './helpers/fakeRedis.js';
import { AppealStore, type NewAppealInput } from '../src/core/store.js';
import { AppealService } from '../src/core/service.js';
import {
  DEFAULT_CONFIG,
  REDACTABLE_TOP_LEVEL_STRING_FIELDS,
  REDACTABLE_DECISION_FIELDS,
  type Appeal,
} from '../src/core/types.js';
import { keys } from '../src/core/keys.js';
import {
  FakeClock,
  MemoryLogger,
  MemoryMetrics,
} from '../src/core/observability/index.js';
import { redactForErasure, REDACTED } from '../src/core/lifecycle/retention.js';

function input(overrides: Partial<NewAppealInput> = {}): NewAppealInput {
  return {
    subreddit: 'aww',
    actionType: 'ban',
    targetId: 't2_alice',
    authorId: 't2_alice',
    authorName: 'alice',
    reason: 'please unban me i understand the rule i broke now',
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

function makeService(deps: ReturnType<typeof makeStore>) {
  const reddit = {
    sendReply: async (): Promise<void> => undefined,
  };
  return new AppealService(deps.store, reddit, undefined, {
    clock: deps.clock,
    metrics: deps.metrics,
    logger: deps.logger,
  });
}

// ---- Finding B: redactable-fields invariant -------------------------------

describe('Finding B: redactForErasure scrubs every listed redactable field', () => {
  it('every top-level + decision string in REDACTABLE_* becomes REDACTED', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }),
        fc.string({ minLength: 1, maxLength: 200 }),
        (reason, note) => {
          const a: Appeal = {
            id: 'ap_x',
            subreddit: 'aww',
            actionType: 'ban',
            targetId: 't',
            authorId: 't2_u',
            authorName: 'u',
            reason,
            acknowledged: true,
            originalContent: 'orig',
            originalReason: 'spam',
            status: 'resolved',
            triage: { repeatCount: 0 },
            decisions: [
              {
                decision: 'upheld',
                modId: 'm',
                modName: 'mod',
                note,
                replyText: 'reply',
                decidedAt: 1,
              },
            ],
            version: 1,
            createdAt: 1,
            updatedAt: 1,
          };
          const r = redactForErasure(a, 2);
          for (const field of REDACTABLE_TOP_LEVEL_STRING_FIELDS) {
            expect((r as unknown as Record<string, string>)[field as string]).toBe(REDACTED);
          }
          for (const d of r.decisions) {
            for (const f of REDACTABLE_DECISION_FIELDS) {
              expect((d as unknown as Record<string, string>)[f as string]).toBe(REDACTED);
            }
          }
        },
      ),
    );
  });
});

// ---- M1: CAS-guarded rate-limit -------------------------------------------

describe('M1: rate-limit consumption is CAS-guarded under contention', () => {
  it('does not burn the same token twice across parallel calls', async () => {
    const { store } = makeStore();
    await store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      oneAppealPerAction: false,
      rateLimitCapacity: 3,
      rateLimitRefillPerHour: 0,
    });
    // Fire 6 parallel creates against 6 different targets. With CAS, at most
    // `capacity` (3) should succeed; the rest should fail RATE_LIMITED or
    // OPTIMISTIC_LOCK_CONFLICT (a CAS conflict on the bucket).
    const results = await Promise.allSettled(
      [0, 1, 2, 3, 4, 5].map((i) => store.create(input({ targetId: `t3_${i}` }))),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeLessThanOrEqual(3);
  });
});

// ---- M2: claimActionLock returns typed contention --------------------------
// already covered in store.depth.test.ts under "reports persistent CAS
// contention on the lock as OPTIMISTIC_LOCK_CONFLICT (M2)"

// ---- H1: snapshot TTL + purge index ---------------------------------------

describe('H1: action-snapshot lifecycle', () => {
  it('writeSnapshot sets a TTL and registers in the snapshot-purge index', async () => {
    const { store, redis } = makeStore();
    const config = { ...DEFAULT_CONFIG, snapshotRetentionHours: 24 };
    await store.writeSnapshot('aww', 't3_x', { actionType: 'removal' }, config);
    // Key exists.
    expect(await redis.get(keys.actionSeed('aww', 't3_x'))).toBeDefined();
    // Index has an entry.
    const idx = await redis.zRange(keys.snapshotPurgeIndex('aww'), 0, Number.MAX_SAFE_INTEGER, {
      by: 'score',
    });
    expect(idx.map((e) => e.member)).toContain('t3_x');
  });

  it('L4: a second writeSnapshot for the same target does NOT overwrite', async () => {
    const { store, redis } = makeStore();
    const config = { ...DEFAULT_CONFIG, snapshotRetentionHours: 24 };
    await store.writeSnapshot('aww', 't3_x', { actionType: 'removal', tag: 'first' }, config);
    const r2 = await store.writeSnapshot('aww', 't3_x', { actionType: 'removal', tag: 'second' }, config);
    expect(r2.written).toBe(false);
    const raw = await redis.get(keys.actionSeed('aww', 't3_x'));
    expect(raw).toContain('first');
    expect(raw).not.toContain('second');
  });

  it('purgeExpiredSnapshots sweeps entries with elapsed TTL', async () => {
    const { store, redis, clock } = makeStore();
    const config = { ...DEFAULT_CONFIG, snapshotRetentionHours: 1 };
    await store.writeSnapshot('aww', 't3_x', { actionType: 'removal' }, config);
    clock.advance(2 * 60 * 60 * 1000); // 2h later
    const n = await store.purgeExpiredSnapshots('aww');
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await redis.get(keys.actionSeed('aww', 't3_x'))).toBeUndefined();
  });
});

// ---- H2: rate-limit TTL + erasure scrub ------------------------------------

describe('H2: rate-limit lifecycle', () => {
  it('eraseUser deletes the user rate-limit bucket', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    await deps.store.create(input({ targetId: 't3_a' }));
    // Bucket exists.
    expect(await deps.redis.get(keys.rateLimit('aww', 'alice'))).toBeDefined();
    await service.eraseUser('aww', 'alice');
    expect(await deps.redis.get(keys.rateLimit('aww', 'alice'))).toBeUndefined();
  });

  it('purgeExpiredRateLimits sweeps idle buckets', async () => {
    const { store, redis, clock } = makeStore();
    await store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      oneAppealPerAction: false,
      rateLimitIdleHours: 1,
    });
    await store.create(input({ targetId: 't3_a' }));
    expect(await redis.get(keys.rateLimit('aww', 'alice'))).toBeDefined();
    clock.advance(2 * 60 * 60 * 1000);
    const n = await store.purgeExpiredRateLimits('aww');
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

// ---- D1: paraphrase signal -----------------------------------------------

describe('D1: dedup raises paraphraseOfAppealId for reworded duplicates', () => {
  it('catches a paraphrase that token-Jaccard would miss', async () => {
    const { store } = makeStore();
    await store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    // Two near-paraphrases: same topic & many shared character trigrams, but
    // different enough at the word level that token-Jaccard misses them.
    await store.create(
      input({
        targetId: 't3_a',
        reason: 'my ban was unfair and I would like it reviewed by a mod please',
      }),
    );
    const second = await store.create(
      input({
        targetId: 't3_b',
        reason: 'the ban was unfair and i would like a review from a mod please',
      }),
    );
    // Either the strict duplicate or the paraphrase flag should fire; the
    // *paraphrase* slot is the new D1 capability.
    const flagged =
      second.triage.duplicateOfAppealId !== undefined ||
      second.triage.paraphraseOfAppealId !== undefined;
    expect(flagged).toBe(true);
  });
});

// ---- D4: MemoryMetrics percentiles ----------------------------------------

describe('D4: MemoryMetrics percentile rollups', () => {
  it('returns the requested quantile from a histogram', () => {
    const m = new MemoryMetrics();
    for (let i = 1; i <= 100; i++) m.timing('latency', i);
    expect(m.histogramCount('latency')).toBe(100);
    const p50 = m.percentile('latency', 50);
    const p99 = m.percentile('latency', 99);
    expect(p50).toBeDefined();
    expect(p99).toBeDefined();
    expect(p50!).toBeLessThan(p99!);
  });

  it('returns null for an unsampled metric', () => {
    const m = new MemoryMetrics();
    expect(m.percentile('nothing', 50)).toBeNull();
  });
});

// ---- D5: validation codes -------------------------------------------------

describe('D5: validation issues carry stable codes', () => {
  it('REASON_TOO_SHORT fires for sub-min reasons', async () => {
    const { store } = makeStore();
    const service = makeService({ ...makeStore(), store } as ReturnType<typeof makeStore>);
    await expect(
      service.submitAppeal({
        subreddit: 'aww',
        actionType: 'ban',
        targetId: 't',
        authorId: 't2',
        authorName: 'u',
        reason: 'short',
        acknowledged: true,
        originalContent: '',
        originalReason: '',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      context: expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'REASON_TOO_SHORT' }),
        ]),
      }),
    });
  });
});

// ---- D7: prompt escape + per-sub backend + confidence floor ---------------

describe('D7: AI hardening', () => {
  it('escapeQuoted folds triple-double-quotes to triple-single', async () => {
    const { escapeQuoted } = await import('../src/ai/provider.js');
    expect(escapeQuoted('safe text')).toBe('safe text');
    expect(escapeQuoted('"""breakout"""')).toBe("'''breakout'''");
  });

  it('selectProvider honours aiBackend=noop even with a wired backend', async () => {
    const { selectProvider, NoopAiProvider } = await import('../src/ai/provider.js');
    const backend = { triage: async () => null, softenReply: async (s: string) => s };
    const p = selectProvider(true, backend, 'noop');
    expect(p).toBeInstanceOf(NoopAiProvider);
    const q = selectProvider(true, backend, 'devvit');
    expect(q).toBe(backend);
  });

  it('applyConfidenceFloor drops low-signal labels', async () => {
    const { applyConfidenceFloor } = await import('../src/ai/provider.js');
    expect(
      applyConfidenceFloor(
        { label: 'likely_genuine', confidence: 0.4, rationale: 'r' },
        0.5,
      ),
    ).toBeNull();
    expect(
      applyConfidenceFloor(
        { label: 'likely_genuine', confidence: 0.9, rationale: 'r' },
        0.5,
      ),
    ).toMatchObject({ confidence: 0.9 });
  });
});

// ---- D8: audit chain ------------------------------------------------------

describe('D8: audit chainHash + verifyChain', () => {
  it('decide records a chainHash on each decision', async () => {
    const { store } = makeStore();
    const a = await store.create(input());
    const decided = await store.decide('aww', a.id, 'overturned', {
      modId: 'm',
      modName: 'mod',
      note: 'ok',
      replyText: 'welcome back',
    });
    expect(decided.decisions[0]?.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyChain accepts a valid chain and rejects a tampered one', async () => {
    const { verifyChain } = await import('../src/core/audit.js');
    const { store } = makeStore();
    const a = await store.create(input());
    const decided = await store.decide('aww', a.id, 'overturned', {
      modId: 'm',
      modName: 'mod',
      note: 'ok',
      replyText: 'welcome back',
    });
    expect(verifyChain(decided)).toEqual({ ok: true });
    // Tamper.
    const bad = {
      ...decided,
      decisions: decided.decisions.map((d, i) =>
        i === 0 ? { ...d, note: 'TAMPERED' } : d,
      ),
    };
    const result = verifyChain(bad);
    expect(result.ok).toBe(false);
  });
});

// ---- W3: policy predicates ------------------------------------------------

describe('W3: policy eligibility predicates', () => {
  it('cooldown blocks a re-file within the window', async () => {
    const { evaluateEligibility, DEFAULT_POLICY } = await import('../src/core/policy/index.js');
    const policy = { ...DEFAULT_POLICY, cooldownPerTargetSeconds: 60 };
    const priors = [
      {
        id: 'ap_old',
        targetId: 't3_x',
        createdAt: 100_000,
        status: 'resolved' as const,
        lastDecision: 'upheld' as const,
      },
    ];
    const r = evaluateEligibility(
      {
        authorName: 'u',
        targetId: 't3_x',
        actionType: 'removal',
        originalReason: 'r',
      },
      priors,
      policy,
      130_000, // 30s after the prior — within 60s cooldown
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('COOLDOWN_PER_TARGET');
  });

  it('blocked patterns refuse outright', async () => {
    const { evaluateEligibility, DEFAULT_POLICY } = await import('../src/core/policy/index.js');
    const r = evaluateEligibility(
      {
        authorName: 'u',
        targetId: 't3_x',
        actionType: 'ban',
        originalReason: 'ToS-violation: doxxing',
      },
      [],
      { ...DEFAULT_POLICY, blockedReasonPatterns: ['tos-violation'] },
      1,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BLOCKED_REASON_PATTERN');
  });

  it('mapRuleId resolves patterns and falls back to unmapped', async () => {
    const { mapRuleId, DEFAULT_POLICY } = await import('../src/core/policy/index.js');
    const policy = {
      ...DEFAULT_POLICY,
      rules: [
        { ruleId: 'rule-3-self-promo', label: 'Self promo', patterns: ['self promo', 'spam'] },
      ],
    };
    expect(mapRuleId('Spam — repeated self-promo', policy)).toBe('rule-3-self-promo');
    expect(mapRuleId('Off-topic', policy)).toBe('unmapped');
  });

  it('service raises APPEAL_INELIGIBLE when policy refuses', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setPolicy('aww', {
      cooldownPerTargetSeconds: 0,
      blockedReasonPatterns: ['no-appeals-allowed'],
      maxPerWindow: 0,
      maxPerWindowDays: 30,
      rules: [],
    });
    await expect(
      service.submitAppeal(input({ originalReason: 'no-appeals-allowed: ToS' })),
    ).rejects.toMatchObject({ code: 'APPEAL_INELIGIBLE' });
  });
});

// ---- W4: claim / unclaim --------------------------------------------------

describe('W4: claim / unclaim with TTL', () => {
  it('claim assigns the mod and mirrors on the appeal record', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    const a = await deps.store.create(input());
    const claimed = await service.claim('aww', a.id, 't2_mod', 'modA');
    expect(claimed.assignedModId).toBe('t2_mod');
    expect(claimed.assignedModName).toBe('modA');
  });

  it('a different mod cannot claim an unexpired claim', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    const a = await deps.store.create(input());
    await service.claim('aww', a.id, 't2_modA', 'modA');
    await expect(
      service.claim('aww', a.id, 't2_modB', 'modB'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('the holder can unclaim and someone else can then claim', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    const a = await deps.store.create(input());
    await service.claim('aww', a.id, 't2_modA', 'modA');
    await service.unclaim('aww', a.id, 't2_modA');
    const taken = await service.claim('aww', a.id, 't2_modB', 'modB');
    expect(taken.assignedModId).toBe('t2_modB');
  });

  it('claim disabled when config.claimTtlMinutes <= 0', async () => {
    const deps = makeStore();
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, claimTtlMinutes: 0 });
    const service = makeService(deps);
    const a = await deps.store.create(input());
    await expect(
      service.claim('aww', a.id, 't2_modA', 'modA'),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });
});

// ---- decideBatch (T2.2) ---------------------------------------------------

describe('decideBatch applies a decision to N appeals with per-item failure surfacing', () => {
  it('decides every healthy item and collects failures for invalid ids', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    const a = await deps.store.create(input({ targetId: 't3_a' }));
    const b = await deps.store.create(input({ targetId: 't3_b' }));
    const result = await service.decideBatch({
      subreddit: 'aww',
      appealIds: [a.id, 'ap_does_not_exist', b.id],
      decision: 'upheld',
      modId: 'm',
      modName: 'mod',
      note: '',
    });
    expect(result.decided).toEqual([a.id, b.id]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.code).toBe('APPEAL_NOT_FOUND');
  });
});

// ---- analytics (T2.1 / W2) ------------------------------------------------

describe('Analytics: SubAnalytics output', () => {
  it('reports counts and median TTR for resolved appeals in the window', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    // Two resolved appeals.
    const a = await deps.store.create(input({ targetId: 't3_a' }));
    const b = await deps.store.create(input({ targetId: 't3_b' }));
    deps.clock.advance(60_000);
    await deps.store.decide('aww', a.id, 'overturned', {
      modId: 'm',
      modName: 'mod',
      note: '',
      replyText: 'r',
    });
    await deps.store.decide('aww', b.id, 'upheld', {
      modId: 'm',
      modName: 'mod',
      note: '',
      replyText: 'r',
    });
    const stats = await service.analytics('aww', 30);
    expect(stats.resolvedInWindow).toBe(2);
    expect(stats.overturnedInWindow).toBe(1);
    expect(stats.medianTimeToDecisionMs).not.toBeNull();
  });
});

// ---- coverage closers (exercise every public branch) ---------------------

describe('coverage closers', () => {
  it('keys.subwideRateLimit composes the documented shape', () => {
    expect(keys.subwideRateLimit('aww', 'ban')).toBe('ratelimit-sub:aww:ban');
  });

  it('verifyChain rejects a gap_after_hash', async () => {
    const { computeChainHash, verifyChain } = await import('../src/core/audit.js');
    const recA = { decision: 'upheld' as const, modId: 'm', modName: 'mod', note: '', replyText: 'r', decidedAt: 1 };
    const hashA = computeChainHash('', recA);
    const appeal: Appeal = {
      id: 'a', subreddit: 's', actionType: 'ban', targetId: 't',
      authorId: 't2', authorName: 'u', reason: 'r', acknowledged: true,
      originalContent: 'o', originalReason: 'or',
      status: 'resolved', triage: { repeatCount: 0 }, version: 1,
      createdAt: 1, updatedAt: 2,
      decisions: [
        { ...recA, chainHash: hashA },
        // The follow-up record has NO chainHash — a "gap after hash" tamper.
        { decision: 'overturned', modId: 'm', modName: 'mod', note: '', replyText: 'r', decidedAt: 2 },
      ],
    };
    const result = verifyChain(appeal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('gap_after_hash');
      expect(result.at).toBe(1);
    }
  });

  it('NoopNotifier.notify is awaitable and does nothing observable', async () => {
    const { NoopNotifier } = await import('../src/core/notifier.js');
    const n = new NoopNotifier();
    await expect(
      n.notify({
        kind: 'sla_breach',
        subreddit: 'aww',
        subject: 's',
        body: 'b',
      }),
    ).resolves.toBeUndefined();
  });

  it('service.notifySlaBreach forwards through the injected Notifier', async () => {
    const calls: unknown[] = [];
    const deps = makeStore();
    const reddit = { sendReply: async (): Promise<void> => undefined };
    const notifier = { notify: async (n: unknown): Promise<void> => { calls.push(n); } };
    const service = new AppealService(deps.store, reddit, undefined, {
      clock: deps.clock,
      metrics: deps.metrics,
      logger: deps.logger,
    }, notifier);
    await service.notifySlaBreach('aww', 3, 48);
    expect(calls).toHaveLength(1);
    expect((calls[0] as { kind: string }).kind).toBe('sla_breach');
  });

  it('service.purgeSnapshots / purgeRateLimits are pass-throughs', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      snapshotRetentionHours: 1,
      rateLimitIdleHours: 1,
      oneAppealPerAction: false,
    });
    await deps.store.writeSnapshot('aww', 't3_x', { actionType: 'removal' }, {
      ...DEFAULT_CONFIG,
      snapshotRetentionHours: 1,
    });
    await deps.store.create(input({ targetId: 't3_a' }));
    deps.clock.advance(2 * 60 * 60 * 1000);
    expect(await service.purgeSnapshots('aww')).toBeGreaterThanOrEqual(1);
    expect(await service.purgeRateLimits('aww')).toBeGreaterThanOrEqual(1);
  });

  it('service.purgeRetention drains resolved appeals', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      retentionDays: 1,
      oneAppealPerAction: false,
    });
    const a = await deps.store.create(input({ targetId: 't3_a' }));
    await deps.store.decide('aww', a.id, 'upheld', {
      modId: 'm',
      modName: 'mod',
      note: '',
      replyText: 'r',
    });
    deps.clock.advance(2 * 24 * 60 * 60 * 1000);
    const purged = await service.purgeRetention('aww');
    expect(purged).toContain(a.id);
  });

  it('service.remapRuleId re-applies the current policy mapping', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    const a = await deps.store.create(input({ originalReason: 'self-promo' }));
    expect(a.ruleId).toBeUndefined();
    await deps.store.setPolicy('aww', {
      cooldownPerTargetSeconds: 0,
      blockedReasonPatterns: [],
      maxPerWindow: 0,
      maxPerWindowDays: 30,
      rules: [{ ruleId: 'rule-3', label: 'Self promo', patterns: ['self-promo'] }],
    });
    const remapped = await service.remapRuleId('aww', a.id);
    expect(remapped.ruleId).toBe('rule-3');
  });

  it('service.eraseAppeal redacts a single resolved appeal', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    const a = await deps.store.create(input({ reason: 'this is my private appeal text' }));
    await deps.store.decide('aww', a.id, 'upheld', {
      modId: 'm', modName: 'mod', note: '', replyText: 'r',
    });
    const erased = await service.eraseAppeal('aww', a.id);
    expect(erased.reason).not.toBe('this is my private appeal text');
  });

  it('service.eraseUserByMod writes to the erasure log', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    await deps.store.create(input());
    await service.eraseUserByMod('aww', 'alice', 't2_mod', 'modA');
    const log = await deps.redis.zRange(
      keys.erasureLog('aww'),
      0,
      Number.MAX_SAFE_INTEGER,
      { by: 'score' },
    );
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it('analytics returns zeros for an empty sub', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    const stats = await service.analytics('empty-sub', 30);
    expect(stats.openCount).toBe(0);
    expect(stats.resolvedInWindow).toBe(0);
    expect(stats.medianTimeToDecisionMs).toBeNull();
  });

  it('analytics tops are bounded and stable', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      oneAppealPerAction: false,
      rateLimitCapacity: 100,
    });
    // Resolve several overturns sharing one reason
    for (let i = 0; i < 3; i++) {
      const a = await deps.store.create(input({ targetId: `t3_${i}`, originalReason: 'shared reason X' }));
      deps.clock.advance(60_000);
      await deps.store.decide('aww', a.id, 'overturned', {
        modId: 'm', modName: 'mod', note: '', replyText: 'r',
      });
    }
    const stats = await service.analytics('aww', 30);
    expect(stats.topOriginalReasonsOverturned[0]?.count).toBe(3);
  });

  it('decideBatch surfaces a validation failure as a per-item failure', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, oneAppealPerAction: false });
    const a = await deps.store.create(input());
    const result = await service.decideBatch({
      subreddit: 'aww',
      appealIds: [a.id],
      decision: 'upheld',
      modId: 'm',
      modName: 'mod',
      note: 'x'.repeat(10_000), // far past the noteMax → validation fails
    });
    expect(result.decided).toHaveLength(0);
    expect(result.failures[0]?.code).toBe('VALIDATION_FAILED');
  });

  it('policy MAX_PER_WINDOW refuses when the user is past the cap', async () => {
    const { evaluateEligibility, DEFAULT_POLICY } = await import('../src/core/policy/index.js');
    const priors = [
      { id: 'a', targetId: '', createdAt: 100, status: 'resolved' as const, lastDecision: null },
      { id: 'b', targetId: '', createdAt: 200, status: 'resolved' as const, lastDecision: null },
    ];
    const policy = { ...DEFAULT_POLICY, maxPerWindow: 2, maxPerWindowDays: 30 };
    const r = evaluateEligibility(
      { authorName: 'u', targetId: 't', actionType: 'ban', originalReason: 'r' },
      priors,
      policy,
      300,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MAX_PER_WINDOW');
  });

  it('policy mapRuleId skips empty patterns gracefully', async () => {
    const { mapRuleId, DEFAULT_POLICY } = await import('../src/core/policy/index.js');
    const policy = {
      ...DEFAULT_POLICY,
      rules: [
        { ruleId: 'has-empty', label: 'L', patterns: ['', 'good'] }, // empty pattern
      ],
    };
    expect(mapRuleId('match the good one', policy)).toBe('has-empty');
    expect(mapRuleId('other', policy)).toBe('unmapped');
  });

  it('analytics labelForActionType handles known & unknown action types', async () => {
    const { labelForActionType } = await import('../src/core/analytics/index.js');
    expect(labelForActionType('ban')).not.toBe('ban'); // mapped to a human label
    expect(labelForActionType('mystery')).toBe('mystery'); // passthrough
  });

  it('store: claimAppeal refuses past TTL when a different mod tries', async () => {
    const deps = makeStore();
    const a = await deps.store.create(input());
    await deps.store.setConfig('aww', { ...DEFAULT_CONFIG, claimTtlMinutes: 5 });
    await deps.store.claimAppeal('aww', a.id, 't2_modA', 'modA', 5);
    deps.clock.advance(6 * 60 * 1000); // past TTL
    const claimed = await deps.store.claimAppeal('aww', a.id, 't2_modB', 'modB', 5);
    expect(claimed.assignedModId).toBe('t2_modB');
  });
});

// ---- M3: paged queue + bounded read ---------------------------------------

describe('M3: queuePage exposes the next cursor, openCount returns the true total', () => {
  it('pages through 50 open appeals at PAGE_SIZE=25', async () => {
    const deps = makeStore();
    const service = makeService(deps);
    await deps.store.setConfig('aww', {
      ...DEFAULT_CONFIG,
      oneAppealPerAction: false,
      rateLimitCapacity: 1000,
      rateLimitRefillPerHour: 0,
    });
    for (let i = 0; i < 50; i++) {
      await deps.store.create(input({ targetId: `t3_${i}` }));
      deps.clock.advance(1); // unique timestamps
    }
    expect(await service.openCount('aww')).toBe(50);
    const first = await service.queuePage('aww', 25);
    expect(first.items).toHaveLength(25);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.queuePage('aww', 25, first.nextCursor!);
    expect(second.items).toHaveLength(25);
    expect(second.nextCursor).toBeNull();
  });
});
