/**
 * Data lifecycle — retention and right-to-erasure.
 *
 * Two concerns a real deployment can't skip:
 *
 *   1. Retention: resolved appeals shouldn't accumulate forever. After
 *      `retentionDays` past resolution, an appeal is eligible for purge. A
 *      scheduled job (server/retention.ts) walks resolved appeals and removes
 *      eligible ones.
 *
 *   2. Erasure: a user may request deletion of their personal content. We
 *      redact the personally-identifying free text while keeping a tombstone of
 *      the decision metadata, so moderation history (counts, outcomes) stays
 *      intact and auditable without retaining the user's words.
 *
 * Both are expressed here as pure transformations over an Appeal, so they're
 * deterministic and testable; the store applies them and the scheduler drives
 * them.
 */

import type { Appeal, DecisionRecord } from '../types.js';
import {
  REDACTABLE_TOP_LEVEL_STRING_FIELDS,
  REDACTABLE_DECISION_FIELDS,
} from '../types.js';

/** When does this resolved appeal become eligible for purge? */
export function purgeEligibleAt(appeal: Appeal, retentionDays: number): number | null {
  if (retentionDays <= 0) return null; // retention disabled => never purge
  if (appeal.status !== 'resolved') return null; // only resolved appeals age out
  const resolvedAt = lastDecisionAt(appeal) ?? appeal.updatedAt;
  return resolvedAt + retentionDays * 24 * 60 * 60 * 1000;
}

/** Is this appeal past its retention window as of `now`? */
export function isPurgeEligible(
  appeal: Appeal,
  retentionDays: number,
  now: number,
): boolean {
  const at = purgeEligibleAt(appeal, retentionDays);
  return at !== null && now >= at;
}

/** Timestamp of the most recent recorded decision, if any. */
export function lastDecisionAt(appeal: Appeal): number | null {
  if (appeal.decisions.length === 0) return null;
  return appeal.decisions[appeal.decisions.length - 1]!.decidedAt;
}

export const REDACTED = '[redacted]';

/**
 * Produce a redacted copy of an appeal for right-to-erasure. Every free-text
 * field listed in `REDACTABLE_TOP_LEVEL_STRING_FIELDS` is scrubbed, plus the
 * `REDACTABLE_DECISION_FIELDS` on each decision record; structural facts
 * (status, decision types, timestamps, counts) are preserved as an auditable
 * tombstone. The version is bumped so the redaction itself is a tracked
 * mutation.
 *
 * The scrub iterates the lists rather than spelling each field by hand (B), so
 * adding a new free-text field on `Appeal` just means appending it to the
 * list — the property test in `test/property/invariants.test.ts` then catches
 * any forgotten scrub.
 */
export function redactForErasure(appeal: Appeal, now: number): Appeal {
  const next: Appeal = { ...appeal };
  for (const field of REDACTABLE_TOP_LEVEL_STRING_FIELDS) {
    // `Appeal[field]` is always typed string for the entries in the constant —
    // the cast through `unknown` is the standard "I know more than the
    // structural type does" escape, used at exactly this boundary.
    (next as unknown as Record<string, string>)[field as string] = REDACTED;
  }
  next.permalink = undefined;
  next.triage = {
    ...appeal.triage,
    // Keep the numeric/structural signal; drop any free-text rationale.
    model: appeal.triage.model
      ? { ...appeal.triage.model, rationale: REDACTED }
      : undefined,
  };
  next.decisions = appeal.decisions.map((d) => {
    const scrubbed: DecisionRecord = { ...d };
    for (const f of REDACTABLE_DECISION_FIELDS) {
      (scrubbed as unknown as Record<string, string>)[f as string] = REDACTED;
    }
    return scrubbed;
  });
  next.version = appeal.version + 1;
  next.updatedAt = now;
  return next;
}

/** Whether an appeal has already been redacted (idempotency guard). */
export function isRedacted(appeal: Appeal): boolean {
  return appeal.authorName === REDACTED && appeal.reason === REDACTED;
}
