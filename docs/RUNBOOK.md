# Appealdesk — Operator Runbook

Operational reference for someone running Appealdesk in a live subreddit:
what to watch, how to diagnose common alerts, and how to drive each repair
manually when the schedulers aren't doing the job.

This is a companion to `docs/THREAT_MODEL.md` and `docs/ARCHITECTURE.md` —
those tell you *what* the system does and where the risks live; this tells
you *what to do* when something looks off.

---

## 1. Metrics: what to watch

All metrics flow through `Telemetry.metrics` (see `core/observability`). A
deployment can forward them to a real monitoring backend by replacing the
default `MemoryMetrics` in `context.ts`. The names below are stable.

### Health-of-the-queue

| Metric | Read it as |
|---|---|
| `appeal.created{sub}` | Steady-state intake rate. |
| `appeal.rate_limited{sub,scope}` | `scope=user` (M1) per-user limit; `scope=subwide` (D3) coordinated-cohort limit. Spikes in `subwide` are the early-warning for a botnet. |
| `appeal.decided{sub,decision}` | Decision throughput per outcome. |
| `appeal.decided_batch{sub}` | T2.2 batch volume. |
| `store.cas_retry{op}` | CAS retries inside `mutate`/rate-limit/lock — small numbers are normal; large numbers signal hot keys or scheduler thrash. |
| `store.cas_conflict{op}` | CAS *exhausted* the retry budget. Each occurrence surfaces a typed error to the caller; investigate any sustained signal. |

### Data lifecycle

| Metric | Read it as |
|---|---|
| `appeal.purged{sub}` | Retention sweep: resolved appeals dropped. |
| `snapshot.purged{sub}` | H1 sweep: unappealed action snapshots dropped. |
| `ratelimit.purged{sub}` | H2 sweep: idle rate-limit buckets dropped. |
| `snapshot.overwrite_skipped{sub}` | L4 fired: a same-target re-action was prevented from clobbering a pending appeal's snapshot. A few per day is normal; many per minute is a webhook loop. |
| `appeals.erased_for_user{sub}` | `eraseUser` (right-to-erasure) volume. |
| `appeal.erased_by_mod{sub}` | W1 mod-driven erasure volume — write a transparency-report scrape against `index:<sub>:erasure_log` if this is non-zero. |

### Latency rollups (D4)

`MemoryMetrics.percentile(name, q)` exposes a percentile estimate from each
metric's histogram. Forward `store.create`, `store.decide`, `store.mutate`,
`appeal.created`, and `appeal.decided` p50/p95/p99 to your dashboard. The
hot paths target sub-millisecond at the in-memory layer; real Redis adds
network RTT on top.

---

## 2. Alarming signals & responses

### Signal: `store.cas_conflict{op=mutate}` sustained > 1/min

A hot appeal-key is being CAS-thrashed. Most likely cause: two mod surfaces
have the same appeal open and are both submitting. Action:

1. Pull the recent log entries with `correlationId` from the failing
   surface (Finding D — every entry point logs a correlationId).
2. Confirm both writers are intentional. If yes, the typed error is the
   correct user-facing outcome; the UI should be retrying.
3. If a scheduler keeps colliding with a mod surface, lower the
   scheduler's cron frequency or sequence the job after the surface's
   request window.

### Signal: `snapshot.purged` is 0 for > 48h

The H1 sweep isn't running. Action:

1. Check the scheduler at the Devvit dashboard — confirm
   `appealdesk_snapshot_purge` is registered and firing.
2. Manually drive a sweep:
   ```ts
   await service.purgeSnapshots('<sub>', 1000);
   ```
3. If a backlog drains in one call, the cron was failing silently; if
   not, the index isn't being populated (the snapshot writes aren't
   reaching `store.writeSnapshot`). Confirm `triggers.ts` and
   `menu.tsx` aren't bypassing the helper.

### Signal: `appeal.rate_limited{scope=subwide}` spikes

A coordinated cohort is hitting the per-actionType bucket. Action:

1. Tighten `subwideRateLimitCapacity` / `subwideRateLimitRefillPerHour`
   in settings.
2. If the cohort persists, configure a policy `blockedReasonPatterns`
   (W3) for the matching `originalReason` so the policy gate rejects at
   intake without consuming a token.

### Signal: `RATE_LIMITED` errors with `OPTIMISTIC_LOCK_CONFLICT`-shaped retries

This is the M1 burst-contention path: two intakes raced on the bucket. It's
self-healing — the UI retries — and a healthy app sees a few of these per
day. Sustained signal means the rate-limit refill is too low for the actual
demand; raise `rateLimitCapacity` or `rateLimitRefillPerHour`.

### Signal: a mod reports "I edited this appeal's note but the chain failed verification"

The audit chain (D8) is doing its job. Action:

1. Call `verifyChain(appeal)` (or run the export tool) — note the `at`
   index of the tampered record.
2. Check the Redis WAL / Devvit backup for the pre-tamper record; if
   the tamper was an authorised edit, the chain CAN'T accommodate it
   because it's append-only by design. Issue a new decision record with
   the correction; the chain extends.

---

## 3. Manual operations

All entries below assume you have a `service: AppealService` constructed from
the current context — `makeService(context)` in `server/context.ts` is the
canonical way to get one.

### Drain a retention backlog now

```ts
let total = 0;
for (let i = 0; i < 100; i++) {
  const ids = await service.purgeRetention('<sub>', 200);
  total += ids.length;
  if (ids.length < 200) break;
}
console.log(`Purged ${total} resolved appeals`);
```

### Drain a snapshot backlog now (H1)

```ts
let total = 0;
for (let i = 0; i < 100; i++) {
  const n = await service.purgeSnapshots('<sub>', 500);
  total += n;
  if (n < 500) break;
}
```

### Drain idle rate-limit buckets now (H2)

```ts
let total = 0;
for (let i = 0; i < 100; i++) {
  const n = await service.purgeRateLimits('<sub>', 500);
  total += n;
  if (n < 500) break;
}
```

### Right-to-erasure for a user

```ts
const ids = await service.eraseUserByMod('<sub>', 'username', myModId, myModName);
console.log(`Erased ${ids.length} appeals; recorded in erasure log.`);
```

### Verify the audit chain for one appeal

```ts
import { verifyChain } from './core/audit.js';
const appeal = await store.getOrThrow('<sub>', appealId);
const result = verifyChain(appeal);
if (!result.ok) console.error(`Chain broken at index ${result.at}: ${result.reason}`);
```

### Recompute rule mappings (after editing the policy)

```ts
for (const id of await store.openQueue('<sub>').then((q) => q.map((a) => a.id))) {
  await service.remapRuleId('<sub>', id);
}
```

---

## 4. Recovery from `DATA_CORRUPTION`

`AppealStore.get` raises `DATA_CORRUPTION` when a present record fails to
parse as JSON. The error carries the offending key and a cause string.

Recovery steps:

1. **Capture the key.** Don't delete it; copy it to a safe location for
   forensics first.
2. **Confirm the corruption isn't transient** — re-fetch from Redis.
3. **Pull the last good copy from a backup** (if your deployment captures
   Devvit KV backups; not all do).
4. **If no backup exists**, the record is unrecoverable. The honest move
   is to delete the key and remove its references:
   ```ts
   const sub = '...'; const id = '...';
   const targetId = '...'; // from the corruption error's key, derive if known
   await context.redis.del(`appeal:${sub}:${id}`);
   await context.redis.zRem(`index:${sub}:open`, [id]);
   await context.redis.zRem(`index:${sub}:purge`, [id]);
   await context.redis.zRem(`index:${sub}:resolved`, [id]);
   // history requires the authorName; if you can't reconstruct it, accept
   // the dangling pointer — the `safeGet`-protected reads will log and skip.
   ```
5. **File a post-mortem entry** in the deployment's incident log. The
   corruption was either a serialisation bug (which warrants a code fix)
   or a write-during-redeploy (which warrants a deploy-process review).

---

## 5. Scheduler administration

The four cron jobs and their default schedules:

| Job | Cron | Purpose |
|---|---|---|
| `appealdesk_sla_nudge` | `0 */6 * * *` | Modmail + Notifier on aging appeals |
| `appealdesk_retention_purge` | `0 3 * * *` | Resolved-appeal retention sweep |
| `appealdesk_snapshot_purge` | `15 3 * * *` | H1: snapshot retention sweep |
| `appealdesk_ratelimit_purge` | `30 3 * * *` | H2: idle bucket sweep |

> **Naming note.** The Devvit slug is `appeal-desk` (hyphenated, matches the
> registered name on developers.reddit.com), but the scheduler job names use
> the underscored form `appealdesk_*` because they're internal identifiers
> that pre-date the slug rename and must stay stable — renaming them would
> orphan any scheduled job on an existing install. The Redis key prefixes
> (`appeal:`, `index:<sub>:open`, etc) are likewise unchanged for the same
> reason.

To re-register a job that fell out of the schedule, re-run
`onInstallOrUpgrade` (or simply re-install the app — install / upgrade
both call into `syncConfigFromSettings` + `runJob` with the same job
names, which is idempotent at the scheduler).
