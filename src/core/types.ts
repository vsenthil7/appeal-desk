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
  /** Softer paraphrase signal (D1) — char-trigram Jaccard match against a
   *  prior appeal that the strict token signal didn't catch. */
  paraphraseOfAppealId?: string;
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
  /**
   * Tamper-evidence chain hash (D8). `chainHash = sha256(prevChainHash + canonicalize(thisRecord))`,
   * where `prevChainHash` is the previous record's hash (or "" for the first
   * record). A future export can prove the audit trail hasn't been silently
   * edited by recomputing every hash from the canonical record. Optional on
   * read for back-compat with records that pre-date this field.
   */
  chainHash?: string;
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

  /**
   * Optional rule id mapped from `originalReason` by the policy module (W3).
   * `unmapped` for subs that haven't configured the policy. Surfaced on the
   * dashboard for filter/sort and powers per-rule analytics breakdowns.
   */
  ruleId?: string;

  /**
   * Currently-claiming moderator id (W4). When set, the dashboard surfaces a
   * "claimed by u/X" pill so a second mod doesn't duplicate work. Backed by
   * the TTL'd `claim:<sub>:<id>` key; mirrored on the appeal so a single read
   * gets both the appeal and its claim state.
   */
  assignedModId?: string;
  assignedModName?: string;
  assignedAt?: number;

  /** Monotonic version for optimistic concurrency control. Incremented on
   *  every persisted mutation; a compare-and-set rejects stale writes. */
  version: number;

  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
}

/**
 * Single source of truth for which `Appeal` fields contain user-supplied free
 * text and MUST be scrubbed by `redactForErasure`. The redaction routine
 * iterates this list rather than spelling each field by hand, and the property
 * test in `test/property/invariants.test.ts` asserts every entry survives a
 * round-trip → all become `REDACTED`. Adding a new free-text field on `Appeal`
 * just means adding it here; the invariant test then catches any forgotten
 * scrub site (B).
 */
export const REDACTABLE_TOP_LEVEL_STRING_FIELDS: ReadonlyArray<
  keyof Appeal
> = ['authorName', 'reason', 'originalContent'];

/**
 * Free-text fields inside each `DecisionRecord` that erasure must scrub.
 * Symmetric to the top-level list and used by the same invariant test.
 */
export const REDACTABLE_DECISION_FIELDS: ReadonlyArray<keyof DecisionRecord> = [
  'note',
  'replyText',
];

/** Lightweight summary used by the dashboard list (avoids loading every field). */
export interface AppealSummary {
  id: string;
  authorName: string;
  actionType: ActionType;
  status: AppealStatus;
  repeatCount: number;
  createdAt: number;
  /** Optional policy-mapped rule id (W3). `undefined`/`unmapped` if policy
   *  is not configured for this sub — back-compat. */
  ruleId?: string;
  /** Optional claim info so the dashboard row can show "claimed by u/X" without
   *  a second round-trip (W4). */
  assignedModName?: string;
}

/** Per-subreddit configuration, persisted and editable via app settings. */
export interface SubredditConfig {
  /** Hours before an open appeal is considered "aging" and mods get nudged. */
  slaHours: number;
  /** Whether the optional AI triage/tone layer is enabled for this sub. */
  aiEnabled: boolean;
  /**
   * Per-sub AI backend selector (D7). `noop` always uses the deterministic
   * fallback regardless of whether a model is wired; `devvit` (or any other
   * string the host recognises) uses the runtime-supplied backend if present.
   * Defaults to `devvit` so subs that flip `aiEnabled` get the platform model.
   */
  aiBackend: 'noop' | 'devvit' | string;
  /** Hide AI triage hints below this confidence (0..1) so low-signal labels
   *  don't clutter the dashboard. 0 disables the floor (D7). */
  aiConfidenceFloor: number;
  /** Templated replies, keyed by decision. Mods can edit these per sub. */
  templates: Record<AppealDecision, string>;
  /** If true, a user may file at most one open appeal per action. */
  oneAppealPerAction: boolean;
  /** Rate limit: burst capacity of appeals a single user may file. */
  rateLimitCapacity: number;
  /** Rate limit: appeals replenished per hour. */
  rateLimitRefillPerHour: number;
  /** Sub-wide rate limit (D3): burst capacity across all users, per actionType.
   *  Caps coordinated cohorts that out-run the per-user bucket. 0 disables. */
  subwideRateLimitCapacity: number;
  /** Sub-wide refill per hour (D3). 0 disables. */
  subwideRateLimitRefillPerHour: number;
  /** Days after resolution before an appeal is eligible for archival/purge.
   *  0 disables retention (keep forever). */
  retentionDays: number;
  /** Hours an unappealed action snapshot lives before the retention job sweeps
   *  it (H1). Snapshots may contain post/comment bodies, so this MUST be
   *  bounded; the default is the typical appeal window. */
  snapshotRetentionHours: number;
  /** Hours an idle rate-limit bucket lives (H2). A full bucket refills in
   *  `capacity / refillPerHour` hours — anything beyond that is identical to
   *  a fresh bucket, so TTLing the key past that point is lossless. */
  rateLimitIdleHours: number;
  /** Max minutes a mod can hold an unrenewed claim before it auto-releases
   *  (W4). 0 disables the claim feature entirely. */
  claimTtlMinutes: number;
}

export const DEFAULT_CONFIG: SubredditConfig = {
  slaHours: 48,
  aiEnabled: false,
  aiBackend: 'devvit',
  aiConfidenceFloor: 0,
  oneAppealPerAction: true,
  rateLimitCapacity: 5,
  rateLimitRefillPerHour: 2,
  subwideRateLimitCapacity: 0,
  subwideRateLimitRefillPerHour: 0,
  retentionDays: 180,
  snapshotRetentionHours: 24 * 90, // 90 days — matches the typical appeal window
  rateLimitIdleHours: 24,
  claimTtlMinutes: 30,
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
