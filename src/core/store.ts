/**
 * AppealStore — the persistence layer.
 *
 * The ONLY place that touches Redis. Everything above speaks in domain objects.
 * This version is hardened for production concerns:
 *
 *   - Optimistic concurrency: writes are version-checked compare-and-sets, so a
 *     concurrent mutation raises OPTIMISTIC_LOCK_CONFLICT instead of silently
 *     clobbering. `mutate()` retries the read-modify-write a bounded number of
 *     times before surfacing the conflict.
 *   - Rate limiting: a stateless token bucket per user, persisted in Redis.
 *   - Pagination: the open queue and history are cursor-paginated.
 *   - Typed errors: storage faults, corruption, and not-found are AppealErrors,
 *     not nulls. (Reads still return null for genuine absence.)
 *   - Telemetry: every operation is timed and counted; corruption is logged.
 *   - Lifecycle: redaction (erasure) and purge (retention) operations.
 *
 * The Redis surface used: get/set/del, zAdd/zRange/zRem/zCard.
 */

import type { RedisLike } from './redisLike.js';
import { keys, generateAppealId } from './keys.js';
import {
  type Appeal,
  type AppealSummary,
  type AppealDecision,
  type DecisionRecord,
  type SubredditConfig,
  DEFAULT_CONFIG,
} from './types.js';
import { computeDedup } from './dedup.js';
import { errors } from './errors/index.js';
import {
  type Telemetry,
  defaultTelemetry,
  time,
} from './observability/index.js';
import {
  bumpVersion,
  statusForDecision,
  isDecidable,
  isInOpenQueue,
} from './concurrency/optimistic.js';
import {
  type BucketState,
  type RateLimitConfig,
  type RateLimitDecision,
  initialBucket,
  checkRateLimit,
} from './concurrency/rateLimit.js';
import {
  purgeEligibleAt,
  redactForErasure,
  isRedacted,
} from './lifecycle/retention.js';

export interface NewAppealInput {
  subreddit: string;
  actionType: Appeal['actionType'];
  targetId: string;
  authorId: string;
  authorName: string;
  reason: string;
  acknowledged: boolean;
  originalContent: string;
  originalReason: string;
  permalink?: string;
}

/** A page of results plus an opaque cursor for the next page. */
export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to fetch the next page; null when exhausted. */
  nextCursor: number | null;
}

/** How many CAS attempts before we give up and surface the conflict. */
const MAX_CAS_RETRIES = 5;

export class AppealStore {
  private readonly tel: Telemetry;

  constructor(
    private readonly redis: RedisLike,
    telemetry: Telemetry = defaultTelemetry,
  ) {
    this.tel = telemetry;
  }

  private now(): number {
    return this.tel.clock.now();
  }

  // ---- low-level Redis with typed errors -------------------------------

  private async rawGet(key: string): Promise<string | undefined> {
    try {
      return await this.redis.get(key);
    } catch (e) {
      this.tel.metrics.increment('store.error', 1, { op: 'get' });
      throw errors.storage('get', e);
    }
  }

  private async rawSet(key: string, value: string): Promise<void> {
    try {
      await this.redis.set(key, value);
    } catch (e) {
      this.tel.metrics.increment('store.error', 1, { op: 'set' });
      throw errors.storage('set', e);
    }
  }

  private async rawDel(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (e) {
      this.tel.metrics.increment('store.error', 1, { op: 'del' });
      throw errors.storage('del', e);
    }
  }

  // ---- config ----------------------------------------------------------

  async getConfig(sub: string): Promise<SubredditConfig> {
    const raw = await this.rawGet(keys.config(sub));
    if (!raw) return DEFAULT_CONFIG;
    try {
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as SubredditConfig) };
    } catch {
      this.tel.logger.log('warn', 'config corrupt; using defaults', { sub });
      return DEFAULT_CONFIG;
    }
  }

  async setConfig(sub: string, config: SubredditConfig): Promise<void> {
    await this.rawSet(keys.config(sub), JSON.stringify(config));
  }

  private rateLimitConfig(config: SubredditConfig): RateLimitConfig {
    return {
      capacity: config.rateLimitCapacity,
      refillPerHour: config.rateLimitRefillPerHour,
    };
  }

  // ---- rate limiting ---------------------------------------------------

  /**
   * Check (and consume) one rate-limit token for a user. Persists the new
   * bucket state. Returns the decision so the caller can surface a retry hint.
   */
  async consumeRateToken(
    sub: string,
    user: string,
    config: SubredditConfig,
  ): Promise<RateLimitDecision> {
    const now = this.now();
    const rlConfig = this.rateLimitConfig(config);
    const key = keys.rateLimit(sub, user);

    let state: BucketState;
    const raw = await this.rawGet(key);
    if (!raw) {
      state = initialBucket(rlConfig, now);
    } else {
      try {
        state = JSON.parse(raw) as BucketState;
      } catch {
        state = initialBucket(rlConfig, now);
      }
    }

    const decision = checkRateLimit(state, rlConfig, now);
    await this.rawSet(key, JSON.stringify(decision.next));
    if (!decision.allowed) {
      this.tel.metrics.increment('appeal.rate_limited', 1, { sub });
    }
    return decision;
  }

  // ---- reads -----------------------------------------------------------

  /**
   * Read an appeal. Returns null for genuine absence; throws DATA_CORRUPTION
   * for a present-but-unparseable record (a real bug worth surfacing loudly).
   */
  async get(sub: string, id: string): Promise<Appeal | null> {
    const raw = await this.rawGet(keys.appeal(sub, id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Appeal;
    } catch {
      this.tel.logger.log('error', 'appeal record corrupt', { sub, id });
      throw errors.corruption(keys.appeal(sub, id), 'invalid JSON');
    }
  }

  /** Like `get`, but throws APPEAL_NOT_FOUND instead of returning null. */
  async getOrThrow(sub: string, id: string): Promise<Appeal> {
    const appeal = await this.get(sub, id);
    if (!appeal) throw errors.notFound(id);
    return appeal;
  }

  async historyIds(sub: string, user: string): Promise<string[]> {
    const entries = await this.redis.zRange(keys.history(sub, user), 0, -1);
    return entries.map((e) => e.member);
  }

  async priorAppeals(
    sub: string,
    user: string,
  ): Promise<Pick<Appeal, 'id' | 'reason'>[]> {
    const ids = await this.historyIds(sub, user);
    const loaded = await Promise.all(ids.map((id) => this.safeGet(sub, id)));
    return loaded
      .filter((a): a is Appeal => a !== null)
      .map((a) => ({ id: a.id, reason: a.reason }));
  }

  /** A get that tolerates corruption (used for bulk index hydration where one
   *  bad record shouldn't fail the whole page). Corruption is logged + counted. */
  private async safeGet(sub: string, id: string): Promise<Appeal | null> {
    try {
      return await this.get(sub, id);
    } catch {
      this.tel.metrics.increment('store.skip_corrupt', 1, { sub });
      return null;
    }
  }

  /**
   * Paginated open queue, newest first. `cursor` is the score (timestamp) to
   * read strictly below; omit for the first page. Dangling/corrupt entries are
   * skipped without failing the page.
   */
  async openQueuePage(
    sub: string,
    limit = 25,
    cursor?: number,
  ): Promise<Page<AppealSummary>> {
    return time(this.tel.metrics, this.tel.clock, 'store.openQueuePage', async () => {
      const max = cursor !== undefined ? cursor - 1 : Number.MAX_SAFE_INTEGER;
      // zRange by score, descending, bounded by the cursor.
      const entries = await this.redis.zRange(
        keys.openIndex(sub),
        0,
        max,
        { by: 'score', reverse: true },
      );
      const slice = entries.slice(0, limit);
      const appeals = await Promise.all(
        slice.map((e) => this.safeGet(sub, e.member)),
      );
      const items = appeals
        .filter((a): a is Appeal => a !== null)
        .map(summarise);
      const last = slice[slice.length - 1];
      const nextCursor =
        entries.length > limit && last ? last.score : null;
      return { items, nextCursor };
    });
  }

  /** Convenience: the first page at the default size (back-compat shape). */
  async openQueue(sub: string, limit = 100): Promise<AppealSummary[]> {
    const page = await this.openQueuePage(sub, limit);
    return page.items;
  }

  /** Total count of open appeals (for dashboard badges). */
  async openCount(sub: string): Promise<number> {
    try {
      return await this.redis.zCard(keys.openIndex(sub));
    } catch (e) {
      throw errors.storage('zCard', e);
    }
  }

  // ---- writes ----------------------------------------------------------

  /**
   * Create a new appeal. Rate-limits the user, enforces the optional
   * one-open-appeal-per-action lock, computes the dedup signal, and atomically
   * (per-key) persists the record plus its indexes.
   *
   * Throws RATE_LIMITED or DUPLICATE_OPEN_APPEAL; returns the created appeal.
   */
  async create(input: NewAppealInput): Promise<Appeal> {
    return time(this.tel.metrics, this.tel.clock, 'store.create', async () => {
      const { subreddit: sub } = input;
      const config = await this.getConfig(sub);
      const now = this.now();

      const rl = await this.consumeRateToken(sub, input.authorName, config);
      if (!rl.allowed) {
        throw errors.rateLimited(input.authorName, rl.retryAfterMs);
      }

      const id = generateAppealId(now);

      // Atomically claim the per-action lock. WATCH the lock key, confirm it's
      // free (absent, or pointing at an already-resolved appeal), then set it
      // inside a MULTI/EXEC. If a concurrent create claimed it first, EXEC
      // aborts and we reject with DUPLICATE_OPEN_APPEAL. This closes the
      // read-then-write race that a plain get/set would leave open.
      if (config.oneAppealPerAction) {
        const lockKey = keys.actionLock(sub, input.targetId);
        const claimed = await this.claimActionLock(sub, lockKey, id);
        if (!claimed) throw errors.duplicateOpen(input.targetId);
      } else {
        await this.rawSet(keys.actionLock(sub, input.targetId), id);
      }

      const prior = await this.priorAppeals(sub, input.authorName);
      const dedup = computeDedup(input.reason, prior);

      const appeal: Appeal = {
        id,
        subreddit: sub,
        actionType: input.actionType,
        targetId: input.targetId,
        authorId: input.authorId,
        authorName: input.authorName,
        reason: input.reason,
        acknowledged: input.acknowledged,
        originalContent: input.originalContent,
        originalReason: input.originalReason,
        permalink: input.permalink,
        status: 'open',
        triage: {
          repeatCount: dedup.repeatCount,
          duplicateOfAppealId: dedup.duplicateOfAppealId,
        },
        decisions: [],
        version: 1,
        createdAt: now,
        updatedAt: now,
      };

      await this.persist(appeal);
      await this.redis.zAdd(keys.history(sub, appeal.authorName), {
        member: appeal.id,
        score: now,
      });
      await this.redis.zAdd(keys.openIndex(sub), {
        member: appeal.id,
        score: now,
      });

      this.tel.metrics.increment('appeal.created', 1, {
        sub,
        action: appeal.actionType,
      });
      return appeal;
    });
  }

  /**
   * Atomically claim the per-action lock for a new appeal id. Returns true if
   * claimed, false if another open appeal already holds it. Uses WATCH on the
   * lock key so a concurrent claim aborts our EXEC.
   */
  private async claimActionLock(
    sub: string,
    lockKey: string,
    newId: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      let tx;
      try {
        tx = await this.redis.watch(lockKey);
      } catch (e) {
        throw errors.storage('watch', e);
      }

      const existing = await this.rawGet(lockKey);
      if (existing && existing !== newId) {
        const holder = await this.safeGet(sub, existing);
        // The lock is free to reclaim ONLY if its holder is a resolved appeal.
        // If the holder is open, or hasn't been persisted yet (a concurrent
        // claim that has set the lock but not yet written its record), the
        // action is still locked and we must reject.
        if (!holder || holder.status !== 'resolved') {
          await tx.multi();
          await tx.exec();
          return false;
        }
      }

      await tx.multi();
      await tx.set(lockKey, newId);
      let result: unknown[] | null;
      try {
        result = await tx.exec();
      } catch (e) {
        throw errors.storage('exec', e);
      }
      if (result !== null) return true; // claimed
      this.tel.metrics.increment('store.lock_retry', 1, { sub });
    }
    // Persistent contention — treat as a duplicate to stay safe.
    return false;
  }

  /**
   * Read-modify-write with optimistic concurrency. Reads the appeal, applies
   * `mutator` to a copy, and writes back only if the stored version still
   * matches. Retries on conflict up to MAX_CAS_RETRIES, then throws
   * OPTIMISTIC_LOCK_CONFLICT. The mutator may return null to abort with no
   * write (used for idempotent no-ops). Index upkeep is the caller's job via
   * the returned appeal.
   */
  async mutate(
    sub: string,
    id: string,
    mutator: (current: Appeal) => Appeal | null,
  ): Promise<Appeal> {
    const key = keys.appeal(sub, id);
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      // WATCH the key, then read it inside the watched window.
      let tx;
      try {
        tx = await this.redis.watch(key);
      } catch (e) {
        throw errors.storage('watch', e);
      }

      const current = await this.readWatched(sub, id, tx);
      const next = mutator(structuredCloneSafe(current));
      if (next === null) {
        // No write needed. Discard the watch by execing an empty transaction.
        await tx.multi();
        await tx.exec();
        return current;
      }

      // Queue the write atomically. If the watched key changed since WATCH,
      // exec() resolves to null and we retry.
      await tx.multi();
      await tx.set(key, JSON.stringify(next));
      let result: unknown[] | null;
      try {
        result = await tx.exec();
      } catch (e) {
        throw errors.storage('exec', e);
      }

      if (result !== null) return next; // committed
      this.tel.metrics.increment('store.cas_retry', 1, { sub });
    }
    this.tel.metrics.increment('store.cas_conflict', 1, { sub });
    throw errors.lockConflict(key, -1, -1);
  }

  /** Read an appeal inside a watched transaction window (throws if absent). */
  private async readWatched(
    sub: string,
    id: string,
    tx: { exec(): Promise<unknown[] | null>; multi(): Promise<void> },
  ): Promise<Appeal> {
    const appeal = await this.get(sub, id);
    if (!appeal) {
      // Nothing to mutate — release the watch and report not-found.
      await tx.multi();
      await tx.exec();
      throw errors.notFound(id);
    }
    return appeal;
  }

  /** Mark an appeal as opened for review (idempotent, version-checked). */
  async markInReview(sub: string, id: string): Promise<Appeal> {
    const now = this.now();
    return this.mutate(sub, id, (appeal) => {
      // Only an open appeal moves to in_review; any other status is an
      // idempotent no-op. (open -> in_review is always a legal transition.)
      if (appeal.status !== 'open') return null;
      return {
        ...appeal,
        status: 'in_review',
        version: bumpVersion(appeal.version),
        updatedAt: now,
      };
    });
  }

  /**
   * Record a moderator decision. Appends to the audit trail, enforces the legal
   * state transition, updates indexes, and (on resolution) schedules the appeal
   * for retention purge and releases the per-action lock.
   *
   * Throws INVALID_STATE_TRANSITION for a decision on a resolved appeal.
   */
  async decide(
    sub: string,
    id: string,
    decision: AppealDecision,
    record: Omit<DecisionRecord, 'decision' | 'decidedAt'>,
  ): Promise<Appeal> {
    const now = this.now();
    const targetStatus = statusForDecision(decision);

    const updated = await this.mutate(sub, id, (appeal) => {
      // A resolved appeal is terminal: it accepts no further decisions. For any
      // non-terminal status, the target (resolved or awaiting_user) is always a
      // legal transition, so this single guard is sufficient.
      if (!isDecidable(appeal.status)) {
        throw errors.invalidTransition(appeal.status, targetStatus);
      }
      const decisions = [
        ...appeal.decisions,
        { ...record, decision, decidedAt: now },
      ];
      return {
        ...appeal,
        decisions,
        status: targetStatus,
        version: bumpVersion(appeal.version),
        updatedAt: now,
      };
    });

    // Index upkeep based on the resulting status.
    if (!isInOpenQueue(updated.status)) {
      await this.redis.zRem(keys.openIndex(sub), [id]);
      await this.rawDel(keys.actionLock(sub, updated.targetId));
      // Schedule for retention purge.
      const config = await this.getConfig(sub);
      const at = purgeEligibleAt(updated, config.retentionDays);
      if (at !== null) {
        await this.redis.zAdd(keys.purgeIndex(sub), { member: id, score: at });
      }
    }

    this.tel.metrics.increment('appeal.decided', 1, { sub, decision });
    return updated;
  }

  /** Attach (or overwrite) the optional AI triage label (version-checked). */
  async setAiLabel(
    sub: string,
    id: string,
    model: NonNullable<Appeal['triage']['model']>,
  ): Promise<void> {
    const now = this.now();
    await this.mutate(sub, id, (appeal) => ({
      ...appeal,
      triage: { ...appeal.triage, model },
      version: bumpVersion(appeal.version),
      updatedAt: now,
    }));
  }

  // ---- lifecycle: erasure & retention ----------------------------------

  /**
   * Right-to-erasure: redact a user's free text while keeping the structural
   * tombstone. Idempotent — redacting an already-redacted appeal is a no-op.
   */
  async redactAppeal(sub: string, id: string): Promise<Appeal> {
    const now = this.now();
    const result = await this.mutate(sub, id, (appeal) => {
      if (isRedacted(appeal)) return null; // already done
      return redactForErasure(appeal, now);
    });
    this.tel.metrics.increment('appeal.redacted', 1, { sub });
    return result;
  }

  /**
   * Purge appeals whose retention window has elapsed. Returns the ids purged.
   * Walks the purge index for entries scored at or before `now`.
   */
  async purgeExpired(sub: string, limit = 100): Promise<string[]> {
    const now = this.now();
    const due = await this.redis.zRange(keys.purgeIndex(sub), 0, now, {
      by: 'score',
    });
    const ids = due.slice(0, limit).map((e) => e.member);
    for (const id of ids) {
      const appeal = await this.safeGet(sub, id);
      await this.rawDel(keys.appeal(sub, id));
      await this.redis.zRem(keys.purgeIndex(sub), [id]);
      if (appeal) {
        await this.redis.zRem(keys.history(sub, appeal.authorName), [id]);
      }
    }
    if (ids.length > 0) {
      this.tel.metrics.increment('appeal.purged', ids.length, { sub });
    }
    return ids;
  }

  // ---- internals -------------------------------------------------------

  private async persist(appeal: Appeal): Promise<void> {
    await this.rawSet(
      keys.appeal(appeal.subreddit, appeal.id),
      JSON.stringify(appeal),
    );
  }
}

/** Reduce a full appeal to its dashboard-list summary. */
export function summarise(a: Appeal): AppealSummary {
  return {
    id: a.id,
    authorName: a.authorName,
    actionType: a.actionType,
    status: a.status,
    repeatCount: a.triage.repeatCount,
    createdAt: a.createdAt,
  };
}

/** Deep clone that works without structuredClone (Node < 17 / some runtimes). */
function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
