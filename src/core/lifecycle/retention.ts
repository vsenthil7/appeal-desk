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

import type { Appeal } from '../types.js';

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
 * Produce a redacted copy of an appeal for right-to-erasure. Free-text and the
 * author name are scrubbed; structural facts (status, decision types,
 * timestamps, counts) are preserved as an auditable tombstone. The version is
 * bumped so the redaction itself is a tracked mutation.
 */
export function redactForErasure(appeal: Appeal, now: number): Appeal {
  return {
    ...appeal,
    authorName: REDACTED,
    reason: REDACTED,
    originalContent: REDACTED,
    permalink: undefined,
    triage: {
      ...appeal.triage,
      // Keep the numeric/structural signal; drop any free-text rationale.
      model: appeal.triage.model
        ? { ...appeal.triage.model, rationale: REDACTED }
        : undefined,
    },
    decisions: appeal.decisions.map((d) => ({
      ...d,
      note: REDACTED,
      replyText: REDACTED,
    })),
    version: appeal.version + 1,
    updatedAt: now,
  };
}

/** Whether an appeal has already been redacted (idempotency guard). */
export function isRedacted(appeal: Appeal): boolean {
  return appeal.authorName === REDACTED && appeal.reason === REDACTED;
}
