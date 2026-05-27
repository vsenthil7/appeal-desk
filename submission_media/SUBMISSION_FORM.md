# Reddit Developer Platform Hackathon — submission form (copy-paste reference)

All fields below are ready to paste directly into the hackathon submission
portal for **AT-Hack0022 (Reddit Developer Platform 2026)**.
Numbers are reproducible on the repo (see the **Judge Test Script** for a
deterministic verification walkthrough).

**App is live in the Devvit App Directory:**
https://developers.reddit.com/apps/appeal-desk

---

## Project name (1 line, \u2264 60 chars)

```
Appeal-Desk \u2014 a fair appeals desk for modteams
```

(49 chars)

---

## Tagline / one-liner (1 line, \u2264 140 chars)

```
Structured intake, audit-trail, one-tap decisions, civil replies. AI assists, mods decide \u2014 and the app still works with AI off.
```

(135 chars)

---

## Short description (1\u20132 sentences, \u2264 250 chars)

```
Appeal-Desk turns ban and removal appeals from unstructured modmail into a structured queue with one-tap decisions, deterministic duplicate detection, templated civil replies, and a tamper-evident audit trail. AI is strictly assistive.
```

(238 chars)

---

## Long description (Markdown allowed)

```
**Today, appealing a ban or removal on Reddit means writing into modmail and
hoping.** Mods get an unstructured wall of text with no link to the action,
no history, and no audit trail. Inconsistent decisions, mod burnout, and
users who feel unheard \u2014 even when their appeal is fair.

**Appeal-Desk is a dedicated, fair appeals desk built into the subreddit.**

## What it does, end to end

1. **Action snapshot.** When a mod bans a user or removes content, Appeal-Desk
   atomically snapshots the action context (action type, target ID, original
   removal reason) keyed by the target. The user can never edit this; the mod
   always sees the *original* reason at decision time.
2. **Civil invite.** The banned user is invited (via modmail, on bans) to file
   an appeal through a structured intake form. The form pre-fills the action
   context (read-only) and asks for a reason and explicit acknowledgement.
3. **Submission \u2014 hardened.** Validation, sanitisation, rate-limiting, and
   atomic action-lock (WATCH/MULTI/EXEC CAS on Redis) all run at the boundary.
   Two users cannot open duplicate appeals for the same action even if they
   submit in the same millisecond. Deterministic Jaccard-based dedup against
   the user's prior appeals fires a near-duplicate flag for the mod \u2014 not a
   block.
4. **Mod dashboard.** A custom post renders a queue of open appeals with full
   context, history count, and near-duplicate score. Each appeal opens a
   detail panel with three one-tap buttons: **Uphold**, **Overturn**, **Ask
   for more info**. AI hints (if enabled) appear clearly marked, never
   load-bearing.
5. **Reply-confirm gate.** Every one-tap button opens a reply-confirm form
   with a templated civil reply pre-filled. Nothing is sent until the mod
   confirms. AI never blocks, AI never decides, AI never sends.
6. **Record-then-send.** The decision is persisted *before* the reply is
   dispatched. If modmail send fails transiently, the decision still stands
   and the UI offers a resend \u2014 the recorded verdict is the source of truth.
7. **Lifecycle.** SLA-nudge scheduler. Daily retention purge of resolved
   appeals past the configured window. GDPR-style erasure scrubs free text
   but keeps an auditable tombstone (idempotent).

## The AI stance

**AI assists. Mods decide. The audit trail proves it.**

Three rules, enforced structurally:

- AI never blocks intake. `submitAppeal()` calls the optional triage provider
  best-effort; failure returns `null` and the appeal is created either way.
- AI output is clamped. Empty / too-long replies fall back to the deterministic
  template. Malformed triage JSON yields `null`, never throws.
- `NoopAiProvider` is the default. `selectProvider(aiEnabled, backend)`
  returns a no-op whenever AI is off or no backend is wired. **The full
  happy path works without an API key** \u2014 verified by tests.

## Why this isn't slideware \u2014 reproducible numbers

- **288 / 288** tests pass across 18 test files
- **99.97 % statements / 99.06 % branches / 100 % functions / 99.97 % lines** coverage
  on the platform-free core (gates pass; the two non-100 % branches are
  documented defensive guards)
- **0** TypeScript errors (`npx tsc --noEmit` clean across `.ts` + `.tsx`)
- **0** ESLint issues
- **4** BUILD commits on `main` showing the project's evolution from initial
  scaffold through the code-review fixes to the final renamed app
- An honest defect log: every reviewer-found bug (broken lint, same-ms cursor
  tie-skip, unbounded queue read, smuggled lock key, dead retention code,
  stray metric field) was found *and fixed*, with new tests landing alongside
  each fix.

## Architecture in one sentence

A **platform-free TypeScript core** (`core/` + `ai/`, zero Devvit imports,
100 % testable without the runtime) behind a **thin Devvit shell** that wires
triggers, custom posts, forms, menu items, and the scheduler.

That is the single architectural decision the project most rewards: the core
speaks plain domain objects and small injected interfaces (`RedisLike`,
`RedditGateway`, `AiProvider`, `Telemetry`), which is why both 100 % coverage
without the Devvit runtime, and gradual deprecation of the AI layer if the
team ever wants to, are tractable.

## Try it now

- **Install from the App Directory:** https://developers.reddit.com/apps/appeal-desk
- **Reproduce the numbers:**
  `git clone https://github.com/vsenthil7/appeal-desk && cd appeal-desk &&
   npm ci && npx tsc --noEmit && npm run lint && npx vitest run --coverage`

See `submission_media/JUDGE_TEST_SCRIPT.md` for a step-by-step deterministic
verification walkthrough (~10 minutes, every step has a concrete pass
criterion).

## License

MIT.
```

---

## Tags / categories

**Primary track:**
```
Moderation Tools
```

**Topics / tags:**
```
moderation
appeals
modmail
audit
governance
devvit
reddit-developer-platform
typescript
redis
property-based-testing
concurrency
gdpr
retention
ai-assistive
no-ai-required
hackathon
at-hack0022
```

---

## Submission artefacts checklist

| Artefact | Path | Status |
|---|---|---|
| Pitch deck PDF | `submission_media/appeal-desk-pitch-deck-<stamp>.pdf` | \u2705 |
| Pitch deck PPTX (editable) | `submission_media/appeal-desk-pitch-deck-<stamp>.pptx` | \u2705 |
| Cover image square (1200x1200) | `submission_media/cover-square-1200x1200.png` | \u2705 |
| Cover image banner (1600x900) | `submission_media/cover-banner-1600x900.png` | \u2705 |
| Cover image OG (1200x630) | `submission_media/cover-og-1200x630.png` | \u2705 |
| App icon (512x512) | `assets/icon.png` | \u2705 |
| Judge test script (PDF) | `submission_media/JUDGE_TEST_SCRIPT.pdf` | \u2705 |
| Judge test script (MD source) | `submission_media/JUDGE_TEST_SCRIPT.md` | \u2705 |
| GitHub repo | https://github.com/vsenthil7/appeal-desk (4 commits, public) | \u2705 |
| **App Directory listing** | **https://developers.reddit.com/apps/appeal-desk** | \u2705 LIVE |
| Playtest sub | `r/appeal_desk_dev` (installed @ v0.0.1) | \u2705 |
| Demo video | `submission_media/appeal-desk-walkthrough-<stamp>.mp4` | \u23f3 |

---

## Field-by-field paste cheatsheet

| Submission field | Source above |
|---|---|
| Project name | "Project name" |
| Tagline / catchphrase | "Tagline / one-liner" |
| Short description | "Short description" |
| Description (main body) | "Long description" (Markdown) |
| Cover image upload | `cover-square-1200x1200.png` |
| GitHub URL | `https://github.com/vsenthil7/appeal-desk` |
| **App URL** | **`https://developers.reddit.com/apps/appeal-desk`** |
| Playtest subreddit | `r/appeal_desk_dev` |
| Pitch deck (PDF upload) | latest `appeal-desk-pitch-deck-<stamp>.pdf` |
| Track / challenge | Moderation Tools |
| License | MIT |
| Team | Solo (vsenthil7); engineering paired with Claude under the AT-Hack0022 sprint |

---

## Judge instructions to embed in the description (optional)

If the form supports a "How to try the app" callout:

```
1. Open https://developers.reddit.com/apps/appeal-desk
2. Click "Install on subreddit" \u2014 pick a test sub you mod (<200 members)
3. As a mod, ban a test account (or remove a post) on the test sub
4. The banned user receives a civil modmail with a link to the appeal form
5. As the banned user, submit an appeal via the form
6. As a mod, open "Appeals Dashboard" from the sub menu
7. Tap Uphold / Overturn / Ask-for-more. A reply-confirm form opens \u2014 confirm to send
8. Re-open the appeal: the decision, reply, and audit trail are all there
```

For the full deterministic verification walkthrough \u2014 the one a judge runs
to verify the engineering claims independently \u2014 see
`submission_media/JUDGE_TEST_SCRIPT.md` (also rendered as PDF in the same
folder).
