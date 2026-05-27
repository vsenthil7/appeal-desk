/**
 * Analytics (W2).
 *
 * Per the review's T2.1 framing: the MVP analytics surface is *not* a new
 * persisted module — it's a function that walks existing indexes and returns
 * a typed shape the dashboard can render. Everything here is computed on
 * demand against:
 *
 *   - `index:<sub>:open` (live counts by status)
 *   - `index:<sub>:resolved` (recently-resolved ids, populated by store.decide;
 *     bounded by retention)
 *   - per-resolved-appeal records (read individually via `safeGet`)
 *
 * The "topOriginalReasonsOverturned" / "topRules" output is the single most
 * demo-able signal: it surfaces rules that are being mis-enforced. That's
 * what turns the audit trail from compliance into product.
 *
 * All reads are bounded (`limit + 1`) so the function is O(window) not
 * O(all-time). Re-uses the bounded-range primitive established by `openQueuePage`.
 */

import type { AppealStore } from '../store.js';
import type { Appeal, AppealSummary } from '../types.js';
import { keys } from '../keys.js';
import { actionLabel } from '../format.js';

export interface SubAnalytics {
  /** Window the time-bounded stats cover, in days. */
  windowDays: number;
  /** Live: number of open appeals (any non-resolved status). */
  openCount: number;
  /** In-window: total resolved appeals. */
  resolvedInWindow: number;
  /** In-window: count of resolutions whose final decision was `overturned`. */
  overturnedInWindow: number;
  /** Median time from `createdAt` to last `decidedAt` for resolved appeals
   *  in the window, in ms. Null when no resolved appeals fall in the window. */
  medianTimeToDecisionMs: number | null;
  /** Top original-reason buckets that resulted in `overturned` decisions —
   *  the "your rule is mis-tuned" signal. Empty array if no overturns. */
  topOriginalReasonsOverturned: Array<{ reason: string; count: number }>;
  /** Top rule-ids (policy-mapped) by overturn rate — same idea, but using the
   *  configured rule mapping for cleaner buckets. Empty when policy is unmapped. */
  topRulesOverturned: Array<{ ruleId: string; count: number }>;
  /** Per-actionType breakdown of resolutions in the window. */
  byActionType: Array<{ actionType: string; count: number }>;
}

/**
 * Compute the analytics shape for a sub over the trailing `windowDays`. The
 * underlying reads are bounded: at most `maxScan` resolved-index entries are
 * fetched (default 1000 — covers a generous window without going wild).
 */
export async function computeSubAnalytics(
  store: AppealStore,
  sub: string,
  options: { windowDays?: number; now?: number; maxScan?: number } = {},
): Promise<SubAnalytics> {
  const windowDays = options.windowDays ?? 30;
  const now = options.now ?? Date.now();
  const maxScan = options.maxScan ?? 1000;
  const since = now - windowDays * 24 * 60 * 60 * 1000;

  const openCount = await store.openCount(sub);

  // Read resolved ids scored at-or-after `since`, newest first, bounded.
  // Using the platform-free Redis surface that `openQueuePage` already proved.
  const redis = store.getRedisForAnalytics();
  const entries = await redis.zRange(keys.resolvedIndex(sub), since, now, {
    by: 'score',
    reverse: true,
    limit: { offset: 0, count: maxScan },
  });

  let resolvedInWindow = 0;
  let overturnedInWindow = 0;
  const durations: number[] = [];
  const overturnReasonCounts = new Map<string, number>();
  const overturnRuleCounts = new Map<string, number>();
  const actionTypeCounts = new Map<string, number>();

  // Hydrate each resolved appeal once. The for-of keeps memory bounded.
  for (const e of entries) {
    const appeal = await store.safeGetForAnalytics(sub, e.member);
    if (!appeal) continue;
    resolvedInWindow++;
    actionTypeCounts.set(
      appeal.actionType,
      (actionTypeCounts.get(appeal.actionType) ?? 0) + 1,
    );
    const last = appeal.decisions[appeal.decisions.length - 1];
    if (!last) continue;
    durations.push(last.decidedAt - appeal.createdAt);
    if (last.decision === 'overturned') {
      overturnedInWindow++;
      const reason = appeal.originalReason || '(no reason)';
      overturnReasonCounts.set(reason, (overturnReasonCounts.get(reason) ?? 0) + 1);
      const ruleId = appeal.ruleId ?? 'unmapped';
      overturnRuleCounts.set(ruleId, (overturnRuleCounts.get(ruleId) ?? 0) + 1);
    }
  }

  const medianTimeToDecisionMs =
    durations.length === 0 ? null : median(durations);

  return {
    windowDays,
    openCount,
    resolvedInWindow,
    overturnedInWindow,
    medianTimeToDecisionMs,
    topOriginalReasonsOverturned: topN(overturnReasonCounts, 5).map(
      ([reason, count]) => ({ reason, count }),
    ),
    topRulesOverturned: topN(overturnRuleCounts, 5)
      .filter(([rule]) => rule !== 'unmapped')
      .map(([ruleId, count]) => ({ ruleId, count })),
    byActionType: topN(actionTypeCounts, 10).map(([actionType, count]) => ({
      actionType,
      count,
    })),
  };
}

function median(sorted: number[]): number {
  const a = [...sorted].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 === 0 ? Math.floor((a[mid - 1]! + a[mid]!) / 2) : a[mid]!;
}

function topN<K>(counts: Map<K, number>, n: number): Array<[K, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Human label for an analytics row (used by the UI; pure helper). */
export function labelForActionType(s: string): string {
  // Validate against known types; unknown ones pass through verbatim.
  const known = ['ban', 'removal', 'comment_removal'];
  return known.includes(s) ? actionLabel(s as 'ban' | 'removal' | 'comment_removal') : s;
}

/** Defensive re-export — the dashboard tab also wants the summary shape. */
export type { AppealSummary, Appeal };
