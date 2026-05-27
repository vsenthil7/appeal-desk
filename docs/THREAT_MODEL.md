# Appealdesk — Threat Model

This document enumerates Appealdesk's trust boundaries, the threats against each,
and the mitigations in place (or explicitly deferred). It follows a STRIDE-style
pass (Spoofing, Tampering, Repudiation, Information disclosure, Denial of
service, Elevation of privilege) and is intended to be read alongside the code,
not as marketing. Where a mitigation is partial or a risk is accepted, it says
so plainly.

The guiding principle: Appealdesk handles emotionally charged moderation
disputes between users and mods. The data is low-secrecy but high-sensitivity
(it can inflame conflict), and the actions (ban/unban context) are
consequential. So the priorities are, in order: **(1) never let AI or automation
take a moderation decision, (2) keep an honest audit trail, (3) protect users'
words from misuse, (4) keep the queue available and fair.**

---

## 1. Assets

| Asset | Why it matters |
|---|---|
| Appeal records (reason, original content) | User's words; PII-adjacent; sensitive in conflict. |
| Decision audit trail | Accountability; must be tamper-evident and truthful. |
| Per-action lock & queue | Fairness; controls who can appeal and prevents spam. |
| Reply delivery | The user's only feedback channel; must reflect the real decision. |
| Subreddit config (templates, AI toggle, retention) | Controls behaviour; mod-only. |

## 2. Trust boundaries

```
   Untrusted                  Semi-trusted              Trusted
 ┌───────────┐   intake     ┌───────────────┐  app   ┌──────────────┐
 │  Appealing │ ───────────►│  Devvit runtime│ ─────► │ Appealdesk    │
 │   user     │   (form)    │  (Reddit-hosted│        │ core + Redis  │
 └───────────┘             │   sandbox)     │        └──────────────┘
 ┌───────────┐  decisions   │                │        ▲
 │ Moderator  │ ───────────►│                │        │ optional, gated
 └───────────┘             └───────────────┘        ┌──────────────┐
                                                     │ AI backend    │
                                                     │ (suggestions) │
                                                     └──────────────┘
```

- **Untrusted:** the appealing user. Supplies free text and triggers intake.
- **Semi-trusted:** moderators. Authenticated and authorised by Reddit/Devvit;
  trusted to *decide*, but their free-text input is still sanitised.
- **Trusted:** the Devvit runtime, Redis (Devvit KV), and Appealdesk's own code.
- **Gated:** the optional AI backend — treated as untrusted *output*: its
  suggestions are clamped and never authoritative.

## 3. Threats and mitigations (STRIDE)

### Spoofing — "acting as someone you're not"
- **A user submits an appeal as another user.** *Mitigation:* identity comes
  from `context.reddit.getCurrentUser()` inside the Devvit runtime, never from
  client-supplied fields. The intake form's identity fields are not trusted for
  `authorId`/`authorName`.
- **A non-mod opens the dashboard or decides.** *Mitigation:* the dashboard is a
  mod-only custom post and the create-dashboard menu item is gated with
  `forUserType: 'moderator'`. Decisions execute in the mod-only post context.

### Tampering — "unauthorised modification"
- **Concurrent writes corrupt an appeal (lost update).** *Mitigation:*
  optimistic concurrency via Redis `WATCH`/`MULTI`/`EXEC` with a per-record
  `version`; conflicting writes abort and retry, then surface
  `OPTIMISTIC_LOCK_CONFLICT`. Verified by concurrency tests.
- **Two open appeals created for one action (race).** *Mitigation:* the
  per-action lock is claimed in an atomic watched transaction that fails closed;
  a second concurrent claim is rejected with `DUPLICATE_OPEN_APPEAL`. Verified
  by a parallel-submission test.
- **Malicious input corrupts stored JSON or logs.** *Mitigation:* validation
  rejects control characters and over-length fields; `sanitiseText` strips
  control chars before storage. Corrupt stored records are detected on read and
  raised as `DATA_CORRUPTION` rather than silently parsed.
- **Illegal state changes (e.g. re-deciding a resolved appeal).** *Mitigation:* a
  status state machine; resolved is terminal and rejects further decisions with
  `INVALID_STATE_TRANSITION`.

### Repudiation — "denying an action happened"
- **A mod denies how an appeal was decided.** *Mitigation:* every decision
  appends an immutable record to an append-only audit trail (decision, mod id,
  mod name, note, the exact reply sent, timestamp). The trail is never mutated,
  only appended.
- *Accepted risk:* the audit trail lives in Redis and is not independently
  signed or exported to a write-once store. For higher assurance, a deployment
  could mirror decision events to an append-only external log. Deferred.

### Information disclosure — "leaking data"
- **A user's appeal text leaks to other users.** *Mitigation:* appeals are
  stored under sub-scoped keys and only surfaced in the mod-only dashboard.
  Replies go to the appealing user via modmail, on-platform.
- **Original removal reason leaks into the user's editable form.** *Mitigation:*
  the original context is shown only to the mod; it is stashed in Redis at
  action time and read back on submit, never placed in a field the user sees or
  can alter.
- **Right-to-erasure.** *Mitigation:* `redactAppeal` scrubs the author name,
  reason, original content, permalink, and free-text notes/replies while keeping
  a structural tombstone (status, decision types, counts, timestamps) so
  moderation history stays auditable without retaining the user's words.
- *Accepted risk:* Appealdesk does not encrypt data at rest beyond what Devvit
  KV provides; it relies on the platform's storage security.

### Denial of service — "exhausting or blocking the system"
- **A user floods the queue with appeals.** *Mitigation:* a per-user
  token-bucket rate limiter (configurable capacity + refill), enforced at
  intake; over-limit submissions get `RATE_LIMITED` with a retry hint.
- **Duplicate-appeal spam wears mods down.** *Mitigation:* deterministic
  duplicate/repeat detection flags re-files; the one-appeal-per-action lock
  prevents stacking open appeals on the same action.
- **Unbounded data growth.** *Mitigation:* retention purges resolved appeals
  past a configurable window; the purge index lets the job range-scan only
  due records.
- **Aging appeals rot silently.** *Mitigation:* a scheduled SLA-nudge job alerts
  the mod team about appeals past the configured age.
- *Known scaling characteristic:* dedup hydrates a user's prior appeals on each
  submission, which is linear in that user's history length. In practice this is
  bounded (retention + realistic per-user appeal counts), but a pathological
  single user with thousands of retained appeals would slow their own
  submissions. A deployment can lower `retentionDays` or cap history depth.

### Elevation of privilege — "gaining capability you shouldn't have"
- **AI making a moderation decision.** *Mitigation — the central one:* AI is
  structurally incapable of deciding. It only produces a triage *label* (a hint)
  and a reply *draft*; the decision is always a mod's explicit action, and the
  reply is mod-reviewed before sending. The `NoopAiProvider` is a first-class
  implementation, so the entire feature degrades to deterministic behaviour when
  AI is off or unavailable. Malformed model output is parsed defensively and
  discarded; over-long or empty drafts fall back to the static template.
- **Prompt injection via appeal text.** *Threat:* a user writes their appeal to
  manipulate the AI triage/softening prompt. *Mitigation:* the AI output is
  never authoritative — a manipulated triage label is still only a hint a mod
  may ignore, and a manipulated softened reply is still mod-reviewed before
  sending. The blast radius is "a mod sees a misleading hint", not "an action is
  taken". The triage prompt also states the no-decision rule explicitly.

## 4. Failure-handling posture

- **Storage faults** surface as `STORAGE_UNAVAILABLE` (retryable), never silent
  data loss.
- **Reply delivery failure** does not roll back the decision (the decision is
  the source of truth); it raises `REPLY_DELIVERY_FAILED` so the surface can
  offer a resend, and the recorded `replyText` preserves what should have gone.
- **AI failure** degrades silently to the deterministic path — by design.
- **Best-effort, non-fatal paths** (the proactive ban-appeal modmail nudge, the
  SLA nudge) are wrapped so their failure never blocks the core workflow.

## 5. Explicitly out of scope / accepted risks

- No independent, signed, or external audit log (Redis-resident trail only).
- No at-rest encryption beyond the platform's.
- No abuse-detection on mod behaviour (Appealdesk assumes mods are trusted to
  decide; it provides the audit trail for after-the-fact review, not real-time
  mod-abuse prevention).
- The optional AI backend, if wired to an external model, inherits that
  provider's privacy posture — which is why AI is off by default and the product
  is complete without it.

## 6. Security-relevant invariants (enforced and tested)

1. AI never sets an appeal's decision or status. *(provider + service tests)*
2. A resolved appeal is terminal. *(state-machine + store tests)*
3. At most one open appeal exists per action under `oneAppealPerAction`.
   *(concurrency test)*
4. Concurrent writes never silently clobber. *(CAS + concurrency tests)*
5. User-supplied text is validated and sanitised before storage.
   *(validation tests)*
6. Erasure removes PII while preserving the audit tombstone. *(retention tests)*
