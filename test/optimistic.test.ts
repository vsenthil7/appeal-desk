import { describe, it, expect } from 'vitest';
import {
  hasConflict,
  bumpVersion,
  canTransition,
  statusForDecision,
  isDecidable,
  isInOpenQueue,
  withStatus,
} from '../src/core/concurrency/optimistic.js';
import type { Appeal, AppealStatus } from '../src/core/types.js';

function appeal(status: AppealStatus, version = 1): Appeal {
  return {
    id: 'ap_1',
    subreddit: 'aww',
    actionType: 'ban',
    targetId: 't2_u',
    authorId: 't2_u',
    authorName: 'alice',
    reason: 'r',
    acknowledged: true,
    originalContent: 'c',
    originalReason: 'reason',
    status,
    triage: { repeatCount: 0 },
    decisions: [],
    version,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('version helpers', () => {
  it('detects a version conflict', () => {
    expect(hasConflict(1, 1)).toBe(false);
    expect(hasConflict(1, 2)).toBe(true);
  });
  it('bumps monotonically', () => {
    expect(bumpVersion(1)).toBe(2);
    expect(bumpVersion(9)).toBe(10);
  });
});

describe('canTransition', () => {
  it('allows the documented legal moves', () => {
    expect(canTransition('open', 'in_review')).toBe(true);
    expect(canTransition('open', 'resolved')).toBe(true);
    expect(canTransition('open', 'awaiting_user')).toBe(true);
    expect(canTransition('in_review', 'resolved')).toBe(true);
    expect(canTransition('in_review', 'awaiting_user')).toBe(true);
    expect(canTransition('awaiting_user', 'in_review')).toBe(true);
    expect(canTransition('awaiting_user', 'resolved')).toBe(true);
  });

  it('rejects illegal moves, especially out of the terminal state', () => {
    expect(canTransition('resolved', 'open')).toBe(false);
    expect(canTransition('resolved', 'in_review')).toBe(false);
    expect(canTransition('in_review', 'open')).toBe(false);
  });

  it('treats a same-state transition as an idempotent allow', () => {
    expect(canTransition('resolved', 'resolved')).toBe(true);
    expect(canTransition('open', 'open')).toBe(true);
  });
});

describe('statusForDecision', () => {
  it('maps more_info to awaiting_user and others to resolved', () => {
    expect(statusForDecision('more_info')).toBe('awaiting_user');
    expect(statusForDecision('upheld')).toBe('resolved');
    expect(statusForDecision('overturned')).toBe('resolved');
  });
});

describe('isDecidable / isInOpenQueue', () => {
  it('treats resolved as not decidable and not queued', () => {
    expect(isDecidable('resolved')).toBe(false);
    expect(isInOpenQueue('resolved')).toBe(false);
  });
  it('treats every other status as decidable and queued', () => {
    for (const s of ['open', 'in_review', 'awaiting_user'] as const) {
      expect(isDecidable(s)).toBe(true);
      expect(isInOpenQueue(s)).toBe(true);
    }
  });
});

describe('withStatus', () => {
  it('sets the status, bumps the version, and stamps updatedAt', () => {
    const next = withStatus(appeal('open', 3), 'in_review', 9999);
    expect(next.status).toBe('in_review');
    expect(next.version).toBe(4);
    expect(next.updatedAt).toBe(9999);
  });

  it('does not mutate the input (returns a copy)', () => {
    const original = appeal('open', 1);
    withStatus(original, 'resolved', 2);
    expect(original.status).toBe('open');
    expect(original.version).toBe(1);
  });
});
