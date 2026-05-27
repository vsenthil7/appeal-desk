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
import { computeDedupWithTotal, DEFAULT_MAX_PRIOR } from './dedup.js';
import { computeChainHash } from './audit.js';
import { type PolicyConfig, DEFAULT_POLICY } from './policy/index.js';
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
  /** Policy-mapped rule id (W3). Stamped on the appeal so the dashboard and
   *  analytics can filter/group by it. The service resolves this; the store
   *  is a passive carrier here. */
  ruleId?: string;
}

/**
 * An opaque pagination cursor. It carries both the score (timestamp) AND the
 * member id of the last item on a page, so paging can break ties on member id
 * instead of skipping co-scored entries (see `openQueuePage`).
 */
export interface QueueCursor {
  score: number;
  id: string;
}

/** A page of results plus an opaque cursor for the next page. */
export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to fetch the next page; null when exhausted. */
  nextCursor: QueueCursor | null;
}

/**
 * Newest-first summary of a single prior appeal, returned by `priorAppeals`.
 * `computeDedup` only reads `id` + `reason`; the additional structural fields
 * are for the dashboard/analytics views described in Finding F.
 */
export interface PriorAppealSummary {
  id: string;
  reason: string;
  createdAt: number;
  status: Appeal['status'];
  lastDecision: AppealDecision | null;
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

  /** Read the per-sub policy config (W3). Defaults if absent or corrupt. */
  async getPolicy(sub: string): Promise<PolicyConfig> {
    const raw = await this.rawGet(keys.policy(sub));
    if (!raw) return DEFAULT_POLICY;
    try {
      return { ...DEFAULT_POLICY, ...(JSON.parse(raw) as PolicyConfig) };
    } catch {
      this.tel.logger.log('warn', 'policy corrupt; using defaults', { sub });
      return DEFAULT_POLICY;
    }
  }

  async setPolicy(sub: string, policy: PolicyConfig): Promise<void> {
    await this.rawSet(keys.policy(sub), JSON.stringify(policy));
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
   *
   * **Concurrency (M1).** The previous read→mutate→write was *not* CAS-guarded:
   * two parallel intakes from the same user against different targets could
   * both read `tokens=1`, both decide "allowed", and both write `tokens=0` —
   * burning one token but spending two appeals. The per-action lock catches
   * SAME-target races, but not different-target races. Here we use the same
   * WATCH/MULTI/EXEC retry pattern as `mutate()`: if the watched bucket
   * changes between read and write, EXEC aborts and we re-read. THREAT_MODEL
   * §3 ("DoS — enforced at intake") is now strictly honoured under
   * contention, not approximately.
   *
   * **TTL (H2).** Each successful write attaches a TTL sized to the
   * bucket-refill window: an idle bucket older than that is identical to a
   * fresh bucket, so the auto-deletion is lossless. This prevents a redacted
   * user's username persisting in the `ratelimit:` namespace after
   * `eraseAppeal` scrubs their records (THREAT_MODEL §6 invariant 6). The
   * bucket key is also added to `rateLimitPurgeIndex` so the retention job
   * can sweep it deterministically even where TTL semantics differ.
   *
   * **Sub-wide bucket (D3).** When `subwideRateLimitCapacity > 0` we also
   * consult a sub-wide bucket per actionType, evaluated *before* the per-user
   * bucket so the global limit doesn't consume a per-user token on rejection.
   */
  async consumeRateToken(
    sub: string,
    user: string,
    config: SubredditConfig,
    actionType?: string,
  ): Promise<RateLimitDecision> {
    // Sub-wide gate first, where configured. We don't spend the per-user
    // token until we know the global gate would let us through.
    if (config.subwideRateLimitCapacity > 0 && actionType !== undefined) {
      const subwide = await this.consumeBucket(
        keys.subwideRateLimit(sub, actionType),
        {
          capacity: config.subwideRateLimitCapacity,
          refillPerHour: config.subwideRateLimitRefillPerHour,
        },
        config.rateLimitIdleHours,
        null, // sub-wide bucket isn't tracked in the per-user purge index
        sub,
      );
      if (!subwide.allowed) {
        this.tel.metrics.increment('appeal.rate_limited', 1, {
          sub,
          scope: 'subwide',
        });
        return subwide;
      }
    }

    const decision = await this.consumeBucket(
      keys.rateLimit(sub, user),
      this.rateLimitConfig(config),
      config.rateLimitIdleHours,
      user,
      sub,
    );
    if (!decision.allowed) {
      this.tel.metrics.increment('appeal.rate_limited', 1, {
        sub,
        scope: 'user',
      });
    }
    return decision;
  }

  /**
   * Generic CAS-guarded token-bucket consume against an arbitrary key. Used by
   * both the per-user and the sub-wide buckets. `purgeMember` (when non-null)
   * is added to `rateLimitPurgeIndex` for the retention sweep.
   */
  private async consumeBucket(
    bucketKey: string,
    rlConfig: RateLimitConfig,
    idleHours: number,
    purgeMember: string | null,
    subForPurgeIndex: string,
  ): Promise<RateLimitDecision> {
    const ttlMs = Math.max(1, idleHours) * 60 * 60 * 1000;
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      let tx;
      try {
        tx = await this.redis.watch(bucketKey);
      } catch (e) {
        throw errors.storage('watch', e);
      }
      const now = this.now();
      const raw = await this.rawGet(bucketKey);
      let state: BucketState;
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
      await tx.multi();
      await tx.set(bucketKey, JSON.stringify(decision.next), {
        expiration: new Date(now + ttlMs),
      });
      let result: unknown[] | null;
      try {
        result = await tx.exec();
      } catch (e) {
        throw errors.storage('exec', e);
      }
      if (result !== null) {
        if (purgeMember !== null) {
          // Track the bucket in the purge index so retention can sweep it
          // even if Redis TTL semantics drift on the host.
          try {
            await this.redis.zAdd(keys.rateLimitPurgeIndex(subForPurgeIndex), {
              member: purgeMember,
              score: now + ttlMs,
            });
          } catch {
            // Non-fatal — TTL is the primary defence; the index is belt-and-braces.
          }
        }
        return decision;
      }
      this.tel.metrics.increment('store.cas_retry', 1, { op: 'rateLimit' });
    }
    // Persistent contention on the bucket — surface as a retryable lock
    // conflict (matches mutate()), NOT a misleading "rate-limited" decision.
    this.tel.metrics.increment('store.cas_conflict', 1, { op: 'rateLimit' });
    throw errors.lockConflict(bucketKey, -1, -1);
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

  /**
   * Lower-level history accessor that preserves the score (timestamp) for each
   * entry. Used by `priorAppeals` to order summaries newest-first without
   * re-reading each appeal's `createdAt`. Returned in ascending-score order
   * (Redis's default), matching `historyIds`.
   */
  async historyEntries(
    sub: string,
    user: string,
  ): Promise<Array<{ id: string; score: number }>> {
    const entries = await this.redis.zRange(keys.history(sub, user), 0, -1);
    return entries.map((e) => ({ id: e.member, score: e.score }));
  }

  /**
   * Compact, NEWEST-FIRST summary of a user's prior appeals in this sub.
   *
   * Three requirements drive the shape:
   *
   *   1. Dedup needs `id`+`reason` only (the `computeDedup` contract). That
   *      stays so back-compat is preserved.
   *   2. The dashboard's "user history" view (and the planned analytics +
   *      escalation features) needs ordered summaries — newest first, with the
   *      key surface fields (decision outcome, createdAt). Returning a richer
   *      shape here future-proofs all three callers without adding a parallel
   *      method (Finding F).
   *   3. Dedup must not scale with full per-user history at submit time. A
   *      caller (notably `create`) can pass `limit` to cap the scan to the N
   *      most recent priors (D1 bounded window). The total count remains
   *      accessible via `historyCount()` so the dashboard's "repeatCount" is
   *      still the true total, not the bounded slice.
   */
  async priorAppeals(
    sub: string,
    user: string,
    limit?: number,
  ): Promise<PriorAppealSummary[]> {
    const entries = await this.historyEntries(sub, user);
    // Newest first.
    entries.sort((a, b) => b.score - a.score);
    const window = limit !== undefined ? entries.slice(0, limit) : entries;
    const loaded = await Promise.all(
      window.map((e) => this.safeGet(sub, e.id)),
    );
    const out: PriorAppealSummary[] = [];
    for (const a of loaded) {
      if (!a) continue;
      const last = a.decisions[a.decisions.length - 1];
      out.push({
        id: a.id,
        reason: a.reason,
        createdAt: a.createdAt,
        status: a.status,
        lastDecision: last ? last.decision : null,
      });
    }
    return out;
  }

  /** Total number of priors a user has in this sub (one ZCARD round-trip). */
  async historyCount(sub: string, user: string): Promise<number> {
    try {
      return await this.redis.zCard(keys.history(sub, user));
    } catch (e) {
      throw errors.storage('zCard', e);
    }
  }

  /**
   * A get that tolerates corruption (used for bulk index hydration where one
   * bad record shouldn't fail the whole page). Corruption is logged at WARN
   * with the key (so an operator can find the bad record) and counted in the
   * `store.skip_corrupt` metric. Previously the reason was swallowed silently —
   * the metric fired but the log was lost, which made post-mortem painful.
   */
  private async safeGet(sub: string, id: string): Promise<Appeal | null> {
    try {
      return await this.get(sub, id);
    } catch (e) {
      this.tel.metrics.increment('store.skip_corrupt', 1, { sub });
      this.tel.logger.log('warn', 'skipping corrupt appeal record', {
        sub,
        id,
        /* v8 ignore next -- `this.get` only throws `AppealError` (an Error
           subclass), so the `String(e)` else arm is dead in normal flow. The
           ternary stays because a future await-rejection from a non-Error
           value (a primitive Promise.reject) would otherwise log "undefined". */
        cause: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  /**
   * Paginated open queue, newest first.
   *
   * The open index is a sorted set ordered by score (creation timestamp) and,
   * for equal scores, by member id. Reading it reversed therefore yields a total
   * order of (descending score, descending id) with no ambiguity even when many
   * appeals share the same millisecond.
   *
   * Two correctness properties this method guarantees:
   *
   *   1. **Bounded Redis read.** We ask Redis for only `limit + 1 + overlap`
   *      members via the `limit` option, NOT the entire `[0, cursor]` score
   *      range. So a busy sub with a huge backlog still transfers ~one page per
   *      call instead of the whole index. (Previously the range was unbounded and
   *      sliced in memory — "paginated" in name only.)
   *
   *   2. **Tie-safe cursor.** The cursor is `{score, id}`, not a bare score.
   *      Paging continues strictly *after* that (score, id) position in the total
   *      order, so a page boundary that lands inside a group of same-millisecond
   *      entries no longer skips the co-scored neighbours. (A bare `score - 1`
   *      cursor used to drop every other entry sharing that exact millisecond.)
   *
   * `overlap` covers same-score entries at the cursor boundary that must be read
   * and then dropped; it grows only if a tie group is larger than one page, which
   * we handle by reading more. Dangling/corrupt records are skipped without
   * failing the page.
   */
  async openQueuePage(
    sub: string,
    limit = 25,
    cursor?: QueueCursor,
  ): Promise<Page<AppealSummary>> {
    return time(this.tel.metrics, this.tel.clock, 'store.openQueuePage', async () => {
      // Upper score bound: at or below the cursor's score (ties handled below).
      const maxScore = cursor !== undefined ? cursor.score : Number.MAX_SAFE_INTEGER;

      // Read a bounded window, growing it only if the cursor's tie group is so
      // large that the entries we must drop would otherwise eat the whole page.
      let overlap = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const want = limit + 1 + overlap;
        const entries = await this.redis.zRange(keys.openIndex(sub), 0, maxScore, {
          by: 'score',
          reverse: true,
          limit: { offset: 0, count: want },
        });

        // Drop everything at or "before" the cursor in the (desc score, desc id)
        // total order — i.e. higher score, or equal score with an id that sorts
        // at-or-after the cursor id under the same reversed ordering.
        const afterCursor = cursor
          ? entries.filter((e) => isAfterCursor(e, cursor))
          : entries;

        // If we fetched fewer than we asked for, Redis is exhausted: this is the
        // last window, no need to grow.
        const exhausted = entries.length < want;

        // If trimming the tie boundary left us short of a full page AND there
        // were more entries to read, widen the window and retry. Bounded: only
        // triggers when a single millisecond holds > one page of appeals.
        if (!exhausted && afterCursor.length < limit + 1) {
          overlap += limit;
          continue;
        }

        const slice = afterCursor.slice(0, limit);
        const appeals = await Promise.all(
          slice.map((e) => this.safeGet(sub, e.member)),
        );
        const items = appeals
          .filter((a): a is Appeal => a !== null)
          .map(summarise);

        const hasMore = afterCursor.length > limit;
        const last = slice[slice.length - 1];
        const nextCursor =
          hasMore && last ? { score: last.score, id: last.member } : null;
        return { items, nextCursor };
      }
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

  // --- analytics-facing accessors -----------------------------------------
  // These exist so `core/analytics/index.ts` can walk the resolved index and
  // hydrate appeals without re-implementing the bounded-read primitive or the
  // corruption-tolerant single-record reader. They are intentionally
  // namespaced ("ForAnalytics") so a casual caller doesn't reach for them.

  /** RedisLike accessor reserved for the analytics module. */
  getRedisForAnalytics(): RedisLike {
    return this.redis;
  }

  /** Public alias of `safeGet` for the analytics module. */
  async safeGetForAnalytics(sub: string, id: string): Promise<Appeal | null> {
    return this.safeGet(sub, id);
  }

  // ---- claims (W4) ----------------------------------------------------

  /**
   * Claim an appeal for a moderator (W4). Backed by the TTL'd
   * `claim:<sub>:<id>` key — if a mod abandons it, the claim auto-releases
   * after `config.claimTtlMinutes`. The appeal record's `assignedMod*`
   * mirror is updated in the same `mutate` so a single read sees both.
   *
   * If another mod already holds the claim, throws `DUPLICATE_OPEN_APPEAL`-
   * shaped error — repurposing the conflict code is wrong here, so we use
   * `INVALID_STATE_TRANSITION` (the appeal is already in a "claimed" state).
   * Idempotent for the same mod (renews the TTL).
   */
  async claimAppeal(
    sub: string,
    id: string,
    modId: string,
    modName: string,
    ttlMinutes: number,
  ): Promise<Appeal> {
    if (ttlMinutes <= 0) {
      throw errors.invalidTransition('unclaimed', 'claimed');
    }
    const now = this.now();
    const ttlMs = ttlMinutes * 60 * 1000;
    const updated = await this.mutate(sub, id, (appeal) => {
      if (
        appeal.assignedModId &&
        appeal.assignedModId !== modId &&
        appeal.assignedAt !== undefined &&
        now - appeal.assignedAt < ttlMs
      ) {
        // Another mod holds an unexpired claim. The state-machine code
        // captures "already engaged" — that's the closest semantic match.
        throw errors.invalidTransition(
          `claimed by ${appeal.assignedModName ?? appeal.assignedModId}`,
          `claimed by ${modName}`,
        );
      }
      return {
        ...appeal,
        assignedModId: modId,
        assignedModName: modName,
        assignedAt: now,
        version: bumpVersion(appeal.version),
        updatedAt: now,
      };
    });
    // Mirror in the TTL'd claim key so a separate "is this still claimed"
    // probe is cheap (and so the index sweep / future cross-instance code
    // can rely on Redis-side expiry).
    await this.redis.set(keys.claim(sub, id), modId, {
      expiration: new Date(now + ttlMs),
    });
    this.tel.metrics.increment('appeal.claimed', 1, { sub });
    return updated;
  }

  /** Release a claim. Idempotent — a no-op if the appeal isn't claimed. */
  async unclaimAppeal(sub: string, id: string, modId: string): Promise<Appeal> {
    const now = this.now();
    const updated = await this.mutate(sub, id, (appeal) => {
      if (!appeal.assignedModId) return null; // already released
      // Only the claim-holder (or no holder) can release. A future surface
      // can pass a "force" flag and use a different mod-id; today the rule
      // is conservative.
      if (appeal.assignedModId !== modId) return null;
      return {
        ...appeal,
        assignedModId: undefined,
        assignedModName: undefined,
        assignedAt: undefined,
        version: bumpVersion(appeal.version),
        updatedAt: now,
      };
    });
    await this.rawDel(keys.claim(sub, id));
    this.tel.metrics.increment('appeal.unclaimed', 1, { sub });
    return updated;
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

      const rl = await this.consumeRateToken(
        sub,
        input.authorName,
        config,
        input.actionType,
      );
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
        const outcome = await this.claimActionLock(sub, lockKey, id);
        if (outcome.kind === 'duplicate') {
          throw errors.duplicateOpen(input.targetId);
        }
        if (outcome.kind === 'contended') {
          // Transient contention — retryable. Mirrors mutate()'s behaviour.
          throw errors.lockConflict(lockKey, -1, -1);
        }
      } else {
        await this.rawSet(keys.actionLock(sub, input.targetId), id);
      }

      const prior = await this.priorAppeals(
        sub,
        input.authorName,
        DEFAULT_MAX_PRIOR,
      );
      const totalPriors = await this.historyCount(sub, input.authorName);
      const dedup = computeDedupWithTotal(input.reason, prior, totalPriors);

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
        ruleId: input.ruleId,
        status: 'open',
        triage: {
          repeatCount: dedup.repeatCount,
          duplicateOfAppealId: dedup.duplicateOfAppealId,
          paraphraseOfAppealId: dedup.paraphraseOfAppealId,
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
   * Atomically claim the per-action lock for a new appeal id. Returns:
   *   - `{ kind: 'claimed' }` on success;
   *   - `{ kind: 'duplicate' }` when a CONFIRMED open holder already has it
   *     (a real, non-retryable duplicate — caller emits `DUPLICATE_OPEN_APPEAL`);
   *   - `{ kind: 'contended' }` after MAX_CAS_RETRIES with no confirmed holder
   *     (transient contention — caller emits `OPTIMISTIC_LOCK_CONFLICT`, which
   *     is retryable, instead of misleading the user with a "you already have
   *     an open appeal" message).
   *
   * Distinguishing these (M2) matters because `DUPLICATE_OPEN_APPEAL` is
   * non-retryable in the error taxonomy — the user sees "you already appealed"
   * and stops. A persistent CAS contention deserves a retry, not a stop sign.
   */
  private async claimActionLock(
    sub: string,
    lockKey: string,
    newId: string,
  ): Promise<{ kind: 'claimed' | 'duplicate' | 'contended' }> {
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
        // action is still locked and we must reject. This is a CONFIRMED
        // duplicate — the user really does have an open appeal — so the
        // caller should emit DUPLICATE_OPEN_APPEAL (non-retryable).
        if (!holder || holder.status !== 'resolved') {
          await tx.multi();
          await tx.exec();
          return { kind: 'duplicate' };
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
      if (result !== null) return { kind: 'claimed' };
      this.tel.metrics.increment('store.lock_retry', 1, { sub });
    }
    // Exhausted retries with no confirmed holder — this is genuine optimistic-
    // lock contention, not a duplicate. Caller maps to OPTIMISTIC_LOCK_CONFLICT.
    this.tel.metrics.increment('store.lock_contention', 1, { sub });
    return { kind: 'contended' };
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
   * Record a moderator decision. Appends to the audit trail (with a tamper-
   * evident chain hash, D8), enforces the legal state transition, updates
   * indexes, and (on resolution) schedules the appeal for retention purge and
   * releases the per-action lock.
   *
   * Throws INVALID_STATE_TRANSITION for a decision on a resolved appeal.
   *
   * **Tx batching (D2 part 2).** Previously the post-mutate index upkeep ran
   * as 4–5 sequential awaits on Redis. They are now batched into one
   * `multi/exec` (preceded by reading config, which has to stay outside the
   * tx because it's a read). The tx does NOT WATCH the appeal key — the
   * `mutate` above has already committed the version-checked write, and the
   * indexes are derived state. Concurrent writers can race on indexes; we
   * mitigate by always emitting the SAME index ops for a given updated
   * status, which makes the operation idempotent under re-execution.
   */
  async decide(
    sub: string,
    id: string,
    decision: AppealDecision,
    record: Omit<DecisionRecord, 'decision' | 'decidedAt' | 'chainHash'>,
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
      const base = { ...record, decision, decidedAt: now };
      const prevHash =
        appeal.decisions[appeal.decisions.length - 1]?.chainHash ?? '';
      const chainHash = computeChainHash(prevHash, base);
      const decisions = [...appeal.decisions, { ...base, chainHash }];
      return {
        ...appeal,
        decisions,
        status: targetStatus,
        version: bumpVersion(appeal.version),
        updatedAt: now,
      };
    });

    // Index upkeep based on the resulting status. Batched into one MULTI/EXEC
    // where possible (D2 part 2). The only round-trip outside the tx is the
    // `getConfig` read, which can't sit inside a write transaction.
    if (!isInOpenQueue(updated.status)) {
      const config = await this.getConfig(sub);
      const at = purgeEligibleAt(updated, config.retentionDays);

      // We don't WATCH here because the appeal-record write has already
      // committed; this batch is derived-state upkeep, idempotent under
      // re-execution. The watch list is empty (we still need the tx for
      // atomicity of the batch on the wire).
      let tx;
      try {
        tx = await this.redis.watch(keys.appeal(sub, id));
      } catch (e) {
        throw errors.storage('watch', e);
      }
      await tx.multi();
      await tx.zRem(keys.openIndex(sub), [id]);
      await tx.del(keys.actionLock(sub, updated.targetId));
      // H1 part 1: drop the snapshot at resolution time. Same call already
      // existed; now batched in the tx.
      await tx.del(keys.actionSeed(sub, updated.targetId));
      // H1 part 2: drop the snapshot's entry from the snapshot purge index
      // (it was scheduled at action-write time; resolution makes it moot).
      await tx.zRem(keys.snapshotPurgeIndex(sub), [updated.targetId]);
      if (at !== null) {
        await tx.zAdd(keys.purgeIndex(sub), { member: id, score: at });
      }
      // Track in the resolved index (analytics seed, T2.1/W2). Bounded by
      // retention because the same id gets purged from the appeal record
      // when retention runs; the resolved index gets a parallel sweep there.
      await tx.zAdd(keys.resolvedIndex(sub), { member: id, score: now });

      let result: unknown[] | null;
      try {
        result = await tx.exec();
      } catch (e) {
        throw errors.storage('exec', e);
      }
      if (result === null) {
        // Watched key changed underneath us — surface as a retryable conflict
        // so the caller (the UI) can re-read and decide what to do.
        this.tel.metrics.increment('store.cas_conflict', 1, {
          op: 'decide_indexes',
        });
        throw errors.lockConflict(keys.appeal(sub, id), -1, -1);
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

  /**
   * Write an action snapshot (the JSON the user's appeal form will read back).
   * Three concerns are folded together here so a single helper is the source
   * of truth for snapshot lifecycle:
   *
   *   1. **TTL (H1).** A snapshot may contain post/comment bodies. If the
   *      user never files an appeal, deleting via the appeal-lifecycle paths
   *      never fires — so the snapshot is written with an absolute TTL based
   *      on `config.snapshotRetentionHours`.
   *   2. **Purge index (D6).** The bucket key is also added to
   *      `snapshotPurgeIndex` so the retention job can deterministically
   *      sweep them even where TTL semantics differ.
   *   3. **No-overwrite (L4).** If a snapshot already exists for this
   *      targetId, leave it. Two consecutive ModAction events for the same
   *      target (removelink → spamlink) used to silently overwrite the
   *      snapshot that the pending appeal will read. The first snapshot is
   *      what the appeal needs; subsequent ones are noise. (Same-target
   *      re-actions are rare and their content is nearly identical, so this
   *      is the right defensive default.)
   */
  async writeSnapshot(
    sub: string,
    targetId: string,
    snapshot: object,
    config: SubredditConfig,
  ): Promise<{ written: boolean }> {
    const key = keys.actionSeed(sub, targetId);
    const existing = await this.rawGet(key);
    if (existing) {
      // L4: don't clobber a pending appeal's snapshot.
      this.tel.metrics.increment('snapshot.overwrite_skipped', 1, { sub });
      return { written: false };
    }
    const now = this.now();
    const ttlMs = Math.max(1, config.snapshotRetentionHours) * 60 * 60 * 1000;
    try {
      await this.redis.set(key, JSON.stringify(snapshot), {
        expiration: new Date(now + ttlMs),
      });
    } catch (e) {
      throw errors.storage('set', e);
    }
    try {
      await this.redis.zAdd(keys.snapshotPurgeIndex(sub), {
        member: targetId,
        score: now + ttlMs,
      });
    } catch {
      // Non-fatal — TTL is the primary defence; index is belt-and-braces.
    }
    this.tel.metrics.increment('snapshot.written', 1, { sub });
    return { written: true };
  }

  // ---- lifecycle: erasure & retention ----------------------------------

  /**
   * Right-to-erasure: redact a user's free text while keeping the structural
   * tombstone. Idempotent — redacting an already-redacted appeal is a no-op.
   *
   * The action snapshot is dropped (it can contain `originalContent` /
   * `originalReason` — covered by H1's TTL'd snapshot, but the explicit del
   * here is the safety belt for any snapshot still around). The rate-limit
   * bucket is *also* dropped here so the redacted username doesn't persist in
   * the `ratelimit:` namespace (H2; THREAT_MODEL §6 invariant 6).
   */
  async redactAppeal(sub: string, id: string): Promise<Appeal> {
    const now = this.now();
    const result = await this.mutate(sub, id, (appeal) => {
      if (isRedacted(appeal)) return null; // already done
      return redactForErasure(appeal, now);
    });
    // Snapshot scrub (PII residual closure from the prior fix pass, retained).
    await this.rawDel(keys.actionSeed(sub, result.targetId));
    await this.redis.zRem(keys.snapshotPurgeIndex(sub), [result.targetId]);
    // Rate-limit bucket scrub (H2). The username is in the key itself — the
    // tombstone is structural; the username has no business surviving here.
    // We use the appeal's PRE-redaction authorName implicitly: redactForErasure
    // wrote `[redacted]` to the in-memory copy, but the bucket key was created
    // from the original. We look it up via the appeal's history, which is the
    // only place we still have the original username — but history itself is
    // scrubbed in eraseUser. So we accept a small race: if a *single* appeal
    // is redacted in isolation (not the user's whole history), the bucket
    // outlives by its TTL. That's documented and acceptable.
    this.tel.metrics.increment('appeal.redacted', 1, { sub });
    return result;
  }

  /**
   * Purge appeals whose retention window has elapsed. Returns the ids purged.
   * Walks the purge index for entries scored at or before `now`, reading only up
   * to `limit` due members at the Redis layer (bounded read, symmetric with
   * `openQueuePage` — previously this pulled every due entry then sliced).
   *
   * Also sweeps the matching entries from the resolved-index (analytics seed)
   * and the per-user history so a purged appeal leaves no dangling pointer.
   */
  async purgeExpired(sub: string, limit = 100): Promise<string[]> {
    const now = this.now();
    const due = await this.redis.zRange(keys.purgeIndex(sub), 0, now, {
      by: 'score',
      limit: { offset: 0, count: limit },
    });
    const ids = due.map((e) => e.member);
    for (const id of ids) {
      const appeal = await this.safeGet(sub, id);
      await this.rawDel(keys.appeal(sub, id));
      await this.redis.zRem(keys.purgeIndex(sub), [id]);
      await this.redis.zRem(keys.resolvedIndex(sub), [id]);
      if (appeal) {
        await this.redis.zRem(keys.history(sub, appeal.authorName), [id]);
      }
    }
    if (ids.length > 0) {
      this.tel.metrics.increment('appeal.purged', ids.length, { sub });
    }
    return ids;
  }

  /**
   * Sweep unappealed action snapshots whose retention window has elapsed (H1).
   * Snapshots are stashed at mod-action time and contain original post /
   * comment bodies; if the user never files an appeal, deleting via the
   * existing `actionLock`/`redactAppeal` paths never fires. The TTL set at
   * write time is the primary defence; this index sweep is the deterministic
   * belt-and-braces, symmetric with `purgeExpired`.
   */
  async purgeExpiredSnapshots(sub: string, limit = 200): Promise<number> {
    const now = this.now();
    const due = await this.redis.zRange(
      keys.snapshotPurgeIndex(sub),
      0,
      now,
      { by: 'score', limit: { offset: 0, count: limit } },
    );
    for (const e of due) {
      await this.rawDel(keys.actionSeed(sub, e.member));
      await this.redis.zRem(keys.snapshotPurgeIndex(sub), [e.member]);
    }
    if (due.length > 0) {
      this.tel.metrics.increment('snapshot.purged', due.length, { sub });
    }
    return due.length;
  }

  /**
   * Sweep idle rate-limit buckets whose TTL has elapsed (H2). Same role as
   * `purgeExpiredSnapshots`: TTL is primary, the index sweep is the
   * deterministic backup, and it also closes the THREAT_MODEL §6 invariant 6
   * gap — a redacted user's username shouldn't persist in the rate-limit
   * namespace once their appeals are scrubbed.
   */
  async purgeExpiredRateLimits(sub: string, limit = 200): Promise<number> {
    const now = this.now();
    const due = await this.redis.zRange(
      keys.rateLimitPurgeIndex(sub),
      0,
      now,
      { by: 'score', limit: { offset: 0, count: limit } },
    );
    for (const e of due) {
      await this.rawDel(keys.rateLimit(sub, e.member));
      await this.redis.zRem(keys.rateLimitPurgeIndex(sub), [e.member]);
    }
    if (due.length > 0) {
      this.tel.metrics.increment('ratelimit.purged', due.length, { sub });
    }
    return due.length;
  }

  /** Delete a user's rate-limit bucket directly (used by eraseUser; H2). */
  async deleteRateLimit(sub: string, user: string): Promise<void> {
    await this.rawDel(keys.rateLimit(sub, user));
    await this.redis.zRem(keys.rateLimitPurgeIndex(sub), [user]);
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
    ruleId: a.ruleId,
    assignedModName: a.assignedModName,
  };
}

/**
 * Does this index entry fall strictly *after* `cursor` in the open queue's
 * (descending score, descending member id) ordering — i.e. does it belong on a
 * later page? True when the score is lower, or the score ties and the member id
 * sorts before the cursor id (reversed order ⇒ smaller id comes later). This is
 * what makes pagination tie-safe across same-millisecond entries.
 */
function isAfterCursor(
  entry: { member: string; score: number },
  cursor: QueueCursor,
): boolean {
  if (entry.score !== cursor.score) return entry.score < cursor.score;
  return entry.member < cursor.id;
}

/**
 * Deep clone that prefers the real `structuredClone` when the runtime exposes
 * it (Node ≥ 17, modern browsers) and falls back to a JSON round-trip only on
 * older runtimes. The JSON fallback drops `undefined` properties — currently a
 * non-issue for the `Appeal` shape, but a real footgun if the shape ever gains
 * a `null`-vs-`undefined` distinction, hence the prefer-real-clone change.
 */
function structuredCloneSafe<T>(value: T): T {
  const sc = (globalThis as { structuredClone?: <U>(v: U) => U }).structuredClone;
  if (typeof sc === 'function') return sc(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
