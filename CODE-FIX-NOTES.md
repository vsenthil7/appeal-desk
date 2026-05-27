# AppealDesk — Code Fix Notes

All fixes below were verified by running the project, not just reading it:
`npm install` ✅ · `tsc --noEmit` ✅ zero errors · `npm run lint` ✅ now clean ·
`vitest run` ✅ **205 passed** (was 197) · coverage ✅ **100%** stmts/branch/funcs/lines ·
`tsx bench/run.ts` ✅ runs (openQueuePage slightly faster after the bounded-read fix).

## Bugs fixed

### Finding 1 — `npm run lint` was broken (HIGH)
No ESLint config existed, so the advertised command errored out. Added
`.eslintrc.cjs` (`@typescript-eslint` recommended, scoped to `src/`) and the two
`@typescript-eslint/*` devDependencies. The only issues that surfaced were
intentional code — the `Devvit` JSX-pragma import required by
`jsxFactory: "Devvit.createElement"`, and the deliberate control-char regex in
the sanitiser — so those are exempted via targeted rule config rather than by
changing working code.

### Findings 2 & 3 — pagination tie-skip + unbounded read (MEDIUM)
- **Tie-safe cursor:** `Page.nextCursor` is now a `{score, id}` tuple, not a bare
  score. The old `cursor - 1` boundary skipped every other entry that shared an
  exact millisecond; the new `isAfterCursor` comparison continues strictly after
  the `(score, id)` position. New test creates 5 appeals in the same millisecond
  and asserts all 5 page through exactly once.
- **Bounded read:** `ZRangeOptions` now exposes the `limit: {offset, count}`
  field that Devvit's real `zRange` already supports. `openQueuePage` reads only
  ~`limit + 1` members instead of hydrating the whole open index. New test spies
  on `zRange` and asserts the requested `count` is bounded (< full index).

### Finding 5 — `purgeExpired` over-fetched before slicing (LOW)
Given the same bounded-read treatment (`limit: {offset, count}`), symmetric with
`openQueuePage`.

### Finding 4 — action snapshot smuggled through the lock key (LOW)
Added a first-class `keys.actionSeed(sub, targetId)` → `actionseed:<sub>:<targetId>`
and routed all three server call sites (`intake.ts`, `triggers.ts`, `menu.tsx`)
through it, removing the `action:` namespace collision. Also fixed the snapshot's
forever-leak: it is now deleted when the appeal resolves and on erasure (the
latter closes a PII residual where the original content survived a GDPR redaction).

### Finding 7 — stray `ms` field + cast in `MemoryMetrics.timing` (NIT)
Dropped the non-interface `ms` property and the `as MetricEvent` cast; `value`
already holds the duration.

## Wiring bugs (from the second review)

### `syncConfigFromSettings` only ran on install
Settings edits were ignored until reinstall. Now also synced on every appeal
submission (`intake.ts`) and on `AppUpgrade`, matching what the function's own
docstring always claimed. Docstring corrected to match reality.

### Retention / erasure were dead code
`purgeExpired` / `redactAppeal` existed but nothing called them. Added a daily
`appealdesk_retention_purge` scheduler job that drains the purge index in bounded
batches, and exposed `eraseAppeal` / `eraseUser` / `purgeRetention` on
`AppealService` so erasure is reachable and testable from the shell.

## Correction to a reported "bug"

The second review listed `Devvit.configure({ scheduler: true })` in `main.tsx`
as a confirmed bug. Verified against the installed `@devvit/public-api@0.11.19`
types: `scheduler` is **not** a member of the `Configuration` type — adding it
would be a compile error. Scheduler is enabled by `scheduler: true` in
`devvit.yaml` (already present) plus `Devvit.addSchedulerJob`. No change made;
the misleading comment in `main.tsx` was corrected instead.

## Not done (out of scope for a code fix)
- A mod-facing "Erase a user" menu item and analytics/policy/notifications
  modules are *width* enhancements, not defects; the erasure capability they'd
  call is now wired and tested at the service layer.
- A repo-wide `prettier --write` was deliberately skipped: the codebase was not
  prettier-clean before these changes, so reformatting would bury the fixes in
  unrelated diff noise. New code follows the surrounding style by hand.
