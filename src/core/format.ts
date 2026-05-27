/**
 * Presentation helpers. Pure functions that map domain values to display
 * strings and colours. Kept out of the components so they can be unit-tested
 * and reused across the dashboard and the detail view.
 */

import type {
  ActionType,
  AppealStatus,
  AppealDecision,
} from './types.js';

export function statusLabel(status: AppealStatus): string {
  switch (status) {
    case 'open':
      return 'Open';
    case 'in_review':
      return 'In review';
    case 'awaiting_user':
      return 'Awaiting user';
    case 'resolved':
      return 'Resolved';
  }
}

export function statusColor(status: AppealStatus): string {
  switch (status) {
    case 'open':
      return '#d93a00'; // reddit orange-red: needs attention
    case 'in_review':
      return '#0079d3'; // reddit blue: being worked
    case 'awaiting_user':
      return '#7c4dff'; // purple: blocked on user
    case 'resolved':
      return '#46a508'; // green: done
  }
}

export function actionLabel(action: ActionType): string {
  switch (action) {
    case 'ban':
      return 'Ban';
    case 'removal':
      return 'Post removal';
    case 'comment_removal':
      return 'Comment removal';
  }
}

export function decisionLabel(decision: AppealDecision): string {
  switch (decision) {
    case 'upheld':
      return 'Upheld';
    case 'overturned':
      return 'Overturned';
    case 'more_info':
      return 'Need more info';
  }
}

export function triageBadge(
  label: 'likely_genuine' | 'likely_duplicate' | 'likely_abusive',
): { text: string; color: string } {
  switch (label) {
    case 'likely_genuine':
      return { text: 'Likely genuine', color: '#46a508' };
    case 'likely_duplicate':
      return { text: 'Likely duplicate', color: '#cc8b00' };
    case 'likely_abusive':
      return { text: 'Likely abusive', color: '#d93a00' };
  }
}

/** Compact relative time, e.g. "3h ago", "2d ago", "just now". */
export function relativeTime(then: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

/** Whether an open appeal has breached its SLA (used for the aging nudge). */
export function isAging(
  createdAt: number,
  slaHours: number,
  now: number = Date.now(),
): boolean {
  return now - createdAt >= slaHours * 60 * 60 * 1000;
}
