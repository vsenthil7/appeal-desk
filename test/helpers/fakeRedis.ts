/**
 * FakeRedis — an in-memory stand-in for Devvit's RedisClient, implementing
 * exactly the operations AppealStore uses. Sorted sets are modelled as a
 * member→score map; zRange supports rank ordering and reverse, which is all
 * the store needs. This lets us test the entire persistence layer without a
 * real Redis or the Devvit runtime.
 */

interface ZEntry {
  member: string;
  score: number;
}

export class FakeRedis {
  private kv = new Map<string, string>();
  private zsets = new Map<string, Map<string, number>>();

  async get(key: string): Promise<string | undefined> {
    return this.kv.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.kv.set(key, value);
  }

  async del(...keys: string[]): Promise<void> {
    for (const k of keys) {
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
    return this.zsets.get(key)?.size ?? 0;
  }

  async zRange(
    key: string,
    start: number,
    stop: number,
    options?: { reverse?: boolean; by?: 'rank' | 'score' },
  ): Promise<ZEntry[]> {
    const set = this.zsets.get(key);
    if (!set) return [];
    let sorted = [...set.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    if (options?.reverse) sorted = sorted.reverse();
    // Devvit zRange is inclusive of stop; -1 means "to the end".
    const end = stop === -1 ? sorted.length - 1 : stop;
    return sorted.slice(start, end + 1);
  }

  /** Test helper: peek at raw kv contents. */
  _dump(): Record<string, string> {
    return Object.fromEntries(this.kv.entries());
  }
}
