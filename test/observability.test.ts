import { describe, it, expect } from 'vitest';
import {
  FakeClock,
  MemoryLogger,
  MemoryMetrics,
  noopLogger,
  noopMetrics,
  systemClock,
  time,
  defaultTelemetry,
} from '../src/core/observability/index.js';

describe('FakeClock', () => {
  it('returns, advances, and sets time deterministically', () => {
    const c = new FakeClock(1000);
    expect(c.now()).toBe(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
    c.set(42);
    expect(c.now()).toBe(42);
  });
});

describe('systemClock', () => {
  it('returns a number close to Date.now', () => {
    const before = Date.now();
    const t = systemClock.now();
    expect(t).toBeGreaterThanOrEqual(before);
  });
});

describe('noop primitives', () => {
  it('do nothing and return safely', () => {
    expect(() => noopLogger.log('info', 'x')).not.toThrow();
    expect(noopLogger.child({ a: 1 })).toBe(noopLogger);
    expect(() => noopMetrics.increment('x')).not.toThrow();
    expect(() => noopMetrics.gauge('x', 1)).not.toThrow();
    expect(() => noopMetrics.timing('x', 1)).not.toThrow();
  });

  it('defaultTelemetry wires the noops and system clock', () => {
    expect(defaultTelemetry.logger).toBe(noopLogger);
    expect(defaultTelemetry.metrics).toBe(noopMetrics);
    expect(defaultTelemetry.clock).toBe(systemClock);
  });
});

describe('MemoryLogger', () => {
  it('records lines with merged base + call context', () => {
    const log = new MemoryLogger({ app: 'appealdesk' });
    log.log('info', 'hello', { sub: 'aww' });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toEqual({
      level: 'info',
      message: 'hello',
      context: { app: 'appealdesk', sub: 'aww' },
    });
  });

  it('child loggers merge context and share the buffer', () => {
    const log = new MemoryLogger({ app: 'a' });
    const child = log.child({ req: 1 });
    child.log('warn', 'w');
    expect(log.lines).toHaveLength(1); // shared buffer
    expect(log.lines[0]!.context).toEqual({ app: 'a', req: 1 });
  });

  it('filters by level via at()', () => {
    const log = new MemoryLogger();
    log.log('info', 'a');
    log.log('error', 'b');
    expect(log.at('error')).toHaveLength(1);
    expect(log.at('error')[0]!.message).toBe('b');
  });

  it('log() context defaults to empty', () => {
    const log = new MemoryLogger();
    log.log('debug', 'd');
    expect(log.lines[0]!.context).toEqual({});
  });
});

describe('MemoryMetrics', () => {
  it('records increments, gauges and timings', () => {
    const m = new MemoryMetrics();
    m.increment('a');
    m.increment('a', 3);
    m.gauge('g', 10, { tag: 'x' });
    m.timing('t', 25);
    expect(m.counter('a')).toBe(4);
    expect(m.named('g')[0]).toMatchObject({ type: 'gauge', value: 10 });
    expect(m.named('t')[0]).toMatchObject({ type: 'timing', value: 25 });
  });

  it('counter is zero for an unseen name', () => {
    expect(new MemoryMetrics().counter('nope')).toBe(0);
  });

  it('increment defaults value to 1 and tags to empty', () => {
    const m = new MemoryMetrics();
    m.increment('x');
    expect(m.named('x')[0]).toMatchObject({ value: 1, tags: {} });
  });
});

describe('time()', () => {
  it('records an ok timing and returns the result', async () => {
    const m = new MemoryMetrics();
    const clock = new FakeClock(0);
    const result = await time(m, clock, 'op', async () => {
      clock.advance(50);
      return 'done';
    });
    expect(result).toBe('done');
    const ev = m.named('op')[0]!;
    expect(ev.value).toBe(50);
    expect(ev.tags).toMatchObject({ outcome: 'ok' });
  });

  it('records an error timing and rethrows', async () => {
    const m = new MemoryMetrics();
    const clock = new FakeClock(0);
    await expect(
      time(m, clock, 'op', async () => {
        clock.advance(10);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(m.named('op')[0]!.tags).toMatchObject({ outcome: 'error' });
  });

  it('merges caller-supplied tags', async () => {
    const m = new MemoryMetrics();
    await time(m, new FakeClock(0), 'op', async () => 1, { sub: 'aww' });
    expect(m.named('op')[0]!.tags).toMatchObject({ sub: 'aww', outcome: 'ok' });
  });
});
