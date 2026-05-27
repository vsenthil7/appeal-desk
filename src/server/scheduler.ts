/**
 * Scheduler — the app's recurring server-side jobs.
 *
 *   - **SLA nudge:** scans each subreddit's open queue and nudges the mod team
 *     about appeals that have aged past the configured SLA window, so nothing
 *     rots silently in the queue. Also forwards the breach summary through
 *     the optional Notifier (W4) so a deployment can wire Slack/PagerDuty.
 *   - **Retention purge:** deletes resolved appeals whose retention window has
 *     elapsed, honouring the per-sub `retentionDays` setting. The store has
 *     always implemented `purgeExpired`, but nothing invoked it — so retention
 *     was advertised (README + THREAT_MODEL) yet never actually ran. This job
 *     wires it in.
 *   - **Snapshot purge (D6 / H1).** Sweeps unappealed action snapshots
 *     whose TTL has elapsed. TTL is the primary defence; the sweep is the
 *     belt-and-braces backup for hosts where TTL semantics drift.
 *   - **Rate-limit purge (D6 / H2).** Same pattern for idle rate-limit
 *     buckets. Closes the THREAT_MODEL §6 invariant 6 gap.
 *
 * Devvit schedulers run server-side on a cron. We register the jobs here and
 * install the crons on app install/upgrade (see settings.ts).
 */

import { Devvit } from '@devvit/public-api';
import { AppealStore, makeService } from './context.js';
import { isAging } from '../core/format.js';

export const SLA_NUDGE_JOB = 'appealdesk_sla_nudge';
export const RETENTION_PURGE_JOB = 'appealdesk_retention_purge';
export const SNAPSHOT_PURGE_JOB = 'appealdesk_snapshot_purge';
export const RATELIMIT_PURGE_JOB = 'appealdesk_ratelimit_purge';

Devvit.addSchedulerJob({
  name: SLA_NUDGE_JOB,
  onRun: async (_event, context) => {
    const sub = await context.reddit.getCurrentSubreddit();
    const store = new AppealStore(context.redis);
    const service = makeService(context);
    const config = await store.getConfig(sub.name);
    const queue = await store.openQueue(sub.name);

    const aging = queue.filter(
      (a) => a.status !== 'resolved' && isAging(a.createdAt, config.slaHours),
    );
    if (aging.length === 0) return;

    const lines = aging
      .slice(0, 10)
      .map((a) => `• u/${a.authorName} — ${a.actionType} (id ${a.id})`)
      .join('\n');

    try {
      await context.reddit.modMail.createModInboxConversation({
        subredditId: sub.id,
        subject: `Appealdesk: ${aging.length} appeal(s) aging past ${config.slaHours}h`,
        bodyMarkdown:
          `These open appeals have passed the ${config.slaHours}h SLA and ` +
          `need attention:\n\n${lines}\n\nOpen the Appealdesk dashboard to action them.`,
      });
    } catch {
      // Non-fatal; the dashboard still surfaces the backlog.
    }
    // W4: also forward through the Notifier if one is wired.
    try {
      await service.notifySlaBreach(sub.name, aging.length, config.slaHours);
    } catch {
      // Notifier failures are operational, never fatal.
    }
  },
});

/**
 * Daily retention purge. Walks the (bounded) purge index and deletes resolved
 * appeals past their retention window. `purgeExpired` is internally capped per
 * call, so we loop until a run returns fewer than the cap — that empties a
 * backlog over successive batches without one job pulling an unbounded set.
 */
Devvit.addSchedulerJob({
  name: RETENTION_PURGE_JOB,
  onRun: async (_event, context) => {
    const sub = await context.reddit.getCurrentSubreddit();
    const store = new AppealStore(context.redis);
    const batch = 100;
    // Cap total work per daily run to avoid pathological loops; a backlog
    // larger than this drains across subsequent days.
    const maxBatches = 50;
    for (let i = 0; i < maxBatches; i++) {
      const purged = await store.purgeExpired(sub.name, batch);
      if (purged.length < batch) break;
    }
  },
});

/** D6 / H1: snapshot purge. Same bounded-batch shape. */
Devvit.addSchedulerJob({
  name: SNAPSHOT_PURGE_JOB,
  onRun: async (_event, context) => {
    const sub = await context.reddit.getCurrentSubreddit();
    const store = new AppealStore(context.redis);
    const batch = 200;
    const maxBatches = 50;
    for (let i = 0; i < maxBatches; i++) {
      const n = await store.purgeExpiredSnapshots(sub.name, batch);
      if (n < batch) break;
    }
  },
});

/** D6 / H2: rate-limit bucket purge. Same bounded-batch shape. */
Devvit.addSchedulerJob({
  name: RATELIMIT_PURGE_JOB,
  onRun: async (_event, context) => {
    const sub = await context.reddit.getCurrentSubreddit();
    const store = new AppealStore(context.redis);
    const batch = 200;
    const maxBatches = 50;
    for (let i = 0; i < maxBatches; i++) {
      const n = await store.purgeExpiredRateLimits(sub.name, batch);
      if (n < batch) break;
    }
  },
});
