/**
 * Rate limiting — a token-bucket, computed purely from persisted state.
 *
 * We don't keep timers in memory (the Devvit runtime is stateless between
 * invocations). Instead the bucket state — `tokens` and `lastRefill` — is
 * stored in Redis per user, and we recompute the available tokens from elapsed
 * wall-clock time on each check. This is the standard stateless token-bucket
 * and it's fully deterministic given a clock, so it's exhaustively testable.
 *
 * The algorithm itself lives here as a pure function; the store wraps it with
 * persistence.
 */

export interface BucketState {
  tokens: number; // fractional tokens currently available
  lastRefill: number; // epoch ms of the last refill calculation
}

export interface RateLimitConfig {
  capacity: number; // max tokens (burst size)
  refillPerHour: number; // tokens added per hour
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Bucket state to persist after this check. */
  next: BucketState;
  /** If denied, how long until at least one token is available (ms). */
  retryAfterMs: number;
}

/** A fresh, full bucket. */
export function initialBucket(
  config: RateLimitConfig,
  now: number,
): BucketState {
  return { tokens: config.capacity, lastRefill: now };
}

/**
 * Refill the bucket based on elapsed time, then attempt to spend one token.
 * Pure: same inputs always give the same decision.
 */
export function checkRateLimit(
  state: BucketState,
  config: RateLimitConfig,
  now: number,
  cost = 1,
): RateLimitDecision {
  const elapsedMs = Math.max(0, now - state.lastRefill);
  const refillRatePerMs = config.refillPerHour / (60 * 60 * 1000);
  const refilled = Math.min(
    config.capacity,
    state.tokens + elapsedMs * refillRatePerMs,
  );

  if (refilled >= cost) {
    return {
      allowed: true,
      next: { tokens: refilled - cost, lastRefill: now },
      retryAfterMs: 0,
    };
  }

  // Not enough tokens. Compute the wait for the shortfall.
  const deficit = cost - refilled;
  const retryAfterMs =
    refillRatePerMs > 0 ? Math.ceil(deficit / refillRatePerMs) : Infinity;
  return {
    allowed: false,
    next: { tokens: refilled, lastRefill: now },
    retryAfterMs,
  };
}
