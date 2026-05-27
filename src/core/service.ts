/**
 * AppealService — the orchestration layer the UI and triggers call into.
 *
 * It coordinates:
 *   - the AppealStore (persistence)
 *   - the AiProvider  (optional triage + tone-softening)
 *   - reply rendering (templates.ts)
 *   - the Reddit API  (sending modmail, looking up the original action)
 *
 * The Reddit side is injected via a small `RedditGateway` interface rather than
 * importing Devvit directly, so the whole service can be unit-tested with fakes.
 */

import { AppealStore, type NewAppealInput } from './store.js';
import { buildReply } from './templates.js';
import type { AiProvider } from '../ai/provider.js';
import { selectProvider } from '../ai/provider.js';
import type {
  Appeal,
  AppealDecision,
  AppealSummary,
} from './types.js';

/** Minimal slice of the Reddit API the service needs. Devvit's `reddit`
 *  client satisfies a superset of this. */
export interface RedditGateway {
  /** Send a modmail / private reply to the appealing user. */
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
  /** If the mod edited the suggested reply, the final text they approved. */
  finalReply?: string;
}

export class AppealService {
  constructor(
    private readonly store: AppealStore,
    private readonly reddit: RedditGateway,
    /** Optional AI backend. When absent or disabled, a no-op is used. */
    private readonly aiBackend?: AiProvider,
  ) {}

  // ---- intake ----------------------------------------------------------

  /** A user submits an appeal. Returns null if a duplicate-open lock blocks it. */
  async submitAppeal(input: NewAppealInput): Promise<Appeal | null> {
    const appeal = await this.store.create(input);
    if (!appeal) return null;

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

  async open(subreddit: string, appealId: string): Promise<Appeal | null> {
    return this.store.markInReview(subreddit, appealId);
  }

  // ---- the human decision ----------------------------------------------

  /**
   * Produce a SUGGESTED reply for a decision (template + optional AI softening).
   * The UI shows this to the mod for editing; nothing is sent here.
   */
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
   * Record the mod's decision and send the (mod-approved) reply to the user.
   * The decision is the human's; AI is nowhere in this path.
   */
  async decide(input: DecideInput): Promise<Appeal | null> {
    const appeal = await this.store.get(input.subreddit, input.appealId);
    if (!appeal) return null;

    const config = await this.store.getConfig(input.subreddit);
    const replyText =
      input.finalReply ?? buildReply(input.decision, config, appeal);

    const decided = await this.store.decide(
      input.subreddit,
      input.appealId,
      input.decision,
      {
        modId: input.modId,
        modName: input.modName,
        note: input.note,
        replyText,
      },
    );
    if (!decided) return null;

    await this.reddit.sendReply({
      subreddit: input.subreddit,
      to: appeal.authorName,
      subject: `Re: your appeal (${appeal.actionType})`,
      body: replyText,
    });

    return decided;
  }
}
