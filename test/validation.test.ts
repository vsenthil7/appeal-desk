import { describe, it, expect } from 'vitest';
import {
  validateSubmission,
  validateDecision,
  sanitiseText,
  LIMITS,
  type AppealSubmissionInput,
} from '../src/core/validation/index.js';

function goodSubmission(
  overrides: Partial<AppealSubmissionInput> = {},
): AppealSubmissionInput {
  return {
    reason: 'this is a perfectly reasonable appeal text',
    acknowledged: true,
    actionType: 'ban',
    targetId: 't2_user',
    authorName: 'alice',
    ...overrides,
  };
}

function issueFields(r: ReturnType<typeof validateSubmission>): string[] {
  return r.ok ? [] : r.issues.map((i) => i.field);
}

describe('validateSubmission', () => {
  it('accepts a well-formed submission', () => {
    expect(validateSubmission(goodSubmission()).ok).toBe(true);
  });

  it('rejects a non-string reason', () => {
    expect(issueFields(validateSubmission(goodSubmission({ reason: 5 })))).toContain(
      'reason',
    );
  });

  it('rejects a reason shorter than the minimum', () => {
    const r = validateSubmission(goodSubmission({ reason: 'short' }));
    expect(issueFields(r)).toContain('reason');
  });

  it('rejects a reason longer than the maximum', () => {
    const r = validateSubmission(
      goodSubmission({ reason: 'a'.repeat(LIMITS.reasonMax + 1) }),
    );
    expect(issueFields(r)).toContain('reason');
  });

  it('rejects a reason with control characters', () => {
    const r = validateSubmission(
      goodSubmission({ reason: 'valid enough text\u0000with null' }),
    );
    expect(issueFields(r)).toContain('reason');
  });

  it('rejects a non-boolean acknowledgement', () => {
    expect(
      issueFields(validateSubmission(goodSubmission({ acknowledged: 'yes' }))),
    ).toContain('acknowledged');
  });

  it('rejects an unknown action type', () => {
    expect(
      issueFields(validateSubmission(goodSubmission({ actionType: 'nuke' }))),
    ).toContain('actionType');
  });

  it('rejects a non-string or out-of-range target id', () => {
    expect(
      issueFields(validateSubmission(goodSubmission({ targetId: 123 }))),
    ).toContain('targetId');
    expect(
      issueFields(validateSubmission(goodSubmission({ targetId: '' }))),
    ).toContain('targetId');
    expect(
      issueFields(
        validateSubmission(
          goodSubmission({ targetId: 'x'.repeat(LIMITS.targetIdMax + 1) }),
        ),
      ),
    ).toContain('targetId');
  });

  it('rejects a non-string or out-of-range author name', () => {
    expect(
      issueFields(validateSubmission(goodSubmission({ authorName: 9 }))),
    ).toContain('authorName');
    expect(
      issueFields(validateSubmission(goodSubmission({ authorName: '' }))),
    ).toContain('authorName');
    expect(
      issueFields(
        validateSubmission(
          goodSubmission({ authorName: 'x'.repeat(LIMITS.usernameMax + 1) }),
        ),
      ),
    ).toContain('authorName');
  });

  it('aggregates multiple issues at once', () => {
    const r = validateSubmission({
      reason: '',
      acknowledged: 'no',
      actionType: 'bad',
      targetId: '',
      authorName: '',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.length).toBeGreaterThanOrEqual(5);
  });
});

describe('validateDecision', () => {
  it('accepts a valid decision with optional fields omitted', () => {
    expect(
      validateDecision({ decision: 'upheld', note: undefined, finalReply: undefined })
        .ok,
    ).toBe(true);
  });

  it('rejects an unknown decision', () => {
    const r = validateDecision({ decision: 'maybe', note: '', finalReply: '' });
    expect(r.ok).toBe(false);
  });

  it('rejects a non-string or over-long note', () => {
    expect(
      validateDecision({ decision: 'upheld', note: 5, finalReply: undefined }).ok,
    ).toBe(false);
    expect(
      validateDecision({
        decision: 'upheld',
        note: 'a'.repeat(LIMITS.noteMax + 1),
        finalReply: undefined,
      }).ok,
    ).toBe(false);
  });

  it('accepts a null note (treated as absent)', () => {
    expect(
      validateDecision({ decision: 'upheld', note: null, finalReply: undefined }).ok,
    ).toBe(true);
  });

  it('rejects an empty, non-string, or over-long final reply', () => {
    expect(
      validateDecision({ decision: 'upheld', note: '', finalReply: '   ' }).ok,
    ).toBe(false);
    expect(
      validateDecision({ decision: 'upheld', note: '', finalReply: 7 }).ok,
    ).toBe(false);
    expect(
      validateDecision({
        decision: 'upheld',
        note: '',
        finalReply: 'a'.repeat(LIMITS.replyMax + 1),
      }).ok,
    ).toBe(false);
  });

  it('accepts a valid final reply', () => {
    expect(
      validateDecision({
        decision: 'overturned',
        note: 'ok',
        finalReply: 'You are unbanned.',
      }).ok,
    ).toBe(true);
  });
});

describe('sanitiseText', () => {
  it('trims, strips control chars, and caps length', () => {
    expect(sanitiseText('  hello\u0000world  ', 100)).toBe('helloworld');
    expect(sanitiseText('abcdef', 3)).toBe('abc');
  });

  it('keeps newlines and tabs', () => {
    expect(sanitiseText('line1\nline2\tend', 100)).toBe('line1\nline2\tend');
  });
});
