/**
 * Dashboard — the mod-only appeals queue. Renders the list of open appeals,
 * newest first, each as a tappable row showing who, what action, how stale,
 * any repeat-count flag, and the optional AI triage badge. Tapping a row opens
 * the detail view (handled by the parent custom post via `onOpen`).
 */

import { Devvit } from '@devvit/public-api';
import type { AppealSummary } from '../core/types.js';
import { actionLabel, relativeTime } from '../core/format.js';
import { StatusPill, EmptyState, Divider } from './primitives.js';

interface DashboardProps {
  subreddit: string;
  appeals: AppealSummary[];
  onOpen: (appealId: string) => void;
  onRefresh: () => void;
}

export function Dashboard(props: DashboardProps): JSX.Element {
  const { appeals } = props;
  const openCount = appeals.filter((a) => a.status !== 'resolved').length;

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
      <text size="xsmall" color="neutral-content-weak">
        {`Appeals for r/${props.subreddit} — most recent first`}
      </text>

      <Divider />

      {appeals.length === 0 ? (
        <EmptyState message="No appeals are waiting. New appeals will appear here the moment a user submits one." />
      ) : (
        <vstack gap="small" grow>
          {appeals.map((a) => (
            <AppealRow appeal={a} onPress={() => props.onOpen(a.id)} />
          ))}
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
