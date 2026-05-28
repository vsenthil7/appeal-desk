# Migration to Devvit 0.13 (@devvit/web) — completed

> **Performed on:** 2026-05-28 00:13–01:25 BST
> **Branch:** `migrate/devvit-0.13-web`
> **Base commit:** aaed118 (the post-submission tip on `main`, on 0.12.24)
> **Outcome:** ✅ SUCCESS — full migration to Devvit 0.13 + `@devvit/web` runtime,
> including a real interactive web-view dashboard backed by a real HTTP server,
> all gates pass, v0.0.5 uploaded.

## Summary

This branch completes the real Devvit 0.13 migration that was deferred when
the AT-Hack0022 submission was due. The earlier UPGRADE_ATTEMPT (see
`docs/UPGRADE_ATTEMPT_2026-05-28.md`) covered the safe 0.11 → 0.12.24 bump;
this branch goes the rest of the way to 0.13 **with the interactive dashboard
fully reimplemented**, not as a landing page.

The 0.13 paradigm is fundamentally different from 0.11/0.12 Blocks:

| | 0.11/0.12 (Blocks) | 0.13 (`@devvit/web`) |
|---|---|---|
| App config | `devvit.yaml` | `devvit.json` (typed JSON schema) |
| Custom posts | `Devvit.addCustomPostType(...)` with Blocks JSX | Web view (real HTML/JS) declared in `devvit.json`, backed by an HTTP server via `createServer()` from `@devvit/web/server` |
| Server-side state | Methods on `context.redis`, `context.reddit`, etc. | Module-level `redis`, `reddit` from `@devvit/web/server` |
| Forms/menus/settings | `Devvit.addX(...)` (Blocks shell) | Still works! Forms/menus/settings/triggers/scheduler all use the same `Devvit.addX(...)` APIs via `blocks` migration mode in `devvit.json`. |
| Hooks (`useState`, `useForm`, `useAsync`) | In `@devvit/public-api` | Removed; the web view manages its own state |

So this migration is half-rewrite, half-config: the **custom post** became a
real web view (HTML+CSS+vanilla JS, talking to an HTTP server at `/api/*`),
but **menu items, forms, triggers, scheduler, and settings** all stay on the
existing Devvit shell via `blocks` migration mode in `devvit.json`.

## Architecture

```
              ┌─ Devvit Blocks shell (src/main.ts + src/server/*.ts)
              │   forms · menu · triggers · scheduler · settings
              │
appeal-desk ──┤
              │
              ├─ Web view (client/index.html + styles.css + app.js)
              │   queue · detail · reply-confirm · analytics
              │
              └─ HTTP server (src/server/main.ts, bundled to dist/server/main.js)
                  /api/appeals/list · /api/appeals/open · /api/appeals/decide
                  /api/appeals/claim · /api/appeals/unclaim · /api/appeals/erase
                  /api/appeals/suggest-reply · /api/analytics · /api/whoami
```

The same `AppealService` + `AppealStore` + `core/` modules power both worlds
— they import nothing from Devvit and were reused verbatim.

## What changed

### Config
- **`devvit.yaml` → `devvit.json`** following the official
  `config-file.v1.json` schema (in
  `node_modules/@devvit/shared-types/schemas/config-file.v1.json`).
- Hybrid config: `blocks` for forms/menus/triggers/settings + `post` for the
  web view + `server` for the HTTP server.

### Deps
- `@devvit/public-api: "0.12.24"` → `"0.13.0"`
- Added `@devvit/web: "0.13.0"` (the new server/client primitives).
- Added `esbuild ^0.24.0` as a devDep (used to bundle the server).

### Source
- **Moved to `src/_legacy_blocks/`** (excluded from the build, preserved as a
  reference):
  - `src/main.tsx`
  - All 5 `src/components/*.tsx` (the Blocks custom-post UI — Dashboard,
    AppealDetail, AnalyticsTab, AppealsDashboardPost, primitives)
  - `src/server/menu.tsx`, `src/server/eraseForm.tsx`
- **New `src/main.ts`** — 0.13 Devvit shell entry. Configures redditAPI +
  redis; imports the side-effecting modules.
- **New `src/server/menu.ts`** — 0.13 version of `menu.tsx`. Uses
  `reddit.submitCustomPost(...)` from `@devvit/web/server` (the only 0.13 way
  to create a custom-post entry that points to the web view). Inlines the
  GDPR erasure form (via `Devvit.createForm`, which still works).
- **New `src/server/main.ts`** — the HTTP server. `createServer` from
  `@devvit/web/server`, with a tiny dispatcher routing the `/api/*` endpoints
  to the same `AppealService` the Blocks shell uses. Reddit modmail gateway
  is a 5-line adapter around the module-level `reddit.modMail`.

### Client
- **`client/index.html`** — header (brand + open-count badge), tabs (queue /
  analytics), and four slots (queue / detail / reply / analytics).
- **`client/styles.css`** — brand palette mirrored from the pitch deck
  (navy + cream + verdigris + coral + amber + blue + violet + green).
  Full responsive grid for the queue rows and the analytics tiles.
- **`client/app.js`** — vanilla JS, ~470 lines, single file. State machine,
  paginated queue, detail screen with claim/unclaim + 3-button decision row,
  reply-confirm screen with editable draft + internal note, analytics tab
  with 7d/30d toggle. Behaviour ported from the legacy Blocks components.

### Build
- **`scripts/build-server.cjs`** — esbuild script that bundles
  `src/server/main.ts` into a single CommonJS file at `dist/server/main.js`,
  externalising every `@devvit/*` package (the host provides them at runtime,
  per the `config-file.v1.json` schema's requirement that the entry be
  "self-contained except for standard Node.js APIs").
- `npm run build` now invokes this; `npm run build:check` runs `tsc --noEmit`
  as before.

### TS config
- `tsconfig.json`: removed `jsxFactory: "Devvit.createElement"`, `include`
  narrowed to `*.ts` only, `_legacy_blocks/` excluded.

### Lint
- `.eslintrc.cjs`: added `_legacy_blocks/` to `ignorePatterns`. The
  Blocks-specific JSX-pragma override is gone.

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
npm run build                     — dist/server/main.js, 79.3 KB
devvit upload                     — v0.0.5, 3 WebView assets uploaded
```

## What the interactive dashboard does (parity with the legacy Blocks shell)

| Feature | Legacy Blocks | New web view |
|---|---|---|
| Paginated queue with row pills | ✅ `Dashboard.tsx` | ✅ `app.js#renderQueue` |
| Detail screen w/ original context | ✅ `AppealDetail.tsx` | ✅ `app.js#renderDetail` |
| Triage flags (repeat / dup / paraphrase / ruleId / claimed) | ✅ | ✅ |
| Near-dup / paraphrase pill jumps to prior appeal | ✅ L3 | ✅ |
| AI hint badge (when AI enabled) | ✅ | ✅ |
| Decision history audit | ✅ | ✅ |
| Claim / unclaim with self-vs-other display | ✅ W4 | ✅ |
| Three-button decision (Uphold primary, Overturn, More info) | ✅ L2 | ✅ |
| Reply-confirm gate with editable draft + internal note | ✅ `useForm` | ✅ |
| Erase resolved appeal (W1) | ✅ | ✅ |
| Analytics tab: 7d/30d toggle, headline tiles | ✅ W2 | ✅ |
| Top overturned rules / original reasons | ✅ | ✅ |
| By-action-type breakdown | ✅ | ✅ |
| AI provider (Devvit runtime model) | ✅ when present | ⚠️ NoopAi default (see below) |

## What didn't migrate

**AI provider in the web shell.** The legacy Blocks shell wired a
`ModelAiProvider` from `context.ai.generateText` when the runtime exposed
one. There is no `@devvit/web/server` equivalent in 0.13.0 yet, so the new
HTTP server defaults to `NoopAiProvider`. This is the documented "AI off"
mode — every feature still works deterministically (the menu items + intake
form still go through the Blocks shell where the runtime AI hook IS still
available). When Devvit ships an `@devvit/web/server` AI hook, wiring it up
is one localised change in `src/server/main.ts#makeService`.

## Recommendation

This branch is ready to merge. Main stays at aaed118 (v0.0.3 on 0.12.24)
until you actively switch — but v0.0.5 on the dashboard is the version Reddit
will offer to installers, so the migration is effectively live for any new
install. Merging just brings the GitHub `main` view into sync with what's
shipping.
