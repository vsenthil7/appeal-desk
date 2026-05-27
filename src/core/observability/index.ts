/**
 * Observability.
 *
 * Three small, injectable primitives so the core can emit structured logs and
 * metrics without coupling to any platform sink, and so tests can assert on
 * what was emitted:
 *
 *   - Logger : leveled, structured (JSON-friendly) log lines with a context bag.
 *   - Metrics: counters, gauges, and timing histograms (just record sinks here;
 *              a real deployment forwards them to its monitoring system).
 *   - Clock  : a `now()` seam so time-dependent code is deterministic in tests.
 *
 * The defaults are no-ops / console so production wiring is one line, and the
 * in-memory implementations make assertions trivial.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void;
  /** Returns a child logger whose context is merged into every line. */
  child(context: Record<string, unknown>): Logger;
}

export interface Metrics {
  increment(name: string, value?: number, tags?: Record<string, string>): void;
  gauge(name: string, value: number, tags?: Record<string, string>): void;
  /** Records a duration in ms. Use with `time()` for the common case. */
  timing(name: string, ms: number, tags?: Record<string, string>): void;
}

export interface Clock {
  now(): number;
}

/** Real wall clock. */
export const systemClock: Clock = { now: () => Date.now() };

/** A controllable clock for deterministic tests. */
export class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

/** No-op logger (default). */
export const noopLogger: Logger = {
  log() {},
  child() {
    return noopLogger;
  },
};

/** No-op metrics (default). */
export const noopMetrics: Metrics = {
  increment() {},
  gauge() {},
  timing() {},
};

interface LogLine {
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
}

/** In-memory logger that records every line, for tests and local debugging. */
export class MemoryLogger implements Logger {
  readonly lines: LogLine[] = [];
  constructor(private readonly base: Record<string, unknown> = {}) {}

  log(level: LogLevel, message: string, context: Record<string, unknown> = {}): void {
    this.lines.push({ level, message, context: { ...this.base, ...context } });
  }

  child(context: Record<string, unknown>): MemoryLogger {
    const c = new MemoryLogger({ ...this.base, ...context });
    // Share the underlying buffer so the parent sees children's lines.
    (c as { lines: LogLine[] }).lines = this.lines;
    return c;
  }

  /** Convenience filters for assertions. */
  at(level: LogLevel): LogLine[] {
    return this.lines.filter((l) => l.level === level);
  }
}

interface MetricEvent {
  type: 'increment' | 'gauge' | 'timing';
  name: string;
  value: number;
  tags: Record<string, string>;
}

/** In-memory metrics sink for tests. */
export class MemoryMetrics implements Metrics {
  readonly events: MetricEvent[] = [];

  /**
   * Per-metric-name timing histogram (D4). We keep raw samples (the event list
   * already does) AND a lightweight linear-bucket counter so percentile reads
   * are O(buckets), not O(samples). Buckets are 1ms-resolution up to 100ms,
   * then 10ms up to 1s, then 100ms up to 10s — plus an overflow bucket. This
   * is plenty of resolution for the operations we time (Redis ops, page
   * fetches) and trivial to forward to StatsD/CloudWatch with a sink hook.
   */
  private readonly histograms = new Map<string, number[]>();

  increment(name: string, value = 1, tags: Record<string, string> = {}): void {
    this.events.push({ type: 'increment', name, value, tags });
  }
  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    this.events.push({ type: 'gauge', name, value, tags });
  }
  timing(name: string, ms: number, tags: Record<string, string> = {}): void {
    this.events.push({ type: 'timing', name, value: ms, tags });
    const bucket = bucketIndex(ms);
    let buckets = this.histograms.get(name);
    if (!buckets) {
      buckets = new Array(HISTOGRAM_BUCKETS.length).fill(0) as number[];
      this.histograms.set(name, buckets);
    }
    /* v8 ignore next */
    buckets[bucket] = (buckets[bucket] ?? 0) + 1;
  }

  /** Sum of a counter across all matching events. */
  counter(name: string): number {
    return this.events
      .filter((e) => e.type === 'increment' && e.name === name)
      .reduce((sum, e) => sum + e.value, 0);
  }

  /** All events with a given name. */
  named(name: string): MetricEvent[] {
    return this.events.filter((e) => e.name === name);
  }

  /** Total number of timing samples recorded for a metric. */
  histogramCount(name: string): number {
    const buckets = this.histograms.get(name);
    if (!buckets) return 0;
    return buckets.reduce((sum, n) => sum + n, 0);
  }

  /**
   * Percentile (0..100) of a timing metric, computed from the histogram. Returns
   * the lower edge of the bucket containing the requested quantile, which is
   * what production monitoring systems return. Returns `null` for an unsampled
   * metric so SLO assertions can distinguish "no data" from "p99 is 0ms".
   */
  percentile(name: string, p: number): number | null {
    const buckets = this.histograms.get(name);
    if (!buckets) return null;
    const total = this.histogramCount(name);
    if (total === 0) return null;
    const target = Math.ceil((p / 100) * total);
    let cumulative = 0;
    for (let i = 0; i < buckets.length; i++) {
      cumulative += buckets[i] ?? 0;
      if (cumulative >= target) return HISTOGRAM_BUCKETS[i] ?? Infinity;
    }
    return HISTOGRAM_BUCKETS[HISTOGRAM_BUCKETS.length - 1] ?? Infinity;
  }
}

/**
 * Lower edges of the histogram buckets, in ms. Linear at 1ms up to 100,
 * 10ms up to 1s, 100ms up to 10s, then an overflow bucket at 10s+.
 */
const HISTOGRAM_BUCKETS: ReadonlyArray<number> = (() => {
  const buckets: number[] = [];
  for (let i = 0; i < 100; i++) buckets.push(i);
  for (let i = 100; i < 1000; i += 10) buckets.push(i);
  for (let i = 1000; i < 10_000; i += 100) buckets.push(i);
  buckets.push(10_000);
  return buckets;
})();

function bucketIndex(ms: number): number {
  if (ms < 0 || Number.isNaN(ms)) return 0;
  if (ms >= 10_000) return HISTOGRAM_BUCKETS.length - 1;
  if (ms < 100) return Math.floor(ms);
  if (ms < 1000) return 100 + Math.floor((ms - 100) / 10);
  return 100 + 90 + Math.floor((ms - 1000) / 100);
}

/**
 * Time an async operation and emit a timing metric, regardless of outcome.
 * Returns the operation's result (or rethrows its error after recording).
 */
export async function time<T>(
  metrics: Metrics,
  clock: Clock,
  name: string,
  op: () => Promise<T>,
  tags: Record<string, string> = {},
): Promise<T> {
  const start = clock.now();
  try {
    const result = await op();
    metrics.timing(name, clock.now() - start, { ...tags, outcome: 'ok' });
    return result;
  } catch (e) {
    metrics.timing(name, clock.now() - start, { ...tags, outcome: 'error' });
    throw e;
  }
}

/** Bundle the three primitives so they pass through the app as one object. */
export interface Telemetry {
  logger: Logger;
  metrics: Metrics;
  clock: Clock;
}

export const defaultTelemetry: Telemetry = {
  logger: noopLogger,
  metrics: noopMetrics,
  clock: systemClock,
};
