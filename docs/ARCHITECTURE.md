# Appealdesk — Architecture & Flow

This document is the visual companion to the README. Every diagram below is a
[Mermaid](https://mermaid.js.org/) diagram, which renders automatically on GitHub
and in most Markdown viewers. They cover: the layered architecture, the appeal
lifecycle state machine, the end-to-end intake and decision sequences, the module
dependency graph, the AI provider selection logic, and the data/Redis model.

---

## 1. Layered architecture

The guiding principle: **all real logic lives in a platform-free core**, and the
Devvit-specific code is a thin shell that injects `redis`, `reddit`, and an optional
`ai` backend into that core.

```mermaid
flowchart TB
    subgraph Reddit["Reddit UI"]
        MOD["Moderators"]
        USER["Affected users"]
    end

    subgraph Shell["Devvit shell (.tsx / server/*)"]
        MAIN["main.tsx\nconfigure + register"]
        POST["AppealsDashboardPost\n(custom post, stateful)"]
        MENU["menu.tsx\nmenu items"]
        INTAKE["intake.ts\nappeal form"]
        TRIG["triggers.ts\nModAction trigger"]
        SCHED["scheduler.ts\nSLA nudge job"]
        SET["settings.ts\nsettings + install"]
        CTX["context.ts\nwiring adapter"]
    end

    subgraph Core["Platform-free core (core/ + ai/)"]
        SVC["AppealService\norchestration"]
        STORE["AppealStore\npersistence"]
        DEDUP["dedup\nduplicate detection"]
        TMPL["templates\nreply rendering"]
        FMT["format\npresentation"]
        AI["AiProvider\n(Model or Noop)"]
        GW["RedditGateway\n(interface)"]
    end

    REDIS[("Redis\nDevvit KV")]
    RAPI["Reddit API\n(modmail, lookups)"]

    MOD --> POST
    MOD --> MENU
    USER --> INTAKE
    USER --> MENU

    POST --> CTX
    INTAKE --> CTX
    MENU --> INTAKE
    TRIG --> STORE
    SCHED --> STORE
    SET --> STORE

    CTX --> SVC
    SVC --> STORE
    SVC --> TMPL
    SVC --> AI
    SVC --> GW
    STORE --> DEDUP
    POST --> FMT

    STORE --> REDIS
    GW --> RAPI

    classDef core fill:#e8f4ff,stroke:#0079d3,color:#000
    classDef shell fill:#fff4e6,stroke:#d93a00,color:#000
    class SVC,STORE,DEDUP,TMPL,FMT,AI,GW core
    class MAIN,POST,MENU,INTAKE,TRIG,SCHED,SET,CTX shell
```

**Why it's shaped this way:** the core imports nothing from Devvit, so it can be
unit-tested to 100% coverage with an in-memory fake Redis and fake gateway/AI. The
only code that touches Redis is `AppealStore`; the only adapter from Devvit context
to the core is `context.ts`.

---

## 2. Appeal lifecycle (state machine)

An appeal moves through four states. The per-action lock is released only when an
appeal reaches `resolved`.

```mermaid
stateDiagram-v2
    [*] --> open : user submits appeal\n(dedup + optional AI hint computed)
    open --> in_review : mod opens it on the dashboard
    in_review --> resolved : mod taps Uphold / Overturn\n(reply sent, lock released)
    open --> resolved : mod decides directly
    in_review --> awaiting_user : mod taps "More info"\n(stays in queue)
    open --> awaiting_user : mod requests more info
    awaiting_user --> resolved : mod makes a final call
    resolved --> [*]

    note right of awaiting_user
        Still owned by a mod and
        still visible in the queue —
        the ball is in the user's court.
    end note

    note right of resolved
        Removed from the open queue.
        Per-action lock released so a
        genuinely new action can be
        appealed later.
    end note
```

---

## 3. End-to-end sequence: intake → decision

```mermaid
sequenceDiagram
    actor U as User
    actor M as Moderator
    participant UI as Devvit UI
    participant SVC as AppealService
    participant ST as AppealStore
    participant DD as dedup
    participant AI as AiProvider
    participant R as Redis
    participant RA as Reddit API

    Note over U,RA: Intake
    U->>UI: "Appeal this removal" → fills structured form
    UI->>SVC: submitAppeal(input)
    SVC->>ST: create(input)
    ST->>R: read prior appeals (history)
    ST->>DD: computeDedup(reason, prior)
    DD-->>ST: { repeatCount, duplicateOfAppealId? }
    ST->>R: write appeal + index + history + action lock
    ST-->>SVC: Appeal
    SVC->>AI: triage(appeal)  [only if aiEnabled]
    AI-->>SVC: hint | null
    SVC->>ST: setAiLabel(...)  [if hint]
    SVC-->>UI: Appeal (or null if duplicate-open)
    UI-->>U: "Appeal submitted"

    Note over U,RA: Review & decision
    M->>UI: open dashboard → tap an appeal
    UI->>SVC: open(sub, id)
    SVC->>ST: markInReview(sub, id)
    ST-->>SVC: Appeal (in_review)
    SVC-->>UI: Appeal → render detail
    M->>UI: tap Uphold / Overturn / More info
    UI->>SVC: suggestReply(sub, id, decision)
    SVC->>AI: softenReply(template)  [if aiEnabled]
    AI-->>SVC: draft
    SVC-->>UI: suggested reply (mod edits & approves)
    UI->>SVC: decide({ ..., finalReply })
    SVC->>ST: decide(...)  → status, audit trail, lock
    ST->>R: persist + update index
    SVC->>RA: sendReply (modmail to user)
    SVC-->>UI: resolved Appeal
    UI-->>M: "Appeal upheld and reply sent"
```

The single invariant across this whole sequence: **the decision is the mod's tap**,
and the reply is mod-approved before `sendReply` is ever called. AI appears only as
`triage` (a hint) and `softenReply` (a draft).

---

## 4. AI provider selection (graceful degradation)

This is the logic that guarantees the app works fully with AI switched off.

```mermaid
flowchart TD
    A["selectProvider(aiEnabled, backend)"] --> B{aiEnabled?}
    B -- no --> N["NoopAiProvider\n• triage → null\n• softenReply → draft unchanged"]
    B -- yes --> C{backend present?}
    C -- no --> N
    C -- yes --> MP["ModelAiProvider"]

    MP --> T["triage()"]
    T --> T1{model throws\nor unparseable?}
    T1 -- yes --> TN["return null\n(no hint; dedup still stands)"]
    T1 -- no --> TR["return clamped label"]

    MP --> S["softenReply()"]
    S --> S1{empty / too long /\nthrows?}
    S1 -- yes --> SD["return original draft"]
    S1 -- no --> SR["return softened reply"]

    classDef safe fill:#e8ffe8,stroke:#46a508,color:#000
    class N,TN,SD safe
```

Every failure path lands on a safe deterministic outcome (green). The `backend` is
populated only when the runtime exposes `context.ai.generateText`; the current Devvit
SDK does not, so in practice `selectProvider` returns the `NoopAiProvider`.

---

## 5. Module dependency graph

Arrows point from a module to what it depends on. Note that nothing in `core/` or
`ai/` points into the Devvit shell — the dependency direction is strictly inward.

```mermaid
flowchart LR
    subgraph shell["Devvit shell"]
        main["main.tsx"]
        post["AppealsDashboardPost"]
        dash["Dashboard"]
        det["AppealDetail"]
        prim["primitives"]
        ctx["context"]
        intake["intake"]
        menu["menu"]
        trig["triggers"]
        sched["scheduler"]
        sett["settings"]
    end

    subgraph core["core + ai"]
        svc["service"]
        store["store"]
        dedup["dedup"]
        tmpl["templates"]
        fmt["format"]
        keys["keys"]
        types["types"]
        prov["ai/provider"]
    end

    main --> post & menu & trig & sched & sett
    post --> ctx & fmt & dash & det
    dash --> prim & fmt
    det --> prim & fmt
    prim --> fmt
    ctx --> store & svc & prov
    intake --> ctx & keys
    menu --> intake & keys
    trig --> keys
    sched --> store & fmt
    sett --> store

    svc --> store & tmpl & prov
    store --> keys & dedup & types
    dedup --> types
    tmpl --> types
    fmt --> types
    prov --> types

    classDef core fill:#e8f4ff,stroke:#0079d3,color:#000
    class svc,store,dedup,tmpl,fmt,keys,types,prov core
```

---

## 6. Data & Redis model

```mermaid
erDiagram
    SUBREDDIT ||--o{ APPEAL : "has"
    APPEAL ||--o{ DECISION : "audit trail"
    APPEAL ||--|| TRIAGE : "carries"
    SUBREDDIT ||--|| CONFIG : "configured by"
    USER ||--o{ APPEAL : "files"

    APPEAL {
        string id PK "ap_<base36 ts><rand>"
        string subreddit
        string actionType "ban|removal|comment_removal"
        string targetId
        string authorName
        string reason "structured field"
        bool   acknowledged
        string originalContent "shown to mod"
        string originalReason
        string status "open|in_review|awaiting_user|resolved"
        number createdAt
    }
    TRIAGE {
        number repeatCount "deterministic"
        string duplicateOfAppealId "deterministic, optional"
        string model_label "AI hint, optional"
        number model_confidence
    }
    DECISION {
        string decision "upheld|overturned|more_info"
        string modName
        string note "internal"
        string replyText "sent to user"
        number decidedAt
    }
    CONFIG {
        number slaHours
        bool   aiEnabled
        bool   oneAppealPerAction
        string templates "per decision"
    }
```

Redis keys backing the above (all built in `core/keys.ts`; the `KEY_DESCRIPTIONS`
table in that module is the canonical source — this section is rendered from it):

```mermaid
flowchart LR
    K1["appeal:&lt;sub&gt;:&lt;id&gt;"] --> V1["Appeal record (JSON)"]
    K2["history:&lt;sub&gt;:&lt;user&gt;"] --> V2["sorted set of appeal ids\n(score = timestamp)"]
    K3["index:&lt;sub&gt;:open"] --> V3["sorted set of OPEN appeal ids\n(score = timestamp)"]
    K4["index:&lt;sub&gt;:purge"] --> V4["sorted set of resolved ids,\nscored by purge-eligibility ts"]
    K5["index:&lt;sub&gt;:snapshot_purge"] --> V5["sorted set of action-snapshot\ntargetIds scored by write ts (H1)"]
    K6["index:&lt;sub&gt;:ratelimit_purge"] --> V6["sorted set of rate-limit\nusernames scored by last-touch (H2)"]
    K7["index:&lt;sub&gt;:resolved"] --> V7["sorted set of recently-resolved ids\nscored by decidedAt — analytics seed (W2)"]
    K8["index:&lt;sub&gt;:erasure_log"] --> V8["mod-driven erasure audit trail (W1)"]
    K9["index:&lt;sub&gt;:dlq"] --> V9["dead-letter index for failed jobs"]
    K10["action:&lt;sub&gt;:&lt;targetId&gt;"] --> V10["open appeal id\n(per-action lock)"]
    K11["actionseed:&lt;sub&gt;:&lt;targetId&gt;"] --> V11["action snapshot (JSON);\nTTL-bounded (H1)"]
    K12["ratelimit:&lt;sub&gt;:&lt;user&gt;"] --> V12["token-bucket state (JSON);\nTTL-bounded (H2)"]
    K13["ratelimit-sub:&lt;sub&gt;:&lt;actionType&gt;"] --> V13["sub-wide token bucket\nper actionType (D3)"]
    K14["claim:&lt;sub&gt;:&lt;id&gt;"] --> V14["mod-id holding the appeal,\nTTL-bounded (W4)"]
    K15["config:&lt;sub&gt;"] --> V15["SubredditConfig (JSON)"]
    K16["policy:&lt;sub&gt;"] --> V16["per-sub PolicyConfig (W3)"]
    K17["dedupsig:&lt;sub&gt;:&lt;user&gt;"] --> V17["compact rolling dedup signature\n(reserved for D2 incremental)"]
```

### 6.1 Retention scheduler (Doc-6)

Three of the index families above are driven by recurring cron jobs registered
in `server/scheduler.ts`. Each is a bounded-batch sweeper: a job pulls at most
`limit` entries due before `now`, deletes them, and the cron re-fires the next
day so a backlog drains over time rather than spiking one run.

```mermaid
flowchart TB
    CRON1["cron 0 3 * * *"] --> RPJ["RETENTION_PURGE_JOB\nstore.purgeExpired (resolved appeals)"]
    CRON2["cron 15 3 * * *"] --> SPJ["SNAPSHOT_PURGE_JOB\nstore.purgeExpiredSnapshots (H1)"]
    CRON3["cron 30 3 * * *"] --> RLPJ["RATELIMIT_PURGE_JOB\nstore.purgeExpiredRateLimits (H2)"]
    CRON4["cron 0 */6 * * *"] --> SLA["SLA_NUDGE_JOB\nmodmail + Notifier (W4)"]

    RPJ --> RD["index:&lt;sub&gt;:purge"]
    SPJ --> SD["index:&lt;sub&gt;:snapshot_purge"]
    RLPJ --> LD["index:&lt;sub&gt;:ratelimit_purge"]
    SLA --> SLAIDX["index:&lt;sub&gt;:open"]

    classDef job fill:#e8f4ff,stroke:#0079d3,color:#000
    classDef idx fill:#fff4e6,stroke:#d93a00,color:#000
    class RPJ,SPJ,RLPJ,SLA job
    class RD,SD,LD,SLAIDX idx
```

Each sweep is **idempotent and bounded**: a sweeper deletes only entries whose
TTL has elapsed (or whose retention score is past `now`). TTLs at write time
are the primary defence; the index sweep is the deterministic belt-and-braces
so a host with drifting TTL semantics still maintains the invariants.

---

## 7. Reading guide

If you're reviewing the code, a good path is:

1. `core/types.ts` — the vocabulary everything else speaks.
2. `core/dedup.ts` — the deterministic value driver, in isolation.
3. `core/store.ts` — how state is persisted and indexed.
4. `core/service.ts` — how a request becomes a decision.
5. `ai/provider.ts` — how the optional layer stays optional.
6. `components/AppealsDashboardPost.tsx` — how the UI drives the service.
7. `server/*` — the triggers, scheduler, settings, and menu wiring.

Then run `npm test` to watch the whole core prove itself.
