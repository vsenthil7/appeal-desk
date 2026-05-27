/**
 * AppealDetail — the single-appeal review screen. Shows the full context the
 * mod needs in one place (original content, original reason, the user's appeal
 * text, their prior-appeal history, any deterministic duplicate flag, the
 * softer paraphrase flag, and the optional AI triage hint), then the three
 * one-tap decision buttons.
 *
 * Each decision button opens a reply-confirm form (handled by the parent),
 * so the reply is always mod-reviewed before sending. AI never decides.
 *
 * Several review-pass touch-ups land here:
 *
 *   - **L2** — button rework. Convention is "destructive coloring = dangerous
 *     action for the actor," not "punitive for the subject." Uphold uses
 *     `primary` (most common outcome), Overturn uses `secondary`, More info
 *     uses `secondary` with a help-y icon. The previous green-for-overturn
 *     scheme was set up to be misclicked when scanning fast.
 *   - **L3** — the near-duplicate pill (and the new paraphrase pill, D1) is
 *     now clickable, jumping the open appeal id to the prior via `onJumpTo`.
 *   - **W1** — resolved-state branch shows an "Erase this appeal" button.
 *   - **W4** — claim / unclaim controls. The "claimed by u/X" pill is shown
 *     when a mod holds the appeal, and the current mod sees an Unclaim button
 *     instead of Claim while it's theirs.
 *   - **D1** — paraphrase pill alongside the strict duplicate pill.
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
  /** Current viewing mod (for the W4 claim/unclaim UI). May be empty if the
   *  context doesn't expose a user yet. */
  meModId?: string;
  meModName?: string;
  onBack: () => void;
  onDecide: (decision: AppealDecision) => void;
  /** L3: jump to a prior appeal by id (clicks on the dup/paraphrase pills). */
  onJumpTo?: (priorId: string) => void;
  /** W1: erase this resolved appeal. */
  onErase?: () => void;
  /** W4: claim / unclaim hooks. */
  onClaim?: () => void;
  onUnclaim?: () => void;
}

export function AppealDetail(props: DetailProps): JSX.Element {
  const { appeal } = props;
  const dup = appeal.triage.duplicateOfAppealId;
  const paraphrase = appeal.triage.paraphraseOfAppealId;
  const ai = appeal.triage.model;
  const resolved = appeal.status === 'resolved';
  const claimedByMe =
    !!props.meModId &&
    !!appeal.assignedModId &&
    appeal.assignedModId === props.meModId;
  const claimedBySomeoneElse =
    !!appeal.assignedModId &&
    appeal.assignedModId !== props.meModId;

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
        {dup ? (
          // L3: clickable, jumps the dashboard to the prior appeal.
          <hstack onPress={() => props.onJumpTo?.(dup)}>
            <Pill text="Near-duplicate of an earlier appeal →" color="#d93a00" />
          </hstack>
        ) : null}
        {paraphrase ? (
          <hstack onPress={() => props.onJumpTo?.(paraphrase)}>
            <Pill text="Likely paraphrase of an earlier appeal →" color="#a0522d" />
          </hstack>
        ) : null}
        {appeal.ruleId && appeal.ruleId !== 'unmapped' ? (
          <Pill text={appeal.ruleId} color="#4b4b4b" />
        ) : null}
        {appeal.assignedModName ? (
          <Pill
            text={`claimed: u/${appeal.assignedModName}`}
            color="#0079d3"
          />
        ) : null}
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

      {/* W4: claim row sits ABOVE the decision row so the act of claiming
          is the visible, deliberate first step before deciding. */}
      {!resolved ? (
        <hstack gap="small" alignment="middle">
          {claimedByMe ? (
            <button
              icon="lock-fill"
              appearance="secondary"
              size="small"
              onPress={() => props.onUnclaim?.()}
            >
              Release claim
            </button>
          ) : claimedBySomeoneElse ? (
            <text size="xsmall" color="neutral-content-weak">
              {`Currently claimed by u/${appeal.assignedModName} — pick a different appeal or wait.`}
            </text>
          ) : (
            <button
              icon="mod"
              appearance="secondary"
              size="small"
              onPress={() => props.onClaim?.()}
            >
              Claim
            </button>
          )}
        </hstack>
      ) : null}

      <spacer grow />

      {/* The human decision. Disabled once resolved. L2 reorders + recolours. */}
      {resolved ? (
        <vstack gap="small">
          <hstack alignment="center middle" padding="small">
            <text size="small" color="neutral-content-weak">
              This appeal is resolved.
            </text>
          </hstack>
          {/* W1: mod-facing erase. The service writes to the erasure audit log. */}
          {props.onErase ? (
            <hstack alignment="center">
              <button
                icon="delete"
                appearance="destructive"
                size="small"
                onPress={() => props.onErase?.()}
              >
                Erase this appeal
              </button>
            </hstack>
          ) : null}
        </vstack>
      ) : (
        // L2: Uphold becomes the visual default (most common outcome,
        // `primary`), Overturn is `secondary` with a clear icon, and More info
        // is `secondary` too. Order also changed so the destructive-leaning
        // option isn't first under the thumb on mobile.
        <hstack gap="small" width="100%">
          <button
            appearance="primary"
            grow
            onPress={() => props.onDecide('upheld')}
          >
            Uphold
          </button>
          <button
            icon="checkmark"
            appearance="secondary"
            grow
            onPress={() => props.onDecide('overturned')}
          >
            Overturn
          </button>
          <button
            icon="help"
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
