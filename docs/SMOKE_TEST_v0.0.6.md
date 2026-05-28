# Appeal-Desk — manual smoke test for v0.0.6 (Devvit 0.13)

> 5-minute checklist for validating the live 0.13 web-view dashboard on
> r/appeal_desk_dev. Walk this if the Chrome MCP can't run it automatically.
>
> **App URL:** https://www.reddit.com/r/appeal_desk_dev/
> **Dashboard page:** developers.reddit.com/apps/appeal-desk
> **Version under test:** 0.0.6 (Public API 0.13.0)
> **What you're checking:** that the real interactive dashboard renders,
> the /api/* endpoints respond, and the three-button decision flow works.

---

## 1. App installs cleanly

- [ ] Open https://developers.reddit.com/apps/appeal-desk in a browser logged
      into u/vsenthil7.
- [ ] Confirm the banner "A new version of Devvit (0.13.0) is now available"
      is **gone** (it was visible when v0.0.3 was latest; it should clear at
      v0.0.4+).
- [ ] In the App Versions table, confirm:
  - Latest version is **0.0.6**
  - Public API is **0.13.0**
  - Status is **Uploaded** (not "Failed")
  - Installations count is **1** (r/appeal_desk_dev)

## 2. Dashboard custom post creates

- [ ] Visit https://www.reddit.com/r/appeal_desk_dev/
- [ ] Click the three-dot subreddit menu (mod controls) and find
      **"Appeal-Desk: create dashboard"** — confirm it's listed.
- [ ] Click it. Toast should say "Appeals Dashboard created and pinned."
- [ ] A new pinned post titled **"Appeal-Desk - Appeals Dashboard (mods only)"**
      should appear at the top of the sub.

## 3. Web view renders

- [ ] Open the pinned dashboard post.
- [ ] Confirm visually:
  - Header shows "Appeal-Desk" brand with the green verdigris tick
  - Two tabs: **Queue** (active) and **Analytics**
  - A refresh button (↻) in the top right
  - Empty state: "No appeals are waiting. New appeals will appear here..."
  - Brand palette: navy background, cream text, verdigris accents

## 4. Generate an appeal

> The dashboard is empty by design — we need to create some test data.

- [ ] In another tab, log into u/<a second test account> (a non-mod account
      you control, or any sock account; the appeal needs to come from a
      non-mod user).
- [ ] In a thread on r/appeal_desk_dev, post a test comment.
- [ ] As u/vsenthil7, remove the comment via mod controls.
- [ ] **Expected behaviour:** the second account receives a modmail invite,
      and clicking "Appeal this removal" on the removed comment opens the
      intake form.
- [ ] Submit the form with a test reason like "this was a misunderstanding".

## 5. Triage from the dashboard

- [ ] Back on the dashboard post (as u/vsenthil7), click ↻ refresh.
- [ ] Confirm the appeal row appears with:
  - The appealing username
  - Action label ("Comment removal · just now")
  - Status pill ("Open" in coral)
  - Chevron on the right
- [ ] Click the row.
- [ ] Confirm the detail screen shows:
  - Back button (← Back)
  - Username, status pill
  - Triage flags row (empty for first appeal)
  - Original removal reason + content cards
  - User's appeal card
  - **Claim button**
  - **Three decision buttons:** Uphold (primary green), Overturn, Need more info

## 6. Claim flow

- [ ] Click **Claim**.
- [ ] Toast: "Claimed." Button changes to **Release claim**.
- [ ] Pill row shows "claimed: u/vsenthil7" (blue).
- [ ] Click **Release claim**.
- [ ] Toast: "Released." Button goes back to **Claim**.

## 7. Decision + reply-confirm flow

- [ ] Click **Uphold**.
- [ ] Reply-confirm screen renders:
  - Title: "Upheld — confirm reply"
  - Hint text about the reply being editable
  - "Reply to the user" textarea — should be pre-filled with the upheld
    template text (the AI softener won't run because there's no AI provider
    wired in the 0.13 server)
  - "Internal note" textarea (empty)
  - **Send & record** (primary), **Cancel** buttons
- [ ] Edit the reply slightly (add "Thanks for understanding." at the end).
- [ ] Add an internal note: "test note".
- [ ] Click **Send & record**.
- [ ] Toast: "Appeal upheld and reply sent."
- [ ] Dashboard refreshes; the appeal is no longer in the open queue (open
      count badge drops or hides).

## 8. Resolved view + erasure

- [ ] Submit a second test appeal (steps 4–5 again) — or reopen the resolved
      one from the queue (won't be there since it's resolved; instead use a
      *new* test appeal and resolve it the same way).
- [ ] From the resolved-appeal detail (if you can navigate there), confirm:
  - No decision buttons
  - "This appeal is resolved." banner
  - **Erase this appeal** (coral/danger button)
- [ ] Click Erase. Confirm dialog. Confirm.
- [ ] Toast: "Appeal erased."

## 9. Analytics tab

- [ ] Go back to the queue, click **Analytics** tab.
- [ ] Confirm rendering:
  - "Window: 7d 30d" toggle
  - Four tiles: **Open** (coral), **Resolved (Nd)** (green), **Overturn
    rate** (violet), **Median TTR** (blue)
  - Top overturned (rules OR original reasons) card
  - By-action-type card (if any resolved appeals exist)
- [ ] Click **7d** vs **30d** — values should change.

## 10. Network sanity check (optional, opens DevTools)

- [ ] Open the browser DevTools Network panel.
- [ ] On the dashboard, click refresh.
- [ ] Confirm a POST request to `/api/appeals/list` is made.
- [ ] Confirm the response is JSON with `items`, `nextCursor`, `hasMore`,
      `openCount`.
- [ ] Click an appeal — confirm POST to `/api/appeals/open`.
- [ ] Run a decision — confirm POST sequence:
      `/api/appeals/suggest-reply` → `/api/appeals/decide`.

---

## Result tally

| Step | Pass? | Notes |
|---|---|---|
| 1 — Install clean | | |
| 2 — Dashboard creates | | |
| 3 — Web view renders | | |
| 4 — Appeal generated | | |
| 5 — Triage works | | |
| 6 — Claim flow | | |
| 7 — Decision + reply | | |
| 8 — Resolved + erase | | |
| 9 — Analytics | | |
| 10 — Network sanity | | |

If any step fails, capture the browser console / network panel output and
share it. The likely failure modes from the migration:

- **Steps 2–3 fail:** the web-view bundle didn't ship. Check the upload log
  said "WebView assets uploaded".
- **Step 5 detail won't load:** /api/appeals/open is broken. Most likely
  cause is the server bundle not loading because `dist/server/main.js` is
  malformed or has an externalised import that the host doesn't actually
  provide. The build script externalises every `@devvit/*` package; if the
  Devvit runtime exposes something under a different name, the bundle will
  throw at first call.
- **Step 7 decide fails:** modmail permissions issue. The 0.13 reddit
  module uses `reddit.modMail.createConversation(...)` directly; if the
  app's reddit scope is `user` instead of `moderator`, this fails. Check
  `devvit.json` — should be `"scope": "moderator"`.
- **Step 9 analytics empty:** expected when no appeals have been resolved.

---

## After a successful smoke test

If everything works:
1. Apply for App Directory: `cd appeal-desk; devvit publish --public`
2. Wait for Reddit's review (manual moderation, can take days).
3. Update `submission_media/DEVPOST_SUBMISSION.md` to mention the App
   Directory URL once approved.
