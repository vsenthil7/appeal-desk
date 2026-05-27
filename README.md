# Appealdesk

**A structured, fair appeals workflow for Reddit removals & bans.**
Built on Reddit's Developer Platform (Devvit) for *Track 1 — Best New Mod Tool*.

Appealdesk turns the worst part of moderation — appeals — from a stream of angry,
context-free modmail into a structured queue with one-tap decisions, a full audit
trail, automatic duplicate detection, and templated civil replies. It is a
brand-new Devvit app: not a port, and nothing like it exists on Reddit today.

---

## Table of contents

1. [The problem](#the-problem)
2. [What Appealdesk does](#what-appealdesk-does)
3. [How it works (end to end)](#how-it-works-end-to-end)
4. [Architecture](#architecture)
5. [The AI stance: assistive, never decisive](#the-ai-stance-assistive-never-decisive)
6. [Installing & using it](#installing--using-it)
7. [Configuration](#configuration)
8. [Project layout](#project-layout)
9. [Data model & Redis schema](#data-model--redis-schema)
10. [Development, testing & coverage](#development-testing--coverage)
11. [Design decisions & trade-offs](#design-decisions--trade-offs)

---

## The problem

When a user is banned or has content removed, their only recourse is modmail.
Appeals arrive as unstructured, often angry free-text messages mixed in with every
other modmail. There is no standard form, no link back to the original removal, no
record of what was decided last time, and no way to spot a user spamming the same
appeal. Mods either rubber-stamp, ignore, or argue — and the process feels
arbitrary to users, which fuels resentment.

Appeals are one of the highest-friction, most emotionally charged parts of
moderation, and Reddit gives mods **no purpose-built tooling** for them.

## What Appealdesk does

- **Structured intake.** Instead of free text, a user fills in a short form tied to
  the exact action being appealed (an explicit reason field plus a rule
  acknowledgement). The original content and removal reason are captured for the mod
  automatically.
- **A dedicated appeals dashboard.** Appeals land in a mod-only custom post, not in
  generic modmail, each showing the original item, the removal reason, and the
  user's prior appeal history inline.
- **One-tap decisions.** Uphold / Overturn / Need-more-info, each sending a
  templated, civil reply automatically. The decision is always the human mod's.
- **Duplicate & repeat detection.** A deterministic text-similarity check flags when
  a user is re-filing the same appeal, so mods don't get worn down.
- **An audit trail.** Every decision is recorded with who, when, the note, and the
  reply sent — so head mods get consistency and accountability.
- **SLA nudges.** A scheduler nudges the mod team about appeals aging past a
  configurable window, so nothing rots silently in the queue.
- **Optional AI, strictly assistive.** With a per-sub toggle, AI can *suggest* a
  triage label and *draft* a calmer reply — but it never decides, bans, or unbans.

## How it works (end to end)

```
 ┌──────────────┐        ┌─────────────────────────┐        ┌──────────────────┐
 │   A user is  │        │  Appealdesk intake form │        │   Redis (Devvit) │
 │ banned/removed├──────► │  (structured, tied to   ├──────► │  appeal:<sub>:<id>│
 │              │  link  │   the original action)  │ submit │  history:<sub>:…  │
 └──────────────┘        └─────────────────────────┘        └────────┬─────────┘
                                                                       │
        deterministic dedup + (optional) AI triage label run here ─────┘
                                                                       │
 ┌─────────────────────────────────────────────────────────────────┐ │
 │            Appeals Dashboard (mod-only custom post)               │◄┘
 │  • original content + removal reason + appeal history (inline)    │
 │  • repeat / near-duplicate flags                                  │
 │  • optional AI hint: "likely genuine / duplicate / abusive"       │
 │                                                                   │
 │  Mod taps  ▸ Uphold   ▸ Overturn   ▸ Need more info               │
 └───────────────────────────────┬───────────────────────────────────┘
                                  │ (reply-confirm form: mod edits & approves)
                                  ▼
                ┌─────────────────────────────────────┐
                │  Templated civil reply sent via      │
                │  modmail · decision logged to the    │
                │  audit trail · queue updated         │
                └─────────────────────────────────────┘
```

The flow has three actors and one rule that never bends: **a human mod makes every
decision.**

1. **Intake.** A ban or removal triggers a civil modmail (for bans) and stashes an
   *action snapshot* keyed by the target id. When the user opens the "Appeal this
   removal" menu item (or follows the ban-message link), they get a structured form
   pre-bound to that action. On submit, the appeal is written to Redis, indexed into
   the open queue and the user's history, and the deterministic dedup signal is
   computed. If AI is enabled for the sub, a triage label is attached as a *hint*.

2. **Review.** Mods open the dashboard custom post. The queue lists open appeals
   newest-first with repeat flags and status. Tapping one shows everything inline —
   original content, reason, the user's appeal text, prior-appeal history, the
   duplicate flag, and (if enabled) the AI hint with its rationale.

3. **Decision.** The mod taps Uphold / Overturn / More info. That opens a
   reply-confirm form pre-filled with the templated reply (optionally AI-softened).
   The mod edits and approves it; only then is the decision recorded and the reply
   sent. Resolving an appeal removes it from the queue and releases the per-action
   lock; "More info" keeps it tracked as *awaiting user*.

## Architecture

Appealdesk is layered so that **all the real logic is platform-independent and
unit-tested**, and the Devvit-specific code is a thin wiring shell on top.

```
                         ┌───────────────────────────────────────────┐
                         │                 Devvit shell                │
                         │  main.tsx · components/*.tsx · server/*     │
   Reddit UI ◄──────────►│  custom post · forms · menu items ·        │
   (mods & users)        │  ModAction trigger · scheduler · settings   │
                         └───────────────┬─────────────────────────────┘
                                         │ injects redis + reddit + (opt) ai
                                         │ + telemetry (logger/metrics/clock)
                                         ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │                          Platform-free core                              │
   │                                                                          │
   │   AppealService  ── orchestration: validate → intake → suggest → decide  │
   │       │              (typed errors; reply-delivery handling; telemetry)  │
   │       ├── validation  ── input checks + sanitisation at the boundary     │
   │       ├── AppealStore ── persistence; the only code that touches Redis    │
   │       │     ├── concurrency/optimistic ── WATCH/MULTI/EXEC version CAS    │
   │       │     ├── concurrency/rateLimit  ── per-user token bucket           │
   │       │     └── lifecycle/retention    ── purge + GDPR erasure            │
   │       ├── templates   ── reply rendering ({{var}} substitution)          │
   │       ├── dedup        ── deterministic duplicate/repeat detection       │
   │       ├── errors       ── typed taxonomy (code/status/retryable)          │
   │       ├── observability── logger · metrics · injectable clock            │
   │       └── AiProvider   ── optional triage + tone-softening (or no-op)     │
   │                                                                          │
   │   RedditGateway · RedisLike (interfaces) ── satisfied by Devvit's API     │
   └───────────────────────────────────────────────────────────────────────┘
```

Key boundaries:

- **`core/` and `ai/` import nothing from Devvit.** They speak in plain domain
  objects and small injectable interfaces (`RedditGateway`, `RedisLike`,
  `AiProvider`, `Telemetry`). That is what makes 100% unit-test coverage
  achievable without the Devvit runtime.
- **`AppealStore` is the only code that touches Redis.** Every key is built in one
  place (`core/keys.ts`), and all mutations go through a `WATCH/MULTI/EXEC`
  compare-and-set so concurrent writes can never silently clobber.
- **Failures are typed, never silent.** Operations throw `AppealError`s carrying a
  stable `code`, an HTTP-ish `status`, and a `retryable` flag — the UI maps these
  to friendly messages; storage faults are distinguishable from validation faults.
- **`server/context.ts` is the single adapter** that turns a Devvit context into a
  fully-wired `AppealService` (store + gateway + optional AI + telemetry).

## The AI stance: assistive, never decisive

This is the most AI-leaning idea in its track, and also the most careful about it.

- **AI never decides.** Uphold/Overturn/More-info is always the human mod's tap. AI
  never bans, unbans, or auto-actions anything.
- **AI triage is a hint, not a verdict.** When enabled, it labels an appeal *likely
  genuine / likely duplicate / likely abusive* with a confidence and a one-line
  rationale, shown to help the mod prioritise. It sits *on top of* the deterministic
  dedup signal, which is always present.
- **AI tone-softening is a draft.** It can rewrite a templated reply to be calmer;
  the mod still edits and approves before anything is sent. Output is clamped (never
  empty, never absurdly long) and falls back to the plain template on any failure.
- **The product is complete with AI switched off.** This is enforced in the design:
  the `NoopAiProvider` is a first-class implementation, and `selectProvider()`
  returns it whenever AI is disabled or no model backend is wired in. The structured
  intake, dashboard, history, dedup, audit trail, and SLA nudges — the real value —
  are all deterministic. AI makes Appealdesk *nicer*; it is never load-bearing.

> The current Devvit SDK ships no on-platform text model, so in practice Appealdesk
> runs fully deterministically today. The AI layer is wired behind a forward-looking
> injection point (`context.ai.generateText`) that activates automatically if/when a
> model backend becomes available — with no other code changes.

## Installing & using it

**Prerequisites:** Node.js 22+, the Devvit CLI (`npm install -g devvit`), and a test
subreddit you moderate.

```bash
# install dependencies
npm install

# log in to Reddit and run live against your test subreddit
devvit login
npm run dev          # = devvit playtest <your-subreddit>

# when ready to publish
npm run upload       # = devvit upload
```

**First-time setup in the subreddit (as a mod):**

1. Open the subreddit's three-dot menu → **"Appealdesk: create dashboard"**. This
   creates and pins a mod-only custom post — your appeals queue.
2. (Optional) Open the app's settings to set the SLA window, edit reply templates,
   or toggle the optional AI layer.

**As a moderator, day to day:**

- New appeals appear in the dashboard automatically. Tap one to review it in full.
- Tap **Uphold**, **Overturn**, or **More info**; edit the suggested reply; approve.
  The reply is sent and the decision logged.
- The mod team gets a modmail nudge when appeals age past the SLA window.

**As an affected user:**

- On a removed post or comment, use the **"Appeal this removal"** menu item.
- On a ban, follow the link in the civil modmail Appealdesk sends you.
- Fill in the short form (reason + rule acknowledgement) and submit. A human mod
  reviews it; you get a clear, civil reply.

## Configuration

All settings are per-subreddit (installation scope) and editable in the app's
settings panel — no code changes needed:

| Setting | Default | What it does |
|---|---|---|
| `aiEnabled` | `false` | Turns the optional, assistive AI triage + tone-softening on. |
| `slaHours` | `48` | Hours before an open appeal is flagged as aging and the mod team is nudged. |
| `rateLimitCapacity` | `5` | Max appeals a single user may file in a burst. |
| `rateLimitRefillPerHour` | `2` | Appeals replenished per hour (token-bucket refill). |
| `retentionDays` | `180` | Days to keep resolved appeals before purge (`0` = keep forever). |
| `templateUpheld` | (civil default) | Reply sent when an appeal is upheld. |
| `templateOverturned` | (civil default) | Reply sent when an appeal is overturned. |
| `templateMoreInfo` | (civil default) | Reply sent when more info is requested. |

Templates support `{{user}}`, `{{subreddit}}`, and `{{action}}` substitution. Unknown
tokens are left visible so a mistyped variable is noticed rather than sent blank.

Internally these map to a `SubredditConfig` persisted at `config:<sub>`, which also
holds `oneAppealPerAction` (default on: at most one open appeal per action).

## Project layout

```
appealdesk/
├── devvit.yaml              app manifest (name, permissions, marketplace meta)
├── package.json             scripts & deps
├── tsconfig.json            strict TS; Devvit's classic JSX factory
├── vitest.config.ts         test + 100%-coverage thresholds for core/ & ai/
├── src/
│   ├── main.tsx             entrypoint: configure, register custom post, load modules
│   ├── core/                ← platform-free, fully unit-tested
│   │   ├── types.ts         domain model + default config
│   │   ├── keys.ts          Redis key scheme + id generation
│   │   ├── redisLike.ts     the narrow Redis interface the store depends on
│   │   ├── dedup.ts         deterministic duplicate/repeat detection
│   │   ├── store.ts         persistence; the only Redis-touching code (CAS-guarded)
│   │   ├── service.ts       orchestration (validate / intake / suggest / decide)
│   │   ├── templates.ts     reply rendering with {{var}} substitution
│   │   ├── format.ts        presentation helpers (labels, colours, relative time)
│   │   ├── errors/          typed error taxonomy (code/status/retryable)
│   │   ├── validation/      input validation + sanitisation
│   │   ├── observability/   logger, metrics, injectable clock, timing helper
│   │   ├── concurrency/     optimistic CAS + status machine; token-bucket rate limit
│   │   └── lifecycle/       retention purge + GDPR-style erasure
│   ├── ai/
│   │   └── provider.ts      optional AI layer + first-class no-op fallback
│   ├── components/          ← Devvit Blocks UI
│   │   ├── primitives.tsx   shared UI pieces (pills, fields, empty state)
│   │   ├── Dashboard.tsx    the open-appeals queue
│   │   ├── AppealDetail.tsx the single-appeal review + decision screen
│   │   └── AppealsDashboardPost.tsx  stateful container (typed-error aware)
│   └── server/              ← Devvit wiring (thin)
│       ├── context.ts       builds AppealService (store + gateway + AI + telemetry)
│       ├── intake.ts        the user-facing structured appeal form
│       ├── menu.tsx         menu items (create dashboard, appeal a removal)
│       ├── triggers.ts      ModAction trigger (snapshot + civil invite)
│       ├── scheduler.ts     SLA nudge + retention purge jobs
│       └── settings.ts      app settings + install lifecycle
├── bench/
│   └── run.ts               dependency-free perf harness (npm run bench)
├── docs/
│   ├── ARCHITECTURE.md      diagrams: layers, lifecycle, sequences, data model
│   ├── THREAT_MODEL.md      STRIDE pass, trust boundaries, accepted risks
│   └── BENCHMARKS.md        methodology, baseline, scaling characteristics
└── test/                    205 tests, 100% coverage of core/ & ai/
    ├── helpers/fakeRedis.ts in-memory Redis stand-in (with WATCH/MULTI/EXEC)
    ├── property/            fast-check invariant tests
    ├── concurrency/         parallel-write / race tests
    ├── keys · dedup · templates · format · provider · store · service
    └── errors · validation · observability · rateLimit · optimistic · retention
```

## Data model & Redis schema

Every key is constructed in `core/keys.ts`:

| Key | Type | Holds |
|---|---|---|
| `appeal:<sub>:<id>` | string (JSON) | The full `Appeal` record (carries a `version` for CAS). |
| `history:<sub>:<user>` | sorted set | The user's appeal ids, scored by timestamp. |
| `index:<sub>:open` | sorted set | Open-queue appeal ids, scored by timestamp (paginated). |
| `index:<sub>:purge` | sorted set | Resolved appeal ids scored by purge-eligibility time. |
| `action:<sub>:<targetId>` | string | The appeal id currently open for an action (the per-action lock, claimed atomically). |
| `actionseed:<sub>:<targetId>` | string (JSON) | Action snapshot stashed at removal/ban time for later appeal context. Its own key family (not under `action:`), cleared when the appeal resolves or is erased. |
| `ratelimit:<sub>:<user>` | string (JSON) | Token-bucket state for per-user appeal rate limiting. |
| `config:<sub>` | string (JSON) | The `SubredditConfig`. |

An `Appeal` carries the action context, the user's submission, a `TriageHint`
(deterministic `repeatCount` + optional `duplicateOfAppealId`, plus an optional AI
`model` label), an append-only `decisions` audit trail, a monotonic `version` for
optimistic concurrency, and lifecycle `status`
(`open → in_review → awaiting_user → resolved`, where `resolved` is terminal).

## Development, testing & coverage

```bash
npm run build     # tsc --noEmit: type-checks the whole project incl. UI
npm test          # vitest run: 205 tests
npm run test:watch
npm run bench     # performance benchmarks (see docs/BENCHMARKS.md)
npm run lint
npm run format
```

The test target is the entire **`core/` and `ai/`** surface — all the logic that can
be wrong. Because that code is platform-free and the dependencies are injected
(`RedisLike`, `RedditGateway`, `AiProvider`, `Telemetry`), it is tested with an
in-memory `FakeRedis` (which implements real `WATCH/MULTI/EXEC` abort semantics) and
fakes for the gateway, AI, clock, logger, and metrics — reaching:

```
File                  | % Stmts | % Branch | % Funcs | % Lines
----------------------|---------|----------|---------|--------
All files             |   100   |   100    |   100   |  100
 ai/provider          |   100   |   100    |   100   |  100
 core/dedup           |   100   |   100    |   100   |  100
 core/format          |   100   |   100    |   100   |  100
 core/keys            |   100   |   100    |   100   |  100
 core/service         |   100   |   100    |   100   |  100
 core/store           |   100   |   100    |   100   |  100
 core/templates       |   100   |   100    |   100   |  100
 core/errors          |   100   |   100    |   100   |  100
 core/validation      |   100   |   100    |   100   |  100
 core/observability   |   100   |   100    |   100   |  100
 core/concurrency     |   100   |   100    |   100   |  100
 core/lifecycle       |   100   |   100    |   100   |  100
```

Coverage thresholds are enforced in `vitest.config.ts` (the build fails below 100%).
The Devvit `.tsx`/`server` glue is deliberately thin wiring, exercised live via
`devvit playtest`, and excluded from the unit-coverage target — but it is fully
type-checked by `npm run build` against the real `@devvit/public-api`, and it now
catches every typed `AppealError` and surfaces a friendly message.

Beyond happy-path unit tests, the suite includes **property-based tests**
(fast-check: jaccard symmetry/bounds, rate-limiter invariants, sanitisation
idempotence, template token-freedom) and **concurrency tests** (parallel decisions
on one appeal, parallel duplicate submissions, interleaved review+decide). Notable
edge cases: corrupt/missing Redis records, dangling indexes, the atomically-claimed
one-appeal-per-action lock under contention, the full decision lifecycle and audit
trail, the terminal-state guard, optimistic-lock conflicts and retries, rate-limit
exhaustion and refill, retention purge and GDPR erasure (idempotent), every storage
fault mapped to a typed error, AI enabled/disabled/declining/failing, and defensive
parsing of malformed model output.

## Production hardening

This codebase is built to run for real users, so it goes beyond a hackathon MVP:

- **Concurrency safety.** All mutations use a Redis `WATCH/MULTI/EXEC` compare-and-set
  keyed on a per-record `version`; the per-action lock is claimed atomically and fails
  closed. Concurrency tests prove two mods can't double-resolve an appeal and two users
  can't open duplicate appeals for one action.
- **Typed failure handling.** Every failure is an `AppealError` with a stable `code`,
  `status`, and `retryable` flag — storage faults, validation, rate limits, conflicts,
  and not-found are all distinguishable. Reply-delivery failure never rolls back a
  recorded decision; it asks the mod to resend.
- **Input validation & sanitisation** at the boundary (length caps, control-char
  stripping, multi-issue aggregation).
- **Rate limiting** (per-user token bucket) and **duplicate detection** protect mods
  from floods and re-files.
- **Data lifecycle.** Retention purges old resolved appeals; right-to-erasure redacts
  PII while keeping an auditable tombstone.
- **Observability.** A structured logger, metrics, and an injectable clock thread
  through the core, ready to forward to a deployment's monitoring.
- **Documented limits.** `docs/THREAT_MODEL.md` states trust boundaries and accepted
  risks plainly; `docs/BENCHMARKS.md` documents the one real scaling characteristic
  (per-user dedup history hydration is linear, bounded by retention).

## Design decisions & trade-offs

- **Deterministic core, optional AI.** Hackathon judges reward tools useful even with
  AI stripped out, so the fallback story is a first-class design axis, not an
  afterthought. The no-op AI provider guarantees the AI-off path is always coherent.
- **Dependency injection over framework coupling.** `RedditGateway` and `AiProvider`
  interfaces keep the core testable and the platform swappable; `server/context.ts`
  is the one place the seams are stitched.
- **One-place key construction.** Centralising the Redis schema in `keys.ts` removes
  a whole class of "two call sites, two key formats" bugs.
- **Snapshots over form-stuffing.** The original removal reason is shown to the *mod*,
  not put in the *user's* editable form — so it's stashed in Redis at action time and
  read back on submit, rather than round-tripped through fields the user could alter.
- **Mod-reviewed replies, always.** Even AI-softened replies pass through a confirm
  form the mod edits and approves; nothing is auto-sent in the user's name.
```

## Engineering notes

Two appendices track the review-driven refactors so a reviewer can follow how
the codebase moved between major passes:

- [`CODE-FIX-NOTES.md`](./CODE-FIX-NOTES.md) — first review pass: the original
  set of fixes (storage round-trips, lock semantics, retention rooting, etc).
- [`CODE-FIX-NOTES-2.md`](./CODE-FIX-NOTES-2.md) — second review pass: H1/H2
  snapshot & rate-limit lifecycle, M1/M2 CAS guards and typed contention, D1
  paraphrase signal, D2 tx batching, D6 retention sweeps, D7 prompt-injection
  hardening, D8 audit chain, W1 mod erasure surface, W2 analytics, W3 policy
  predicates, W4 claims + Notifier, M3 pagination, plus the supporting UI and
  test work.

Operations docs:

- [`docs/RUNBOOK.md`](./docs/RUNBOOK.md) — metrics interpretation, alarming
  signals, manual sweep / erasure / chain-verify commands, recovery from
  `DATA_CORRUPTION`, scheduler drain procedures.
- [`docs/SCREENSHOTS.md`](./docs/SCREENSHOTS.md) — placeholder slots for
  dashboard, detail, analytics tab, intake form, and erasure form
  screenshots; populate when running a fresh install.
