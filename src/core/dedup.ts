/**
 * Deterministic duplicate / repeat-appeal detection.
 *
 * This is a CORE value driver, not an AI feature: mods get worn down by users
 * who re-file the same appeal over and over. We flag those reliably and without
 * any model in the loop. The AI triage layer (if enabled) sits ON TOP of this
 * signal — it never replaces it.
 *
 * Two signals are emitted now (D1):
 *   1. **`duplicateOfAppealId`** — token-level Jaccard ≥ DUPLICATE_THRESHOLD.
 *      Strict word-overlap match. Same as before; the dashboard's "Repeat
 *      appeal" pill is driven by this.
 *   2. **`paraphraseOfAppealId`** — character-trigram Jaccard ≥
 *      PARAPHRASE_THRESHOLD. Catches "I was banned wrongly" vs "wrongful ban
 *      here" — i.e. the same complaint reworded, which token Jaccard misses.
 *      Surfaced as a softer "Likely paraphrase" pill so mods can see the
 *      signal without dedup-conflating it with the strict duplicate.
 *
 * Both signals are computed against a BOUNDED window of the user's most recent
 * prior appeals (`DEFAULT_MAX_PRIOR`), not the entire history. The store's
 * `priorAppeals` returns newest-first (Finding F), so the cap is "the N
 * newest" — older identical re-files still get caught when they appear in the
 * window or by retention purge.
 */

import type { Appeal, TriageHint } from './types.js';

/** Default cap on how many prior appeals dedup looks at, newest first.
 *  Reviews call this out as the right cheap bound (D1). */
export const DEFAULT_MAX_PRIOR = 50;

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

/**
 * Character-trigram set used for paraphrase detection. Operates on the
 * normalised, space-flattened text so casing and punctuation can't dodge the
 * signal. Trigrams are robust to small reorderings ("the cat sat" vs "sat the
 * cat") while staying deterministic.
 */
export function shingleSet(text: string, k = 3): Set<string> {
  const flat = normalise(text).replace(/\s+/g, ' ');
  if (flat.length < k) return new Set();
  const out = new Set<string>();
  for (let i = 0; i <= flat.length - k; i++) {
    out.add(flat.slice(i, i + k));
  }
  return out;
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

/** Token-Jaccard at or above this is treated as a near-duplicate. */
export const DUPLICATE_THRESHOLD = 0.6;
/** Char-trigram-Jaccard at or above this is treated as a likely paraphrase. */
export const PARAPHRASE_THRESHOLD = 0.55;

/**
 * Compute the deterministic part of a TriageHint for a new appeal, given the
 * user's prior appeals in this subreddit (already trimmed to a bounded window).
 * Returns the repeat count, the strict near-duplicate id (if any), and the
 * softer paraphrase id (if any). `repeatCount` reflects the *bounded* window
 * length unless `totalPriorCount` is provided — see `computeDedupWithTotal`.
 */
export function computeDedup(
  newReason: string,
  priorAppeals: Pick<Appeal, 'id' | 'reason'>[],
): Pick<TriageHint, 'duplicateOfAppealId' | 'repeatCount' | 'paraphraseOfAppealId'> {
  return computeDedupWithTotal(newReason, priorAppeals, priorAppeals.length);
}

/**
 * Lower-level dedup that decouples *what we scanned* from *how many total
 * priors the user has*. The store's `priorAppeals` returns at most
 * `DEFAULT_MAX_PRIOR` entries newest-first; the dashboard still wants the
 * accurate total in `repeatCount`. Pass it explicitly here.
 */
export function computeDedupWithTotal(
  newReason: string,
  priorAppeals: Pick<Appeal, 'id' | 'reason'>[],
  totalPriorCount: number,
): Pick<TriageHint, 'duplicateOfAppealId' | 'repeatCount' | 'paraphraseOfAppealId'> {
  const newTokens = tokenSet(newReason);
  const newShingles = shingleSet(newReason);

  let bestTokenId: string | undefined;
  let bestTokenScore = 0;
  let bestShingleId: string | undefined;
  let bestShingleScore = 0;
  for (const prior of priorAppeals) {
    const t = jaccard(newTokens, tokenSet(prior.reason));
    if (t > bestTokenScore) {
      bestTokenScore = t;
      bestTokenId = prior.id;
    }
    const s = jaccard(newShingles, shingleSet(prior.reason));
    if (s > bestShingleScore) {
      bestShingleScore = s;
      bestShingleId = prior.id;
    }
  }

  return {
    repeatCount: totalPriorCount,
    duplicateOfAppealId:
      bestTokenScore >= DUPLICATE_THRESHOLD ? bestTokenId : undefined,
    paraphraseOfAppealId:
      bestShingleScore >= PARAPHRASE_THRESHOLD &&
      // Don't redundantly raise the paraphrase flag when the strict signal
      // already caught the same prior — keeps the dashboard quieter.
      bestShingleId !== undefined &&
      bestShingleId !== (bestTokenScore >= DUPLICATE_THRESHOLD ? bestTokenId : undefined)
        ? bestShingleId
        : undefined,
  };
}
