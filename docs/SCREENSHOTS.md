# Appealdesk — Screenshots

This file documents the recommended screenshot set for a fresh install. Drop
images into `docs/img/` with the filenames below and they'll render here.

The goal is one screenshot per visible surface so a reviewer can scan the app
without installing it. None of the screenshots contain real user PII (the dev
playtest sub is the canonical capture source).

---

## 1. Queue tab — the live dashboard

![Dashboard queue](./img/01-dashboard-queue.png)

Shows: header with open-count badge, queue / analytics toggle, row layout with
the W3 ruleId pill, W4 "claimed by u/X" pill, and the "Load more" pagination
control at the bottom.

## 2. Analytics tab (W2)

![Dashboard analytics](./img/02-dashboard-analytics.png)

Shows: 7d / 30d window toggle, the four headline tiles (Open / Resolved /
Overturn rate / Median TTR), top overturned rules, and the action-type
breakdown.

## 3. Appeal detail — open

![Appeal detail](./img/03-appeal-detail-open.png)

Shows: the triage row (repeat-count pill, duplicate / paraphrase pills clickable
to L3 jump, AI hint), original-content and user-appeal panels, claim controls
(W4), and the L2 button order (Uphold primary / Overturn / More info).

## 4. Appeal detail — resolved

![Appeal detail resolved](./img/04-appeal-detail-resolved.png)

Shows: status pill, decision history with chainHash verified, and the W1
"Erase this appeal" button.

## 5. Intake form (user-facing)

![Intake form](./img/05-intake-form.png)

Shows: structured fields the user fills out — reason, acknowledgement
checkbox, etc.

## 6. Erasure form (mod-facing, W1)

![Erasure form](./img/06-erase-form.png)

Shows: username + ERASE confirmation gate; clicking submits to
`service.eraseUserByMod` which redacts every appeal and writes to the
erasure audit log.

## 7. Settings page

![Settings](./img/07-settings.png)

Shows: per-sub configuration including new fields: AI backend selector, AI
confidence floor, sub-wide rate limit, snapshot retention hours, claim TTL
minutes.

---

## Capturing screenshots in a fresh install

1. Install the app to your dev playtest sub.
2. Trigger one ban and one removal to seed snapshots.
3. From a separate account, file two appeals (one duplicate, one paraphrase).
4. As a mod, claim one and decide it.
5. Open the dashboard and capture each surface above.

PII guidance: use Reddit's test-account creation flow; never capture real
modlog entries or real usernames.
