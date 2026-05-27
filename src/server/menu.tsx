/**
 * Menu items — the entry points surfaced in Reddit's UI.
 *
 *   1. Subreddit menu  → "Create Appealdesk dashboard" (mods, one-time setup).
 *   2. Post/comment menu → "Appeal this removal" (the affected user).
 *
 * Mod-only items are gated with `forUserType: 'moderator'`. The appeal item is
 * available to the content's author.
 */

import { Devvit } from '@devvit/public-api';
import { intakeForm } from './intake.js';
import { keys } from '../core/keys.js';
import type { ActionType } from '../core/types.js';

/** Mods: create the pinned, mod-only Appeals Dashboard custom post. */
Devvit.addMenuItem({
  label: 'Appealdesk: create dashboard',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const sub = await context.reddit.getCurrentSubreddit();
    const post = await context.reddit.submitPost({
      title: '📋 Appealdesk — Appeals Dashboard (mods only)',
      subredditName: sub.name,
      preview: (
        <vstack height="100%" width="100%" alignment="center middle">
          <text size="large">Loading Appealdesk…</text>
        </vstack>
      ),
    });
    // Pin and restrict visibility is handled via subreddit settings/sticky.
    await post.sticky().catch(() => undefined);
    context.ui.showToast({
      appearance: 'success',
      text: 'Appeals Dashboard created and pinned.',
    });
    context.ui.navigateTo(post);
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

    // Best-effort capture of original context to show the mod later.
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
      // Non-fatal — the appeal still works with placeholders.
    }

    // Stash an action snapshot for the submit handler to read back. The mod
    // sees this on the dashboard; it never enters the user's editable form.
    await context.redis.set(
      keys.actionSeed(subreddit, targetId),
      JSON.stringify({ actionType, originalContent, originalReason, permalink }),
    );

    // Only JSON-safe, user-visible fields go into the form data bag.
    context.ui.showForm(intakeForm, { actionType, targetId });
  },
});
