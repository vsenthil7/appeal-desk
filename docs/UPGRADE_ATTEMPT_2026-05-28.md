# UPGRADE ATTEMPT \u2014 @devvit/public-api 0.11.x \u2192 0.13.0

> **Attempted on:** 2026-05-28 00:01 BST
> **Branch:** `upgrade/devvit-0.13` (this branch)
> **Base commit:** da63d58 (the submission tip on `main`)
> **Outcome:** STOPPED \u2014 not a routine version bump; significant API redesign required.

## Why this attempt happened

The Devvit developer dashboard surfaces a banner whenever the project's
`@devvit/public-api` minor lags the installed CLI:

> *"A new version of Devvit (0.13.0) is now available. Please update to the
> latest version and upload a new build of your app."*

Our CLI is already 0.13.0 (installed globally as the `devvit` wrapper); our
project's runtime dep was pinned to `@devvit/public-api: "0.11.x"`. So the
banner was asking for a runtime bump, not a CLI bump.

This branch was created at da63d58 to attempt the bump in isolation,
keeping the submission on `main` safe.

## What was tried

```
1. Edit package.json: "@devvit/public-api": "0.11.x" \u2192 "0.13.0"
2. npm install (regen lock, fetch 0.13.0)        \u2014 OK, 6.5s
3. npx tsc --noEmit                                \u2014 FAILED with ~150 errors
4. npm run lint                                    \u2014 passed (lint is structural, not type)
```

## Why it failed

`@devvit/public-api@0.13` is not a routine minor bump from 0.11.x. It is a
substantial public-API redesign affecting the *entire* `.tsx` shell:

| Breaking change | Files touched in this repo |
|---|---|
| `JSX.Element` / `JSX.IntrinsicElements` no longer ambient | every `.tsx` (~150 errors) |
| Hooks removed from `@devvit/public-api`: `useState`, `useAsync`, `useForm` | `AppealsDashboardPost.tsx` |
| `Devvit.addCustomPostType` removed / renamed | `main.tsx` |
| `Devvit.CustomPostComponent` type removed | `AppealsDashboardPost.tsx` |
| `SubmitPostOptions.preview` removed | `server/menu.tsx` |

The `core/` + `ai/` layers (the platform-free 2,100 LOC that hold 100 % test
coverage) are completely untouched by the upgrade \u2014 those modules import
nothing from Devvit. **Every test still passes** because tests don't depend
on the `.tsx` surface. The failures are all in the shell.

Migrating to 0.13 means rewriting the shell against the new API surface:
new custom-post registration model, hooks moved (or replaced with the new
`@devvit/web` patterns), new JSX wiring, new submit/preview API. Realistic
estimate: 4-6 hours of careful work plus a full re-test of the live
playtest path. Not feasible in the ~2 hours before the AT-Hack0022 deadline
(02:00 BST).

## What was preserved

- **`main` is untouched** at da63d58.
- **The submission package on `main` is complete**: 6 commits, 288/288
  tests, 99.97 % coverage, v0.0.2 uploaded to `developers.reddit.com/apps/appeal-desk`,
  installed on `r/appeal_desk_dev`, all media artefacts in
  `submission_media/`.
- **0.11.x is still fully supported by the platform.** Reddit accepted our
  v0.0.2 upload on the 0.11.19 public-api without complaint. The dashboard
  banner is an *encouragement*, not a *gate*.

## What this branch contains

After the failed attempt:

- `package.json` reverted to `"@devvit/public-api": "0.11.x"` (from `git checkout HEAD`).
- `package-lock.json` reverted likewise.
- This document, committed as the visible record of the attempt.

The branch is left in place (rather than deleted) so the attempt is
auditable. Backups of the original tracked files were taken before any edits
to:
- `_backup/package.json.HEAD-da63d58.20260527-234618`
- `_backup/package-lock.json.HEAD-da63d58.20260527-234618`
- `_backup/devvit.yaml.HEAD-da63d58.20260527-234618`

## Recommendation for the next sprint

Do the 0.13 migration in a dedicated post-submission session. Steps:

1. Read the official 0.11 \u2192 0.13 migration guide on developers.reddit.com
   (almost certainly published; we didn't have time to consult it tonight).
2. Decide between **two paths**:
   - **Stay on classic Devvit 0.13 hooks API** \u2014 rewrite components against
     the new hook/JSX wiring. Smaller delta from current code.
   - **Migrate to `@devvit/web`** \u2014 the newer post architecture (Express + web
     view + Devvit client). Bigger rewrite, future-proof for 1.0.
3. Rewrite shell incrementally, with the test suite as a safety net (core
   layer requires no changes).
4. `devvit upload` v0.0.3 once the shell type-checks and the playtest sub
   exercises happy path.
5. Merge `upgrade/devvit-0.13` (or its successor) into `main`.

The submission on `main` does not depend on this work landing.
