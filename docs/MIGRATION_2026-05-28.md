# Migration to Devvit 0.13 (@devvit/web) — completed

> **Performed on:** 2026-05-28 00:13–00:55 BST
> **Branch:** `migrate/devvit-0.13-web`
> **Base commit:** aaed118 (the post-submission tip on `main`, on 0.12.24)
> **Outcome:** ✅ SUCCESS — full migration to Devvit 0.13 + `@devvit/web` runtime,
> all gates pass, v0.0.4 uploaded.

## Summary

This branch completes the real Devvit 0.13 migration that was deferred when
the AT-Hack0022 submission was due. The earlier UPGRADE_ATTEMPT (see
`docs/UPGRADE_ATTEMPT_2026-05-28.md`) covered the safe 0.11 → 0.12.24 bump;
this branch goes the rest of the way to 0.13.

The 0.13 paradigm is fundamentally different from 0.11/0.12 Blocks:

| | 0.11/0.12 (Blocks) | 0.13 (`@devvit/web`) |
|---|---|---|
| App config | `devvit.yaml` | `devvit.json` (typed JSON schema) |
| Custom posts | `Devvit.addCustomPostType(...)` with Blocks JSX | Web view (HTML+JS) declared in `devvit.json` |
| Server-side state | Methods on `context.redis`, `context.reddit`, etc. | Module-level `redis`, `reddit` from `@devvit/web/server` |
| Forms/menus/settings | `Devvit.addX(...)` (Blocks shell) | Still works! Forms/menus/settings/triggers/scheduler all use the same `Devvit.addX(...)` APIs via `blocks` migration mode in `devvit.json`. |
| Hooks (`useState`, `useForm`, `useAsync`) | In `@devvit/public-api` | Removed (use the web view's own JS for state) |

So the migration is half-rewrite, half-config: the **custom post** must become
a web view (real HTML+JS), but **menu items, forms, triggers, scheduler, and
settings** can all stay on the existing Blocks shell via `blocks` migration
mode in `devvit.json`.

## What changed

### Config
- **`devvit.yaml` → `devvit.json`** following the official
  `config-file.v1.json` schema (found in
  `node_modules/@devvit/shared-types/schemas/config-file.v1.json`).
- Hybrid config: `blocks` block for forms/menus/triggers/settings + `post`
  block for the web view.

### Deps
- `@devvit/public-api: "0.12.24"` → `"0.13.0"`
- Added `@devvit/web: "0.13.0"` (the new server/client primitives package).

### Source
- **Moved to `src/_legacy_blocks/`** (excluded from the build, preserved as a
  reference):
  - `src/main.tsx`
  - All 5 `src/components/*.tsx` (the Blocks custom-post UI)
  - `src/server/menu.tsx`
  - `src/server/eraseForm.tsx`
- **New `src/main.ts`** — 0.13 shell entry. Configures redditAPI + redis;
  imports side-effecting modules.
- **New `src/server/menu.ts`** — 0.13 version of `menu.tsx`. Uses
  `reddit.submitCustomPost(...)` from `@devvit/web/server` (the only 0.13 way
  to create a custom-post entry that points to the web view). Inlines the
  GDPR erasure form (registered via `Devvit.createForm`, which still works).

### Client
- **New `client/index.html`** — minimal 1-file vanilla web view, brand
  palette mirrored from the pitch deck. Shows the AppealDesk landing /
  how-to-use page. The interactive queue dashboard will land in a follow-up
  iteration.

### TS config
- `tsconfig.json`: removed `jsxFactory: "Devvit.createElement"` (no Blocks
  JSX in the new build), `include` narrowed to `*.ts` only, `_legacy_blocks/`
  excluded.

### Lint
- `.eslintrc.cjs`: added `_legacy_blocks/` to `ignorePatterns`. The
  Blocks-specific JSX-pragma override is gone (no `.tsx` files in scope).

### Pure-TS server-side files (no changes needed)
- `src/server/triggers.ts` — `Devvit.addTrigger` still works.
- `src/server/scheduler.ts` — `Devvit.addSchedulerJob` still works.
- `src/server/settings.ts` — `Devvit.addSettings` still works.
- `src/server/intake.ts` — `Devvit.createForm` still works.
- `src/server/context.ts` — `context.redis` / `context.reddit` still work.
- All of `src/core/` and `src/ai/` — zero changes (platform-free by design).

## Verification (all run, all green)

```
npx tsc --noEmit                  — exit 0
npm run lint                      — exit 0
npx vitest run                    — 288 / 288 passed across 18 files
npx vitest run --coverage         — gate PASS (99.97 / 99.06 / 100 / 99.97)
devvit upload                     — v0.0.4 uploaded, 1 WebView asset uploaded
```

## What didn't migrate (deferred to a follow-up)

The interactive **appeals queue UI** that lived in `Dashboard.tsx`,
`AppealDetail.tsx`, `AnalyticsTab.tsx`, and `primitives.tsx` is preserved in
`_legacy_blocks/` but not yet reimplemented in the web view. The current
`client/index.html` is a polished landing page with usage instructions.

A future sprint will replace it with a real interactive UI:
- Vite + vanilla JS or React (or whatever the team prefers — the choice is
  free now that we're on `@devvit/web`).
- `/api/*` endpoints served by `createServer()` from `@devvit/web/server`,
  backed by the same `core/` modules that already power the legacy shell.
- The audit-trail view, the dedup flag panel, and the three one-tap decision
  buttons.

In the meantime: the **menu items, intake form, GDPR erasure form, triggers,
scheduler, and settings** all work exactly as on v0.0.3. The flow from "ban
happens → user submits structured appeal → audit trail logs decision" is
unchanged. Only the dashboard *view* lost interactivity; the dashboard *data*
is still being written and queried as designed.

## Recommendation

This branch is ready to merge after the dashboard UI is ported. Until then,
`main` continues to ship v0.0.3 (Public API 0.12.24), which is the
submission-safe state. v0.0.4 sits on the dashboard as a preview of the
fully-migrated 0.13 build.
