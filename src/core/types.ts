/**
 * Core domain types for Appealdesk.
 *
 * These describe the shape of an appeal as it moves through the pipeline:
 * a user submits one against a specific mod action, a mod reviews it on the
 * dashboard, and a decision is recorded. Everything here is platform-agnostic
 * plain data — no Devvit imports — so it can be unit-tested in isolation.
 */

/** The moderator's verdict on an appeal. The decision is ALWAYS a human's. */
export type AppealDecision = 'upheld' | 'overturned' | 'more_info';

/** Lifecycle state of an appeal. */
export type AppealStatus =
  | 'open' // submitted, awaiting mod review
  | 'in_review' // a mod has opened it but not decided
  | 'awaiting_user' // mod asked for more info; ball is in the user's court
  | 'resolved'; // a final decision (upheld/overturned) was recorded

/** What kind of moderator action is being appealed. */
export type ActionType = 'ban' | 'removal' | 'comment_removal';

/**
 * Optional, ASSISTIVE-ONLY triage hint. This is a suggestion to help a mod
 * prioritise — never a verdict, and never auto-actioned. The deterministic
 * dedup signal is separate and always present; the `model` label is only set
 * when the optional AI layer is enabled.
 */
export interface TriageHint {
  /** Deterministic signal computed without AI — always available. */
  duplicateOfAppealId?: string;
  repeatCount: number; // how many prior appeals this user has filed in this sub
  /** AI-derived label, only present when the AI setting is on. */
  model?: {
    label: 'likely_genuine' | 'likely_duplicate' | 'likely_abusive';
    confidence: number; // 0..1
    rationale: string; // short, human-readable; shown as a tooltip to the mod
  };
}

/** A single recorded decision event (for the audit trail). */
export interface DecisionRecord {
  decision: AppealDecision;
  modId: string; // the acting moderator (t2_ id)
  modName: string;
  note: string; // mod's internal note (not sent to the user)
  replyText: string; // the civil reply that WAS sent to the user
  decidedAt: number; // epoch ms
}

/** The full appeal record stored at `appeal:<sub>:<id>`. */
export interface Appeal {
  id: string; // stable appeal id, e.g. "ap_lp93f2"
  subreddit: string; // subreddit name without the r/
  actionType: ActionType;
  /** The thing being appealed. For a ban this is the username; for a removal
   *  it's the post/comment id (t3_/t1_). */
  targetId: string;
  /** Reddit fullname (t2_) of the user who is appealing. */
  authorId: string;
  authorName: string;

  // What the user submitted via the structured form:
  reason: string; // free text, but captured in a structured field
  acknowledged: boolean; // did they tick "I understand the rule I broke"?

  // Snapshot of the original action so the mod has full context inline:
  originalContent: string; // body of the removed item, or "(account ban)"
  originalReason: string; // the removal/ban reason the mod gave originally
  permalink?: string; // link back to the original item, when applicable

  status: AppealStatus;
  triage: TriageHint;
  decisions: DecisionRecord[]; // append-only audit trail (latest is current)

  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

/** Lightweight summary used by the dashboard list (avoids loading every field). */
export interface AppealSummary {
  id: string;
  authorName: string;
  actionType: ActionType;
  status: AppealStatus;
  repeatCount: number;
  createdAt: number;
}

/** Per-subreddit configuration, persisted and editable via app settings. */
export interface SubredditConfig {
  /** Hours before an open appeal is considered "aging" and mods get nudged. */
  slaHours: number;
  /** Whether the optional AI triage/tone layer is enabled for this sub. */
  aiEnabled: boolean;
  /** Templated replies, keyed by decision. Mods can edit these per sub. */
  templates: Record<AppealDecision, string>;
  /** If true, a user may file at most one open appeal per action. */
  oneAppealPerAction: boolean;
}

export const DEFAULT_CONFIG: SubredditConfig = {
  slaHours: 48,
  aiEnabled: false,
  oneAppealPerAction: true,
  templates: {
    upheld:
      "We've reviewed your appeal and the original decision stands. " +
      'This was reviewed by a human moderator. Please review the community ' +
      'rules before participating again. Thank you for understanding.',
    overturned:
      "We've reviewed your appeal and have decided to reverse the original " +
      'action. Sorry for the disruption — your access has been restored. ' +
      'Welcome back.',
    more_info:
      "Thanks for appealing. Before we can decide, a moderator needs a bit " +
      'more information. Please reply with the details requested and we will ' +
      'pick the appeal back up.',
  },
};
