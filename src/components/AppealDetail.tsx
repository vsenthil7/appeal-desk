/**
 * AppealDetail — the single-appeal review screen. Shows the full context the
 * mod needs in one place (original content, original reason, the user's appeal
 * text, their prior-appeal history, any deterministic duplicate flag, and the
 * optional AI triage hint), then the three one-tap decision buttons.
 *
 * The decision buttons each open a reply-confirm form (handled by the parent),
 * so the reply is always mod-reviewed before sending. AI never decides.
 */

import { Devvit } from '@devvit/public-api';
import type { Appeal, AppealDecision } from '../core/types.js';
import {
  actionLabel,
  relativeTime,
  decisionLabel,
  triageBadge,
} from '../core/format.js';
import { Field, StatusPill, Pill, Divider } from './primitives.js';

interface DetailProps {
  appeal: Appeal;
  onBack: () => void;
  onDecide: (decision: AppealDecision) => void;
}

export function AppealDetail(props: DetailProps): JSX.Element {
  const { appeal } = props;
  const dup = appeal.triage.duplicateOfAppealId;
  const ai = appeal.triage.model;
  const resolved = appeal.status === 'resolved';

  return (
    <vstack height="100%" width="100%" padding="medium" gap="small">
      {/* Header / back */}
      <hstack alignment="middle" gap="small">
        <button
          icon="back"
          appearance="secondary"
          size="small"
          onPress={props.onBack}
        />
        <text size="large" weight="bold">
          {`u/${appeal.authorName}`}
        </text>
        <spacer grow />
        <StatusPill status={appeal.status} />
      </hstack>

      <text size="xsmall" color="neutral-content-weak">
        {`${actionLabel(appeal.actionType)} · submitted ${relativeTime(
          appeal.createdAt,
        )}`}
      </text>

      {/* Triage row: deterministic flags first, AI hint clearly marked. */}
      <hstack gap="small" alignment="middle">
        {appeal.triage.repeatCount > 0 ? (
          <Pill
            text={`${appeal.triage.repeatCount} prior appeal(s)`}
            color="#cc8b00"
          />
        ) : null}
        {dup ? <Pill text="Near-duplicate of an earlier appeal" color="#d93a00" /> : null}
        {ai ? (
          <hstack gap="small" alignment="middle">
            <Pill {...triageBadge(ai.label)} />
            <text size="xsmall" color="neutral-content-weak">
              {`AI hint · ${Math.round(ai.confidence * 100)}%`}
            </text>
          </hstack>
        ) : null}
      </hstack>

      <Divider />

      {/* Context the mod needs, all inline */}
      <vstack
        backgroundColor="neutral-background"
        cornerRadius="medium"
        padding="small"
      >
        <Field label="Original removal reason" value={appeal.originalReason} />
        <Field label="Original content" value={appeal.originalContent} />
        {appeal.permalink ? (
          <Field label="Link" value={appeal.permalink} />
        ) : null}
      </vstack>

      <vstack
        backgroundColor="neutral-background"
        cornerRadius="medium"
        padding="small"
      >
        <Field label="User's appeal" value={appeal.reason} />
        <Field
          label="Acknowledged the rule?"
          value={appeal.acknowledged ? 'Yes' : 'No'}
        />
        {ai ? <Field label="AI rationale (hint only)" value={ai.rationale} /> : null}
      </vstack>

      {/* Audit trail of any prior decisions on THIS appeal */}
      {appeal.decisions.length > 0 ? (
        <vstack
          backgroundColor="neutral-background"
          cornerRadius="medium"
          padding="small"
          gap="small"
        >
          <text size="xsmall" weight="bold" color="neutral-content-weak">
            DECISION HISTORY
          </text>
          {appeal.decisions.map((d) => (
            <text size="xsmall" wrap>
              {`${decisionLabel(d.decision)} by u/${d.modName} · ${relativeTime(
                d.decidedAt,
              )}${d.note ? ` — ${d.note}` : ''}`}
            </text>
          ))}
        </vstack>
      ) : null}

      <spacer grow />

      {/* The human decision. Disabled once resolved. */}
      {resolved ? (
        <hstack alignment="center middle" padding="small">
          <text size="small" color="neutral-content-weak">
            This appeal is resolved.
          </text>
        </hstack>
      ) : (
        <hstack gap="small" width="100%">
          <button
            appearance="destructive"
            grow
            onPress={() => props.onDecide('upheld')}
          >
            Uphold
          </button>
          <button
            appearance="success"
            grow
            onPress={() => props.onDecide('overturned')}
          >
            Overturn
          </button>
          <button
            appearance="secondary"
            grow
            onPress={() => props.onDecide('more_info')}
          >
            More info
          </button>
        </hstack>
      )}
    </vstack>
  );
}
