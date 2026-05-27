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

/**
 * Options for `set`. Devvit's RedisClient exposes `expiration: Date` — an
 * ABSOLUTE expiry instant, not a duration. We mirror that so this interface
 * is structurally satisfied by the real Devvit client without an adapter.
 * Used by H1 (snapshot TTL), H2 (rate-limit bucket TTL), and W4 (claim TTL).
 */
export interface SetOptions {
  /** Absolute time at which the key should auto-delete. */
  expiration?: Date;
}

/** A queued transaction. Commands return the txn for chaining; exec runs them. */
export interface RedisTx {
  set(key: string, value: string, options?: SetOptions): Promise<RedisTx>;
  del(...keys: string[]): Promise<RedisTx>;
  /** Atomic sorted-set remove inside the transaction (D2 tx batching). */
  zRem(key: string, members: string[]): Promise<RedisTx>;
  /** Atomic sorted-set add inside the transaction (D2 tx batching). */
  zAdd(key: string, ...members: ZMember[]): Promise<RedisTx>;
  multi(): Promise<void>;
  /** Resolves to an array of replies, or null if the transaction was aborted
   *  because a watched key changed. */
  exec(): Promise<unknown[] | null>;
}

export interface RedisLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, options?: SetOptions): Promise<string | void>;
  del(...keys: string[]): Promise<number | void>;
  /** Set a TTL on an existing key. Optional — call sites that know their TTL
   *  up front pass it to `set` directly. Devvit's RedisClient exposes `expire`. */
  expire?(key: string, seconds: number): Promise<void>;
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
