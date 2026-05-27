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
import {
  SLA_NUDGE_JOB,
  RETENTION_PURGE_JOB,
  SNAPSHOT_PURGE_JOB,
  RATELIMIT_PURGE_JOB,
} from './scheduler.js';

Devvit.addSettings([
  {
    type: 'boolean',
    name: 'aiEnabled',
    label: 'Enable optional AI triage & tone-softening (assistive only — never decides)',
    defaultValue: false,
    scope: 'installation',
  },
  {
    type: 'string',
    name: 'aiBackend',
    label: "AI backend selector — 'devvit' (use runtime model) or 'noop' (force off)",
    defaultValue: 'devvit',
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'aiConfidenceFloor',
    label: 'Hide AI hints below this confidence (0..1). 0 = show all.',
    defaultValue: 0,
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
    type: 'number',
    name: 'rateLimitCapacity',
    label: 'Max appeals a single user may file in a burst',
    defaultValue: DEFAULT_CONFIG.rateLimitCapacity,
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'rateLimitRefillPerHour',
    label: 'Appeals replenished per hour (rate-limit refill)',
    defaultValue: DEFAULT_CONFIG.rateLimitRefillPerHour,
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'subwideRateLimitCapacity',
    label: 'Sub-wide rate-limit burst capacity per actionType (0 = disabled)',
    defaultValue: DEFAULT_CONFIG.subwideRateLimitCapacity,
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'subwideRateLimitRefillPerHour',
    label: 'Sub-wide rate-limit refill per hour',
    defaultValue: DEFAULT_CONFIG.subwideRateLimitRefillPerHour,
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'retentionDays',
    label: 'Days to keep resolved appeals before purge (0 = keep forever)',
    defaultValue: DEFAULT_CONFIG.retentionDays,
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'snapshotRetentionHours',
    label: 'Hours an unappealed action snapshot lives before retention sweeps it',
    defaultValue: DEFAULT_CONFIG.snapshotRetentionHours,
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'rateLimitIdleHours',
    label: 'Hours an idle rate-limit bucket lives before it is swept',
    defaultValue: DEFAULT_CONFIG.rateLimitIdleHours,
    scope: 'installation',
  },
  {
    type: 'number',
    name: 'claimTtlMinutes',
    label: 'Minutes a mod can hold an unrenewed claim before it auto-releases (0 = disable claims)',
    defaultValue: DEFAULT_CONFIG.claimTtlMinutes,
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
 * install, on upgrade, and on every appeal submission (see intake.ts) so a
 * mod's settings changes take effect without reinstalling — cheap, and avoids
 * needing a dedicated settings-change webhook.
 *
 * Two perf improvements over the previous (sequential, always-write) shape:
 *
 *   - **Parallel reads (Finding C).** The fifteen `settings.get` calls now
 *     run via `Promise.all` so they don't gate on each other's round-trips.
 *   - **Hash short-circuit (D9).** The synced tuple is hash-stamped and the
 *     hash is persisted at `config:<sub>:hash`. A no-change submit skips the
 *     `setConfig` write entirely. On Devvit's hosted settings the reads are
 *     cheap, but skipping the write halves the per-intake floor when nothing
 *     drifted (which is the common case).
 */
const CONFIG_HASH_KEY_SUFFIX = ':hash';

export async function syncConfigFromSettings(
  context: TriggerContext,
): Promise<void> {
  const sub = context.subredditName;
  if (!sub) return;
  const store = new AppealStore(context.redis);

  // Finding C: parallel reads.
  const [
    aiEnabled,
    aiBackend,
    aiConfidenceFloor,
    slaHours,
    rateLimitCapacity,
    rateLimitRefillPerHour,
    subwideRateLimitCapacity,
    subwideRateLimitRefillPerHour,
    retentionDays,
    snapshotRetentionHours,
    rateLimitIdleHours,
    claimTtlMinutes,
    templateUpheld,
    templateOverturned,
    templateMoreInfo,
  ] = await Promise.all([
    context.settings.get<boolean>('aiEnabled'),
    context.settings.get<string>('aiBackend'),
    context.settings.get<number>('aiConfidenceFloor'),
    context.settings.get<number>('slaHours'),
    context.settings.get<number>('rateLimitCapacity'),
    context.settings.get<number>('rateLimitRefillPerHour'),
    context.settings.get<number>('subwideRateLimitCapacity'),
    context.settings.get<number>('subwideRateLimitRefillPerHour'),
    context.settings.get<number>('retentionDays'),
    context.settings.get<number>('snapshotRetentionHours'),
    context.settings.get<number>('rateLimitIdleHours'),
    context.settings.get<number>('claimTtlMinutes'),
    context.settings.get<string>('templateUpheld'),
    context.settings.get<string>('templateOverturned'),
    context.settings.get<string>('templateMoreInfo'),
  ]);

  const templates: Record<AppealDecision, string> = {
    upheld: templateUpheld ?? DEFAULT_CONFIG.templates.upheld,
    overturned: templateOverturned ?? DEFAULT_CONFIG.templates.overturned,
    more_info: templateMoreInfo ?? DEFAULT_CONFIG.templates.more_info,
  };

  const synced = {
    ...DEFAULT_CONFIG,
    aiEnabled: aiEnabled ?? false,
    aiBackend: aiBackend ?? DEFAULT_CONFIG.aiBackend,
    aiConfidenceFloor: aiConfidenceFloor ?? DEFAULT_CONFIG.aiConfidenceFloor,
    slaHours: slaHours ?? DEFAULT_CONFIG.slaHours,
    rateLimitCapacity: rateLimitCapacity ?? DEFAULT_CONFIG.rateLimitCapacity,
    rateLimitRefillPerHour:
      rateLimitRefillPerHour ?? DEFAULT_CONFIG.rateLimitRefillPerHour,
    subwideRateLimitCapacity:
      subwideRateLimitCapacity ?? DEFAULT_CONFIG.subwideRateLimitCapacity,
    subwideRateLimitRefillPerHour:
      subwideRateLimitRefillPerHour ??
      DEFAULT_CONFIG.subwideRateLimitRefillPerHour,
    retentionDays: retentionDays ?? DEFAULT_CONFIG.retentionDays,
    snapshotRetentionHours:
      snapshotRetentionHours ?? DEFAULT_CONFIG.snapshotRetentionHours,
    rateLimitIdleHours:
      rateLimitIdleHours ?? DEFAULT_CONFIG.rateLimitIdleHours,
    claimTtlMinutes: claimTtlMinutes ?? DEFAULT_CONFIG.claimTtlMinutes,
    templates,
  };

  // D9: hash-stamp short-circuit.
  const hash = quickHash(JSON.stringify(synced));
  const hashKey = `config:${sub}${CONFIG_HASH_KEY_SUFFIX}`;
  const priorHash = await context.redis.get(hashKey);
  if (priorHash === hash) {
    return; // settings unchanged — skip the write.
  }
  await store.setConfig(sub, synced);
  await context.redis.set(hashKey, hash);
}

/** Tiny, fast, NON-cryptographic hash used purely for change detection.
 *  FNV-1a 32-bit, hex-encoded. Production code uses this to short-circuit
 *  no-op config writes (D9) — a real digest would be overkill here. */
function quickHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Install / upgrade lifecycle. On both we (re)seed config from settings and
 * (re)install the recurring cron jobs: the SLA nudge AND the retention purge.
 * Re-running on upgrade is safe — `runJob` with the same name replaces the
 * existing schedule rather than stacking duplicates — and it's the mechanism by
 * which a settings change picked up at upgrade time takes effect.
 */
async function onInstallOrUpgrade(context: TriggerContext): Promise<void> {
  await syncConfigFromSettings(context);
  await context.scheduler.runJob({
    name: SLA_NUDGE_JOB,
    cron: '0 */6 * * *', // every 6 hours
  });
  await context.scheduler.runJob({
    name: RETENTION_PURGE_JOB,
    cron: '0 3 * * *', // daily at 03:00
  });
  // D6 sweeps for the new index families. Run them daily on offset hours so
  // they don't all stack against the same minute.
  await context.scheduler.runJob({
    name: SNAPSHOT_PURGE_JOB,
    cron: '15 3 * * *',
  });
  await context.scheduler.runJob({
    name: RATELIMIT_PURGE_JOB,
    cron: '30 3 * * *',
  });
}

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (_event, context) => {
    await onInstallOrUpgrade(context);
  },
});

Devvit.addTrigger({
  event: 'AppUpgrade',
  onEvent: async (_event, context) => {
    await onInstallOrUpgrade(context);
  },
});
