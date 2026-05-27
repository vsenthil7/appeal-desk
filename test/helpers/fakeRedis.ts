/**
 * FakeRedis — an in-memory stand-in for Devvit's RedisClient implementing the
 * RedisLike surface AppealStore uses, INCLUDING WATCH/MULTI/EXEC transactions
 * with correct optimistic-lock abort semantics.
 *
 * Transaction model (matching Redis):
 *   - `watch(...keys)` snapshots the current value of each key and returns a tx.
 *   - queued commands (`set`/`del`) are buffered, not applied.
 *   - `exec()` checks every watched key against its snapshot; if any changed,
 *     the transaction is ABORTED and exec resolves to null (no writes applied).
 *     Otherwise all buffered writes are applied atomically and an array of
 *     replies is returned.
 *
 * To exercise concurrency deterministically, `onWatchedRead` fires once after a
 * tx reads a watched key (before exec), letting a test mutate the store to
 * force a CAS miss. Fault injection (`failNext`) covers storage-error paths.
 */

interface ZEntry {
  member: string;
  score: number;
}

type ZRangeOpts = { reverse?: boolean; by?: 'rank' | 'score' | 'lex' };

export class FakeRedis {
  private kv = new Map<string, string>();
  private zsets = new Map<string, Map<string, number>>();

  /** When set, the next matching op throws — for storage-error tests. */
  failNext: {
    op: 'get' | 'set' | 'del' | 'watch' | 'exec' | 'zCard';
    key?: string;
  } | null = null;
  /** Fires once after a watched key is read inside `mutate`, before exec. */
  onWatchedRead: ((key: string) => Promise<void> | void) | null = null;

  private maybeFail(
    op: 'get' | 'set' | 'del' | 'watch' | 'exec' | 'zCard',
    key: string,
  ): void {
    if (this.failNext && this.failNext.op === op) {
      if (!this.failNext.key || this.failNext.key === key) {
        this.failNext = null;
        throw new Error(`injected ${op} failure`);
      }
    }
  }

  async get(key: string): Promise<string | undefined> {
    this.maybeFail('get', key);
    return this.kv.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.maybeFail('set', key);
    this.kv.set(key, value);
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) {
      this.maybeFail('del', k);
      this.kv.delete(k);
      this.zsets.delete(k);
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
    const set = this.zsets.get(key);
    if (!set) return [];
    let sorted = [...set.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));

    if (options?.by === 'score') {
      let inRange = sorted.filter((e) => e.score >= start && e.score <= stop);
      if (options.reverse) inRange = inRange.reverse();
      return inRange;
    }

    if (options?.reverse) sorted = sorted.reverse();
    const end = stop === -1 ? sorted.length - 1 : stop;
    return sorted.slice(start, end + 1);
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
  _applySet(key: string, value: string): void {
    this.kv.set(key, value);
  }
  _applyDel(keys: string[]): void {
    for (const k of keys) {
      this.kv.delete(k);
      this.zsets.delete(k);
    }
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
    return Object.fromEntries(this.kv.entries());
  }
}

type QueuedCmd =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'del'; keys: string[] };

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

  async set(key: string, value: string): Promise<FakeTx> {
    this.queue.push({ kind: 'set', key, value });
    return this;
  }

  async del(...keys: string[]): Promise<FakeTx> {
    this.queue.push({ kind: 'del', keys });
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
        this.redis._applySet(cmd.key, cmd.value);
        replies.push('OK');
      } else {
        this.redis._applyDel(cmd.keys);
        replies.push(cmd.keys.length);
      }
    }
    this.queue = [];
    this.inMulti = false;
    return replies;
  }
}
