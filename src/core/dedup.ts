/**
 * Deterministic duplicate / repeat-appeal detection.
 *
 * This is a CORE value driver, not an AI feature: mods get worn down by users
 * who re-file the same appeal over and over. We flag those reliably and without
 * any model in the loop. The AI triage layer (if enabled) sits ON TOP of this
 * signal — it never replaces it.
 *
 * The approach is intentionally simple and explainable:
 *   1. Normalise the reason text (lowercase, collapse whitespace, strip punctuation).
 *   2. Compare against the user's prior appeals in the same sub using a
 *      token Jaccard similarity. High overlap => near-duplicate.
 *
 * No external libraries, no network, fully synchronous, easy to unit-test.
 */

import type { Appeal, TriageHint } from './types.js';

/** Normalise free text for comparison. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ') // drop urls — they add noise
    .replace(/[^a-z0-9\s]/g, ' ') // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tokenise into a set of words longer than 2 chars (drops "a", "to", etc.). */
export function tokenSet(text: string): Set<string> {
  return new Set(
    normalise(text)
      .split(' ')
      .filter((w) => w.length > 2),
  );
}

/** Jaccard similarity of two token sets: |A ∩ B| / |A ∪ B|, in [0, 1]. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/** Similarity at or above this is treated as a near-duplicate. */
export const DUPLICATE_THRESHOLD = 0.6;

/**
 * Compute the deterministic part of a TriageHint for a new appeal, given the
 * user's prior appeals in this subreddit. Returns the repeat count and, if a
 * near-duplicate exists, the id of the most similar prior appeal.
 */
export function computeDedup(
  newReason: string,
  priorAppeals: Pick<Appeal, 'id' | 'reason'>[],
): Pick<TriageHint, 'duplicateOfAppealId' | 'repeatCount'> {
  const newTokens = tokenSet(newReason);

  let bestId: string | undefined;
  let bestScore = 0;
  for (const prior of priorAppeals) {
    const score = jaccard(newTokens, tokenSet(prior.reason));
    if (score > bestScore) {
      bestScore = score;
      bestId = prior.id;
    }
  }

  return {
    repeatCount: priorAppeals.length,
    duplicateOfAppealId:
      bestScore >= DUPLICATE_THRESHOLD ? bestId : undefined,
  };
}
