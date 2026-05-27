import { describe, it, expect } from 'vitest';
import {
  normalise,
  tokenSet,
  jaccard,
  computeDedup,
  DUPLICATE_THRESHOLD,
} from '../src/core/dedup.js';

describe('normalise', () => {
  it('lowercases, strips punctuation and urls, collapses whitespace', () => {
    const out = normalise('  Hello,   WORLD!! visit https://x.com/y now ');
    expect(out).toBe('hello world visit now');
  });

  it('handles empty input', () => {
    expect(normalise('')).toBe('');
  });
});

describe('tokenSet', () => {
  it('keeps only words longer than two characters', () => {
    const s = tokenSet('I am at the big house to go in');
    expect(s.has('big')).toBe(true);
    expect(s.has('house')).toBe(true);
    expect(s.has('am')).toBe(false); // length 2
    expect(s.has('to')).toBe(false);
  });
});

describe('jaccard', () => {
  it('is 1 for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });

  it('is 0 when exactly one set is empty', () => {
    expect(jaccard(new Set(['a']), new Set())).toBe(0);
    expect(jaccard(new Set(), new Set(['a']))).toBe(0);
  });

  it('computes intersection over union', () => {
    const a = new Set(['cat', 'dog', 'fish']);
    const b = new Set(['dog', 'fish', 'bird']);
    // intersection {dog,fish}=2, union {cat,dog,fish,bird}=4 => 0.5
    expect(jaccard(a, b)).toBe(0.5);
  });

  it('is 1 for identical sets', () => {
    const a = new Set(['x', 'y']);
    expect(jaccard(a, new Set(['x', 'y']))).toBe(1);
  });
});

describe('computeDedup', () => {
  it('reports zero repeats and no duplicate when there is no history', () => {
    const r = computeDedup('please unban me I was wrong', []);
    expect(r.repeatCount).toBe(0);
    expect(r.duplicateOfAppealId).toBeUndefined();
  });

  it('flags a near-duplicate above the threshold and returns its id', () => {
    const prior = [
      { id: 'ap_old', reason: 'please unban me this was so unfair' },
      { id: 'ap_other', reason: 'completely different topic about cats' },
    ];
    // ~0.71 Jaccard against ap_old — comfortably above the 0.6 threshold.
    const r = computeDedup('please unban me this was very unfair indeed', prior);
    expect(r.repeatCount).toBe(2);
    expect(r.duplicateOfAppealId).toBe('ap_old');
  });

  it('does not flag a duplicate when similarity is below threshold', () => {
    const prior = [{ id: 'ap_old', reason: 'my cat knocked over a vase' }];
    const r = computeDedup('the moderation policy is inconsistent here', prior);
    expect(r.repeatCount).toBe(1);
    expect(r.duplicateOfAppealId).toBeUndefined();
  });

  it('picks the MOST similar prior appeal when several exist', () => {
    const prior = [
      { id: 'ap_a', reason: 'unban me please i promise to behave now' },
      { id: 'ap_b', reason: 'unban me please i promise to behave from now on' },
    ];
    const r = computeDedup(
      'unban me please i promise to behave from now on really',
      prior,
    );
    expect(r.duplicateOfAppealId).toBe('ap_b');
  });

  it('exposes a sane threshold constant', () => {
    expect(DUPLICATE_THRESHOLD).toBeGreaterThan(0);
    expect(DUPLICATE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
