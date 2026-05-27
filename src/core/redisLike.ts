/**
 * The minimal Redis surface AppealStore depends on.
 *
 * We deliberately depend on this narrow interface rather than Devvit's full
 * `RedisClient` so the store is unit-testable with an in-memory fake and so the
 * exact set of operations we rely on is explicit and auditable. Devvit's
 * `RedisClient` structurally satisfies this.
 *
 * The transaction primitives (`watch` → `multi`/`exec`) give us genuine
 * optimistic locking: WATCH a key, read it, queue the write in a MULTI block,
 * and EXEC. If the watched key changed between WATCH and EXEC, Redis aborts the
 * transaction and `exec()` resolves to `null`, which we treat as a CAS miss and
 * retry. This is real cross-instance concurrency control, not an in-process
 * approximation.
 */

export interface ZMember {
  member: string;
  score: number;
}

export interface ZRangeOptions {
  reverse?: boolean;
  by?: 'rank' | 'score' | 'lex';
  /**
   * Bound the number of members returned at the Redis layer (not just sliced in
   * memory). Mirrors Devvit's real `zRange` option of the same shape, so a
   * caller can fetch only the page it needs instead of the whole range.
   */
  limit?: { offset: number; count: number };
}

/** A queued transaction. Commands return the txn for chaining; exec runs them. */
export interface RedisTx {
  set(key: string, value: string): Promise<RedisTx>;
  del(...keys: string[]): Promise<RedisTx>;
  multi(): Promise<void>;
  /** Resolves to an array of replies, or null if the transaction was aborted
   *  because a watched key changed. */
  exec(): Promise<unknown[] | null>;
}

export interface RedisLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<string | void>;
  del(...keys: string[]): Promise<number | void>;
  zAdd(key: string, ...members: ZMember[]): Promise<number>;
  zRem(key: string, members: string[]): Promise<number>;
  zCard(key: string): Promise<number>;
  zRange(
    key: string,
    start: number,
    stop: number,
    options?: ZRangeOptions,
  ): Promise<ZMember[]>;
  /** Begin watching keys for a conditional transaction. */
  watch(...keys: string[]): Promise<RedisTx>;
}
