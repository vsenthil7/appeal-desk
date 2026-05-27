# Appealdesk — Performance Benchmarks

Run with `npm run bench`. The harness (`bench/run.ts`) times each hot path over
many iterations with the high-resolution clock and reports ops/sec plus mean and
p95 latency. It is dependency-free and runs anywhere the project builds.

## What's measured

The benchmarks isolate **Appealdesk's own logic**, not Redis network latency:
the pure functions run directly, and the store operations run against an
in-memory Redis fake. Production adds Devvit KV round-trips on top of these
numbers, but these establish a regression baseline for the code we own — if a
change makes `computeDedup` 10× slower, a re-run shows it immediately.

## Baseline (illustrative)

Captured on Node 22, a single shared CI-class core. Absolute numbers vary by
machine; the **relative** cost and the **shape** (which paths are cheap vs
linear) are the durable signal.

```
dedup.computeDedup (20 prior)        ~20,000 ops/s   mean ~50µs
dedup.jaccard                       ~135,000 ops/s   mean  ~7µs
validation.validateSubmission     ~1,500,000 ops/s   mean ~0.6µs
validation.sanitiseText           ~1,900,000 ops/s   mean ~0.5µs
templates.renderTemplate            ~910,000 ops/s   mean  ~1µs
rateLimit.checkRateLimit          ~4,100,000 ops/s   mean ~0.2µs
store.create (shared author)            ~140 ops/s   mean ~7ms   (see note)
store.openQueuePage (25)              ~6,200 ops/s   mean ~160µs
```

## Reading the results

- **Validation, sanitisation, templating, and rate-limiting are effectively
  free** (sub-microsecond to ~1µs). None of these will ever be a bottleneck.
- **Dedup is the most expensive pure path** (~50µs for 20 prior appeals) because
  it tokenises and compares the new reason against each prior reason. Still
  trivial at realistic per-user history sizes.
- **`store.create` in the benchmark looks slow (~7ms)** for a specific,
  documented reason: the benchmark files every appeal under a **single shared
  author**, so the per-user dedup history grows to thousands of entries and each
  `create` re-hydrates all of them — an O(history) read per submission, O(n²)
  across the run. This is a deliberate stress of the worst case.

## The one real scaling characteristic

`AppealStore.create` hydrates the submitting user's prior appeals to compute the
deterministic dedup signal. Cost is **linear in that user's retained appeal
history**. In normal operation this is small and bounded by:

- **Retention** (`retentionDays`, default 180) — old appeals are purged, capping
  history depth over time.
- **Realistic per-user volume** — a user files a handful of appeals, not
  thousands.

A pathological single user with thousands of retained appeals would slow *their
own* submissions (not others'). Mitigations available without code changes:
lower `retentionDays`, or rely on the rate limiter to bound submission velocity.
A future optimisation could cap dedup comparison to the N most-recent prior
appeals — noted, not yet needed.

## Regression use

Before a change to `core/`, run `npm run bench` and note the numbers; after,
re-run and compare. The pure-function paths should stay within noise; any large
movement in `dedup` or the store paths warrants a look.
