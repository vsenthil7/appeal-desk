import { describe, it, expect } from 'vitest';
import {
  AppealError,
  isAppealError,
  errors,
  type AppealErrorCode,
} from '../src/core/errors/index.js';

describe('AppealError', () => {
  it('carries code, status, retryable and frozen context', () => {
    const e = new AppealError('RATE_LIMITED', 'slow down', { user: 'a' });
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.context).toEqual({ user: 'a' });
    expect(Object.isFrozen(e.context)).toBe(true);
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe('AppealError');
  });

  it('serialises to a stable, stack-free JSON shape', () => {
    const e = new AppealError('INTERNAL', 'boom', { x: 1 });
    expect(e.toJSON()).toEqual({
      code: 'INTERNAL',
      message: 'boom',
      status: 500,
      retryable: false,
      context: { x: 1 },
    });
    expect(JSON.stringify(e)).not.toContain('stack');
  });

  it('defaults context to an empty object', () => {
    const e = new AppealError('INTERNAL', 'x');
    expect(e.context).toEqual({});
  });

  it('assigns the correct status/retryable for every code', () => {
    const expected: Record<AppealErrorCode, [number, boolean]> = {
      VALIDATION_FAILED: [400, false],
      DUPLICATE_OPEN_APPEAL: [409, false],
      OPTIMISTIC_LOCK_CONFLICT: [409, true],
      RATE_LIMITED: [429, true],
      INVALID_STATE_TRANSITION: [409, false],
      APPEAL_NOT_FOUND: [404, false],
      CONFIG_NOT_FOUND: [404, false],
      STORAGE_UNAVAILABLE: [503, true],
      REPLY_DELIVERY_FAILED: [502, true],
      DATA_CORRUPTION: [500, false],
      INTERNAL: [500, false],
    };
    for (const [code, [status, retryable]] of Object.entries(expected)) {
      const e = new AppealError(code as AppealErrorCode, 'm');
      expect(e.status).toBe(status);
      expect(e.retryable).toBe(retryable);
    }
  });
});

describe('isAppealError', () => {
  it('distinguishes AppealError from other errors', () => {
    expect(isAppealError(new AppealError('INTERNAL', 'x'))).toBe(true);
    expect(isAppealError(new Error('plain'))).toBe(false);
    expect(isAppealError('string')).toBe(false);
    expect(isAppealError(null)).toBe(false);
  });
});

describe('errors factory', () => {
  it('builds each error variant with the right code and context', () => {
    expect(errors.validation('m', { a: 1 }).code).toBe('VALIDATION_FAILED');
    expect(errors.duplicateOpen('t3_x').context).toMatchObject({ targetId: 't3_x' });
    expect(errors.lockConflict('k', 1, 2).code).toBe('OPTIMISTIC_LOCK_CONFLICT');
    expect(errors.rateLimited('u', 500).context).toMatchObject({
      user: 'u',
      retryAfterMs: 500,
    });
    expect(errors.invalidTransition('resolved', 'open').code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(errors.notFound('id').code).toBe('APPEAL_NOT_FOUND');
    expect(errors.configNotFound('sub').code).toBe('CONFIG_NOT_FOUND');
    expect(errors.corruption('k', 'bad').code).toBe('DATA_CORRUPTION');
    expect(errors.internal('m').code).toBe('INTERNAL');
  });

  it('normalises Error and non-Error causes into a string', () => {
    expect(errors.storage('get', new Error('redis')).context.cause).toBe('redis');
    expect(errors.storage('get', 42).context.cause).toBe('42');
    expect(errors.replyDelivery('u', new Error('mail')).context.cause).toBe('mail');
    expect(errors.replyDelivery('u', 'oops').context.cause).toBe('oops');
  });
});
