import { describe, it, expect } from 'vitest';
import {
  statusLabel,
  statusColor,
  actionLabel,
  decisionLabel,
  triageBadge,
  relativeTime,
  isAging,
} from '../src/core/format.js';

describe('label/colour mappers cover every enum value', () => {
  it('statusLabel', () => {
    expect(statusLabel('open')).toBe('Open');
    expect(statusLabel('in_review')).toBe('In review');
    expect(statusLabel('awaiting_user')).toBe('Awaiting user');
    expect(statusLabel('resolved')).toBe('Resolved');
  });

  it('statusColor returns a colour for each status', () => {
    for (const s of ['open', 'in_review', 'awaiting_user', 'resolved'] as const) {
      expect(statusColor(s)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('actionLabel', () => {
    expect(actionLabel('ban')).toBe('Ban');
    expect(actionLabel('removal')).toBe('Post removal');
    expect(actionLabel('comment_removal')).toBe('Comment removal');
  });

  it('decisionLabel', () => {
    expect(decisionLabel('upheld')).toBe('Upheld');
    expect(decisionLabel('overturned')).toBe('Overturned');
    expect(decisionLabel('more_info')).toBe('Need more info');
  });

  it('triageBadge', () => {
    expect(triageBadge('likely_genuine').text).toBe('Likely genuine');
    expect(triageBadge('likely_duplicate').text).toBe('Likely duplicate');
    expect(triageBadge('likely_abusive').text).toBe('Likely abusive');
    for (const l of ['likely_genuine', 'likely_duplicate', 'likely_abusive'] as const) {
      expect(triageBadge(l).color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('relativeTime', () => {
  const now = 1_000_000_000_000;
  it('handles each unit band and clamps negatives to "just now"', () => {
    expect(relativeTime(now + 5000, now)).toBe('just now'); // future => clamped
    expect(relativeTime(now - 5_000, now)).toBe('just now'); // <60s
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(relativeTime(now - 40 * 86_400_000, now)).toBe('1mo ago');
    expect(relativeTime(now - 400 * 86_400_000, now)).toBe('1y ago');
  });

  it('uses Date.now by default', () => {
    expect(typeof relativeTime(Date.now())).toBe('string');
  });
});

describe('isAging', () => {
  const now = 1_000_000_000_000;
  it('is true once the SLA window has elapsed', () => {
    expect(isAging(now - 49 * 3_600_000, 48, now)).toBe(true);
  });
  it('is false before the window elapses', () => {
    expect(isAging(now - 1 * 3_600_000, 48, now)).toBe(false);
  });
  it('uses Date.now by default', () => {
    expect(typeof isAging(Date.now(), 48)).toBe('boolean');
  });
});
