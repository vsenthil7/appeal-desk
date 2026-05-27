/**
 * AppealStore — the persistence layer.
 *
 * Wraps Devvit's Redis client and is the ONLY place that touches Redis.
 * Everything above it (handlers, UI) speaks in domain objects (`Appeal`),
 * not keys. This keeps the keying scheme honest and makes the storage layer
 * swappable / mockable for tests.
 *
 * Devvit's Redis surface used here:
 *   - get / set                  : the JSON appeal & config blobs
 *   - zAdd / zRange / zCard / zRem: the open-queue and per-user history indexes
 *   - del                        : releasing the per-action lock
 */

import type { RedisClient } from '@devvit/public-api';
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

export class AppealStore {
  constructor(private readonly redis: RedisClient) {}

  // ---- config ----------------------------------------------------------

  async getConfig(sub: string): Promise<SubredditConfig> {
    const raw = await this.redis.get(keys.config(sub));
    if (!raw) return DEFAULT_CONFIG;
    try {
      // Merge over defaults so newly-added config fields are always populated.
      return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as SubredditConfig) };
    } catch {
      return DEFAULT_CONFIG;
    }
  }

  async setConfig(sub: string, config: SubredditConfig): Promise<void> {
    await this.redis.set(keys.config(sub), JSON.stringify(config));
  }

  // ---- reads -----------------------------------------------------------

  async get(sub: string, id: string): Promise<Appeal | null> {
    const raw = await this.redis.get(keys.appeal(sub, id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Appeal;
    } catch {
      return null;
    }
  }

  /** Ids of a user's prior appeals in this sub, oldest first. */
  async historyIds(sub: string, user: string): Promise<string[]> {
    const entries = await this.redis.zRange(keys.history(sub, user), 0, -1);
    return entries.map((e) => e.member);
  }

  /** Hydrate a user's prior appeals (used by the dedup detector). */
  async priorAppeals(
    sub: string,
    user: string,
  ): Promise<Pick<Appeal, 'id' | 'reason'>[]> {
    const ids = await this.historyIds(sub, user);
    const loaded = await Promise.all(ids.map((id) => this.get(sub, id)));
    return loaded
      .filter((a): a is Appeal => a !== null)
      .map((a) => ({ id: a.id, reason: a.reason }));
  }

  /** The open-appeal queue for the dashboard, newest first, with summaries. */
  async openQueue(sub: string, limit = 100): Promise<AppealSummary[]> {
    const entries = await this.redis.zRange(keys.openIndex(sub), 0, limit - 1, {
      reverse: true,
      by: 'rank',
    });
    const appeals = await Promise.all(
      entries.map((e) => this.get(sub, e.member)),
    );
    return appeals
      .filter((a): a is Appeal => a !== null)
      .map(summarise);
  }

  // ---- writes ----------------------------------------------------------

  /**
   * Create a new appeal. Enforces the optional one-open-appeal-per-action lock,
   * computes the deterministic dedup signal, persists the record, and updates
   * both the open-queue and per-user history indexes.
   *
   * Returns the created appeal, or `null` if a one-per-action lock blocked it.
   */
  async create(input: NewAppealInput): Promise<Appeal | null> {
    const { subreddit: sub } = input;
    const config = await this.getConfig(sub);
    const now = Date.now();

    if (config.oneAppealPerAction) {
      const existing = await this.redis.get(
        keys.actionLock(sub, input.targetId),
      );
      if (existing) {
        const open = await this.get(sub, existing);
        if (open && open.status !== 'resolved') return null; // already pending
      }
    }

    const prior = await this.priorAppeals(sub, input.authorName);
    const dedup = computeDedup(input.reason, prior);

    const appeal: Appeal = {
      id: generateAppealId(now),
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
      triage: { repeatCount: dedup.repeatCount, duplicateOfAppealId: dedup.duplicateOfAppealId },
      decisions: [],
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
    await this.redis.set(keys.actionLock(sub, appeal.targetId), appeal.id);

    return appeal;
  }

  /** Mark an appeal as opened for review (idempotent). */
  async markInReview(sub: string, id: string): Promise<Appeal | null> {
    const appeal = await this.get(sub, id);
    if (!appeal || appeal.status !== 'open') return appeal;
    appeal.status = 'in_review';
    appeal.updatedAt = Date.now();
    await this.persist(appeal);
    return appeal;
  }

  /**
   * Record a moderator decision. This is the human verdict. It appends to the
   * audit trail, updates status, and removes the appeal from the open queue
   * (unless we're only asking for more info, in which case it stays trackable).
   */
  async decide(
    sub: string,
    id: string,
    decision: AppealDecision,
    record: Omit<DecisionRecord, 'decision' | 'decidedAt'>,
  ): Promise<Appeal | null> {
    const appeal = await this.get(sub, id);
    if (!appeal) return null;

    const now = Date.now();
    appeal.decisions.push({ ...record, decision, decidedAt: now });
    appeal.updatedAt = now;

    if (decision === 'more_info') {
      appeal.status = 'awaiting_user';
      // Stays in the open queue — a mod still owns it.
    } else {
      appeal.status = 'resolved';
      await this.redis.zRem(keys.openIndex(sub), [id]);
      // Release the per-action lock so a genuinely new action can be appealed later.
      await this.redis.del(keys.actionLock(sub, appeal.targetId));
    }

    await this.persist(appeal);
    return appeal;
  }

  /** Attach (or overwrite) the optional AI triage label. */
  async setAiLabel(
    sub: string,
    id: string,
    model: NonNullable<Appeal['triage']['model']>,
  ): Promise<void> {
    const appeal = await this.get(sub, id);
    if (!appeal) return;
    appeal.triage.model = model;
    appeal.updatedAt = Date.now();
    await this.persist(appeal);
  }

  // ---- internals -------------------------------------------------------

  private async persist(appeal: Appeal): Promise<void> {
    await this.redis.set(
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
