/**
 * Triggers — react to moderator actions so an appeal can be offered the moment
 * an action happens, tying the appeal back to the original action id (the key
 * thing free-text modmail can't do).
 *
 * On a ban or removal we (1) stash an action snapshot keyed by the target id so
 * a future appeal can show the mod the original context inline, and (2) for
 * bans, send the affected user a short, civil modmail inviting them to file a
 * structured appeal. We never auto-create an appeal — the user must choose to.
 *
 * Snapshot lifecycle is handled by `store.writeSnapshot` — that one helper
 * applies the TTL (H1), registers the snapshot in the purge index (D6), and
 * refuses to overwrite an existing snapshot (L4, so a removelink→spamlink
 * sequence doesn't silently clobber the snapshot a pending appeal will read).
 */

import { Devvit } from '@devvit/public-api';
import { AppealStore } from './context.js';
import type { ActionType } from '../core/types.js';

/** Human-readable reason derived from the action string (no reason field is
 *  carried on the ModAction event itself). */
function reasonForAction(action: string): string {
  switch (action) {
    case 'banuser':
      return '(account ban — see mod log for details)';
    case 'removelink':
    case 'spamlink':
      return '(post removed — see mod log for details)';
    case 'removecomment':
    case 'spamcomment':
      return '(comment removed — see mod log for details)';
    default:
      return '(see mod log)';
  }
}

Devvit.addTrigger({
  event: 'ModAction',
  onEvent: async (event, context) => {
    const action = event.action;
    if (!action) return;

    const sub = event.subreddit;
    if (!sub) return;

    const isRemoval =
      action === 'removelink' ||
      action === 'removecomment' ||
      action === 'spamlink' ||
      action === 'spamcomment';
    const isBan = action === 'banuser';
    if (!isRemoval && !isBan) return;

    // Identify the target. For a ban it's the user; for a removal the item.
    const targetId =
      event.targetPost?.id ??
      event.targetComment?.id ??
      event.targetUser?.id;
    if (!targetId) return;

    const actionType: ActionType = isBan
      ? 'ban'
      : event.targetComment
        ? 'comment_removal'
        : 'removal';

    const originalContent = isBan
      ? '(account ban)'
      : (event.targetPost?.title
          ? event.targetPost.title +
            (event.targetPost.selftext ? `\n\n${event.targetPost.selftext}` : '')
          : event.targetComment?.body) ?? '(not captured)';

    const permalink =
      event.targetPost?.permalink ?? event.targetComment?.permalink;

    // Record a lightweight action snapshot for later appeal context. The
    // store helper handles TTL, the snapshot purge index, and no-overwrite
    // (so a same-target re-action doesn't clobber a pending appeal's
    // snapshot — see L4).
    const store = new AppealStore(context.redis);
    const config = await store.getConfig(sub.name);
    try {
      await store.writeSnapshot(
        sub.name,
        targetId,
        {
          actionType,
          originalContent,
          originalReason: reasonForAction(action),
          permalink,
        },
        config,
      );
    } catch {
      // Snapshot write failure is non-fatal — the appeal still works with
      // placeholder context.
    }

    // Invite the affected user to appeal (civil, links to the form). Only for
    // bans, where the user can't reach the removed item's menu.
    const username = event.targetUser?.name;
    if (username && isBan) {
      try {
        await context.reddit.modMail.createConversation({
          subredditName: sub.name,
          subject: 'You can appeal this action',
          body:
            `Hi u/${username}, a moderator action was taken on your account in ` +
            `r/${sub.name}. If you believe this was a mistake, you can file a ` +
            `structured appeal that a human moderator will review. Reply here ` +
            `and a mod will route it to Appealdesk, or use the "Appeal this ` +
            `removal" option on any of your removed posts.`,
          to: username,
        });
      } catch {
        // Non-fatal — appeals still work without the proactive nudge.
      }
    }
  },
});

export const triggersLoaded = true;
