/**
 * The Memory workbench.
 *
 * Every card renders every provenance field. That is deliberately more
 * information than a tidy design would show — and it is the right trade,
 * because the failure this surface exists to prevent is a person reading a
 * sentence the system believes about them with no way to tell where it came
 * from, how sure it is, or whether they ever agreed to it.
 *
 * Operations are buttons on the card. A confirm that takes four clicks is a
 * confirm nobody performs, and an uncorrected memory is worse than none.
 *
 * @module @watchskill/dsh-client-memory/components
 */

import type { ReactNode } from 'react'
import { toneFor, tokenFor } from '@watchskill/dsh-client-brand'
import type { MemoryEvent } from '@watchskill/dsh-memory'
import {
  MEMORY_VIEWS,
  MODE_DESCRIPTION,
  OPERATION_LABEL,
  VIEW_LABEL,
  eventsForTimeline,
  whyChip,
  type MemoryCard,
  type MemoryOperation,
  type MemoryView,
} from '../views.js'

/** A memory status's tone, through the brand's one table. */
function statusColor(status: string): string {
  return tokenFor(toneFor(status))
}

/** Props for {@link WhyRememberedChip}. */
export interface WhyRememberedChipProps {
  readonly card: MemoryCard
}

/**
 * The "Why remembered?" chip.
 *
 * Renders nothing when the memory has never reached a turn. An empty chip that
 * said "no reason recorded" would appear on most cards most of the time, and a
 * signal that is always present is not a signal.
 */
export function WhyRememberedChip({ card }: WhyRememberedChipProps): ReactNode {
  const line = whyChip(card)
  if (line === null) return null
  return (
    <span
      data-watch-why={card.memoryId}
      title={`${String(card.why.length)} recorded injection(s)`}
      style={{
        border: '1px solid var(--watch-tone-neutral)',
        borderRadius: '10px',
        padding: '0 6px',
        fontSize: '11px',
      }}
    >
      {line}
    </span>
  )
}

/** Props for {@link MemoryCardRow}. */
export interface MemoryCardRowProps {
  readonly card: MemoryCard
  readonly onOperation: (operation: MemoryOperation, memoryId: string) => void
}

/** One memory, with its provenance and its operations. */
export function MemoryCardRow({ card, onOperation }: MemoryCardRowProps): ReactNode {
  return (
    <article
      data-watch-memory={card.memoryId}
      data-watch-status={card.status}
      data-watch-origin={card.origin}
      data-watch-scope={card.scope}
      style={{ borderInlineStart: `3px solid ${statusColor(card.status)}`, padding: '6px 10px' }}
    >
      <p
        data-watch-memory-content=""
        lang={card.locale ?? undefined}
        // A memory written in Arabic renders right to left even in an English
        // interface. `auto` reads the first strong character, which is right
        // for content whose language is recorded but whose direction is not.
        dir="auto"
        style={{ margin: 0 }}
      >
        {card.content}
      </p>
      <dl
        data-watch-memory-fields=""
        style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0 8px', fontSize: '11px', margin: '4px 0 0' }}
      >
        <dt>id</dt><dd data-watch-field="memory_id">{card.memoryId}</dd>
        <dt>kind</dt><dd data-watch-field="kind">{card.kind}</dd>
        <dt>scope</dt><dd data-watch-field="scope">{`${card.scope}${card.scopeId === '' ? '' : `:${card.scopeId}`}`}</dd>
        <dt>origin</dt><dd data-watch-field="origin">{card.origin}</dd>
        <dt>confidence</dt><dd data-watch-field="confidence">{card.confidence.toFixed(2)}</dd>
        <dt>status</dt><dd data-watch-field="status">{card.status}</dd>
        <dt>from</dt>
        <dd data-watch-field="provenance">
          {card.provenance.length === 0 ? 'not recorded' : card.provenance.join(', ')}
        </dd>
        <dt>confirmed</dt>
        <dd data-watch-field="last_confirmed">{card.lastConfirmedAt ?? 'never'}</dd>
      </dl>
      <WhyRememberedChip card={card} />
      <div data-watch-memory-operations="" style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
        {card.operations.map(operation => (
          <button
            key={operation}
            type="button"
            data-watch-operation={operation}
            onClick={() => { onOperation(operation, card.memoryId) }}
            style={{ font: 'inherit', cursor: 'pointer' }}
          >
            {OPERATION_LABEL[operation]}
          </button>
        ))}
      </div>
    </article>
  )
}

/** Props for {@link MemoryTimeline}. */
export interface MemoryTimelineProps {
  readonly events: readonly MemoryEvent[]
}

/**
 * The Memory timeline.
 *
 * Events, not records. It is the only surface that shows a memory that no
 * longer exists — as the event that removed it, never as its content — which
 * is what makes "did it actually go?" answerable.
 */
export function MemoryTimeline({ events }: MemoryTimelineProps): ReactNode {
  return (
    <ol data-watch-memory-timeline="" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {eventsForTimeline(events).map(event => (
        <li key={event.eventId} data-watch-event={event.kind} data-watch-actor={event.actor}>
          <time dateTime={event.at}>{event.at}</time>
          <span>{` ${event.kind} by ${event.actor} — `}</span>
          <code dir="ltr">{event.memoryId}</code>
        </li>
      ))}
    </ol>
  )
}

/** Props for {@link MemoryWorkbench}. */
export interface MemoryWorkbenchProps {
  readonly view: MemoryView
  readonly cards: readonly MemoryCard[]
  readonly events: readonly MemoryEvent[]
  /** The durable memory mode this profile is in. */
  readonly mode: 'off' | 'session_only' | 'local_personal' | 'workspace_shared'
  /** The generated wiki, when the wiki view is open. Markdown. */
  readonly wiki?: string
  readonly onView: (view: MemoryView) => void
  readonly onOperation: (operation: MemoryOperation, memoryId: string) => void
}

/**
 * The Memory mode, in the product's own vocabulary.
 *
 * The current mode is stated on every Memory screen rather than hidden in
 * settings, because what a person is looking at means something different in
 * each one: an empty Taste in `off` is correct, and in `local_personal` it is
 * a question.
 */
export function MemoryWorkbench(props: MemoryWorkbenchProps): ReactNode {
  return (
    <section data-watch-memory-surface="" data-watch-memory-mode={props.mode} aria-label="Memory">
      <p data-watch-mode-description="">{MODE_DESCRIPTION[props.mode]}</p>
      <div role="tablist" aria-label="Memory view" style={{ display: 'flex', gap: '2px' }}>
        {MEMORY_VIEWS.map(view => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={props.view === view}
            data-watch-memory-view={view}
            onClick={() => { props.onView(view) }}
            style={{
              background: 'none',
              border: 'none',
              font: 'inherit',
              color: 'inherit',
              cursor: 'pointer',
              borderBottom: props.view === view
                ? '2px solid var(--watch-accent)'
                : '2px solid transparent',
            }}
          >
            {VIEW_LABEL[view]}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-watch-memory-panel={props.view}>
        {props.view === 'timeline' && <MemoryTimeline events={props.events} />}
        {props.view === 'wiki' && (
          <pre data-watch-memory-wiki="" style={{ whiteSpace: 'pre-wrap' }}>
            {props.wiki ?? 'No wiki has been generated for this workspace yet.'}
          </pre>
        )}
        {props.view !== 'timeline' && props.view !== 'wiki' && (
          props.cards.length === 0
            ? <p data-watch-memory-empty="">{`Nothing in ${VIEW_LABEL[props.view]}.`}</p>
            : props.cards.map(card => (
              <MemoryCardRow key={card.memoryId} card={card} onOperation={props.onOperation} />
            ))
        )}
      </div>
    </section>
  )
}
