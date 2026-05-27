/**
 * Settings & install lifecycle.
 *
 * Per-subreddit settings let mods toggle the optional AI layer, set the SLA
 * window, and edit reply templates without touching code. On install we kick
 * off the SLA scheduler and seed default config.
 */

import { Devvit } from '@devvit/public-api';
import type { TriggerContext } from '@devvit/public-api';
import { AppealStore } from './context.js';
import { DEFAULT_CONFIG, type AppealDecision } from '../core/types.js';
import { SLA_NUDGE_JOB } from './scheduler.js';

Devvit.addSettings([
  {
    type: 'boolean',
    name: 'aiEnabled',
    label: 'Enable optional AI triage & tone-softening (assistive only — never decides)',
    defaultValue: false,
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'slaHours',
    label: 'Hours before an open appeal is flagged as aging',
    defaultValue: 48,
    scope: 'installation',
  },
  {
    type: 'paragraph',
    name: 'templateUpheld',
    label: 'Reply template — Upheld',
    defaultValue: DEFAULT_CONFIG.templates.upheld,
    scope: 'installation',
  },
  {
    type: 'paragraph',
    name: 'templateOverturned',
    label: 'Reply template — Overturned',
    defaultValue: DEFAULT_CONFIG.templates.overturned,
    scope: 'installation',
  },
  {
    type: 'paragraph',
    name: 'templateMoreInfo',
    label: 'Reply template — Need more info',
    defaultValue: DEFAULT_CONFIG.templates.more_info,
    scope: 'installation',
  },
]);

/**
 * Sync the editable settings into our persisted SubredditConfig. Called on
 * install and whenever an appeal is created (cheap, keeps config fresh without
 * a settings-change webhook).
 */
export async function syncConfigFromSettings(
  context: TriggerContext,
): Promise<void> {
  const sub = context.subredditName;
  if (!sub) return;
  const store = new AppealStore(context.redis);

  const aiEnabled = (await context.settings.get<boolean>('aiEnabled')) ?? false;
  const slaHours = (await context.settings.get<number>('slaHours')) ?? 48;
  const templates: Record<AppealDecision, string> = {
    upheld:
      (await context.settings.get<string>('templateUpheld')) ??
      DEFAULT_CONFIG.templates.upheld,
    overturned:
      (await context.settings.get<string>('templateOverturned')) ??
      DEFAULT_CONFIG.templates.overturned,
    more_info:
      (await context.settings.get<string>('templateMoreInfo')) ??
      DEFAULT_CONFIG.templates.more_info,
  };

  await store.setConfig(sub, {
    ...DEFAULT_CONFIG,
    aiEnabled,
    slaHours,
    templates,
  });
}

/** On install: seed config and schedule the SLA nudge (every 6 hours). */
Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event, context) => {
    await syncConfigFromSettings(context);
    await context.scheduler.runJob({
      name: SLA_NUDGE_JOB,
      cron: '0 */6 * * *', // every 6 hours
    });
  },
});
