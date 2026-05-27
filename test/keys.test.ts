import { describe, it, expect } from 'vitest';
import { keys, generateAppealId } from '../src/core/keys.js';

describe('keys', () => {
  it('builds every key in the documented scheme', () => {
    expect(keys.appeal('aww', 'ap_1')).toBe('appeal:aww:ap_1');
    expect(keys.history('aww', 'alice')).toBe('history:aww:alice');
    expect(keys.openIndex('aww')).toBe('index:aww:open');
    expect(keys.actionLock('aww', 't3_x')).toBe('action:aww:t3_x');
    expect(keys.actionSeed('aww', 't3_x')).toBe('actionseed:aww:t3_x');
    expect(keys.config('aww')).toBe('config:aww');
  });

  it('keeps the action lock and action seed in distinct namespaces', () => {
    // Regression for the snapshot/lock collision (Finding 4): the seed key must
    // NOT live under the `action:` prefix, even for a targetId that itself
    // starts with `seed:`.
    expect(keys.actionSeed('aww', 't3_x')).not.toBe(keys.actionLock('aww', 't3_x'));
    expect(keys.actionLock('aww', 'seed:t3_x')).not.toBe(keys.actionSeed('aww', 't3_x'));
  });
});

describe('generateAppealId', () => {
  it('is prefixed and roughly time-sortable for same-era timestamps', () => {
    // Real-world epoch-ms values render to equal-length base36, so lexical
    // ordering of the time segment tracks chronological ordering.
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_500_000;
    const a = generateAppealId(t1);
    const b = generateAppealId(t2);
    expect(a.startsWith('ap_')).toBe(true);
    expect(b.startsWith('ap_')).toBe(true);
    // Compare just the time segment (strip the 4-char random suffix).
    const timeA = a.slice(3, -4);
    const timeB = b.slice(3, -4);
    expect(timeA < timeB).toBe(true);
  });

  it('produces distinct ids at the same timestamp', () => {
    const ids = new Set(
      Array.from({ length: 200 }, () => generateAppealId(12345)),
    );
    // Random suffix keeps collisions away across many calls at one instant.
    expect(ids.size).toBeGreaterThan(190);
  });

  it('defaults to Date.now when no timestamp is supplied', () => {
    const id = generateAppealId();
    expect(id.startsWith('ap_')).toBe(true);
  });
});
