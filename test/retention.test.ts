import { describe, it, expect } from 'vitest';
import {
  purgeEligibleAt,
  isPurgeEligible,
  lastDecisionAt,
  redactForErasure,
  isRedacted,
  REDACTED,
} from '../src/core/lifecycle/retention.js';
import type { Appeal, AppealStatus } from '../src/core/types.js';

const DAY = 24 * 60 * 60 * 1000;

function appeal(over: Partial<Appeal> = {}): Appeal {
  return {
    id: 'ap_1',
    subreddit: 'aww',
    actionType: 'ban',
    targetId: 't2_u',
    authorId: 't2_u',
    authorName: 'alice',
    reason: 'please reconsider this',
    acknowledged: true,
    originalContent: 'the original post body',
    originalReason: 'spam',
    permalink: 'https://reddit.com/x',
    status: 'resolved' as AppealStatus,
    triage: {
      repeatCount: 1,
      duplicateOfAppealId: 'ap_old',
      model: { label: 'likely_genuine', confidence: 0.8, rationale: 'sincere note' },
    },
    decisions: [
      {
        decision: 'upheld',
        modId: 'm',
        modName: 'mod',
        note: 'internal note',
        replyText: 'sent reply',
        decidedAt: 10 * DAY,
      },
    ],
    version: 2,
    createdAt: 1 * DAY,
    updatedAt: 10 * DAY,
    ...over,
  };
}

describe('lastDecisionAt', () => {
  it('returns the most recent decision time', () => {
    expect(lastDecisionAt(appeal())).toBe(10 * DAY);
  });
  it('returns null when there are no decisions', () => {
    expect(lastDecisionAt(appeal({ decisions: [] }))).toBeNull();
  });
});

describe('purgeEligibleAt', () => {
  it('is resolvedAt + retention window for a resolved appeal', () => {
    expect(purgeEligibleAt(appeal(), 30)).toBe(10 * DAY + 30 * DAY);
  });
  it('is null when retention is disabled', () => {
    expect(purgeEligibleAt(appeal(), 0)).toBeNull();
  });
  it('is null for a non-resolved appeal', () => {
    expect(purgeEligibleAt(appeal({ status: 'open' }), 30)).toBeNull();
  });
  it('falls back to updatedAt when there are no decisions', () => {
    const a = appeal({ decisions: [], updatedAt: 5 * DAY });
    expect(purgeEligibleAt(a, 10)).toBe(5 * DAY + 10 * DAY);
  });
});

describe('isPurgeEligible', () => {
  it('is true at or after the eligibility time', () => {
    expect(isPurgeEligible(appeal(), 30, 10 * DAY + 30 * DAY)).toBe(true);
    expect(isPurgeEligible(appeal(), 30, 100 * DAY)).toBe(true);
  });
  it('is false before the eligibility time and when disabled', () => {
    expect(isPurgeEligible(appeal(), 30, 11 * DAY)).toBe(false);
    expect(isPurgeEligible(appeal(), 0, 100 * DAY)).toBe(false);
  });
});

describe('redactForErasure', () => {
  it('scrubs PII and free text while keeping structural facts', () => {
    const r = redactForErasure(appeal(), 50 * DAY);
    expect(r.authorName).toBe(REDACTED);
    expect(r.reason).toBe(REDACTED);
    expect(r.originalContent).toBe(REDACTED);
    expect(r.permalink).toBeUndefined();
    expect(r.triage.model?.rationale).toBe(REDACTED);
    // Structural signal preserved.
    expect(r.triage.repeatCount).toBe(1);
    expect(r.triage.model?.label).toBe('likely_genuine');
    expect(r.status).toBe('resolved');
    expect(r.decisions[0]!.decision).toBe('upheld');
    expect(r.decisions[0]!.note).toBe(REDACTED);
    expect(r.decisions[0]!.replyText).toBe(REDACTED);
    expect(r.version).toBe(3);
    expect(r.updatedAt).toBe(50 * DAY);
  });

  it('handles an appeal with no AI model gracefully', () => {
    const a = appeal({ triage: { repeatCount: 0 } });
    const r = redactForErasure(a, 1);
    expect(r.triage.model).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const a = appeal();
    redactForErasure(a, 1);
    expect(a.authorName).toBe('alice');
    expect(a.reason).toBe('please reconsider this');
  });
});

describe('isRedacted', () => {
  it('detects a redacted appeal', () => {
    expect(isRedacted(redactForErasure(appeal(), 1))).toBe(true);
  });
  it('is false for a normal appeal', () => {
    expect(isRedacted(appeal())).toBe(false);
  });
});
