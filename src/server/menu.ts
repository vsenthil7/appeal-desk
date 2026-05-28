/**
 * Menu items — Devvit 0.13 version.
 *
 * What changed from the 0.11/0.12 version:
 *
 *   - The Blocks "preview" inside `submitPost(...)` is gone (the field was
 *     removed from `SubmitPostOptions` in 0.13). The web-view post is created
 *     via the module-level `reddit.submitCustomPost(...)` from
 *     `@devvit/web/server`, which renders the entrypoint declared in
 *     `devvit.json` under `post.entrypoints.default`.
 *   - `eraseUserForm` is registered inline rather than in a separate `.tsx`
 *     file. Blocks forms via `Devvit.createForm` are still supported.
 *
 * Three menu items survive from the original design:
 *   1. Subreddit menu  → "Appeal-Desk: create dashboard" (mods, one-time setup).
 *   2. Subreddit menu  → "Appeal-Desk: erase a user's appeals" (W1 mod-facing
 *      erasure surface).
 *   3. Post / comment  → "Appeal this removal" (the affected user).
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
 * Mods: create the pinned Appeals Dashboard custom post.
 *
 * Uses the new 0.13 `submitCustomPost` via the module-level `reddit` import
 * from `@devvit/web/server`. The post entrypoint resolves to the `default`
 * entry declared in `devvit.json` (`client/index.html`).
 */
Devvit.addMenuItem({
  label: 'Appeal-Desk: create dashboard',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const { reddit } = await import('@devvit/web/server');
    const sub = await context.reddit.getCurrentSubreddit();
    const post = await reddit.submitCustomPost({
      subredditName: sub.name,
      title: 'Appeal-Desk - Appeals Dashboard (mods only)',
      textFallback: {
        text: 'Open the Appeals Dashboard to triage open appeals.',
      },
    });
    try {
      await post.sticky();
    } catch {
      // non-fatal: post still works without being pinned
    }
    context.ui.showToast({
      appearance: 'success',
      text: 'Appeals Dashboard created and pinned.',
    });
    context.ui.navigateTo(post);
  },
});

/** W1: mod-facing erasure surface. */
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
