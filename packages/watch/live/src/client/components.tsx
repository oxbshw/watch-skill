/**
 * The Live surface.
 *
 * The header is deliberately busy. A live view's job is to be trustworthy
 * about time, and that means the clocks, the latency, the connection state and
 * the continuity line are all present at once rather than behind a disclosure.
 * The moment one of them is hidden, the surface starts implying a continuity
 * it has not checked.
 *
 * @module @watchskill/dsh-live/components
 */

import type { ReactNode } from 'react'
import { toneFor, tokenFor } from '@watchskill/dsh-client-brand'
import {
  describeContinuity,
  type LiveEvent,
  type LiveSessionState,
} from '../session.js'

/** Connection states, mapped onto the brand's status vocabulary. */
const CONNECTION_STATUS: Readonly<Record<string, string>> = {
  connecting: 'queued',
  live: 'running',
  reconnecting: 'gap',
  lost: 'unavailable',
  stopped: 'completed',
}

/** A millisecond count as a clock reading. */
function clock(ms: number | null): string {
  if (ms === null) return '—'
  const total = Math.max(0, Math.floor(ms / 1000))
  const seconds = String(total % 60).padStart(2, '0')
  const minutes = String(Math.floor(total / 60) % 60).padStart(2, '0')
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

/** Props for {@link LiveHeader}. */
export interface LiveHeaderProps {
  readonly state: LiveSessionState
}

/**
 * Session, media and wall clocks, side by side.
 *
 * Three readings rather than one, because they answer three questions and
 * disagree constantly during a live observation. A single "time" field would
 * be right about one of them and quietly wrong about the other two.
 */
export function LiveHeader({ state }: LiveHeaderProps): ReactNode {
  const status = CONNECTION_STATUS[state.connection] ?? 'unavailable'
  return (
    <header data-watch-live-header="" data-watch-live-session={state.sessionId}>
      <span data-watch-field="target" dir="ltr">{state.target}</span>
      <span data-watch-field="kind">{state.kind}</span>
      <span data-watch-field="status">{state.status}</span>
      <span data-watch-field="connection" style={{ color: tokenFor(toneFor(status)) }}>
        <span aria-hidden="true">{state.connection === 'live' ? '●' : '▲'}</span>
        <span>{state.connection}</span>
      </span>
      <span data-watch-field="session-clock" dir="ltr">{`session ${clock(state.clocks.sessionMs)}`}</span>
      <span data-watch-field="media-clock" dir="ltr">{`media ${clock(state.clocks.mediaMs)}`}</span>
      <span data-watch-field="wall-clock" dir="ltr">
        {state.clocks.wallMs === null ? 'wall —' : `wall ${new Date(state.clocks.wallMs).toISOString()}`}
      </span>
      <span data-watch-field="latency">
        {state.clocks.latencyMs === null ? 'latency —' : `latency ${String(state.clocks.latencyMs)}ms`}
      </span>
      <span data-watch-field="continuity">{describeContinuity(state)}</span>
    </header>
  )
}

/** Props for {@link LiveEventRow}. */
export interface LiveEventRowProps {
  readonly event: LiveEvent
  readonly onSelect: (event: LiveEvent) => void
}

/**
 * One observed event.
 *
 * A gap draws as a gap — dashed, glyphed and labelled — and is never
 * collapsed into the events around it.
 */
export function LiveEventRow({ event, onSelect }: LiveEventRowProps): ReactNode {
  const isGap = event.kind === 'gap'
  return (
    <li data-watch-live-event={event.kind} data-watch-seq={String(event.seq)}>
      <button
        type="button"
        onClick={() => { onSelect(event) }}
        style={{
          font: 'inherit',
          color: 'inherit',
          cursor: 'pointer',
          background: isGap ? 'var(--watch-wash-caution)' : 'none',
          border: isGap ? '1px dashed var(--watch-tone-caution)' : '1px solid transparent',
          textAlign: 'start',
          width: '100%',
        }}
      >
        <span dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>{clock(event.mediaMs)}</span>
        {isGap && <span aria-hidden="true">{' ⌇ '}</span>}
        <span dir="auto">{event.text}</span>
      </button>
    </li>
  )
}

/** Props for {@link LiveSurface}. */
export interface LiveSurfaceProps {
  readonly state: LiveSessionState
  readonly onStart: () => void
  readonly onStop: (finalize: boolean) => void
  readonly onAsk: (question: string) => void
  readonly onSelect: (event: LiveEvent) => void
  readonly onPin: () => void
}

/**
 * The Live mode body.
 *
 * `Resnapshot needed` is rendered as a banner rather than a toast. A transient
 * notification for "your view of this is not continuous" is a notification
 * that will be missed exactly when it matters.
 */
export function LiveSurface(props: LiveSurfaceProps): ReactNode {
  const { state } = props
  return (
    <section data-watch-live="" aria-label="Live observation">
      <LiveHeader state={state} />
      {state.needsSnapshot && (
        <p
          role="alert"
          data-watch-live-resnapshot=""
          style={{ borderInlineStart: '3px solid var(--watch-tone-caution)', paddingInlineStart: '8px' }}
        >
          {'This view is not continuous. '}
          {state.lastError ?? 'The stream did not continue from the last cursor.'}
          {' A fresh snapshot is needed before anything here can be read as unbroken.'}
        </p>
      )}
      <div data-watch-live-controls="">
        <button type="button" data-watch-action="start" onClick={props.onStart}>Start</button>
        <button type="button" data-watch-action="pin" onClick={props.onPin}>Pin moment</button>
        <button type="button" data-watch-action="finalize" onClick={() => { props.onStop(true) }}>
          Stop and keep
        </button>
        <button type="button" data-watch-action="discard" onClick={() => { props.onStop(false) }}>
          Stop and discard
        </button>
      </div>
      <ul data-watch-live-events="" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {state.events.map(event => (
          <LiveEventRow key={`${String(event.seq)}`} event={event} onSelect={props.onSelect} />
        ))}
      </ul>
      {state.pinned.length > 0 && (
        <ul data-watch-live-pinned="" aria-label="Pinned moments">
          {state.pinned.map(moment => (
            <li key={moment.momentId} data-watch-pinned={moment.momentId}>
              <span dir="ltr">{clock(moment.atMediaMs)}</span>
              <span dir="auto">{` ${moment.note}`}</span>
            </li>
          ))}
        </ul>
      )}
      {state.trimmed > 0 && (
        <p data-watch-live-trimmed={String(state.trimmed)}>
          {`${String(state.trimmed)} earlier event(s) are no longer held in this view. `}
          {'Gaps and pinned moments were kept.'}
        </p>
      )}
    </section>
  )
}
