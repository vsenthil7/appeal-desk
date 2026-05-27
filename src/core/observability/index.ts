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

  increment(name: string, value = 1, tags: Record<string, string> = {}): void {
    this.events.push({ type: 'increment', name, value, tags });
  }
  gauge(name: string, value: number, tags: Record<string, string> = {}): void {
    this.events.push({ type: 'gauge', name, value, tags });
  }
  timing(name: string, ms: number, tags: Record<string, string> = {}): void {
    this.events.push({ type: 'timing', name, ms: ms, value: ms, tags } as MetricEvent);
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
