/**
 * Menu items — Devvit 0.13 version.
 *
 * Split between two delivery mechanisms because 0.13 has different
 * capabilities in different runtimes:
 *
 *   - The "create dashboard" item creates a custom web-view post via
 *     `reddit.submitCustomPost(...)`. That API only exists on the
 *     `@devvit/web/server` runtime, NOT on the Blocks `context.reddit`
 *     surface. So it's declared in `devvit.json#menu.items` and dispatches
 *     to `/internal/menu/create-dashboard` in `src/server/main.ts`.
 *
 *   - The other items ("erase a user's appeals", "Appeal this removal")
 *     don't need server-only APIs — they show forms via `context.ui.showForm`,
 *     which works fine from a Blocks menu handler. Those stay here.
 *
 * Forms (`Devvit.createForm`) are still legal in 0.13 Blocks mode. The
 * "show the form" call happens from a Blocks handler; the form's own
 * submit handler runs in the Blocks runtime too. We don't need to
 * migrate forms to the JSON-config `forms` block for this app.
 */

import { Devvit } from '@devvit/public-api';
import { intakeForm } from './intake.js';
import { AppealStore, makeService } from './context.js';
import type { ActionType } from '../core/types.js';

/** GDPR erasure form (W1). */
export const eraseUserForm = Devvit.createForm(
  {
    title: "Erase a user's appeals",
    description:
      "GDPR-style erasure. Free text in every appeal by this user in this " +
      "sub is scrubbed; an auditable tombstone is preserved. Idempotent.",
    acceptLabel: 'Erase',
    fields: [
      {
        type: 'string',
        name: 'username',
        label: "User's name (without u/)",
        required: true,
      },
      {
        type: 'paragraph',
        name: 'reason',
        label: 'Why is this erasure being performed?',
        helpText:
          'Logged in the audit trail. e.g. user request, legal requirement.',
        required: true,
      },
    ],
  },
  async (event, context) => {
    const sub = context.subredditName ?? '';
    const service = makeService(context);
    const username = (event.values.username ?? '').trim();
    const reason = (event.values.reason ?? '').trim();
    const modName = (await context.reddit.getCurrentUser())?.username ?? 'unknown';
    if (!username || !reason) {
      context.ui.showToast({
        appearance: 'neutral',
        text: 'Username and reason are required.',
      });
      return;
    }
    try {
      const ids = await service.eraseUserByMod(sub, username, modName, reason);
      context.ui.showToast({
        appearance: 'success',
        text:
          ids.length === 0
            ? `No appeals found for u/${username}.`
            : `Erased ${ids.length} appeal(s) for u/${username}.`,
      });
    } catch (e) {
      context.ui.showToast({
        appearance: 'neutral',
        text: e instanceof Error ? e.message : 'Erasure failed.',
      });
    }
  },
);

/**
 * W1: mod-facing erasure surface. Shows the GDPR erasure form.
 *
 * Note: "create dashboard" used to live here too, but its implementation
 * required `reddit.submitCustomPost` from `@devvit/web/server`, which is
 * unavailable in the Blocks runtime. It's been moved to `devvit.json`
 * under `menu.items` -> `/internal/menu/create-dashboard`. See
 * `src/server/main.ts` for the handler.
 */
Devvit.addMenuItem({
  label: "Appeal-Desk: erase a user's appeals",
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: (_event, context) => {
    context.ui.showForm(eraseUserForm);
  },
});

/** Affected users: appeal a removed post or comment. */
Devvit.addMenuItem({
  label: 'Appeal this removal',
  location: ['post', 'comment'],
  onPress: async (event, context) => {
    const isComment = event.location === 'comment';
    const actionType: ActionType = isComment ? 'comment_removal' : 'removal';
    const targetId = event.targetId;
    const subreddit = context.subredditName ?? '';

    let originalContent = '(not captured)';
    const originalReason = '(see mod log)';
    let permalink: string | undefined;
    try {
      if (isComment) {
        const c = await context.reddit.getCommentById(targetId);
        originalContent = c.body ?? originalContent;
        permalink = c.permalink;
      } else {
        const p = await context.reddit.getPostById(targetId);
        originalContent = p.title + (p.body ? `\n\n${p.body}` : '');
        permalink = p.permalink;
      }
    } catch {
      // Non-fatal — appeal still works with placeholders.
    }

    const store = new AppealStore(context.redis);
    const config = await store.getConfig(subreddit);
    try {
      await store.writeSnapshot(
        subreddit,
        targetId,
        { actionType, originalContent, originalReason, permalink },
        config,
      );
    } catch {
      // Non-fatal — the appeal still works with placeholder context.
    }

    context.ui.showForm(intakeForm, { actionType, targetId });
  },
});
