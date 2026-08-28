/**
 * The Watch mode body.
 *
 * This is the surface the whole product is named after, and it exists to make
 * one distinction impossible to miss: **the agent finishing is not the world
 * agreeing.** A tool that returns without an error has finished. Whether the
 * thing actually happened is a separate question with a separate answer, and
 * only Watch Core answers it.
 *
 * What it can show is bounded by what reaches the browser. Watch contributes
 * tools, so verdicts and evidence arrive as tool results in the conversation,
 * and a `conversation.view` entry is handed the record the person selected —
 * `inspect`. That selection is the supported subset, and it is rendered in
 * full. Everything the surface cannot reach is named rather than mocked.
 *
 * @module @watchskill/dsh-workspace/client/mode-views
 */

import type { ReactNode } from 'react'
import { parseVerdict } from '@watchskill/dsh-contracts'
import type { PresentableCheck } from '@watchskill/dsh-contracts'
import { EmptyState, Facts, ModeSurface, Note, Panel, Unavailable, readToolResult } from './surface.js'
import type { ModeViewProps } from './surface.js'

/**
 * The verdict, and the words that go with it.
 *
 * `success` is reachable from exactly one verdict. Everything else is caution
 * or error, and the wording matters as much as the colour: "not proven" and
 * "proven false" are different findings, and a reader who cannot tell them
 * apart will eventually treat both as noise.
 */
const VERDICTS: Record<string, { readonly tone: string, readonly says: string }> = {
  VERIFIED: {
    tone: 'var(--watch-tone-success)',
    says: 'Checked against the world, and it held.',
  },
  FAILED: {
    tone: 'var(--watch-tone-error)',
    says: 'Checked, and it did not hold. The agent may still have reported success.',
  },
  UNVERIFIED: {
    tone: 'var(--watch-tone-caution)',
    says: 'Not checked. This is an absence, not a failure.',
  },
  INCONCLUSIVE: {
    tone: 'var(--watch-tone-caution)',
    says: 'Checked, and the evidence did not settle it either way.',
  },
  DISPUTED: {
    tone: 'var(--watch-tone-caution)',
    says: 'Evidence points both ways. Nothing is being asserted.',
  },
}

function VerdictHeadline({ verdict }: { readonly verdict: string }): ReactNode {
  const entry = VERDICTS[verdict] ?? {
    tone: 'var(--watch-tone-neutral)',
    says: 'An outcome this build does not recognise.',
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' }}>
        {/* The word, not only the colour. A verdict distinguished by hue alone
            disappears on a monochrome display and for a colour-blind reader,
            and this is the one place that is unacceptable. */}
        <strong style={{ fontSize: '17px', letterSpacing: '0.01em', color: entry.tone }}>
          {verdict}
        </strong>
        <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
          {entry.says}
        </span>
      </div>
    </div>
  )
}

/** The Watch mode: completion on one side, verification on the other. */
export function WatchModeView({ inspect }: ModeViewProps): ReactNode {
  const payload = parseVerdict(readToolResult(inspect))

  return (
    <ModeSurface
      title="Watch"
      lead={
        'What the agent did, and what the world says about it. These are two '
        + 'different records, and this surface never merges them.'
      }
    >
      {payload === null
        ? (
            <>
              <EmptyState
                shows={
                  'A verification record: the verdict, the reason behind it, the '
                  + 'individual checks that ran, and the contract they were run '
                  + 'against.'
                }
                why={
                  'Nothing is selected. Verifications arrive as results in the '
                  + 'conversation, and this surface shows the one you pick.'
                }
                next={[
                  'Open Chat and select a Watch tool row in the message flow.',
                  'Or run a verification: ask the agent to check a claim rather than to perform an action.',
                  'Deterministic checks need no provider and work offline — see Settings → Verification.',
                ]}
              />
              <Note>
                Agent completed ≠ Verified. A tool returning without an error means
                the call finished, not that the thing happened.
              </Note>
            </>
          )
        : (
            <>
              <Panel>
                <VerdictHeadline verdict={payload.verdict} />
                <p style={{
                  fontSize: '13px', lineHeight: 1.6, margin: '10px 0 0',
                  color: 'var(--dsw-alias-label-secondary)',
                }}
                >
                  {payload.reason}
                </p>
                <div style={{ marginTop: '14px' }}>
                  <Facts
                    rows={[
                      [
                        'Assurance',
                        payload.assurance ?? 'Not stated by this record',
                      ],
                      [
                        'Contract',
                        payload.contractDigest === ''
                          ? 'Not stated by this record'
                          : <span key="d" data-watch-ltr>{payload.contractDigest}</span>,
                      ],
                      ['Issued by', 'Watch Core — nothing else can issue a verdict'],
                    ]}
                  />
                </div>
              </Panel>

              <Panel heading={`Checks (${String(payload.checks.length)})`}>
                {payload.checks.length === 0
                  ? (
                      <p style={{ fontSize: '13px', margin: 0, color: 'var(--dsw-alias-label-tertiary)' }}>
                        This record carries no individual checks. A verdict with no
                        checks behind it is stated as such rather than dressed up.
                      </p>
                    )
                  : (
                      <Facts
                        rows={payload.checks.map(check => [
                          check.checkId,
                          <CheckOutcome key={check.checkId} check={check} />,
                        ])}
                      />
                    )}
              </Panel>

              <Note>
                Only Watch Core issues a verdict. Nothing in this client, in a
                plugin, or in a model can mint one — this surface reads records
                rather than producing them.
              </Note>
            </>
          )}
    </ModeSurface>
  )
}

/**
 * One check's outcome.
 *
 * `passed` is nullable in the contract, and the third state is the interesting
 * one: a check that did not run is not a check that failed, and collapsing
 * them would put a red mark against something nobody looked at.
 */
function CheckOutcome({ check }: { readonly check: PresentableCheck }): ReactNode {
  const tone = check.passed === true
    ? 'var(--watch-tone-success)'
    : check.passed === false ? 'var(--watch-tone-error)' : 'var(--watch-tone-neutral)'
  const word = check.passed === true ? 'held' : check.passed === false ? 'did not hold' : 'did not run'
  return (
    <span style={{ color: tone }}>
      {word}
      {check.detail === null ? '' : ` — ${check.detail}`}
      {check.description === null ? '' : ` (${check.description})`}
    </span>
  )
}

/**
 * The Compare mode.
 *
 * A comparison describes a difference. It never produces a verdict of its own,
 * which is why the verification difference is presented separately from the
 * output difference — those are not the same kind of change, and a surface that
 * blends them invites the reader to treat a changed answer as a changed truth.
 */
export function CompareModeView({ inspect }: ModeViewProps): ReactNode {
  const selected = parseVerdict(readToolResult(inspect))

  return (
    <ModeSurface
      title="Compare"
      lead={
        'Two records, side by side, with the first place they diverge. A '
        + 'comparison describes a difference; it never issues a verdict.'
      }
    >
      <EmptyState
        shows={
          selected === null
            ? 'Two comparable records — runs, revisions or verifications — with agent output and verification outcome shown as separate columns.'
            : `One record is selected (${selected.verdict}). A comparison needs a second.`
        }
        why={
          'Comparison reads two records at once. A view is handed the single '
          + 'record you selected, and this build has no client-side route that '
          + 'can fetch a second one to set beside it.'
        }
        next={[
          'Select a Watch tool row in Chat to choose the first record.',
          'The second side needs a stored run to compare against — see the limitation below.',
        ]}
      />
      <Note>
        Honest limit: Watch contributes tools, so its records reach the browser
        as conversation results rather than through a query route. Holding two
        records at once needs a stored history this build does not expose to the
        client, so Compare shows the supported subset and says the rest is
        unavailable rather than fabricating a second column.
      </Note>
    </ModeSurface>
  )
}

/**
 * The Live mode.
 *
 * Nothing here asks the operating system for anything. A permission prompt on
 * load teaches people to click Allow without reading, so every source states
 * when it *would* ask rather than asking now — and the state shown is the
 * un-prompted one, which is the state actually being claimed.
 *
 * Browser Observer and Browser Operator stay separate rows because they are
 * separate capabilities: watching a page and acting on one carry different
 * consequences, and a single "browser" switch would grant the second while a
 * person believed they were enabling the first.
 */
const LIVE_SOURCES = [
  {
    id: 'screen',
    name: 'Screen',
    what: 'The whole display, as a continuous observation.',
    asks: 'Asks for screen-capture permission the first time you start it.',
  },
  {
    id: 'window',
    name: 'Window',
    what: 'One application window rather than the whole display.',
    asks: 'Asks for screen-capture permission the first time you start it.',
  },
  {
    id: 'camera',
    name: 'Camera',
    what: 'Live visual input from an attached device.',
    asks: 'Asks for camera permission the first time you start it.',
  },
  {
    id: 'microphone',
    name: 'Microphone',
    what: 'Live audio, with timings a citation can point at.',
    asks: 'Asks for microphone permission the first time you start it.',
  },
  {
    id: 'browser-observer',
    name: 'Browser Observer',
    what: 'Watches a page and records what it showed. Takes no action.',
    asks: 'No OS permission. Needs the browser runtime enabled.',
  },
  {
    id: 'browser-operator',
    name: 'Browser Operator',
    what: 'Acts on a page and returns a receipt for what it did. A separate capability from observing.',
    asks: 'No OS permission. Needs the browser runtime enabled, and every side effect carries an idempotency key.',
  },
]

/** The Live mode: what could be observed, and what is being observed. */
export function LiveModeView(): ReactNode {
  return (
    <ModeSurface
      title="Live"
      lead={
        'A continuous observation over a source, with its clock, its gaps and '
        + 'its freshness. Opening this page starts nothing and asks for nothing.'
      }
    >
      <EmptyState
        shows={
          'An active session: which source is bound, its permission state, the '
          + 'observations arriving with their timestamps, and any gap where the '
          + 'stream was interrupted.'
        }
        why="No live session is running, and no source has been started."
        next={[
          'Bind ASR or Visual Perception in Settings → Role Bindings if you want a source interpreted rather than only recorded.',
          'Start a source below — each asks for its own permission at that moment, not before.',
        ]}
      />

      <Panel heading="Sources">
        <Facts
          rows={LIVE_SOURCES.map(source => [
            source.name,
            <span key={source.id}>
              <span style={{ color: 'var(--watch-tone-neutral)' }}>Not started</span>
              {' — '}
              {source.what}
              <br />
              <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>{source.asks}</span>
            </span>,
          ])}
        />
      </Panel>

      <Unavailable
        what="Starting a live session"
        because={
          'Start and stop controls are shown only when the integration behind '
          + 'them can actually run. This build composes no live capture backend, '
          + 'so a Start button here would fail when pressed — which teaches '
          + 'people the product is broken rather than that a capability is absent.'
        }
        wouldNeed={[
          'A capture integration installed and enabled as a plugin.',
          'The relevant OS permission, granted at first use rather than on load.',
          'A role bound for interpretation if the stream is to be transcribed or described.',
        ]}
      />
    </ModeSurface>
  )
}

/**
 * The Library mode.
 *
 * Search, filters and revisions are all downstream of one thing: an index this
 * client can query. There is no such route in this build — Watch contributes
 * tools, and tool results reach the conversation rather than a searchable store
 * the browser can reach — so the surface names the fields it would search on
 * and says plainly that it cannot search yet.
 *
 * The alternative would be a search box that returns nothing, which is worse
 * than no search box: it looks like an empty library rather than an absent
 * capability.
 */
export function LibraryModeView({ inspect }: ModeViewProps): ReactNode {
  const selected = parseVerdict(readToolResult(inspect))

  return (
    <ModeSurface
      title="Library"
      lead={
        'Every source and every piece of evidence this workspace has recorded, '
        + 'with its revisions and whether it is still current.'
      }
    >
      {selected === null
        ? (
            <EmptyState
              shows={
                'Indexed sources and evidence, filtered by type, run, timestamp, '
                + 'verification state and provenance, each with its revision history '
                + 'and a current-or-stale marker.'
              }
              why="Nothing is selected, and this build exposes no searchable index to the client."
              next={[
                'Select a Watch tool row in Chat to inspect a single record here.',
                'Bind Embeddings in Settings → Role Bindings for retrieval; without it, search falls back to lexical matching.',
              ]}
            />
          )
        : (
            <Panel heading="Selected record">
              <Facts
                rows={[
                  ['Verdict', selected.verdict],
                  ['Reason', selected.reason],
                  ['Checks', String(selected.checks.length)],
                  [
                    'Freshness',
                    'Not stated by this record — freshness comes from the index, which this build does not expose.',
                  ],
                ]}
              />
            </Panel>
          )}

      <Unavailable
        what="Search, filtering and revision history"
        because={
          'These read an index. Watch contributes tools, so its records arrive '
          + 'as conversation results rather than through a query route the '
          + 'browser can call, and there is no client-side store to search.'
        }
        wouldNeed={[
          'A Watch query route exposed through the Host, or a client-side projection of the evidence ledger.',
          'Embeddings bound for semantic retrieval; lexical matching works without it.',
        ]}
      />
    </ModeSurface>
  )
}
