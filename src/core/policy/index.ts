/**
 * Policy module (W3).
 *
 * Two pure-function concerns, both deterministic, both AI-free:
 *
 *   1. **Eligibility predicates** — should this submission even be allowed?
 *      Three predicates cover the 80% of mod demand the review identified:
 *        - `cooldownAfterRecent`: a per-target cooldown so a user can't re-file
 *          the same appeal seconds after the last one.
 *        - `permabanForTosBlocked`: refuses appeals whose `originalReason`
 *          matches the configured ToS pattern. (Default off; mods opt in.)
 *        - `maxPerWindow`: caps appeals per user across the sub in a sliding
 *          window. Pairs naturally with the rate limit but operates at a
 *          coarser cadence (days, not hours).
 *
 *   2. **Rule mapping** — turn a free-text `originalReason` into a stable
 *      `ruleId`, so the dashboard can filter by rule and analytics can break
 *      down by rule, not just `actionType`. Unmapped reasons yield
 *      `unmapped` — no behavioural change for subs that haven't configured it.
 *
 * Everything here is a pure function over `PolicyConfig`, the new appeal
 * input, and a NEWEST-FIRST list of priors. Trivially testable.
 */

import type { ActionType, AppealDecision } from '../types.js';

/** Per-sub policy configuration; persisted at `keys.policy(sub)`. */
export interface PolicyConfig {
  /** Minimum seconds between two appeals on the SAME targetId by the same
   *  user. 0 disables. */
  cooldownPerTargetSeconds: number;
  /**
   * If set, an appeal whose `originalReason` matches any of these (case-
   * insensitive substring) is refused outright. Use sparingly — this is a
   * hard "no appeals" gate, not a rate limit. Empty array disables.
   */
  blockedReasonPatterns: string[];
  /** Max appeals a user can file across the sub in `maxPerWindowDays`. 0 disables. */
  maxPerWindow: number;
  maxPerWindowDays: number;
  /**
   * Optional rule mapping. Each entry: any (case-insensitive substring)
   * pattern in `patterns` maps the originalReason to `ruleId`. First match
   * wins; unmatched reasons get `unmapped`.
   */
  rules: Array<{
    ruleId: string;
    label: string;
    patterns: string[];
  }>;
}

export const DEFAULT_POLICY: PolicyConfig = {
  cooldownPerTargetSeconds: 0,
  blockedReasonPatterns: [],
  maxPerWindow: 0,
  maxPerWindowDays: 30,
  rules: [],
};

/** A user's prior appeal as seen by the eligibility check (newest-first). */
export interface PolicyPrior {
  id: string;
  targetId: string;
  createdAt: number;
  status: 'open' | 'in_review' | 'awaiting_user' | 'resolved';
  lastDecision: AppealDecision | null;
}

/** Inputs to the eligibility check. */
export interface EligibilityInput {
  authorName: string;
  targetId: string;
  actionType: ActionType;
  originalReason: string;
}

/** Result of the eligibility check. */
export type EligibilityResult =
  | { ok: true; ruleId: string }
  | {
      ok: false;
      reason: string;
      code:
        | 'COOLDOWN_PER_TARGET'
        | 'BLOCKED_REASON_PATTERN'
        | 'MAX_PER_WINDOW';
      retryAfterMs?: number;
    };

/**
 * Run the eligibility predicates against `input`, the user's prior appeals
 * (newest-first), and the policy config. Returns `{ ok: true }` if all gates
 * pass, with the resolved `ruleId` for downstream storage; otherwise the
 * specific gate that refused plus a human-readable reason.
 */
export function evaluateEligibility(
  input: EligibilityInput,
  priors: PolicyPrior[],
  policy: PolicyConfig,
  now: number,
): EligibilityResult {
  // 1. Cooldown per target.
  if (policy.cooldownPerTargetSeconds > 0) {
    const samePrior = priors.find((p) => p.targetId === input.targetId);
    if (samePrior) {
      const ageMs = now - samePrior.createdAt;
      const cooldownMs = policy.cooldownPerTargetSeconds * 1000;
      if (ageMs < cooldownMs) {
        return {
          ok: false,
          code: 'COOLDOWN_PER_TARGET',
          reason: `Please wait before re-filing an appeal on this same action (cooldown ${policy.cooldownPerTargetSeconds}s).`,
          retryAfterMs: cooldownMs - ageMs,
        };
      }
    }
  }

  // 2. Blocked reason patterns (case-insensitive substring on originalReason).
  if (policy.blockedReasonPatterns.length > 0) {
    const r = input.originalReason.toLowerCase();
    for (const pat of policy.blockedReasonPatterns) {
      if (pat.length > 0 && r.includes(pat.toLowerCase())) {
        return {
          ok: false,
          code: 'BLOCKED_REASON_PATTERN',
          reason:
            'This action is not appealable. Please review the community rules.',
        };
      }
    }
  }

  // 3. Max appeals per sliding window.
  if (policy.maxPerWindow > 0 && policy.maxPerWindowDays > 0) {
    const windowMs = policy.maxPerWindowDays * 24 * 60 * 60 * 1000;
    const within = priors.filter((p) => now - p.createdAt < windowMs);
    if (within.length >= policy.maxPerWindow) {
      return {
        ok: false,
        code: 'MAX_PER_WINDOW',
        reason: `You have reached the maximum of ${policy.maxPerWindow} appeals in ${policy.maxPerWindowDays} days.`,
      };
    }
  }

  return { ok: true, ruleId: mapRuleId(input.originalReason, policy) };
}

/**
 * Map a free-text removal/ban reason to a stable rule id using the policy's
 * rule list. First match wins; unmatched reasons get `unmapped`.
 */
export function mapRuleId(originalReason: string, policy: PolicyConfig): string {
  const r = originalReason.toLowerCase();
  for (const rule of policy.rules) {
    for (const pat of rule.patterns) {
      if (pat.length > 0 && r.includes(pat.toLowerCase())) return rule.ruleId;
    }
  }
  return 'unmapped';
}
