/**
 * Dashboard — the mod-only appeals queue. Renders the list of open appeals,
 * newest first, each as a tappable row showing who, what action, how stale,
 * any repeat-count flag, the optional AI triage badge, and (W4) any "claimed
 * by u/X" pill. Tapping a row opens the detail view (handled by the parent
 * custom post via `onOpen`).
 *
 * M3 (pagination): the parent now passes a paged slice plus `hasMore` and
 * `onLoadMore`. The header shows the *true* open total via the new
 * `openCount` prop (not `appeals.length`, which was previously called
 * `openCount` and filtered for non-resolved — a dead filter, since the open
 * index never holds resolved appeals; L1).
 *
 * The tab toggle at the top lets a mod switch to the analytics view (W2)
 * without leaving the post.
 */

import { Devvit } from '@devvit/public-api';
import type { AppealSummary } from '../core/types.js';
import { actionLabel, relativeTime } from '../core/format.js';
import { StatusPill, EmptyState, Divider, Pill } from './primitives.js';

export type DashboardTab = 'queue' | 'analytics';

interface DashboardProps {
  subreddit: string;
  appeals: AppealSummary[];
  /** True total of open appeals — for the M3 header badge. The previous
   *  derivation (`appeals.filter(...).length`) was always equal to
   *  `appeals.length` because the open index excludes resolved appeals, and
   *  the page only ever held a slice anyway, so the badge undercounted. */
  openCount: number;
  /** True when there's another page to load (M3). */
  hasMore: boolean;
  /** Currently visible tab; the toggle at the top switches it. */
  tab: DashboardTab;
  onTab: (t: DashboardTab) => void;
  onOpen: (appealId: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  /** Slot for the analytics tab content; rendered when `tab === 'analytics'`. */
  analyticsSlot: JSX.Element | null;
}

export function Dashboard(props: DashboardProps): JSX.Element {
  const { appeals, openCount, hasMore, tab } = props;

  return (
    <vstack height="100%" width="100%" padding="medium" gap="small">
      {/* Header */}
      <hstack alignment="middle" gap="small">
        <text size="large" weight="bold">
          📋 Appealdesk
        </text>
        <spacer grow />
        <hstack
          backgroundColor="#d93a00"
          cornerRadius="full"
          padding="xsmall"
        >
          <text size="small" weight="bold" color="white">
            {`${openCount} open`}
          </text>
        </hstack>
        <button
          icon="refresh"
          appearance="secondary"
          size="small"
          onPress={props.onRefresh}
        />
      </hstack>

      {/* Tab toggle */}
      <hstack gap="small">
        <button
          appearance={tab === 'queue' ? 'primary' : 'secondary'}
          size="small"
          onPress={() => props.onTab('queue')}
        >
          Queue
        </button>
        <button
          appearance={tab === 'analytics' ? 'primary' : 'secondary'}
          size="small"
          onPress={() => props.onTab('analytics')}
        >
          Analytics
        </button>
      </hstack>

      <Divider />

      {tab === 'analytics' ? (
        props.analyticsSlot ?? <EmptyState message="Loading analytics…" />
      ) : appeals.length === 0 ? (
        <EmptyState message="No appeals are waiting. New appeals will appear here the moment a user submits one." />
      ) : (
        <vstack gap="small" grow>
          <text size="xsmall" color="neutral-content-weak">
            {`Appeals for r/${props.subreddit} — most recent first`}
          </text>
          {appeals.map((a) => (
            <AppealRow appeal={a} onPress={() => props.onOpen(a.id)} />
          ))}
          {hasMore ? (
            <hstack alignment="center" padding="small">
              <button
                appearance="secondary"
                size="small"
                onPress={props.onLoadMore}
              >
                Load more
              </button>
            </hstack>
          ) : null}
        </vstack>
      )}
    </vstack>
  );
}

function AppealRow(props: {
  appeal: AppealSummary;
  onPress: () => void;
}): JSX.Element {
  const { appeal } = props;
  const repeatFlag = appeal.repeatCount > 0;

  return (
    <hstack
      backgroundColor="neutral-background"
      cornerRadius="medium"
      padding="small"
      gap="small"
      alignment="middle"
      onPress={props.onPress}
    >
      <vstack gap="none" grow>
        <hstack gap="small" alignment="middle">
          <text size="medium" weight="bold">
            {`u/${appeal.authorName}`}
          </text>
          {repeatFlag ? (
            <hstack
              backgroundColor="#cc8b00"
              cornerRadius="full"
              padding="xsmall"
            >
              <text size="xsmall" weight="bold" color="white">
                {`↻ ${appeal.repeatCount} prior`}
              </text>
            </hstack>
          ) : null}
          {appeal.ruleId && appeal.ruleId !== 'unmapped' ? (
            <Pill text={appeal.ruleId} color="#4b4b4b" />
          ) : null}
          {appeal.assignedModName ? (
            <Pill text={`claimed: u/${appeal.assignedModName}`} color="#0079d3" />
          ) : null}
        </hstack>
        <text size="xsmall" color="neutral-content-weak">
          {`${actionLabel(appeal.actionType)} · ${relativeTime(appeal.createdAt)}`}
        </text>
      </vstack>
      <StatusPill status={appeal.status} />
      <text size="large" color="neutral-content-weak">
        ›
      </text>
    </hstack>
  );
}
