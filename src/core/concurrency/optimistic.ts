/**
 * Optimistic concurrency control.
 *
 * Devvit's Redis has no multi-key transactions we can rely on, so we guard
 * against lost updates with record versioning: every Appeal carries a `version`
 * integer. A writer reads the record (capturing its version), mutates a copy,
 * and writes back only if the stored version still matches what it read. If a
 * concurrent writer got there first, the versions differ and we reject with an
 * OPTIMISTIC_LOCK_CONFLICT so the caller can re-read and retry.
 *
 * This module holds the pure pieces: the version-bump helper, the conflict
 * predicate, and the appeal state-transition machine (which encodes the legal
 * status moves so an illegal transition is a typed error, not a silent
 * corruption). The store performs the actual CAS against Redis.
 */

import type { Appeal, AppealStatus, AppealDecision } from '../types.js';

/** Anything that carries a monotonic version counter. */
export interface Versioned {
  version: number;
}

/** True when the record changed under us (stored version moved on). */
export function hasConflict(expected: number, actual: number): boolean {
  return expected !== actual;
}

/** Produce the next version. Kept trivial but centralised for intent clarity. */
export function bumpVersion(current: number): number {
  return current + 1;
}

// ---- appeal status state machine ---------------------------------------

/** Legal status transitions. Anything not listed is rejected. */
const TRANSITIONS: Record<AppealStatus, ReadonlySet<AppealStatus>> = {
  open: new Set<AppealStatus>(['in_review', 'awaiting_user', 'resolved']),
  in_review: new Set<AppealStatus>(['awaiting_user', 'resolved']),
  awaiting_user: new Set<AppealStatus>(['in_review', 'resolved']),
  resolved: new Set<AppealStatus>([]), // terminal
};

export function canTransition(from: AppealStatus, to: AppealStatus): boolean {
  if (from === to) return true; // idempotent no-op is always allowed
  return TRANSITIONS[from].has(to);
}

/** The status a given decision drives an appeal into. */
export function statusForDecision(decision: AppealDecision): AppealStatus {
  return decision === 'more_info' ? 'awaiting_user' : 'resolved';
}

/** Whether an appeal in this status may still receive a decision. */
export function isDecidable(status: AppealStatus): boolean {
  return status !== 'resolved';
}

/** Whether an appeal should occupy the open queue. */
export function isInOpenQueue(status: AppealStatus): boolean {
  return status !== 'resolved';
}

/**
 * Apply a status change to an appeal copy, enforcing the state machine and
 * bumping the version. Returns the updated copy. Throws nothing — the caller
 * checks `canTransition` first and raises the typed error, so this stays pure
 * and side-effect-free for easy testing.
 */
export function withStatus(appeal: Appeal, to: AppealStatus, now: number): Appeal {
  return {
    ...appeal,
    status: to,
    version: bumpVersion(appeal.version),
    updatedAt: now,
  };
}
