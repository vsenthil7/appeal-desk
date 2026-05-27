# Appeal-Desk \u2014 Devpost submission (copy-paste-ready)

Every field below maps 1:1 to a Devpost form field for AT-Hack0022 (Reddit
Developer Platform 2026). Character counts are noted where Devpost enforces
caps. Sources: the actual repo at https://github.com/vsenthil7/appeal-desk
(288/288 tests, 99.97 % line coverage, 4 BUILD + 1 SUBMISSION commit on main).

---

## Page 1 \u2014 Project overview

### Project name (60 chars max)

```
Appeal-Desk \u2014 a fair appeals desk for modteams
```

`49 / 60`

### Elevator pitch (200 chars max)

```
Turn ban + removal appeals from unstructured modmail into a structured queue: one-tap decisions, audit trail, civil replies, dedup. AI assists; mods decide \u2014 and it still works with AI off.
```

`192 / 200`

### Thumbnail (3:2 ratio, JPG/PNG/GIF, \u22645 MB)

Upload: **`appeal-desk/submission_media/cover-og-1200x630.png`** (3:2 ratio, 35 KB).

> Not the square one. The form specifies a 3:2 ratio for best results.

---

## Page 2 \u2014 Project details

### About the project (Markdown)

```markdown
## Inspiration

Reddit's appeals process today is "write into modmail and hope." Mods get an
unstructured wall of text with no link to the action, no per-user history,
no audit trail. The same user can re-appeal the same ban six times. Reply
drafts get written from scratch under pressure. Decisions drift. Mods burn out.

Appeal-Desk is the desk that should have existed all along: a structured
queue with one-tap decisions, deterministic duplicate detection, templated
civil replies, and a tamper-evident audit trail. AI helps where it can;
humans decide always.

## What it does

A mod action (ban or removal) triggers an **atomic action snapshot** keyed to
the target. The user receives a civil modmail invite to a structured intake
form pre-filled with the action context (read-only \u2014 the user can't edit the
mod's reason). The submission is validated, sanitised, rate-limited, and
checked against an action-lock CAS so two users can't open duplicate appeals
for the same ban even in the same millisecond.

Mods see a dashboard with the full appeal, the user's prior-appeal history,
and a near-duplicate Jaccard flag. Each appeal has three one-tap buttons:
**Uphold**, **Overturn**, **Ask for more info**. Each button opens a
**reply-confirm form** \u2014 the templated civil reply is editable, and nothing
is sent until the mod confirms. The decision is recorded *before* the modmail
is dispatched, so a transient send failure never rolls back the verdict;
the UI offers a resend instead.

Behind it: an SLA-nudge scheduler, a daily retention purge job that drains
the purge index in bounded batches, and GDPR-style erasure that scrubs free
text but keeps an auditable tombstone (idempotent).

## How we built it

The single most important architectural decision: the `core/` and `ai/`
layers import **nothing** from Devvit. They speak in plain domain objects
and small injected interfaces (`RedisLike`, `RedditGateway`, `AiProvider`,
`Telemetry`). The Devvit shell (.tsx) is a thin wiring layer for triggers,
custom posts, forms, menu items, and the scheduler.

That separation is why the platform-free core hits 100 % function coverage
without the Devvit runtime, and why the AI layer is a swap rather than a
load-bearing dependency. `selectProvider(aiEnabled, backend)` returns a
`NoopAiProvider` whenever AI is off or no backend is wired \u2014 the full happy
path works with AI completely stripped out.

Stack:
- **Runtime:** Devvit (Reddit Developer Platform), `@devvit/public-api@0.11.19`, TypeScript 5
- **Storage:** Devvit Redis primitives (zsets, hashes, WATCH/MULTI/EXEC CAS)
- **Concurrency:** atomic action-lock via WATCH/MULTI/EXEC; tie-safe `{score, id}` cursor pagination
- **Quality gates:** vitest (288 tests / 18 files), ESLint, `tsc --noEmit`, tiny tsx benchmark
- **AI seam:** optional, clamped, never load-bearing \u2014 default is `NoopAiProvider`

Four BUILD commits on `main` show the evolution from initial scaffold
through a thorough code-review pass to the final renamed app. A fifth
SUBMISSION commit added the pitch deck, judge test script, and covers.

## Challenges we ran into

- **Concurrency under load.** A naive `get` \u2192 `set` would let two users open
  duplicate appeals for the same ban. The fix is WATCH/MULTI/EXEC CAS on the
  action-lock, with the lock reclaimable *only* if the holder is a resolved
  appeal. Property-based tests prove two parallel submissions never both win.
- **Pagination tie-skip.** The open-queue index was scored by `now` (ms epoch).
  Two appeals created in the same millisecond got the same score, and the
  `cursor - 1` boundary skipped every other co-scored entry. Fixed by making
  the cursor a `{score, id}` tuple. New tests create 5 same-ms appeals and
  assert all 5 page through exactly once.
- **Unbounded "paginated" reads.** `openQueuePage` was passing `(start=0,
  stop=max)` to `zRange ... { by: 'score' }`, fetching the *entire* open
  index per page call. Fixed by exposing the `limit: {offset, count}` field
  on `ZRangeOptions` (which the Devvit Redis surface already supports).
- **Retention was dead code.** `purgeExpired` and `redactAppeal` existed but
  nothing called them. Added a daily `appealdesk_retention_purge` scheduler
  job and exposed `eraseAppeal` / `eraseUser` on the service.
- **`npm run lint` was advertised but broken.** No ESLint config existed.
  Trivial fix; visible blemish until then. Added `.eslintrc.cjs` with
  `@typescript-eslint`.

Every defect found by the code review was fixed in-line with the BUILD
commits and a new test landed alongside each fix.

## Accomplishments that we're proud of

- **288 / 288** tests pass across 18 test files
- **99.97 %** statements / **99.06 %** branches / **100 %** functions / **99.97 %** lines on the platform-free core
- **0** TypeScript errors. **0** ESLint issues. Clean type-check across `.ts` + `.tsx`.
- The product **works end-to-end with AI removed**. That's not marketing; it's
  enforced by `selectProvider()` and tested.
- **Honest defect log.** Every bug the reviewer found is acknowledged, fixed,
  and shipped with a regression test \u2014 documented in `CODE-FIX-NOTES.md`.
- A platform-free core that any future maintainer can refactor against,
  because the test suite never depended on the Devvit runtime to begin with.

## What we learned

- "Paginated" without a bounded Redis read is just an array slice. If you
  can't see a `limit` in the underlying call, you haven't paginated yet.
- Same-millisecond cursor ties bite in tests with fake clocks long before
  they bite in production. Always tie-break the cursor on `(score, id)`.
- "AI-assisted, never AI-decisive" is much easier to enforce when the AI
  provider is a swap behind an interface than a sprinkle of `if (ai.enabled)`.
  Make the no-op the default and the rest follows.
- Audit trails are only useful if retention + erasure are *wired*, not just
  defined. A daily purge job is the difference between "GDPR-ready" and
  "GDPR claim on the README."

## What's next for Appeal-Desk

**Width first** (new modules, the codebase is architecturally ready):

- `core/analytics` \u2014 overturn rate, time-to-decision, top reasons that get
  overturned (a signal that a rule or automod setting is mis-tuned).
- `core/policy` \u2014 configurable eligibility predicates (e.g. one appeal per
  user per 30 days, no appeals on ToS perm-bans).
- `core/notifications` \u2014 user-facing status updates so the appellant isn't
  in the dark between submit and verdict. Attacks the *cause* of duplicate
  re-files.
- `core/escalation` \u2014 multi-mod sign-off for contentious appeals.
- `core/export` \u2014 CSV/JSON portability for sub-transparency reports.
- `core/i18n` \u2014 message catalogs per sub language.

**Depth** (richer existing modules), after width:

- Bulk decisions on near-duplicates ("uphold all near-dupes of this appeal").
- Incremental dedup using rolling MinHash signatures \u2014 no full per-user
  history re-hydration on each submit.
- Conditional templates + token linter at settings-save time.
- AI eval harness with golden fixtures so prompt changes are *measured*.
```

### Built with

```
typescript
devvit
reddit-developer-platform
redis
vitest
eslint
tsx
property-based-testing
zustand-free-react
zod (validation)
```

> Devpost's "Built with" field is a tag soup. The above mirrors what's
> actually in `package.json` and the docs.

### Try it out (links)

| Label | URL |
|---|---|
| GitHub repo | https://github.com/vsenthil7/appeal-desk |
| App Directory listing | https://developers.reddit.com/apps/appeal-desk |
| Playtest subreddit | https://www.reddit.com/r/appeal_desk_dev |
| Judge test script | https://github.com/vsenthil7/appeal-desk/blob/main/submission_media/JUDGE_TEST_SCRIPT.md |

### Image gallery (upload)

Upload all three so Devpost has variants to choose from:

- `appeal-desk/submission_media/cover-og-1200x630.png` (3:2 hero \u2014 primary thumbnail)
- `appeal-desk/submission_media/cover-banner-1600x900.png` (16:9 banner)
- `appeal-desk/submission_media/cover-square-1200x1200.png` (square)

### Video demo link

\u2264 1 minute, YouTube preferred (Devpost embeds YouTube/Facebook/Vimeo/Youku).
See `submission_media/DEMO_VIDEO_SCRIPT.md` for the storyboard;
`appeal-desk-walkthrough-<stamp>.mp4` is produced under 60 s by
`scripts/record_demo.ps1`.

---

## Page 3 \u2014 Additional info (for judges)

### Sponsor / Special prizes

```
Feedback Awards
```

> Tick **Feedback Awards** (also submit the feedback survey for eligibility).
> "Devvit Helper Award" is for community helpers, not solo submissions.

### Reddit username

```
u/vsenthil7
```

### developers.reddit.com app page

```
https://developers.reddit.com/apps/appeal-desk
```

### Tool overview (functionality of the bot)

```
Appeal-Desk is a moderation tool that turns ban and removal appeals from
unstructured modmail into a structured, audited queue.

For moderators:
- A new menu item "Open Appeals Dashboard" appears on subs where the app is
  installed.
- The dashboard custom post lists every open appeal with the user's
  prior-appeal count and a near-duplicate similarity flag (deterministic
  Jaccard, no AI required).
- Tapping an appeal shows the full submitted reason, the original action
  snapshot (with the mod's *original* removal reason, captured at action
  time and not editable by the user), and three one-tap decision buttons:
  Uphold, Overturn, Ask for more info.
- Each button opens a reply-confirm form with a templated civil reply
  pre-filled. The mod edits and confirms before anything is sent.
- The decision is recorded BEFORE the reply is dispatched. A modmail send
  failure throws REPLY_DELIVERY_FAILED but the recorded verdict stands, and
  the UI offers a resend.
- Optional AI triage labels and tone-softened reply drafts appear clearly
  marked as hints. The mod can ignore them. AI never blocks intake, never
  sends a reply, and never makes a decision.

For users (banned/removed):
- On a ban, the user receives a civil modmail with a link to a structured
  intake form.
- The form pre-fills the action context (read-only) and asks for the appeal
  reason plus an explicit acknowledgement.
- Validation aggregates all field errors at once (no "fix one, see the next"
  cycle). Sanitisation strips control characters and caps length.
- Rate-limiting and an atomic action-lock prevent both spam re-submissions
  and duplicate appeals for the same action.

Behind the scenes:
- Daily retention purge (configurable per sub) drains the purge index in
  bounded batches.
- GDPR-style erasure scrubs free text but keeps an auditable tombstone.
  Idempotent.
- SLA-nudge scheduler keeps aging appeals visible.
- Settings changes take effect on the next submission or AppUpgrade, not
  only on install.

Permissions: reddit (mod scope, modmail), redis, scheduler. http: false \u2014
the app is fully on-platform with no external service dependencies.
```

### Project Impact (1\u20133 communities + benefits)

```
Three categories of community would benefit most:

1. Large, rule-heavy subs (500k+, e.g. r/AskHistorians, r/science) where
   the moderator team handles dozens of ban appeals a week. The structured
   queue + audit trail directly attack two failure modes that scale with
   sub size: inconsistent decisions across mods and lost institutional
   memory when mods rotate. Time saved per appeal: replacing a freeform
   modmail back-and-forth with one structured form and one confirmed reply
   is realistically 5\u201310 minutes per appeal, multiplied by hundreds of
   appeals a month.

2. Mid-size subs with a small mod team (50k\u2013500k, e.g. niche-hobby subs)
   where the *same* small team is the appeals-handling team. Here the
   biggest win is the deterministic dedup flag \u2014 the same user re-filing
   the same appeal three times in a week is the single most common pattern,
   and the near-duplicate score lets a mod close it in seconds with a
   templated reply.

3. Communities that publish transparency reports (e.g. r/Modnews-adjacent
   subs). The append-only audit trail + future `core/export` module
   produce report-ready data: appeals submitted, decisions split by
   outcome, median time-to-decision, overturn rate by removal reason.
   That last metric is itself a moderator-team tuning signal \u2014 a high
   overturn rate on a specific removal reason is a hint that an automod
   rule needs adjustment.

For moderators specifically: less cognitive load (the queue replaces
modmail-search), fewer "did we already decide on this?" moments (history
visible by default), and zero "what did we say last time?" guesswork
(every reply is in the audit trail). For users: a civil reply they can
read, written from a template that doesn't sound dashed-off, and
confidence that the same person isn't going to give them a contradictory
verdict next week.
```

### Is this a new app or a migrated app?

```
New app
```

### [For Ported Projects] Original Bot username

```
N/A
```

### [For Ported Projects] Port Completion

```
N/A
```

### [For Ported Projects] Are you the original owner of this migration?

```
N/A
```

### Nominate a most helpful user

```
N/A \u2014 solo submission, no community helpers to nominate. (The submission
was built with Claude as a paired engineer under the AT-Hack0022 sprint
discipline, but Claude is not a community member.)
```

---

## Page 5 \u2014 Submit

Final reminders to check off:

- [x] Video is **\u2264 1 minute** (record at 50\u201358 s for safety margin).
- [x] App is **uploaded to developers.reddit.com**
      \u2192 https://developers.reddit.com/apps/appeal-desk (v0.0.2).
- [ ] Feedback survey submitted (required for Feedback Award eligibility).
- [x] Official Rules and Devpost Terms of Service read.

---

## Submission artefact paths (one-shot reference)

| Devpost field | File or URL |
|---|---|
| Thumbnail | `appeal-desk/submission_media/cover-og-1200x630.png` |
| Image gallery (3) | `cover-og-1200x630.png`, `cover-banner-1600x900.png`, `cover-square-1200x1200.png` |
| Video demo link | YouTube URL after upload (see `submission_media/DEMO_VIDEO_SCRIPT.md`) |
| Try-it-out URL #1 | https://github.com/vsenthil7/appeal-desk |
| Try-it-out URL #2 | https://developers.reddit.com/apps/appeal-desk |
| Try-it-out URL #3 | https://www.reddit.com/r/appeal_desk_dev |
| Try-it-out URL #4 | https://github.com/vsenthil7/appeal-desk/blob/main/submission_media/JUDGE_TEST_SCRIPT.md |
