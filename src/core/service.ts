/**
 * AppealService — the orchestration layer the UI and triggers call into.
 *
 * Coordinates the store, the optional AI provider, reply rendering, and the
 * Reddit gateway. This version adds input validation at the boundary, typed
 * error propagation, telemetry, and reply-delivery error handling.
 *
 * The Reddit side is injected via `RedditGateway` so the service is unit-testable.
 */

import { AppealStore, type NewAppealInput, type QueueCursor } from './store.js';
import { buildReply } from './templates.js';
import type { AiProvider } from '../ai/provider.js';
import { selectProvider } from '../ai/provider.js';
import type { Appeal, AppealDecision, AppealSummary } from './types.js';
import {
  validateSubmission,
  validateDecision,
  sanitiseText,
  LIMITS,
} from './validation/index.js';
import { errors } from './errors/index.js';
import {
  type Telemetry,
  defaultTelemetry,
} from './observability/index.js';

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

export class AppealService {
  constructor(
    private readonly store: AppealStore,
    private readonly reddit: RedditGateway,
    private readonly aiBackend?: AiProvider,
    private readonly tel: Telemetry = defaultTelemetry,
  ) {}

  // ---- intake ----------------------------------------------------------

  /**
   * A user submits an appeal. Validates and sanitises input, then creates the
   * appeal (which rate-limits and dedup-checks). Throws VALIDATION_FAILED,
   * RATE_LIMITED, or DUPLICATE_OPEN_APPEAL as appropriate.
   */
  async submitAppeal(input: NewAppealInput): Promise<Appeal> {
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
      });
    }

    const clean: NewAppealInput = {
      ...input,
      reason: sanitiseText(input.reason, LIMITS.reasonMax),
      originalContent: sanitiseText(input.originalContent, LIMITS.replyMax),
      originalReason: sanitiseText(input.originalReason, LIMITS.replyMax),
    };

    const appeal = await this.store.create(clean);

    // Best-effort optional AI triage. Never blocks; never decides.
    const config = await this.store.getConfig(input.subreddit);
    const ai = selectProvider(config.aiEnabled, this.aiBackend);
    const label = await ai.triage(appeal);
    if (label) await this.store.setAiLabel(input.subreddit, appeal.id, label);

    return appeal;
  }

  // ---- dashboard reads -------------------------------------------------

  async queue(subreddit: string): Promise<AppealSummary[]> {
    return this.store.openQueue(subreddit);
  }

  async queuePage(subreddit: string, limit = 25, cursor?: QueueCursor) {
    return this.store.openQueuePage(subreddit, limit, cursor);
  }

  async open(subreddit: string, appealId: string): Promise<Appeal> {
    return this.store.markInReview(subreddit, appealId);
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
    const ai = selectProvider(config.aiEnabled, this.aiBackend);
    return ai.softenReply(base, appeal);
  }

  /**
   * Record the mod's decision and send the (mod-approved) reply. Validates the
   * decision input. If reply delivery fails, the decision is still recorded
   * (it's the source of truth) and a REPLY_DELIVERY_FAILED error is thrown so
   * the surface can offer a resend — we never silently drop the user's reply.
   */
  async decide(input: DecideInput): Promise<Appeal> {
    const validation = validateDecision({
      decision: input.decision,
      note: input.note,
      finalReply: input.finalReply,
    });
    if (!validation.ok) {
      throw errors.validation('Decision is invalid.', {
        issues: validation.issues,
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

    try {
      await this.reddit.sendReply({
        subreddit: input.subreddit,
        to: appeal.authorName,
        subject: `Re: your appeal (${appeal.actionType})`,
        body: replyText,
      });
    } catch (e) {
      this.tel.logger.log('error', 'reply delivery failed', {
        sub: input.subreddit,
        appealId: input.appealId,
      });
      throw errors.replyDelivery(appeal.authorName, e);
    }

    return decided;
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
   * Returns the ids that were redacted. Idempotent per appeal.
   */
  async eraseUser(subreddit: string, username: string): Promise<string[]> {
    const ids = await this.store.historyIds(subreddit, username);
    const redacted: string[] = [];
    for (const id of ids) {
      await this.store.redactAppeal(subreddit, id);
      redacted.push(id);
    }
    return redacted;
  }

  /**
   * Run one retention purge batch (resolved appeals past their window). Returns
   * the purged ids. Callers loop until a short batch to drain a backlog.
   */
  async purgeRetention(subreddit: string, limit = 100): Promise<string[]> {
    return this.store.purgeExpired(subreddit, limit);
  }
}
