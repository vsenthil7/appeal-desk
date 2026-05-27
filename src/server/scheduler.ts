/**
 * Scheduler — the "SLA feel". A recurring job scans each subreddit's open
 * queue and nudges the mod team about appeals that have aged past the
 * configured SLA window, so nothing rots silently in the queue.
 *
 * Devvit schedulers run server-side on a cron. We register the job here and
 * install the cron on app install (see settings.ts / main.ts).
 */

import { Devvit } from '@devvit/public-api';
import { AppealStore } from './context.js';
import { isAging } from '../core/format.js';

export const SLA_NUDGE_JOB = 'appealdesk_sla_nudge';

Devvit.addSchedulerJob({
  name: SLA_NUDGE_JOB,
  onRun: async (_event, context) => {
    const sub = await context.reddit.getCurrentSubreddit();
    const store = new AppealStore(context.redis);
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
  },
});
