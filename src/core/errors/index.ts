/**
 * Error taxonomy.
 *
 * Production code must not signal failure with `null` and a shrug — callers
 * need to know *why* something failed so they can decide whether to retry,
 * surface a message, or page someone. Every failure mode in Appealdesk maps to
 * a typed `AppealError` carrying a stable machine-readable `code`, an
 * HTTP-ish `status` for surfaces that need one, a `retryable` flag, and an
 * optional `context` bag for structured logging.
 *
 * The codes are a closed union so the compiler enforces exhaustive handling.
 */

export type AppealErrorCode =
  // validation (caller's fault — never retry)
  | 'VALIDATION_FAILED'
  // conflict / concurrency (caller may retry after re-reading)
  | 'DUPLICATE_OPEN_APPEAL'
  | 'OPTIMISTIC_LOCK_CONFLICT'
  | 'RATE_LIMITED'
  | 'INVALID_STATE_TRANSITION'
  // not found (caller's fault — never retry)
  | 'APPEAL_NOT_FOUND'
  | 'CONFIG_NOT_FOUND'
  // infrastructure (transient — safe to retry)
  | 'STORAGE_UNAVAILABLE'
  | 'REPLY_DELIVERY_FAILED'
  // internal (bug — never retry, must be logged loudly)
  | 'DATA_CORRUPTION'
  | 'INTERNAL';

interface ErrorSpec {
  status: number;
  retryable: boolean;
}

/** Static properties for each code: how a surface should treat it. */
const SPECS: Record<AppealErrorCode, ErrorSpec> = {
  VALIDATION_FAILED: { status: 400, retryable: false },
  DUPLICATE_OPEN_APPEAL: { status: 409, retryable: false },
  OPTIMISTIC_LOCK_CONFLICT: { status: 409, retryable: true },
  RATE_LIMITED: { status: 429, retryable: true },
  INVALID_STATE_TRANSITION: { status: 409, retryable: false },
  APPEAL_NOT_FOUND: { status: 404, retryable: false },
  CONFIG_NOT_FOUND: { status: 404, retryable: false },
  STORAGE_UNAVAILABLE: { status: 503, retryable: true },
  REPLY_DELIVERY_FAILED: { status: 502, retryable: true },
  DATA_CORRUPTION: { status: 500, retryable: false },
  INTERNAL: { status: 500, retryable: false },
};

export class AppealError extends Error {
  readonly code: AppealErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: AppealErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppealError';
    this.code = code;
    const spec = SPECS[code];
    this.status = spec.status;
    this.retryable = spec.retryable;
    this.context = Object.freeze({ ...context });
    // Preserve a correct prototype chain when transpiled to ES5-ish targets.
    Object.setPrototypeOf(this, AppealError.prototype);
  }

  /** Stable, log-friendly shape. Never includes the stack (logged separately). */
  toJSON(): {
    code: AppealErrorCode;
    message: string;
    status: number;
    retryable: boolean;
    context: Record<string, unknown>;
  } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      context: { ...this.context },
    };
  }
}

/** Type guard. */
export function isAppealError(e: unknown): e is AppealError {
  return e instanceof AppealError;
}

/** Convenience constructors keep call sites terse and consistent. */
export const errors = {
  validation: (message: string, context?: Record<string, unknown>) =>
    new AppealError('VALIDATION_FAILED', message, context),
  duplicateOpen: (targetId: string) =>
    new AppealError(
      'DUPLICATE_OPEN_APPEAL',
      'An open appeal already exists for this action.',
      { targetId },
    ),
  lockConflict: (key: string, expected: number, actual: number) =>
    new AppealError(
      'OPTIMISTIC_LOCK_CONFLICT',
      'The record changed since it was read.',
      { key, expected, actual },
    ),
  rateLimited: (user: string, retryAfterMs: number) =>
    new AppealError('RATE_LIMITED', 'Too many appeals, too quickly.', {
      user,
      retryAfterMs,
    }),
  invalidTransition: (from: string, to: string) =>
    new AppealError(
      'INVALID_STATE_TRANSITION',
      `Cannot move an appeal from ${from} to ${to}.`,
      { from, to },
    ),
  notFound: (id: string) =>
    new AppealError('APPEAL_NOT_FOUND', 'Appeal not found.', { id }),
  configNotFound: (sub: string) =>
    new AppealError('CONFIG_NOT_FOUND', 'Config not found.', { sub }),
  storage: (op: string, cause?: unknown) =>
    new AppealError('STORAGE_UNAVAILABLE', 'Storage operation failed.', {
      op,
      cause: cause instanceof Error ? cause.message : String(cause),
    }),
  replyDelivery: (to: string, cause?: unknown) =>
    new AppealError('REPLY_DELIVERY_FAILED', 'Could not deliver the reply.', {
      to,
      cause: cause instanceof Error ? cause.message : String(cause),
    }),
  corruption: (key: string, detail: string) =>
    new AppealError('DATA_CORRUPTION', 'Stored data is corrupt.', {
      key,
      detail,
    }),
  internal: (message: string, context?: Record<string, unknown>) =>
    new AppealError('INTERNAL', message, context),
} as const;
