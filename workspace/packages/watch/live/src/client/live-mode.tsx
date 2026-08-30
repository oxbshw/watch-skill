/**
 * The Live mode body.
 *
 * It lives in the package that owns the capability rather than in the workspace
 * shell. That is structural, not tidiness: the shell provides the scaffold every
 * mode shares, and a mode that also needed something back from its own package
 * made the two depend on each other. TypeScript refused the circular project
 * reference, which was the right answer to the wrong arrangement.
 *
 * Nothing here asks the operating system for anything. Rendering the source list
 * calls no probe and no permission API; a prompt on page load teaches people to
 * click Allow without reading, and after that the prompt means nothing.
 *
 * @module @deepwatch/dsh-live/client/live-mode
 */

import type { ReactNode } from 'react'
import { EmptyState, Facts, ModeSurface, Panel, Unavailable } from '@deepwatch/dsh-workspace/surface'
import type { ModeViewProps } from '@deepwatch/dsh-workspace/surface'
import { SOURCES } from '../sources-catalogue.js'
import type { CaptureReceipt, CaptureState, Observation, PermissionState } from '../capture.js'

/** A snapshot of a session, flat enough to render without owning the session. */
export interface LiveSessionView {
  readonly sessionId: string
  readonly sourceId: string
  readonly state: CaptureState
  readonly permission: PermissionState
  readonly runId: string | null
  readonly startedAt: string | null
  readonly observations: readonly Observation[]
  readonly reason: string
}

export interface LiveModeProps extends ModeViewProps {
  /** The session in progress, when there is one. */
  readonly session?: LiveSessionView | null
  /** Receipts from sessions that have ended, newest first. */
  readonly receipts?: readonly CaptureReceipt[]
}

/** Words for a state, so it is never only a colour. */
const STATE_WORDS: Record<CaptureState, string> = {
  idle: 'Not started',
  requesting_permission: 'Waiting for your permission',
  starting: 'Starting',
  active: 'Observing',
  paused: 'Paused',
  stopping: 'Stopping',
  stopped: 'Stopped',
  cancelled: 'Cancelled',
  denied: 'Permission refused — nothing was captured',
  unavailable: 'Source unavailable',
  timed_out: 'The source did not start in time',
  failed: 'Failed',
}

const PERMISSION_WORDS: Record<PermissionState, string> = {
  not_requested: 'Not requested',
  requested: 'Requested',
  granted: 'Granted',
  denied: 'Refused',
}

function toneFor(state: CaptureState): string {
  if (state === 'active') return 'var(--watch-tone-active)'
  if (['denied', 'failed', 'timed_out', 'unavailable'].includes(state)) return 'var(--watch-tone-error)'
  if (['paused', 'starting', 'requesting_permission', 'stopping'].includes(state)) return 'var(--watch-tone-caution)'
  return 'var(--watch-tone-neutral)'
}

/** The Live mode: what could be observed, and what is being observed. */
export function LiveModeView({ session = null, receipts = [] }: LiveModeProps = {}): ReactNode {
  return (
    <ModeSurface
      title="Live"
      lead={
        'A continuous observation over a source, with its clock, its gaps and '
        + 'its freshness. Opening this page starts nothing and asks for nothing.'
      }
    >
      {session === null
        ? (
            <EmptyState
              shows={
                'An active session: which source is bound, its permission state, '
                + 'the observations arriving with their timestamps, and how it ended.'
              }
              why="No live session is running, and no source has been started."
              next={[
                'Choose a source below and start it — each asks for its own permission at that moment, not before.',
                'Bind ASR or Visual Perception in Settings → Role Bindings if you want a source interpreted rather than only recorded.',
              ]}
            />
          )
        : (
            <>
              <Panel>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '15px', color: toneFor(session.state) }}>
                    {STATE_WORDS[session.state]}
                  </strong>
                  <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
                    {session.reason === '' ? session.sourceId : session.reason}
                  </span>
                </div>
                <div style={{ marginTop: '12px' }}>
                  <Facts
                    rows={[
                      ['Session', <span key="s" data-watch-ltr>{session.sessionId}</span>],
                      ['Source', session.sourceId],
                      ['Permission', PERMISSION_WORDS[session.permission]],
                      ['Run', session.runId ?? 'Not associated with a run'],
                      ['Started', <span key="t" data-watch-ltr>{session.startedAt ?? '—'}</span>],
                      ['Observations', String(session.observations.length)],
                    ]}
                  />
                </div>
              </Panel>

              <Panel heading={`Observations (${String(session.observations.length)})`}>
                {session.observations.length === 0
                  ? (
                      <p style={{ fontSize: '13px', margin: 0, color: 'var(--dsw-alias-label-tertiary)' }}>
                        Nothing observed yet. An observation without a timestamp
                        could not be cited, so none is recorded until the clock
                        is running.
                      </p>
                    )
                  : (
                      <ol style={{ margin: 0, paddingInlineStart: '20px', fontSize: '12.5px', lineHeight: 1.7 }}>
                        {session.observations.slice(-25).map(observation => (
                          <li key={observation.observationId}>
                            <span data-watch-ltr style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
                              {`+${String(observation.offsetMs)}ms`}
                            </span>
                            {' '}
                            {observation.text}
                          </li>
                        ))}
                      </ol>
                    )}
              </Panel>
            </>
          )}

      <Panel heading="Sources">
        <Facts
          rows={SOURCES.map(source => [
            source.name,
            <span key={source.id}>
              {source.what}
              <br />
              <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{source.asks}</span>
              {source.canAct
                ? (
                    <>
                      <br />
                      <span style={{ color: 'var(--watch-tone-caution)' }}>
                        This one can act on the world, not only record it.
                      </span>
                    </>
                  )
                : null}
            </span>,
          ])}
        />
      </Panel>

      {receipts.length === 0
        ? null
        : (
            <Panel heading={`Finished sessions (${String(receipts.length)})`}>
              <Facts
                rows={receipts.slice(0, 10).map(receipt => [
                  receipt.sessionId,
                  <span key={receipt.sessionId}>
                    {STATE_WORDS[receipt.finalState]}
                    {` · ${String(receipt.observationCount)} observation(s)`}
                    {receipt.reason === '' ? '' : ` · ${receipt.reason}`}
                  </span>,
                ])}
              />
            </Panel>
          )}

      <Unavailable
        what="Sources this machine cannot provide"
        because={
          'Every source above keeps its real adapter and its real permission '
          + 'boundary, and each is exercised deterministically. A source is only '
          + 'offered as startable where its adapter can actually run here — a '
          + 'control that fails when pressed teaches people the product is '
          + 'broken rather than that a capability is absent.'
        }
        wouldNeed={[
          'The hardware or OS support the adapter names, on the machine running Watch.',
          'The relevant OS permission, granted at first use rather than on load.',
          'A role bound for interpretation if the stream is to be transcribed or described.',
        ]}
      />
    </ModeSurface>
  )
}
