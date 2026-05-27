/**
 * Intake — the structured appeal form a user fills in. This is the heart of the
 * "structured intake vs angry free-text modmail" improvement: instead of a
 * rant, we capture a reason in a dedicated field plus an explicit rule
 * acknowledgement, all tied to the original action id.
 *
 * The original content / removal reason are shown to the MOD on the dashboard,
 * not to the appealing user, so they are NOT form fields. Instead, the menu
 * item (or the ModAction trigger) stashes an action snapshot in Redis keyed by
 * the target id; this submit handler reads that snapshot back. Only the
 * action type and target id round-trip through the form (as disabled fields)
 * so the user sees what they're appealing.
 */

import { Devvit } from '@devvit/public-api';
import { makeService } from './context.js';
import { syncConfigFromSettings } from './settings.js';
import { keys } from '../core/keys.js';
import { isAppealError } from '../core/errors/index.js';
import type { ActionType } from '../core/types.js';

/** Shape of the snapshot stashed by the menu item / trigger. */
interface ActionSnapshot {
  actionType: ActionType;
  originalContent: string;
  originalReason: string;
  permalink?: string;
}

/** Build the intake form. `data` carries the action being appealed. */
export const intakeForm = Devvit.createForm(
  (data) => ({
    title: 'Appeal this moderator action',
    description:
      'Appeals are reviewed by a human moderator. Be clear and civil — ' +
      'that gives your appeal the best chance.',
    acceptLabel: 'Submit appeal',
    fields: [
      {
        type: 'string',
        name: 'actionType',
        label: 'Action',
        defaultValue: (data.actionType as string) ?? 'removal',
        disabled: true,
      },
      {
        type: 'string',
        name: 'targetId',
        label: 'Reference',
        defaultValue: (data.targetId as string) ?? '',
        disabled: true,
      },
      {
        type: 'paragraph',
        name: 'reason',
        label: 'Why should this be reconsidered?',
        helpText: 'Explain calmly. Repeating the same appeal will be flagged.',
        required: true,
      },
      {
        type: 'boolean',
        name: 'acknowledged',
        label: 'I understand which rule was involved.',
        defaultValue: false,
      },
    ],
  }),
  async (event, context) => {
    const subreddit = context.subredditName ?? '';
    const user = await context.reddit.getCurrentUser();
    if (!user) {
      context.ui.showToast({ text: 'You must be signed in to appeal.' });
      return;
    }

    const values = event.values;
    const targetId = (values.targetId as string) ?? 'unknown';
    const actionType = (values.actionType as ActionType) ?? 'removal';

    // Read the action snapshot the menu item / trigger stashed for this target.
    let snapshot: ActionSnapshot = {
      actionType,
      originalContent: '(not captured)',
      originalReason: '(see mod log)',
    };
    try {
      const raw = await context.redis.get(
        keys.actionSeed(subreddit, targetId),
      );
      if (raw) snapshot = { ...snapshot, ...(JSON.parse(raw) as ActionSnapshot) };
    } catch {
      // Non-fatal — placeholders are fine; the appeal still works.
    }

    // Refresh persisted config from the live settings panel. Previously this
    // sync ran ONLY on AppInstall, so any setting a mod changed afterwards (SLA
    // window, rate limits, templates, AI toggle) was silently ignored until the
    // app was reinstalled. Doing it here keeps config fresh on every appeal,
    // which is exactly what this function's own docstring always claimed.
    // Best-effort: a settings read hiccup must never block a legitimate appeal.
    try {
      await syncConfigFromSettings(context);
    } catch {
      // Non-fatal — fall back to whatever config is already persisted.
    }

    const service = makeService(context);
    try {
      await service.submitAppeal({
        subreddit,
        actionType,
        targetId,
        authorId: user.id,
        authorName: user.username,
        reason: (values.reason as string) ?? '',
        acknowledged: Boolean(values.acknowledged),
        originalContent: snapshot.originalContent,
        originalReason: snapshot.originalReason,
        permalink: snapshot.permalink,
      });
    } catch (e) {
      context.ui.showToast({ text: messageForError(e) });
      return;
    }

    context.ui.showToast({
      appearance: 'success',
      text: 'Appeal submitted. A moderator will review it.',
    });
  },
);

/** Map a thrown AppealError to a short, user-appropriate message. */
function messageForError(e: unknown): string {
  if (isAppealError(e)) {
    switch (e.code) {
      case 'DUPLICATE_OPEN_APPEAL':
        return 'You already have an open appeal for this action.';
      case 'RATE_LIMITED':
        return 'You have appealed too many times recently. Please try later.';
      case 'APPEAL_INELIGIBLE':
        // The policy module supplies a human-readable reason; surface it.
        return typeof e.message === 'string' && e.message.length > 0
          ? e.message
          : 'This appeal is not currently eligible. Please review the community rules.';
      case 'OPTIMISTIC_LOCK_CONFLICT':
        // Retryable: a parallel writer was active. Tell the user to retry.
        return 'Your appeal could not be submitted just now — please try again.';
      case 'VALIDATION_FAILED':
        return 'Please check your appeal — the reason looks too short or invalid.';
      case 'STORAGE_UNAVAILABLE':
        return 'Something went wrong saving your appeal. Please try again.';
      default:
        return 'Your appeal could not be submitted. Please try again.';
    }
  }
  return 'Your appeal could not be submitted. Please try again.';
}
