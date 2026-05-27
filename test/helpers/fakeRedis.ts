/**
 * FakeRedis — an in-memory stand-in for Devvit's RedisClient implementing the
 * RedisLike surface AppealStore uses, INCLUDING WATCH/MULTI/EXEC transactions
 * with correct optimistic-lock abort semantics.
 *
 * Transaction model (matching Redis):
 *   - `watch(...keys)` snapshots the current value of each key and returns a tx.
 *   - queued commands (`set`/`del`/`zRem`/`zAdd`) are buffered, not applied.
 *   - `exec()` checks every watched key against its snapshot; if any changed,
 *     the transaction is ABORTED and exec resolves to null (no writes applied).
 *     Otherwise all buffered writes are applied atomically and an array of
 *     replies is returned.
 *
 * To exercise concurrency deterministically, `onWatchedRead` fires once after a
 * tx reads a watched key (before exec), letting a test mutate the store to
 * force a CAS miss. Fault injection (`failNext`) covers storage-error paths.
 *
 * TTL model: `set(key, value, { expiration: ms })` and `expire(key, sec)`
 * schedule an in-memory deletion. The fake exposes `_advanceClock(ms)` so
 * tests can drive expirations without sleeping; production code uses real
 * Redis TTLs.
 */

interface ZEntry {
  member: string;
  score: number;
}

type ZRangeOpts = {
  reverse?: boolean;
  by?: 'rank' | 'score' | 'lex';
  limit?: { offset: number; count: number };
};

interface SetOpts {
  /** Absolute expiry time (matches Devvit RedisClient). */
  expiration?: Date;
}

export class FakeRedis {
  private kv = new Map<string, string>();
  private zsets = new Map<string, Map<string, number>>();
  /** Absolute deletion time per key (epoch ms; compared against `clockNow`). */
  private expirations = new Map<string, number>();
  /**
   * Fake "wall clock" in epoch ms. Starts at 0 so a TTL written as
   * `new Date(fakeClock.now() + ttl)` (where the test's FakeClock starts at a
   * small number) doesn't expire instantly. Tests that want to drive
   * expirations call `_advanceClock(ms)` explicitly.
   */
  private clockNow = 0;

  /**
   * When set, the next matching op throws — for storage-error tests. The
   * optional `skip` lets a test ignore the first N matching ops and fail the
   * one after (used to target the *second* exec/watch in a flow where the
   * first one belongs to a mutate and the failure under test is in a
   * subsequent batch). `throwAs` lets the test throw a non-Error value (a
   * primitive) instead of `new Error(...)` — useful for exercising defensive
   * `instanceof Error` branches in callers.
   */
  failNext: {
    op: 'get' | 'set' | 'del' | 'watch' | 'exec' | 'zCard';
    key?: string;
    skip?: number;
    throwAs?: unknown;
  } | null = null;
  /** Fires once after a watched key is read inside `mutate`, before exec. */
  onWatchedRead: ((key: string) => Promise<void> | void) | null = null;

  private maybeFail(
    op: 'get' | 'set' | 'del' | 'watch' | 'exec' | 'zCard',
    key: string,
  ): void {
    if (this.failNext && this.failNext.op === op) {
      if (!this.failNext.key || this.failNext.key === key) {
        if (this.failNext.skip && this.failNext.skip > 0) {
          this.failNext = { ...this.failNext, skip: this.failNext.skip - 1 };
          return;
        }
        const throwAs = this.failNext.throwAs;
        this.failNext = null;
        if (throwAs !== undefined) {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw throwAs;
        }
        throw new Error(`injected ${op} failure`);
      }
    }
  }

  async get(key: string): Promise<string | undefined> {
    this.maybeFail('get', key);
    this.expireDue();
    return this.kv.get(key);
  }

  async set(key: string, value: string, options?: SetOpts): Promise<void> {
    this.maybeFail('set', key);
    this.expireDue();
    this.kv.set(key, value);
    if (options?.expiration !== undefined) {
      this.expirations.set(key, options.expiration.getTime());
    } else {
      // Setting without an explicit TTL clears any prior TTL on the same key.
      this.expirations.delete(key);
    }
  }

  async expire(key: string, seconds: number): Promise<void> {
    if (this.kv.has(key)) {
      this.expirations.set(key, this.clockNow + seconds * 1000);
    }
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.maybeFail('del', k);
      this.kv.delete(k);
      this.zsets.delete(k);
      this.expirations.delete(k);
    }
  }

  async zAdd(key: string, ...entries: ZEntry[]): Promise<number> {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    let added = 0;
    for (const e of entries) {
      if (!set.has(e.member)) added++;
      set.set(e.member, e.score);
    }
    return added;
  }

  async zRem(key: string, members: string[]): Promise<number> {
    const set = this.zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed++;
    return removed;
  }

  async zCard(key: string): Promise<number> {
    this.maybeFail('zCard', key);
    return this.zsets.get(key)?.size ?? 0;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options?: ZRangeOpts,
  ): Promise<ZEntry[]> {
    this.expireDue();
    const set = this.zsets.get(key);
    if (!set) return [];
    // Real Redis orders ties by member byte/codepoint order, which JS `<`/`>`
    // reproduce (localeCompare does NOT — it is case-folding/locale-aware). The
    // store's cursor tie-break relies on this exact ordering, so we match it.
    let sorted = [...set.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) =>
        a.score - b.score || (a.member < b.member ? -1 : a.member > b.member ? 1 : 0),
      );

    let result: ZEntry[];
    if (options?.by === 'score') {
      let inRange = sorted.filter((e) => e.score >= start && e.score <= stop);
      if (options.reverse) inRange = inRange.reverse();
      result = inRange;
    } else {
      if (options?.reverse) sorted = sorted.reverse();
      const end = stop === -1 ? sorted.length - 1 : stop;
      result = sorted.slice(start, end + 1);
    }

    // Apply the LIMIT offset/count window AFTER range selection + ordering,
    // exactly as Redis does. This is what makes a "bounded read" actually
    // bounded rather than sliced in memory by the caller.
    if (options?.limit) {
      const { offset, count } = options.limit;
      result = result.slice(offset, count < 0 ? undefined : offset + count);
    }
    return result;
  }

  async watch(...keys: string[]): Promise<FakeTx> {
    this.maybeFail('watch', keys[0] ?? '');
    const snapshot = new Map<string, string | undefined>();
    for (const k of keys) snapshot.set(k, this.kv.get(k));
    return new FakeTx(this, keys, snapshot);
  }

  // --- internals used by FakeTx ---
  _snapshotValue(key: string): string | undefined {
    return this.kv.get(key);
  }
  _applySet(key: string, value: string, options?: SetOpts): void {
    this.kv.set(key, value);
    if (options?.expiration !== undefined) {
      this.expirations.set(key, options.expiration.getTime());
    } else {
      this.expirations.delete(key);
    }
  }
  _applyDel(keys: string[]): void {
    for (const k of keys) {
      this.kv.delete(k);
      this.zsets.delete(k);
      this.expirations.delete(k);
    }
  }
  _applyZAdd(key: string, entries: ZEntry[]): number {
    let set = this.zsets.get(key);
    if (!set) {
      set = new Map();
      this.zsets.set(key, set);
    }
    let added = 0;
    for (const e of entries) {
      if (!set.has(e.member)) added++;
      set.set(e.member, e.score);
    }
    return added;
  }
  _applyZRem(key: string, members: string[]): number {
    const set = this.zsets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed++;
    return removed;
  }
  async _fireWatchedRead(key: string): Promise<void> {
    if (this.onWatchedRead) {
      const hook = this.onWatchedRead;
      this.onWatchedRead = null;
      await hook(key);
    }
  }
  _maybeFailExec(): void {
    this.maybeFail('exec', '');
  }

  _dump(): Record<string, string> {
    this.expireDue();
    return Object.fromEntries(this.kv.entries());
  }

  /**
   * Advance the fake's internal clock. Any keys whose TTL has elapsed are
   * deleted on the next operation, mirroring real Redis lazy expiration.
   */
  _advanceClock(ms: number): void {
    this.clockNow += ms;
  }

  /** Sweep expired keys (called from every public op so TTLs are honoured). */
  private expireDue(): void {
    for (const [key, deadline] of this.expirations) {
      if (deadline <= this.clockNow) {
        this.kv.delete(key);
        this.zsets.delete(key);
        this.expirations.delete(key);
      }
    }
  }
}

type QueuedCmd =
  | { kind: 'set'; key: string; value: string; options?: SetOpts }
  | { kind: 'del'; keys: string[] }
  | { kind: 'zAdd'; key: string; entries: ZEntry[] }
  | { kind: 'zRem'; key: string; members: string[] };

export class FakeTx {
  private queue: QueuedCmd[] = [];
  private inMulti = false;
  private firstReadFired = false;

  constructor(
    private readonly redis: FakeRedis,
    private readonly watched: string[],
    private readonly snapshot: Map<string, string | undefined>,
  ) {}

  /** Simulate the watched read hook firing once (the store calls get() between
   *  watch and multi; we approximate by firing on the first queued command). */
  private async fireReadHookOnce(): Promise<void> {
    if (this.firstReadFired) return;
    this.firstReadFired = true;
    const key = this.watched[0];
    if (key) await this.redis._fireWatchedRead(key);
  }

  async set(key: string, value: string, options?: SetOpts): Promise<FakeTx> {
    this.queue.push({ kind: 'set', key, value, options });
    return this;
  }

  async del(...keys: string[]): Promise<FakeTx> {
    this.queue.push({ kind: 'del', keys });
    return this;
  }

  async zAdd(key: string, ...entries: ZEntry[]): Promise<FakeTx> {
    this.queue.push({ kind: 'zAdd', key, entries });
    return this;
  }

  async zRem(key: string, members: string[]): Promise<FakeTx> {
    this.queue.push({ kind: 'zRem', key, members });
    return this;
  }

  async multi(): Promise<void> {
    await this.fireReadHookOnce();
    this.inMulti = true;
  }

  async exec(): Promise<unknown[] | null> {
    this.redis._maybeFailExec();
    // If a watched key changed since WATCH, abort (Redis returns null).
    for (const key of this.watched) {
      const before = this.snapshot.get(key);
      const now = this.redis._snapshotValue(key);
      if (before !== now) {
        this.queue = [];
        this.inMulti = false;
        return null;
      }
    }
    const replies: unknown[] = [];
    for (const cmd of this.queue) {
      if (cmd.kind === 'set') {
        this.redis._applySet(cmd.key, cmd.value, cmd.options);
        replies.push('OK');
      } else if (cmd.kind === 'del') {
        this.redis._applyDel(cmd.keys);
        replies.push(cmd.keys.length);
      } else if (cmd.kind === 'zAdd') {
        replies.push(this.redis._applyZAdd(cmd.key, cmd.entries));
      } else {
        replies.push(this.redis._applyZRem(cmd.key, cmd.members));
      }
    }
    this.queue = [];
    this.inMulti = false;
    return replies;
  }
}
