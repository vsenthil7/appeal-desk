/**
 * Reply rendering: turn a decision + config into the civil reply text that the
 * mod will send. Supports lightweight {{variable}} substitution so a sub can
 * personalise templates without code changes. Pure and synchronous; the AI
 * tone-softening (if enabled) is applied AFTER this, by the caller.
 */

import type { Appeal, AppealDecision, SubredditConfig } from './types.js';

/** Variables available inside reply templates. */
export interface TemplateVars {
  user: string;
  subreddit: string;
  action: string;
}

/** Replace {{key}} tokens. Unknown tokens are left intact (visible, so a mod
 *  notices and fixes the template rather than sending a blank). */
export function renderTemplate(
  template: string,
  vars: TemplateVars,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = (vars as unknown as Record<string, string>)[key];
    return value ?? whole;
  });
}

/** Build the default reply for a decision, before any AI softening. */
export function buildReply(
  decision: AppealDecision,
  config: SubredditConfig,
  appeal: Appeal,
): string {
  const template = config.templates[decision];
  return renderTemplate(template, {
    user: appeal.authorName,
    subreddit: appeal.subreddit,
    action: appeal.actionType,
  });
}
