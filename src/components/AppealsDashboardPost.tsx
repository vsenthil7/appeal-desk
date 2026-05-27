/**
 * The mod-only Appeals Dashboard custom post. This is the stateful container:
 * it owns the "which screen" state (queue vs detail), loads data from the
 * AppealService, and wires the decision flow through a reply-confirm form so
 * every reply is mod-reviewed before it is sent.
 *
 * Devvit gives us `useState`, `useAsync`, and `useForm` on the render context.
 *
 * Note on the casts at the hook boundaries: Devvit's `useAsync` is typed to
 * return `JSONValue`, and our domain objects (`Appeal`, `AppealSummary`) are
 * plain serializable data that already round-trip through Redis as JSON. They
 * are JSON-compatible at runtime but don't carry the structural index
 * signature TypeScript wants for `JSONObject`, so we cast at the boundary and
 * cast back when reading `.data`. This is localised to this one container.
 */

import { Devvit, useState, useAsync, useForm } from '@devvit/public-api';
import type { JSONValue } from '@devvit/public-api';
import { Dashboard } from './Dashboard.js';
import { AppealDetail } from './AppealDetail.js';
import { makeService } from '../server/context.js';
import type { Appeal, AppealDecision, AppealSummary } from '../core/types.js';
import { decisionLabel } from '../core/format.js';

export const AppealsDashboardPost: Devvit.CustomPostComponent = (context) => {
  const subreddit = context.subredditName ?? '';
  const service = makeService(context);

  // Navigation state: null = queue list, else the open appeal id.
  const [openId, setOpenId] = useState<string | null>(null);
  // Bump to force a queue/detail reload after a decision.
  const [version, setVersion] = useState(0);

  // Load the open queue (when on the list screen).
  const queue = useAsync<JSONValue>(
    async () => (await service.queue(subreddit)) as unknown as JSONValue,
    { depends: [version, openId] },
  );

  // Load the active appeal (when on the detail screen).
  const detail = useAsync<JSONValue>(
    async () =>
      openId
        ? ((await service.open(subreddit, openId)) as unknown as JSONValue)
        : null,
    { depends: [openId, version] },
  );

  // Reply-confirm form: shows the suggested (template + optional AI) reply,
  // lets the mod edit it and add an internal note, then records the decision.
  // The form-builder receives Devvit's loosely-typed data bag; we read the
  // fields we seeded in `startDecision`.
  const replyForm = useForm(
    (data) => {
      const decision = (data.decision as AppealDecision) ?? 'upheld';
      const suggested = (data.suggested as string) ?? '';
      return {
        title: `${decisionLabel(decision)} — confirm reply`,
        description:
          'This reply will be sent to the user. Edit as needed. ' +
          'The decision is yours; AI only drafts wording.',
        acceptLabel: 'Send & record',
        cancelLabel: 'Cancel',
        fields: [
          {
            type: 'paragraph',
            name: 'reply',
            label: 'Reply to the user',
            defaultValue: suggested,
            required: true,
          },
          {
            type: 'paragraph',
            name: 'note',
            label: 'Internal note (not sent to the user)',
            required: false,
          },
          {
            type: 'string',
            name: 'decision',
            label: 'Decision',
            defaultValue: decision,
            disabled: true,
          },
        ],
      };
    },
    async (values) => {
      if (!openId) return;
      const me = await context.reddit.getCurrentUser();
      const decided = await service.decide({
        subreddit,
        appealId: openId,
        decision: (values.decision as AppealDecision) ?? 'upheld',
        modId: me?.id ?? 'unknown',
        modName: me?.username ?? 'a moderator',
        note: (values.note as string) ?? '',
        finalReply: values.reply as string,
      });
      if (decided) {
        context.ui.showToast({
          appearance: 'success',
          text: `Appeal ${decisionLabel(
            (values.decision as AppealDecision) ?? 'upheld',
          ).toLowerCase()} and reply sent.`,
        });
        setOpenId(null);
        setVersion((v) => v + 1);
      } else {
        context.ui.showToast({ text: 'Could not record the decision.' });
      }
    },
  );

  async function startDecision(decision: AppealDecision): Promise<void> {
    if (!openId) return;
    const suggested = await service.suggestReply(subreddit, openId, decision);
    context.ui.showForm(replyForm, { decision, suggested });
  }

  // ---- render ----------------------------------------------------------

  const activeAppeal = detail.data as Appeal | null;
  if (openId && activeAppeal) {
    return (
      <AppealDetail
        appeal={activeAppeal}
        onBack={() => setOpenId(null)}
        onDecide={(d) => void startDecision(d)}
      />
    );
  }

  const appeals = (queue.data as AppealSummary[] | null) ?? [];
  return (
    <Dashboard
      subreddit={subreddit}
      appeals={appeals}
      onOpen={(id) => setOpenId(id)}
      onRefresh={() => setVersion((v) => v + 1)}
    />
  );
};
