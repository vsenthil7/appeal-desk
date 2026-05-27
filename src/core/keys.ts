/**
 * Centralised Redis key construction. Keeping every key in one place avoids
 * the classic bug where two call sites disagree on a key format and silently
 * read/write different slots. The scheme — kept in sync with `docs/ARCHITECTURE.md`
 * via the exported `KEY_DESCRIPTIONS` table below so a reviewer can never see
 * the doc and the code disagree:
 *
 *   appeal:<sub>:<id>           -> the Appeal record (JSON)
 *   history:<sub>:<user>        -> sorted set of appeal ids (score = ts)
 *   index:<sub>:open            -> sorted set of OPEN appeal ids (score = ts)
 *   index:<sub>:purge           -> sorted set of resolved ids scored by purge-eligibility ts
 *   index:<sub>:snapshot_purge  -> sorted set of action-snapshot targetIds scored by ts
 *   index:<sub>:ratelimit_purge -> sorted set of rate-limit usernames scored by last-touch ts
 *   index:<sub>:resolved        -> sorted set of recently-resolved ids scored by decidedAt
 *                                  (bounded by retention, used by analytics)
 *   index:<sub>:erasure_log     -> sorted set of mod-driven erasure events (audit trail)
 *   index:<sub>:dlq             -> dead-letter sorted set for scheduler/job failures
 *   action:<sub>:<targetId>     -> appeal id currently open for an action (per-action lock)
 *   actionseed:<sub>:<targetId> -> action snapshot (JSON), TTL-bounded
 *   ratelimit:<sub>:<user>      -> token-bucket state (JSON), TTL-bounded
 *   claim:<sub>:<id>            -> mod-id who currently has the appeal "claimed", TTL'd
 *   config:<sub>                -> SubredditConfig (JSON)
 *   policy:<sub>                -> per-sub policy config (JSON; eligibility predicates + rule map)
 *   dedupsig:<sub>:<user>       -> compact rolling dedup signature (JSON; reserved for D2)
 */

export const keys = {
  appeal: (sub: string, id: string) => `appeal:${sub}:${id}`,
  history: (sub: string, user: string) => `history:${sub}:${user}`,
  openIndex: (sub: string) => `index:${sub}:open`,
  actionLock: (sub: string, targetId: string) => `action:${sub}:${targetId}`,
  /**
   * The action snapshot ("seed") captured at mod-action time and read back when
   * the user submits an appeal. This is a DISTINCT key family from `actionLock`:
   * previously three call sites built it as `actionLock(sub, 'seed:' + targetId)`,
   * which (a) bypassed this single-source-of-truth module and (b) shared the
   * `action:` namespace with the per-action lock, so a `targetId` that itself
   * began with `seed:` could collide with a real lock. Giving it its own prefix
   * removes that collision entirely.
   */
  actionSeed: (sub: string, targetId: string) => `actionseed:${sub}:${targetId}`,
  config: (sub: string) => `config:${sub}`,
  /** Per-sub policy config (eligibility predicates + rule mapping). Separate
   *  from `config` so a mod can edit rules independently of core settings. */
  policy: (sub: string) => `policy:${sub}`,
  /** Token-bucket state for per-user appeal rate limiting. */
  rateLimit: (sub: string, user: string) => `ratelimit:${sub}:${user}`,
  /** Sub-wide token bucket per actionType (D3 — "shared subnet bucket" equivalent
   *  given Devvit doesn't expose IPs). Bounds the global appeal rate per
   *  category so a coordinated cohort can't out-run the per-user bucket. */
  subwideRateLimit: (sub: string, actionType: string) =>
    `ratelimit-sub:${sub}:${actionType}`,
  /** Index of resolved appeals scored by purge-eligibility timestamp, so the
   *  retention job can range-scan "everything due before now" efficiently. */
  purgeIndex: (sub: string) => `index:${sub}:purge`,
  /** Index of action snapshots scored by write-time, for snapshot retention
   *  sweeping. Closes the H1 leak: unappealed snapshots used to live forever. */
  snapshotPurgeIndex: (sub: string) => `index:${sub}:snapshot_purge`,
  /** Index of rate-limit keys scored by last-touch time. Lets the retention
   *  job sweep idle buckets so a redacted user's username doesn't persist in
   *  the rate-limit namespace after their appeals are scrubbed (H2 + the
   *  THREAT_MODEL §6 invariant 6 follow-through). */
  rateLimitPurgeIndex: (sub: string) => `index:${sub}:ratelimit_purge`,
  /** Recently-resolved appeals, scored by `decidedAt`. Powers the analytics
   *  module without rescanning the per-user history. */
  resolvedIndex: (sub: string) => `index:${sub}:resolved`,
  /** Audit log of mod-driven erasures, scored by time. Per W1: the redacted
   *  appeal doesn't store the acting mod (that would defeat the point); the
   *  acting-mod metadata lives here instead. */
  erasureLog: (sub: string) => `index:${sub}:erasure_log`,
  /** Dead-letter index for jobs that failed after retries. Sorted by time. */
  dlq: (sub: string) => `index:${sub}:dlq`,
  /** Per-appeal claim: the mod-id currently working an appeal, with TTL so
   *  abandonment auto-releases. Enables W4 mod-coordination without a separate
   *  store. */
  claim: (sub: string, id: string) => `claim:${sub}:${id}`,
  /** Compact per-user dedup signature (reserved for D2 incremental dedup —
   *  the key is reserved here as the planned slot, the writer is opt-in). */
  dedupSignature: (sub: string, user: string) => `dedupsig:${sub}:${user}`,
} as const;

/**
 * Human-readable description of every key family. The architecture doc renders
 * from this so a reviewer can never see the doc and the code disagree. New
 * entries here automatically show up in the doc check (`test/keys.test.ts`
 * asserts the table is in sync with the `keys` object).
 */
export const KEY_DESCRIPTIONS: ReadonlyArray<{
  pattern: string;
  describe: string;
}> = [
  { pattern: 'appeal:<sub>:<id>', describe: 'Appeal record (JSON)' },
  { pattern: 'history:<sub>:<user>', describe: 'sorted set of appeal ids (score = ts)' },
  { pattern: 'index:<sub>:open', describe: 'sorted set of OPEN appeal ids (score = ts)' },
  { pattern: 'index:<sub>:purge', describe: 'sorted set of resolved ids, scored by purge-eligibility' },
  { pattern: 'index:<sub>:snapshot_purge', describe: 'sorted set of action-snapshot targetIds, scored by ts' },
  { pattern: 'index:<sub>:ratelimit_purge', describe: 'sorted set of rate-limit usernames, scored by last-touch' },
  { pattern: 'index:<sub>:resolved', describe: 'sorted set of recently-resolved ids, scored by decidedAt' },
  { pattern: 'index:<sub>:erasure_log', describe: 'audit log of mod-driven erasures, scored by ts' },
  { pattern: 'index:<sub>:dlq', describe: 'dead-letter sorted set for failed scheduler jobs' },
  { pattern: 'action:<sub>:<targetId>', describe: 'per-action lock — id of the open appeal for this target' },
  { pattern: 'actionseed:<sub>:<targetId>', describe: 'action snapshot (JSON), TTL-bounded' },
  { pattern: 'ratelimit:<sub>:<user>', describe: 'token-bucket state (JSON), TTL-bounded' },
  { pattern: 'ratelimit-sub:<sub>:<actionType>', describe: 'sub-wide token bucket per actionType' },
  { pattern: 'claim:<sub>:<id>', describe: 'mod-id holding an appeal claim, TTL-bounded' },
  { pattern: 'config:<sub>', describe: 'SubredditConfig (JSON)' },
  { pattern: 'policy:<sub>', describe: 'per-sub policy config (JSON)' },
  { pattern: 'dedupsig:<sub>:<user>', describe: 'compact rolling dedup signature (reserved for D2)' },
];

/**
 * Generate a short, sortable, collision-resistant appeal id.
 * Format: `ap_<base36 timestamp><4 random base36 chars>`.
 * Time-prefixing keeps ids roughly chronological, which is handy for debugging.
 */
export function generateAppealId(now: number = Date.now()): string {
  const time = now.toString(36);
  const rand = Math.random().toString(36).slice(2, 6).padStart(4, '0');
  return `ap_${time}${rand}`;
}
