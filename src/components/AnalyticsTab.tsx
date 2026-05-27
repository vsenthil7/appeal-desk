/**
 * AnalyticsTab (W2). Renders the typed SubAnalytics shape into the dashboard.
 * Pure presentation — the data is computed by `AppealService.analytics()`.
 *
 * The headline number is the open queue size; the most visually interesting
 * row is `topRulesOverturned` (when policy is configured) or
 * `topOriginalReasonsOverturned` (when it isn't) — that's the signal that a
 * specific rule or removal reason is being mis-enforced, which is the demo
 * payoff of having analytics at all.
 */

import { Devvit } from '@devvit/public-api';
import type { SubAnalytics } from '../core/analytics/index.js';
import { labelForActionType } from '../core/analytics/index.js';
import { Divider } from './primitives.js';

interface AnalyticsProps {
  data: SubAnalytics | null;
  windowDays: number;
  onSetWindow: (days: number) => void;
}

export function AnalyticsTab(props: AnalyticsProps): JSX.Element {
  const { data, windowDays } = props;
  if (!data) {
    return (
      <vstack alignment="center middle" padding="large">
        <text size="medium">Loading analytics…</text>
      </vstack>
    );
  }

  const overturnRate =
    data.resolvedInWindow > 0
      ? Math.round((data.overturnedInWindow / data.resolvedInWindow) * 100)
      : 0;
  const median =
    data.medianTimeToDecisionMs === null
      ? '—'
      : formatDuration(data.medianTimeToDecisionMs);

  return (
    <vstack gap="small" padding="small">
      {/* Window toggle */}
      <hstack gap="small" alignment="middle">
        <text size="small" color="neutral-content-weak">
          Window:
        </text>
        <button
          appearance={windowDays === 7 ? 'primary' : 'secondary'}
          size="small"
          onPress={() => props.onSetWindow(7)}
        >
          7d
        </button>
        <button
          appearance={windowDays === 30 ? 'primary' : 'secondary'}
          size="small"
          onPress={() => props.onSetWindow(30)}
        >
          30d
        </button>
      </hstack>

      <Divider />

      {/* Headline tiles */}
      <hstack gap="small">
        <Tile label="Open" value={String(data.openCount)} color="#d93a00" />
        <Tile
          label={`Resolved (${data.windowDays}d)`}
          value={String(data.resolvedInWindow)}
          color="#46a508"
        />
        <Tile
          label="Overturn rate"
          value={`${overturnRate}%`}
          color="#7c4dff"
        />
        <Tile label="Median TTR" value={median} color="#0079d3" />
      </hstack>

      <Divider />

      {/* Top overturned rules (policy-mapped) — the rule-mis-tuned signal. */}
      {data.topRulesOverturned.length > 0 ? (
        <vstack gap="small">
          <text size="small" weight="bold">
            Top overturned rules
          </text>
          {data.topRulesOverturned.map((r) => (
            <text size="xsmall">{`${r.ruleId} — ${r.count}`}</text>
          ))}
        </vstack>
      ) : data.topOriginalReasonsOverturned.length > 0 ? (
        <vstack gap="small">
          <text size="small" weight="bold">
            Top overturned reasons
          </text>
          {data.topOriginalReasonsOverturned.map((r) => (
            <text size="xsmall" wrap>
              {`${truncate(r.reason, 60)} — ${r.count}`}
            </text>
          ))}
        </vstack>
      ) : (
        <text size="xsmall" color="neutral-content-weak">
          No overturns in the window — the rules are being applied
          consistently, or no decisions have landed yet.
        </text>
      )}

      <Divider />

      {/* Action-type breakdown */}
      {data.byActionType.length > 0 ? (
        <vstack gap="small">
          <text size="small" weight="bold">
            Resolutions by action type
          </text>
          {data.byActionType.map((b) => (
            <text size="xsmall">
              {`${labelForActionType(b.actionType)} — ${b.count}`}
            </text>
          ))}
        </vstack>
      ) : null}
    </vstack>
  );
}

function Tile(props: { label: string; value: string; color: string }): JSX.Element {
  return (
    <vstack
      backgroundColor="neutral-background"
      cornerRadius="medium"
      padding="small"
      gap="none"
      grow
    >
      <text size="xsmall" color="neutral-content-weak" weight="bold">
        {props.label.toUpperCase()}
      </text>
      <text size="large" weight="bold" color={props.color}>
        {props.value}
      </text>
    </vstack>
  );
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * 60_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 24 * 60 * 60_000) return `${Math.round(ms / (60 * 60_000))}h`;
  return `${Math.round(ms / (24 * 60 * 60_000))}d`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
