/**
 * The mod-only Appeals Dashboard custom post. This is the stateful container:
 * it owns the "which screen / which tab" state (queue vs detail; queue vs
 * analytics), loads data from the AppealService, and wires the decision flow
 * through a reply-confirm form so every reply is mod-reviewed before it is
 * sent.
 *
 * Devvit gives us `useState`, `useAsync`, and `useForm` on the render context.
 *
 * Note on the casts at the hook boundaries: Devvit's `useAsync` is typed to
 * return `JSONValue`, and our domain objects (`Appeal`, `AppealSummary`) are
 * plain serializable data that already round-trip through Redis as JSON. They
 * are JSON-compatible at runtime but don't carry the structural index
 * signature TypeScript wants for `JSONObject`, so we cast at the boundary and
 * cast back when reading `.data`. This is localised to this one container.
 *
 * Post-review changes:
 *   - **M3** — pagination wired. The queue accumulates pages via `cursor`
 *     state; the dashboard header shows the true `openCount`, not the page
 *     size, so a busy sub with > 25 open appeals no longer silently truncates.
 *   - **W2** — Analytics tab, loaded lazily when activated.
 *   - **W1** — Erase button on resolved appeals; calls `service.eraseAppeal`.
 *   - **W4** — Claim / unclaim controls; the "claimed by u/X" pill is shown
 *     on rows and detail view.
 *   - **L3** — clicking the near-duplicate / paraphrase pill navigates to the
 *     prior appeal via `setOpenId`.
 */

import { Devvit, useState, useAsync, useForm } from '@devvit/public-api';
import type { JSONValue } from '@devvit/public-api';
import { Dashboard, type DashboardTab } from './Dashboard.js';
import { AppealDetail } from './AppealDetail.js';
import { AnalyticsTab } from './AnalyticsTab.js';
import { makeService } from '../server/context.js';
import type { Appeal, AppealDecision, AppealSummary } from '../core/types.js';
import type { Page, QueueCursor } from '../core/store.js';
import type { SubAnalytics } from '../core/analytics/index.js';
import { decisionLabel } from '../core/format.js';
import { isAppealError } from '../core/errors/index.js';

const PAGE_SIZE = 25;

export const AppealsDashboardPost: Devvit.CustomPostComponent = (context) => {
  const subreddit = context.subredditName ?? '';
  const service = makeService(context);

  // Navigation state: null = list, else the open appeal id.
  const [openId, setOpenId] = useState<string | null>(null);
  // Tab toggle on the list screen.
  const [tab, setTab] = useState<DashboardTab>('queue');
  // Bump to force a queue/detail reload after a decision.
  const [version, setVersion] = useState(0);
  // M3: accumulated pages + the cursor for the next one. Devvit's useState
  // requires `JSONValue`; `AppealSummary[][]` is JSON-compatible at runtime
  // but doesn't carry the structural index signature TypeScript wants, so
  // we cast at the boundary (same pattern as the useAsync casts elsewhere
  // in this file).
  const [pagesJson, setPagesJson] = useState<JSONValue>(
    [] as unknown as JSONValue,
  );
  const [cursorJson, setCursorJson] = useState<JSONValue>(null);
  const [hasMore, setHasMore] = useState(true);
  // Analytics window (7d / 30d).
  const [analyticsWindow, setAnalyticsWindow] = useState(30);

  const pages = pagesJson as unknown as AppealSummary[][];
  const cursor = cursorJson as unknown as QueueCursor | null;
  const setPages = (p: AppealSummary[][]): void =>
    setPagesJson(p as unknown as JSONValue);
  const setCursor = (c: QueueCursor | null): void =>
    setCursorJson(c as unknown as JSONValue);

  // Identify the viewing mod (W4 claim/unclaim UI).
  const meAsync = useAsync<JSONValue>(
    async () => {
      try {
        const u = await context.reddit.getCurrentUser();
        return u
          ? ({ id: u.id, name: u.username } as unknown as JSONValue)
          : null;
      } catch {
        return null;
      }
    },
    { depends: [] },
  );
  const me = meAsync.data as { id: string; name: string } | null;

  // M3: first page loader. Resets the accumulator when `version` bumps.
  const firstPage = useAsync<JSONValue>(
    async () => {
      try {
        const page = (await service.queuePage(subreddit, PAGE_SIZE)) as Page<AppealSummary>;
        setPages([page.items]);
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
        const count = await service.openCount(subreddit);
        return { count } as unknown as JSONValue;
      } catch {
        setPages([]);
        setCursor(null);
        setHasMore(false);
        return { count: 0 } as unknown as JSONValue;
      }
    },
    { depends: [version, openId, tab] },
  );
  const openCount = ((firstPage.data as { count: number } | null)?.count) ?? 0;

  async function loadMore(): Promise<void> {
    if (!cursor) return;
    try {
      const page = (await service.queuePage(
        subreddit,
        PAGE_SIZE,
        cursor,
      )) as Page<AppealSummary>;
      setPages([...pages, page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
    } catch {
      // Surface nothing on the row; the user can hit Refresh.
    }
  }

  // Load the active appeal (when on the detail screen).
  const detail = useAsync<JSONValue>(
    async () => {
      if (!openId) return null;
      try {
        return (await service.open(subreddit, openId)) as unknown as JSONValue;
      } catch {
        return null;
      }
    },
    { depends: [openId, version] },
  );

  // Lazy-load analytics only when the tab is active.
  const analytics = useAsync<JSONValue>(
    async () => {
      if (tab !== 'analytics') return null;
      try {
        return (await service.analytics(
          subreddit,
          analyticsWindow,
        )) as unknown as JSONValue;
      } catch {
        return null;
      }
    },
    { depends: [tab, version, analyticsWindow] },
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
      const decision = (values.decision as AppealDecision) ?? 'upheld';
      try {
        await service.decide({
          subreddit,
          appealId: openId,
          decision,
          modId: me?.id ?? 'unknown',
          modName: me?.name ?? 'a moderator',
          note: (values.note as string) ?? '',
          finalReply: values.reply as string,
        });
        context.ui.showToast({
          appearance: 'success',
          text: `Appeal ${decisionLabel(decision).toLowerCase()} and reply sent.`,
        });
      } catch (e) {
        if (isAppealError(e) && e.code === 'REPLY_DELIVERY_FAILED') {
          // The decision WAS recorded; only the reply failed to send.
          context.ui.showToast({
            text: 'Decision recorded, but the reply could not be sent. Try resending.',
          });
        } else {
          context.ui.showToast({ text: 'Could not record the decision.' });
          return; // keep the mod on the appeal so they can retry
        }
      }
      setOpenId(null);
      setVersion((v) => v + 1);
    },
  );

  async function startDecision(decision: AppealDecision): Promise<void> {
    if (!openId) return;
    try {
      const suggested = await service.suggestReply(subreddit, openId, decision);
      context.ui.showForm(replyForm, { decision, suggested });
    } catch {
      context.ui.showForm(replyForm, { decision, suggested: '' });
    }
  }

  // ---- render ----------------------------------------------------------

  const activeAppeal = detail.data as Appeal | null;
  if (openId && activeAppeal) {
    return (
      <AppealDetail
        appeal={activeAppeal}
        meModId={me?.id}
        meModName={me?.name}
        onBack={() => setOpenId(null)}
        onDecide={(d) => void startDecision(d)}
        onJumpTo={(priorId) => setOpenId(priorId)}
        onErase={async () => {
          try {
            await service.eraseAppeal(subreddit, activeAppeal.id);
            context.ui.showToast({
              appearance: 'success',
              text: 'Appeal erased.',
            });
            setOpenId(null);
            setVersion((v) => v + 1);
          } catch {
            context.ui.showToast({ text: 'Erasure failed.' });
          }
        }}
        onClaim={async () => {
          try {
            await service.claim(
              subreddit,
              activeAppeal.id,
              me?.id ?? 'unknown',
              me?.name ?? 'a moderator',
            );
            setVersion((v) => v + 1);
          } catch {
            context.ui.showToast({ text: 'Could not claim.' });
          }
        }}
        onUnclaim={async () => {
          try {
            await service.unclaim(
              subreddit,
              activeAppeal.id,
              me?.id ?? 'unknown',
            );
            setVersion((v) => v + 1);
          } catch {
            context.ui.showToast({ text: 'Could not release the claim.' });
          }
        }}
      />
    );
  }

  // Flatten accumulated pages for the dashboard list.
  const appeals = pages.flat();
  return (
    <Dashboard
      subreddit={subreddit}
      appeals={appeals}
      openCount={openCount}
      hasMore={hasMore}
      tab={tab}
      onTab={setTab}
      onOpen={(id) => setOpenId(id)}
      onLoadMore={() => void loadMore()}
      onRefresh={() => {
        setPages([]);
        setCursor(null);
        setHasMore(true);
        setVersion((v) => v + 1);
      }}
      analyticsSlot={
        tab === 'analytics' ? (
          <AnalyticsTab
            data={analytics.data as SubAnalytics | null}
            windowDays={analyticsWindow}
            onSetWindow={(d) => setAnalyticsWindow(d)}
          />
        ) : null
      }
    />
  );
};
