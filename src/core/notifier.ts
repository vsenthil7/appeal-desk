/**
 * Notifier (W4).
 *
 * Today the only mod-facing out-of-band channel is modmail (the SLA nudge),
 * and the only user-facing channel is modmail (the reply). Both stay; this
 * interface adds an OPTIONAL second mod-facing channel so a deployment can
 * wire Slack/Discord/PagerDuty for SLA breaches and analytics signals
 * without touching the core.
 *
 * The default Noop preserves current behaviour exactly. A deployment that
 * wants a webhook constructs its own implementation and passes it through
 * `context.ts → AppealService`.
 *
 * Important: this is for *operational alerting*, not user-facing messages.
 * User replies still go through `RedditGateway.sendReply`.
 */

export type NotificationKind =
  | 'sla_breach'
  | 'analytics_alert'
  | 'erasure'
  | 'job_failure';

export interface Notification {
  kind: NotificationKind;
  subreddit: string;
  /** Short, mod-readable subject. */
  subject: string;
  /** Free-form body (markdown ok). */
  body: string;
  /** Optional structured payload for a webhook to forward. */
  metadata?: Record<string, unknown>;
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}

/** Default notifier — no external side effects. Safe to drop into production. */
export class NoopNotifier implements Notifier {
  async notify(): Promise<void> {
    // Intentionally empty — see file header.
  }
}
