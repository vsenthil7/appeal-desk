/**
 * Performance benchmarks for Appealdesk's core hot paths.
 *
 * These measure the deterministic, CPU-bound logic (dedup, validation,
 * template rendering, rate-limit math) and the store operations against the
 * in-memory FakeRedis — so the numbers isolate OUR code, not Redis network
 * latency. They give a regression baseline: if a change makes dedup 10x slower,
 * a re-run shows it.
 *
 * Run with: `npm run bench`  (node --import tsx bench/run.ts)
 *
 * The harness is dependency-free: it times N iterations with the high-res
 * clock, reports ops/sec and mean/p95 latency, and is intentionally simple so
 * it runs anywhere the project builds.
 */

import { computeDedup, jaccard, tokenSet } from '../src/core/dedup.js';
import { validateSubmission, sanitiseText, LIMITS } from '../src/core/validation/index.js';
import { renderTemplate } from '../src/core/templates.js';
import { checkRateLimit, initialBucket } from '../src/core/concurrency/rateLimit.js';
import { AppealStore } from '../src/core/store.js';
import { FakeClock } from '../src/core/observability/index.js';

// --- a tiny in-memory Redis (mirrors the test fake, kept local to bench) ----

class BenchRedis {
  private kv = new Map<string, string>();
  private z = new Map<string, Map<string, number>>();
  async get(k: string) {
    return this.kv.get(k);
  }
  async set(k: string, v: string) {
    this.kv.set(k, v);
  }
  async del(...ks: string[]) {
    for (const k of ks) {
      this.kv.delete(k);
      this.z.delete(k);
    }
  }
  async zAdd(k: string, ...es: { member: string; score: number }[]) {
    let s = this.z.get(k);
    if (!s) {
      s = new Map();
      this.z.set(k, s);
    }
    for (const e of es) s.set(e.member, e.score);
    return es.length;
  }
  async zRem(k: string, ms: string[]) {
    const s = this.z.get(k);
    if (!s) return 0;
    let n = 0;
    for (const m of ms) if (s.delete(m)) n++;
    return n;
  }
  async zCard(k: string) {
    return this.z.get(k)?.size ?? 0;
  }
  async zRange(
    k: string,
    start: number,
    stop: number,
    opts?: { reverse?: boolean; by?: 'rank' | 'score' | 'lex' },
  ) {
    const s = this.z.get(k);
    if (!s) return [];
    let arr = [...s.entries()]
      .map(([member, score]) => ({ member, score }))
      .sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    if (opts?.by === 'score') {
      let r = arr.filter((e) => e.score >= start && e.score <= stop);
      if (opts.reverse) r = r.reverse();
      return r;
    }
    if (opts?.reverse) arr = arr.reverse();
    const end = stop === -1 ? arr.length - 1 : stop;
    return arr.slice(start, end + 1);
  }
  async watch() {
    const self = this;
    const queue: { k: string; v?: string; del?: string[] }[] = [];
    return {
      async set(k: string, v: string) {
        queue.push({ k, v });
        return this;
      },
      async del(...ks: string[]) {
        queue.push({ k: '', del: ks });
        return this;
      },
      async multi() {},
      async exec() {
        for (const c of queue) {
          if (c.del) await self.del(...c.del);
          else await self.set(c.k, c.v!);
        }
        return queue.map(() => 'OK');
      },
    };
  }
}

// --- timing harness ---------------------------------------------------------

interface Result {
  name: string;
  iterations: number;
  opsPerSec: number;
  meanUs: number;
  p95Us: number;
}

async function bench(
  name: string,
  iterations: number,
  fn: (i: number) => void | Promise<void>,
): Promise<Result> {
  // Warm up the JIT.
  for (let i = 0; i < Math.min(200, iterations); i++) await fn(i);

  const samples: number[] = new Array(iterations);
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    await fn(i);
    const t1 = process.hrtime.bigint();
    samples[i] = Number(t1 - t0) / 1000; // microseconds
  }
  const totalNs = Number(process.hrtime.bigint() - start);

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p95 = samples[Math.floor(samples.length * 0.95)] ?? mean;
  const opsPerSec = (iterations / totalNs) * 1e9;

  return { name, iterations, opsPerSec, meanUs: mean, p95Us: p95 };
}

function fmt(r: Result): string {
  return [
    r.name.padEnd(34),
    `${Math.round(r.opsPerSec).toLocaleString().padStart(12)} ops/s`,
    `mean ${r.meanUs.toFixed(2).padStart(8)}µs`,
    `p95 ${r.p95Us.toFixed(2).padStart(8)}µs`,
  ].join('  ');
}

// --- the benchmarks ---------------------------------------------------------

async function main(): Promise<void> {
  const results: Result[] = [];

  const longReason =
    'I really think this removal was a mistake because I was quoting the rule, ' +
    'not breaking it, and the context makes that clear if you read the thread.';
  const prior = Array.from({ length: 20 }, (_, i) => ({
    id: `ap_${i}`,
    reason: `some earlier appeal number ${i} with varied wording about rules`,
  }));

  results.push(
    await bench('dedup.computeDedup (20 prior)', 8_000, () => {
      computeDedup(longReason, prior);
    }),
  );

  results.push(
    await bench('dedup.jaccard', 30_000, () => {
      jaccard(tokenSet(longReason), tokenSet(prior[0]!.reason));
    }),
  );

  results.push(
    await bench('validation.validateSubmission', 30_000, () => {
      validateSubmission({
        reason: longReason,
        acknowledged: true,
        actionType: 'ban',
        targetId: 't2_user',
        authorName: 'alice',
      });
    }),
  );

  results.push(
    await bench('validation.sanitiseText', 30_000, () => {
      sanitiseText(longReason, LIMITS.reasonMax);
    }),
  );

  results.push(
    await bench('templates.renderTemplate', 50_000, () => {
      renderTemplate('Hi {{user}} in r/{{subreddit}} re {{action}}', {
        user: 'alice',
        subreddit: 'aww',
        action: 'ban',
      });
    }),
  );

  results.push(
    await bench('rateLimit.checkRateLimit', 80_000, () => {
      checkRateLimit(
        initialBucket({ capacity: 5, refillPerHour: 2 }, 0),
        { capacity: 5, refillPerHour: 2 },
        1000,
      );
    }),
  );

  // Store paths against the in-memory fake.
  const clock = new FakeClock(1_000_000);
  const store = new AppealStore(new BenchRedis() as never, {
    clock,
    metrics: { increment() {}, gauge() {}, timing() {} },
    logger: { log() {}, child() { return this; } },
  });
  await store.setConfig('aww', {
    slaHours: 48,
    aiEnabled: false,
    oneAppealPerAction: false,
    rateLimitCapacity: 1_000_000,
    rateLimitRefillPerHour: 1,
    retentionDays: 180,
    templates: { upheld: 'u', overturned: 'o', more_info: 'm' },
  });

  results.push(
    await bench('store.create', 1_500, async (i) => {
      clock.advance(1);
      await store.create({
        subreddit: 'aww',
        actionType: 'ban',
        targetId: `t3_${i}`,
        authorId: 't2_alice',
        authorName: 'alice',
        reason: longReason,
        acknowledged: true,
        originalContent: '(account ban)',
        originalReason: 'spam',
      });
    }),
  );

  results.push(
    await bench('store.openQueuePage (25)', 1_500, async () => {
      await store.openQueuePage('aww', 25);
    }),
  );

  // Report.
  const line = '─'.repeat(86);
  console.log('\nAppealdesk core benchmarks');
  console.log(`node ${process.version} · ${new Date().toISOString()}`);
  console.log(line);
  for (const r of results) console.log(fmt(r));
  console.log(line);
  console.log(
    'Note: store benchmarks run against an in-memory Redis fake, so they\n' +
      'measure Appealdesk logic only — production adds Devvit KV round-trips.\n',
  );
}

void main();
