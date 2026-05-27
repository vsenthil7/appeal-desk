/**
 * Small reusable Blocks UI primitives shared across the dashboard and detail
 * views. Devvit Blocks use a JSX-like syntax with custom elements (<vstack>,
 * <hstack>, <text>, <button>, etc.). These helpers keep the screens tidy.
 */

import { Devvit } from '@devvit/public-api';
import type { AppealStatus } from '../core/types.js';
import { statusColor, statusLabel } from '../core/format.js';

/** A coloured pill, e.g. for status or triage labels. */
export function Pill(props: { text: string; color: string }): JSX.Element {
  return (
    <hstack
      backgroundColor={props.color}
      cornerRadius="full"
      padding="xsmall"
      gap="none"
    >
      <text size="xsmall" weight="bold" color="white">
        {props.text}
      </text>
    </hstack>
  );
}

export function StatusPill(props: { status: AppealStatus }): JSX.Element {
  return <Pill text={statusLabel(props.status)} color={statusColor(props.status)} />;
}

/** A labelled value row used in the detail view. */
export function Field(props: { label: string; value: string }): JSX.Element {
  return (
    <vstack gap="none" padding="xsmall">
      <text size="xsmall" color="neutral-content-weak" weight="bold">
        {props.label.toUpperCase()}
      </text>
      <text size="small" wrap>
        {props.value || '—'}
      </text>
    </vstack>
  );
}

export function Divider(): JSX.Element {
  return <spacer size="small" shape="thin" />;
}

/** Empty-state card for when the queue has no open appeals. */
export function EmptyState(props: { message: string }): JSX.Element {
  return (
    <vstack
      alignment="center middle"
      padding="large"
      gap="small"
      grow
    >
      <text size="xxlarge">📭</text>
      <text size="medium" weight="bold">
        All caught up
      </text>
      <text size="small" color="neutral-content-weak" alignment="center">
        {props.message}
      </text>
    </vstack>
  );
}
