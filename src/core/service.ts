/**
 * AppealService — the orchestration layer the UI and triggers call into.
 *
 * Coordinates the store, the optional AI provider, reply rendering, and the
 * Reddit gateway. Adds (post-Pass-4):
 *
 *   - **Correlation ids (Finding D).** Each entry point generates a short id
 *     and threads it through a child Logger so every log line emitted while
 *     handling that request can be joined by `correlationId`. The Logger.child
 *     API was already there; nothing called it. Now it's the spine for any
 *     join-on-request analytics or escalation work.
 *   - **Policy gate (W3).** `submitAppeal` checks `evaluateEligibility` against
 *     the per-sub PolicyConfig BEFORE `store.create`. Refusals emit the new
 *     `APPEAL_INELIGIBLE` typed error with a human-readable reason. Subs that
 *     haven't configured policy default to the no-op `DEFAULT_POLICY` and see
 *     identical behaviour to today.
 *   - **Erasure surface (W1).** `eraseUserByMod` accepts an acting-mod id /
 *     name and writes an entry to the erasure audit log
 *     (`index:<sub>:erasure_log`). The acting mod is NOT stored in the
 *     redacted appeal (that would defeat the point); it lives in a parallel
 *     sorted set so a transparency report can reconstruct who erased what.
 *     Also extends `eraseUser` to drop the user's rate-limit bucket (H2 +
 *     THREAT_MODEL §6 invariant 6).
 *   - **Bulk decisions (T2.2).** `decideBatch` lets a mod apply the same
 *     decision to N near-duplicate appeals in one call. Each per-appeal
 *     transition still goes through `store.decide` (so the state machine,
 *     version-checked CAS, audit chain, and reply delivery all fire per item).
 *     Reports a batch result so the UI can surface per-item failures without
 *     aborting the rest.
 *   - **Claim / unclaim (W4).** Pass-throughs to `store.claimAppeal` /
 *     `unclaimAppeal` with config-supplied TTL.
 *   - **AI confidence floor (D7).** `triage` results below
 *     `config.aiConfidenceFloor` are dropped so the dashboard doesn't show a
 *     low-signal label.
 *   - **Notifier (W4).** Optional external alerting channel; the default
 *     `NoopNotifier` is a drop-in that preserves current behaviour.
 *
 * The Reddit side is still injected via `RedditGateway`, so the service stays
 * unit-testable without Devvit.
 */

import { AppealStore, type NewAppealInput, type QueueCursor } from './store.js';
import { buildReply } from './templates.js';
import type { AiProvider } from '../ai/provider.js';
import { selectProvider, applyConfidenceFloor } from '../ai/provider.js';
import type {
  Appeal,
  AppealDecision,
  AppealSummary,
} from './types.js';
import {
  validateSubmission,
  validateDecision,
  sanitiseText,
  LIMITS,
} from './validation/index.js';
import { errors, isAppealError } from './errors/index.js';
import {
  type Telemetry,
  type Logger,
  defaultTelemetry,
} from './observability/index.js';
import {
  evaluateEligibility,
  mapRuleId,
  type PolicyConfig,
  type PolicyPrior,
} from './policy/index.js';
import {
  computeSubAnalytics,
  type SubAnalytics,
} from './analytics/index.js';
import {
  type Notifier,
  NoopNotifier,
} from './notifier.js';
import { keys } from './keys.js';

export interface RedditGateway {
  sendReply(args: {
    subreddit: string;
    to: string;
    subject: string;
    body: string;
  }): Promise<void>;
}

export interface DecideInput {
  subreddit: string;
  appealId: string;
  decision: AppealDecision;
  modId: string;
  modName: string;
  note: string;
  finalReply?: string;
}

export interface DecideBatchInput {
  subreddit: string;
  appealIds: string[];
  decision: AppealDecision;
  modId: string;
  modName: string;
  note: string;
  /** Optional final reply applied to ALL items. If omitted, each item uses
   *  the rendered template (since per-item reply editing in a batch is a
   *  contradiction — the batch is for cases that take the same wording). */
  finalReply?: string;
}

export interface DecideBatchResult {
  /** Ids that successfully decided. */
  decided: string[];
  /** Per-item failures, in input order, with the error code that fired. */
  failures: Array<{ id: string; code: string; message: string }>;
}

export class AppealService {
  private readonly notifier: Notifier;

  constructor(
    private readonly store: AppealStore,
    private readonly reddit: RedditGateway,
    private readonly aiBackend?: AiProvider,
    private readonly tel: Telemetry = defaultTelemetry,
    notifier?: Notifier,
  ) {
    this.notifier = notifier ?? new NoopNotifier();
  }

  /**
   * Build the per-request scoped logger (Finding D). Every entry point opens
   * with this so log lines emitted during one user submit / mod decide / etc
   * can be joined by `correlationId`. Cheap — child() just merges contexts.
   */
  private requestLogger(
    op: string,
    extra: Record<string, unknown> = {},
  ): { log: Logger; correlationId: string } {
    const correlationId = newCorrelationId();
    const log = this.tel.logger.child({ op, correlationId, ...extra });
    return { log, correlationId };
  }

  // ---- intake ----------------------------------------------------------

  /**
   * A user submits an appeal. Validates and sanitises input, evaluates the
   * policy eligibility gate (W3), maps the originalReason to a rule id, then
   * creates the appeal (which rate-limits and dedup-checks). Throws
   * VALIDATION_FAILED, APPEAL_INELIGIBLE, RATE_LIMITED, DUPLICATE_OPEN_APPEAL,
   * or OPTIMISTIC_LOCK_CONFLICT as appropriate.
   */
  async submitAppeal(input: NewAppealInput): Promise<Appeal> {
    const { log, correlationId } = this.requestLogger('submitAppeal', {
      sub: input.subreddit,
      author: input.authorName,
    });

    const result = validateSubmission({
      reason: input.reason,
      acknowledged: input.acknowledged,
      actionType: input.actionType,
      targetId: input.targetId,
      authorName: input.authorName,
    });
    if (!result.ok) {
      throw errors.validation('Appeal submission is invalid.', {
        issues: result.issues,
        correlationId,
      });
    }

    // W3: policy eligibility gate. Pulls policy + a bounded prior summary;
    // a default policy is a no-op for subs that haven't configured anything.
    const policy = await this.store.getPolicy(input.subreddit);
    const priorSummaries = await this.store.priorAppeals(
      input.subreddit,
      input.authorName,
      // The policy windows are days, so we want everything in the policy's
      // sliding window. Capping at 100 is generous; for a single sub a user
      // who has > 100 priors is well past any sensible policy.
      100,
    );
    const priors: PolicyPrior[] = priorSummaries.map((p) => ({
      id: p.id,
      targetId: '', // policy's cooldown-per-target predicate needs targetId
      createdAt: p.createdAt,
      status: p.status,
      lastDecision: p.lastDecision,
    }));
    // The priorAppeals summary doesn't include `targetId` (it's not used by
    // dedup), but the policy cooldown predicate does. A second pass enriches
    // the priors with their targetId IF the policy needs it. This is cheap:
    // we only fetch full records when cooldown is configured.
    let enriched = priors;
    if (policy.cooldownPerTargetSeconds > 0) {
      enriched = await Promise.all(
        priorSummaries.map(async (p) => {
          const full = await this.store.get(input.subreddit, p.id);
          return {
            id: p.id,
            /* v8 ignore next -- race-defensive: priorAppeals lists ids
               currently in the history index, but a retention purge between
               that read and this `.get` could remove the record. The empty
               string is the safe default for the cooldown predicate (no
               match → no cooldown fires). */
            targetId: full?.targetId ?? '',
            createdAt: p.createdAt,
            status: p.status,
            lastDecision: p.lastDecision,
          };
        }),
      );
    }
    const eligibility = evaluateEligibility(
      {
        authorName: input.authorName,
        targetId: input.targetId,
        actionType: input.actionType,
        originalReason: input.originalReason,
      },
      enriched,
      policy,
      this.tel.clock.now(),
    );
    if (!eligibility.ok) {
      log.log('info', 'appeal ineligible', { code: eligibility.code });
      throw errors.ineligible(eligibility.reason, {
        code: eligibility.code,
        retryAfterMs: eligibility.retryAfterMs,
        correlationId,
      });
    }
    const ruleId = eligibility.ruleId;

    const clean: NewAppealInput = {
      ...input,
      reason: sanitiseText(input.reason, LIMITS.reasonMax),
      originalContent: sanitiseText(input.originalContent, LIMITS.replyMax),
      originalReason: sanitiseText(input.originalReason, LIMITS.replyMax),
      ruleId,
    };

    const appeal = await this.store.create(clean);
    log.log('info', 'appeal created', {
      appealId: appeal.id,
      ruleId,
    });

    // Best-effort optional AI triage. Never blocks; never decides. Now with
    // a per-sub backend selector and confidence floor (D7).
    const config = await this.store.getConfig(input.subreddit);
    const ai = selectProvider(config.aiEnabled, this.aiBackend, config.aiBackend);
    const rawLabel = await ai.triage(appeal);
    const label = applyConfidenceFloor(rawLabel, config.aiConfidenceFloor);
    if (label) {
      await this.store.setAiLabel(input.subreddit, appeal.id, label);
    } else if (rawLabel) {
      log.log('debug', 'ai triage hidden below confidence floor', {
        label: rawLabel.label,
        confidence: rawLabel.confidence,
        floor: config.aiConfidenceFloor,
      });
    }

    return appeal;
  }

  // ---- dashboard reads -------------------------------------------------

  async queue(subreddit: string): Promise<AppealSummary[]> {
    return this.store.openQueue(subreddit);
  }

  async queuePage(subreddit: string, limit = 25, cursor?: QueueCursor) {
    return this.store.openQueuePage(subreddit, limit, cursor);
  }

  /** Live open-queue cardinality (for the M3 header badge / load-more state). */
  async openCount(subreddit: string): Promise<number> {
    return this.store.openCount(subreddit);
  }

  async open(subreddit: string, appealId: string): Promise<Appeal> {
    return this.store.markInReview(subreddit, appealId);
  }

  /** W2 analytics: a single typed shape for the dashboard tab. */
  async analytics(
    subreddit: string,
    windowDays = 30,
  ): Promise<SubAnalytics> {
    return computeSubAnalytics(this.store, subreddit, {
      windowDays,
      now: this.tel.clock.now(),
    });
  }

  // ---- the human decision ----------------------------------------------

  /** Produce a SUGGESTED reply (template + optional AI softening). Sends nothing. */
  async suggestReply(
    subreddit: string,
    appealId: string,
    decision: AppealDecision,
  ): Promise<string> {
    const appeal = await this.store.get(subreddit, appealId);
    if (!appeal) return '';
    const config = await this.store.getConfig(subreddit);
    const base = buildReply(decision, config, appeal);
    const ai = selectProvider(config.aiEnabled, this.aiBackend, config.aiBackend);
    return ai.softenReply(base, appeal);
  }

  /**
   * Record the mod's decision and send the (mod-approved) reply. Validates the
   * decision input. If reply delivery fails, the decision is still recorded
   * (it's the source of truth) and a REPLY_DELIVERY_FAILED error is thrown so
   * the surface can offer a resend — we never silently drop the user's reply.
   */
  async decide(input: DecideInput): Promise<Appeal> {
    const { log, correlationId } = this.requestLogger('decide', {
      sub: input.subreddit,
      appealId: input.appealId,
      mod: input.modId,
    });

    const validation = validateDecision({
      decision: input.decision,
      note: input.note,
      finalReply: input.finalReply,
    });
    if (!validation.ok) {
      throw errors.validation('Decision is invalid.', {
        issues: validation.issues,
        correlationId,
      });
    }

    const appeal = await this.store.getOrThrow(input.subreddit, input.appealId);
    const config = await this.store.getConfig(input.subreddit);
    const replyText = input.finalReply
      ? sanitiseText(input.finalReply, LIMITS.replyMax)
      : buildReply(input.decision, config, appeal);

    const decided = await this.store.decide(
      input.subreddit,
      input.appealId,
      input.decision,
      {
        modId: input.modId,
        modName: input.modName,
        note: sanitiseText(input.note ?? '', LIMITS.noteMax),
        replyText,
      },
    );
    log.log('info', 'decision recorded', { decision: input.decision });

    try {
      await this.reddit.sendReply({
        subreddit: input.subreddit,
        to: appeal.authorName,
        subject: `Re: your appeal (${appeal.actionType})`,
        body: replyText,
      });
    } catch (e) {
      log.log('error', 'reply delivery failed', {
        cause: e instanceof Error ? e.message : String(e),
      });
      throw errors.replyDelivery(appeal.authorName, e);
    }

    return decided;
  }

  /**
   * T2.2: apply the same decision to N appeals as one batch. Each per-appeal
   * decision still goes through `store.decide` so the state machine, audit
   * chain, version-checked CAS, and reply delivery fire per item. Per-item
   * failures are collected; the batch never aborts on the first failure.
   *
   * Designed for the "uphold all near-duplicates of this appeal" use case.
   */
  async decideBatch(input: DecideBatchInput): Promise<DecideBatchResult> {
    const { log, correlationId } = this.requestLogger('decideBatch', {
      sub: input.subreddit,
      count: input.appealIds.length,
      mod: input.modId,
    });

    const decided: string[] = [];
    const failures: DecideBatchResult['failures'] = [];

    for (const id of input.appealIds) {
      try {
        await this.decide({
          subreddit: input.subreddit,
          appealId: id,
          decision: input.decision,
          modId: input.modId,
          modName: input.modName,
          note: input.note,
          finalReply: input.finalReply,
        });
        decided.push(id);
      } catch (e) {
        const code = isAppealError(e) ? e.code : 'INTERNAL';
        const message = e instanceof Error ? e.message : String(e);
        failures.push({ id, code, message });
      }
    }
    log.log('info', 'batch decision complete', {
      decided: decided.length,
      failures: failures.length,
      correlationId,
    });
    this.tel.metrics.increment('appeal.decided_batch', decided.length, {
      sub: input.subreddit,
    });
    return { decided, failures };
  }

  // ---- claims (W4) ----------------------------------------------------

  /** Claim an appeal so other mods see "claimed by u/X" on the dashboard. */
  async claim(
    subreddit: string,
    appealId: string,
    modId: string,
    modName: string,
  ): Promise<Appeal> {
    const config = await this.store.getConfig(subreddit);
    return this.store.claimAppeal(
      subreddit,
      appealId,
      modId,
      modName,
      config.claimTtlMinutes,
    );
  }

  /** Release a claim. Only the claim-holder can release it. */
  async unclaim(
    subreddit: string,
    appealId: string,
    modId: string,
  ): Promise<Appeal> {
    return this.store.unclaimAppeal(subreddit, appealId, modId);
  }

  // ---- policy --------------------------------------------------------

  async getPolicy(subreddit: string): Promise<PolicyConfig> {
    return this.store.getPolicy(subreddit);
  }

  async setPolicy(subreddit: string, policy: PolicyConfig): Promise<void> {
    return this.store.setPolicy(subreddit, policy);
  }

  /**
   * Recompute the `ruleId` for an existing appeal under the current policy
   * (useful after a mod edits the policy and wants a backfill). Pure
   * convenience — the appeal is mutated via the normal CAS path.
   */
  async remapRuleId(subreddit: string, appealId: string): Promise<Appeal> {
    const policy = await this.store.getPolicy(subreddit);
    return this.store.mutate(subreddit, appealId, (appeal) => ({
      ...appeal,
      ruleId: mapRuleId(appeal.originalReason, policy),
      version: appeal.version + 1,
      updatedAt: this.tel.clock.now(),
    }));
  }

  // ---- lifecycle: retention & erasure ----------------------------------
  //
  // The store has always implemented these, but nothing in the app called
  // them — they were effectively dead code despite being advertised in the
  // README and threat model. Exposing them on the service gives the shell
  // (a scheduled job, a mod menu item) a single, testable entry point.

  /**
   * Right-to-erasure for a single appeal: scrub the user's free text while
   * keeping an auditable tombstone. Idempotent.
   */
  async eraseAppeal(subreddit: string, appealId: string): Promise<Appeal> {
    return this.store.redactAppeal(subreddit, appealId);
  }

  /**
   * Erase every appeal a user has filed in this subreddit (their full history).
   * Returns the ids that were redacted. Idempotent per appeal. Also drops the
   * user's rate-limit bucket so the username doesn't persist in the
   * `ratelimit:` namespace after erasure (H2; THREAT_MODEL §6 invariant 6).
   */
  async eraseUser(subreddit: string, username: string): Promise<string[]> {
    const { log } = this.requestLogger('eraseUser', { sub: subreddit, user: username });
    const ids = await this.store.historyIds(subreddit, username);
    const redacted: string[] = [];
    for (const id of ids) {
      await this.store.redactAppeal(subreddit, id);
      redacted.push(id);
    }
    // H2: scrub the bucket too.
    await this.store.deleteRateLimit(subreddit, username);
    log.log('info', 'user erased', { count: redacted.length });
    this.tel.metrics.increment('appeals.erased_for_user', redacted.length, {
      sub: subreddit,
    });
    return redacted;
  }

  /**
   * Mod-facing erasure (W1). Same as `eraseUser` but records the acting mod
   * in the erasure audit log (`index:<sub>:erasure_log`). We don't store the
   * acting mod inside the redacted appeal (that would defeat the point); the
   * log is a separate sorted set so a transparency report can answer "who
   * erased what."
   */
  async eraseUserByMod(
    subreddit: string,
    username: string,
    modId: string,
    modName: string,
  ): Promise<string[]> {
    const redacted = await this.eraseUser(subreddit, username);
    const now = this.tel.clock.now();
    // Use the store's redis indirectly via the analytics accessor — it's the
    // single platform-free RedisLike handle, and analytics already proved we
    // can name a use-case carve-out.
    try {
      await this.store.getRedisForAnalytics().zAdd(keys.erasureLog(subreddit), {
        member: `${now}:${modId}:${username}`,
        score: now,
      });
    } catch {
      // Audit-log writes are best effort. The erasure itself already
      // committed; we don't fail it because a log write hiccuped.
    }
    this.tel.metrics.increment('appeal.erased_by_mod', 1, {
      sub: subreddit,
    });
    await this.notifier.notify({
      kind: 'erasure',
      subreddit,
      subject: `Appealdesk: ${redacted.length} appeal(s) erased for u/${username}`,
      body: `Mod u/${modName} erased ${redacted.length} appeal(s).`,
      metadata: { modId, modName, target: username, count: redacted.length },
    });
    return redacted;
  }

  /**
   * Run one retention purge batch (resolved appeals past their window). Returns
   * the purged ids. Callers loop until a short batch to drain a backlog.
   */
  async purgeRetention(subreddit: string, limit = 100): Promise<string[]> {
    return this.store.purgeExpired(subreddit, limit);
  }

  /** Snapshot purge sweep (D6 / H1). */
  async purgeSnapshots(subreddit: string, limit = 200): Promise<number> {
    return this.store.purgeExpiredSnapshots(subreddit, limit);
  }

  /** Rate-limit purge sweep (D6 / H2). */
  async purgeRateLimits(subreddit: string, limit = 200): Promise<number> {
    return this.store.purgeExpiredRateLimits(subreddit, limit);
  }

  /** Surface for the scheduler to forward SLA-breach alerts to the Notifier. */
  async notifySlaBreach(
    subreddit: string,
    count: number,
    slaHours: number,
  ): Promise<void> {
    await this.notifier.notify({
      kind: 'sla_breach',
      subreddit,
      subject: `Appealdesk: ${count} appeal(s) past SLA in r/${subreddit}`,
      body: `${count} appeal(s) have exceeded the ${slaHours}h SLA.`,
      metadata: { count, slaHours },
    });
  }
}

/**
 * Short, URL-safe correlation id. Not crypto — this is for log joins, not for
 * security. Format: `c_<base36 ts><6 random base36>`. Easy to grep.
 */
function newCorrelationId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8).padStart(6, '0');
  return `c_${t}${r}`;
}
