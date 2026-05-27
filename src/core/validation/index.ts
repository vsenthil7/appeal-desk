/**
 * Input validation.
 *
 * Nothing user-supplied reaches Redis without passing through here. We use a
 * tiny `Result` type instead of throwing, so callers can aggregate every
 * problem with a field rather than failing on the first one (better UX: the
 * user sees all issues at once). The service layer turns a failed Result into a
 * single `VALIDATION_FAILED` AppealError carrying the field list.
 *
 * These are deterministic, dependency-free pure functions — trivially testable
 * and fuzzable.
 */

import type { ActionType, AppealDecision } from '../types.js';

export interface FieldIssue {
  field: string;
  message: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; issues: FieldIssue[] };

/** Bounds — single source of truth, exported so tests assert against them. */
export const LIMITS = {
  reasonMin: 10,
  reasonMax: 2_000,
  noteMax: 2_000,
  replyMax: 5_000,
  usernameMax: 64,
  targetIdMax: 128,
} as const;

const ACTION_TYPES: ReadonlySet<ActionType> = new Set([
  'ban',
  'removal',
  'comment_removal',
]);

const DECISIONS: ReadonlySet<AppealDecision> = new Set([
  'upheld',
  'overturned',
  'more_info',
]);

/** Reject control characters (except newline/tab) that can corrupt logs/JSON. */
function hasControlChars(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
}

/** Collapse a result list into a single ValidationResult. */
function collect(issues: FieldIssue[]): ValidationResult {
  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

export interface AppealSubmissionInput {
  reason: unknown;
  acknowledged: unknown;
  actionType: unknown;
  targetId: unknown;
  authorName: unknown;
}

export function validateSubmission(
  input: AppealSubmissionInput,
): ValidationResult {
  const issues: FieldIssue[] = [];

  // reason
  if (typeof input.reason !== 'string') {
    issues.push({ field: 'reason', message: 'Reason must be text.' });
  } else {
    const trimmed = input.reason.trim();
    if (trimmed.length < LIMITS.reasonMin) {
      issues.push({
        field: 'reason',
        message: `Reason must be at least ${LIMITS.reasonMin} characters.`,
      });
    }
    if (input.reason.length > LIMITS.reasonMax) {
      issues.push({
        field: 'reason',
        message: `Reason must be at most ${LIMITS.reasonMax} characters.`,
      });
    }
    if (hasControlChars(input.reason)) {
      issues.push({
        field: 'reason',
        message: 'Reason contains invalid control characters.',
      });
    }
  }

  // acknowledged
  if (typeof input.acknowledged !== 'boolean') {
    issues.push({
      field: 'acknowledged',
      message: 'Acknowledgement must be true or false.',
    });
  }

  // actionType
  if (
    typeof input.actionType !== 'string' ||
    !ACTION_TYPES.has(input.actionType as ActionType)
  ) {
    issues.push({ field: 'actionType', message: 'Unknown action type.' });
  }

  // targetId
  if (typeof input.targetId !== 'string') {
    issues.push({ field: 'targetId', message: 'Target id must be text.' });
  } else if (
    input.targetId.length === 0 ||
    input.targetId.length > LIMITS.targetIdMax
  ) {
    issues.push({ field: 'targetId', message: 'Target id is out of range.' });
  }

  // authorName
  if (typeof input.authorName !== 'string') {
    issues.push({ field: 'authorName', message: 'Author name must be text.' });
  } else if (
    input.authorName.length === 0 ||
    input.authorName.length > LIMITS.usernameMax
  ) {
    issues.push({
      field: 'authorName',
      message: 'Author name is out of range.',
    });
  }

  return collect(issues);
}

export interface DecisionInput {
  decision: unknown;
  note: unknown;
  finalReply: unknown;
}

export function validateDecision(input: DecisionInput): ValidationResult {
  const issues: FieldIssue[] = [];

  if (
    typeof input.decision !== 'string' ||
    !DECISIONS.has(input.decision as AppealDecision)
  ) {
    issues.push({ field: 'decision', message: 'Unknown decision.' });
  }

  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') {
      issues.push({ field: 'note', message: 'Note must be text.' });
    } else if (input.note.length > LIMITS.noteMax) {
      issues.push({ field: 'note', message: 'Note is too long.' });
    }
  }

  if (input.finalReply !== undefined && input.finalReply !== null) {
    if (typeof input.finalReply !== 'string') {
      issues.push({ field: 'finalReply', message: 'Reply must be text.' });
    } else if (input.finalReply.trim().length === 0) {
      issues.push({ field: 'finalReply', message: 'Reply must not be empty.' });
    } else if (input.finalReply.length > LIMITS.replyMax) {
      issues.push({ field: 'finalReply', message: 'Reply is too long.' });
    }
  }

  return collect(issues);
}

/** Normalise free text before storage: trim, cap length, strip control chars. */
export function sanitiseText(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const stripped = s.replace(
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    '',
  );
  return stripped.trim().slice(0, max);
}
