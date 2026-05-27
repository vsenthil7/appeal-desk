/**
 * Centralised Redis key construction. Keeping every key in one place avoids
 * the classic bug where two call sites disagree on a key format and silently
 * read/write different slots. The scheme mirrors the spec:
 *
 *   appeal:<sub>:<id>        -> the Appeal record (JSON)
 *   history:<sub>:<user>     -> a Redis sorted set of appeal ids (score = ts)
 *   index:<sub>:open         -> a sorted set of open appeal ids (score = ts)
 *   action:<sub>:<targetId>  -> the appeal id currently open for an action
 *   config:<sub>             -> the SubredditConfig (JSON)
 */

export const keys = {
  appeal: (sub: string, id: string) => `appeal:${sub}:${id}`,
  history: (sub: string, user: string) => `history:${sub}:${user}`,
  openIndex: (sub: string) => `index:${sub}:open`,
  actionLock: (sub: string, targetId: string) => `action:${sub}:${targetId}`,
  config: (sub: string) => `config:${sub}`,
  /** Token-bucket state for per-user appeal rate limiting. */
  rateLimit: (sub: string, user: string) => `ratelimit:${sub}:${user}`,
  /** Index of resolved appeals scored by purge-eligibility timestamp, so the
   *  retention job can range-scan "everything due before now" efficiently. */
  purgeIndex: (sub: string) => `index:${sub}:purge`,
} as const;

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
