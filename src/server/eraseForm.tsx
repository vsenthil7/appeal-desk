/**
 * W1: mod-facing erasure form. Confirms a destructive action with a typed
 * acknowledgement, then calls `AppealService.eraseUserByMod` so the acting
 * mod is recorded in the erasure audit log (the redacted appeal itself can't
 * carry that without defeating the purpose).
 */

import { Devvit } from '@devvit/public-api';
import { makeService } from './context.js';

export const eraseUserForm = Devvit.createForm(
  () => ({
    title: 'Erase a user’s appeals',
    description:
      'Redacts every appeal this user has filed in this sub, drops their ' +
      'rate-limit bucket, and records the action in the erasure audit log. ' +
      "This is IRREVERSIBLE. Type 'ERASE' to confirm.",
    acceptLabel: 'Erase',
    cancelLabel: 'Cancel',
    fields: [
      {
        type: 'string',
        name: 'username',
        label: 'Username (without u/)',
        required: true,
      },
      {
        type: 'string',
        name: 'confirm',
        label: "Type 'ERASE' to confirm",
        required: true,
      },
    ],
  }),
  async (event, context) => {
    const username = ((event.values.username as string) ?? '').trim();
    const confirm = ((event.values.confirm as string) ?? '').trim();
    if (confirm !== 'ERASE') {
      context.ui.showToast({ text: "Type 'ERASE' to confirm." });
      return;
    }
    if (!username) {
      context.ui.showToast({ text: 'Username is required.' });
      return;
    }
    const me = await context.reddit.getCurrentUser();
    const service = makeService(context);
    const subreddit = context.subredditName ?? '';
    try {
      const redacted = await service.eraseUserByMod(
        subreddit,
        username,
        me?.id ?? 'unknown',
        me?.username ?? 'a moderator',
      );
      context.ui.showToast({
        appearance: 'success',
        text: `Erased ${redacted.length} appeal(s) for u/${username}.`,
      });
    } catch {
      context.ui.showToast({ text: 'Erasure failed. See logs.' });
    }
  },
);
