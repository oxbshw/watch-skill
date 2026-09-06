/**
 * The Compare mode body.
 *
 * The engine is elsewhere and deliberately so: `compare-engine.ts` is pure,
 * typed and free of React, which is what lets the diff be tested without a DOM
 * and quoted without a screenshot. This file only renders what the engine
 * decided.
 *
 * The layout carries the engine's one structural opinion — verification
 * differences and output differences are separate sections, never one merged
 * list. An agent producing different text is ordinary. The same claim going
 * from VERIFIED to FAILED is not.
 *
 * @module @deepwatch/dsh-client-evidence/client/compare-mode
 */

import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { EmptyState, Facts, ModeSurface, Note, Panel } from '@deepwatch/dsh-workspace/surface'
import type { ModeViewProps } from '@deepwatch/dsh-workspace/surface'
import { compareRecords, describeIncompatibility } from '../compare-engine.js'
import type { ClaimDifference, ComparableRecord } from '../compare-engine.js'
import { comparableRecords } from '../compare-source.js'
import type { SourceRecord } from '../compare-source.js'

/**
 * The one read this mode makes.
 *
 * Narrower than the Library's whole namespace on purpose: Compare needs a list
 * of records Core has ruled on, and nothing else. A wider dependency here would
 * be a second surface able to refresh or mutate the corpus while somebody is
 * reading a diff of it.
 */
export interface CompareReads {
  readonly librarySearch: (
    request: {
      protocol: number, requestId: string, query: string,
      modalities: readonly string[], limit: number,
      cursor: string | null, deadlineMs: number,
    },
    signal?: AbortSignal,
  ) => Promise<{ readonly value?: { readonly records?: readonly SourceRecord[] } | null } | null>
}

export interface CompareModeProps extends ModeViewProps {
  /** Records the person can choose between, when a caller already has them. */
  readonly records?: readonly ComparableRecord[]
  /** Where to read records from, when it does not. */
  readonly reads?: CompareReads | undefined
}

/** A word and a tone for each disposition. Never colour alone. */
const DISPOSITION: Record<ClaimDifference['disposition'], { readonly says: string, readonly tone: string }> = {
  matching: { says: 'Matching', tone: 'var(--watch-tone-neutral)' },
  changed: { says: 'Claim changed', tone: 'var(--watch-tone-caution)' },
  verdict_changed: { says: 'Verdict changed', tone: 'var(--watch-tone-caution)' },
  missing_right: { says: 'Only on the left', tone: 'var(--watch-tone-info)' },
  missing_left: { says: 'Only on the right', tone: 'var(--watch-tone-info)' },
  contradictory: { says: 'Contradictory', tone: 'var(--watch-tone-error)' },
  unverifiable: { says: 'Unverifiable', tone: 'var(--watch-tone-caution)' },
}

const S = {
  picker: { display: 'flex', gap: '10px', flexWrap: 'wrap' as const, alignItems: 'flex-end' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px', flex: '1 1 220px', minWidth: 0 },
  label: {
    fontSize: '11px', fontWeight: 600, letterSpacing: '.05em',
    textTransform: 'uppercase' as const, color: 'var(--dsw-alias-label-tertiary)',
  },
  select: {
    background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid color-mix(in srgb, var(--watch-accent) 12%, var(--dsw-alias-border-l2))',
    borderRadius: '10px', padding: '9px 11px', fontSize: '13px', color: 'inherit', width: '100%',
  },
  button: {
    background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '10px', padding: '9px 13px', fontSize: '13px', color: 'inherit', cursor: 'pointer',
  },
  row: {
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    padding: '10px 0', display: 'flex', flexDirection: 'column' as const, gap: '4px',
  },
  side: { fontSize: '12.5px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' as const },
  why: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
}

/** The Compare mode: two records, and every way they differ. */
export function CompareModeView(
  { records: given, reads }: CompareModeProps = {},
): ReactNode {
  const [leftId, setLeftId] = useState('')
  const [rightId, setRightId] = useState('')
  const [fetched, setFetched] = useState<readonly ComparableRecord[]>([])

  // Read once when the mode opens, and never on a timer. A comparison somebody
  // is reading must not rearrange itself underneath them: the two sides they
  // picked would keep their ids and change their meaning.
  useEffect(() => {
    if (reads === undefined) return undefined
    const abort = new AbortController()
    void (async () => {
      // An empty query, which the read plane answers with everything it holds.
      // This asked for `'verification'` and got nothing back for the whole life
      // of the feature: the Library indexes a receipt under its tool name and
      // its paths, so `watch_verify` and `write — owner-test/totals.json` are
      // what is searchable, and the one word this looked for appears in
      // neither. Compare drew its empty state after a real verification had
      // just run — the exact failure its registration comment warns about,
      // arriving through the query instead of through the mounting.
      //
      // `comparableRecords` is the filter that matters, and it already ranks
      // verdict-bearing records first; narrowing here only ever hid rows from
      // it.
      const answer = await reads.librarySearch({
        protocol: 1, requestId: `compare-${String(Date.now())}`, query: '',
        modalities: [], limit: 100, cursor: null, deadlineMs: 30_000,
      }, abort.signal)
      if (abort.signal.aborted) return
      setFetched(comparableRecords(answer?.value?.records ?? []))
    })()
    return () => { abort.abort() }
  }, [reads])

  const records = given ?? fetched

  const left = useMemo(() => records.find(r => r.recordId === leftId) ?? null, [records, leftId])
  const right = useMemo(() => records.find(r => r.recordId === rightId) ?? null, [records, rightId])
  const comparison = useMemo(() => compareRecords(left, right), [left, right])

  return (
    <ModeSurface
      title="Compare"
      lead={
        'Two records, side by side, with every way they differ. The comparison '
        + 'is computed, not reasoned about — the same two records always produce '
        + 'the same answer.'
      }
    >
      {records.length === 0
        ? (
            <EmptyState
              shows={
                'Two comparable records with their claims aligned, output '
                + 'differences kept separate from verification differences, and '
                + 'every line linked back to where it came from.'
              }
              why="There are no records to compare yet."
              next={[
                'Run a task, then run it again — two runs of the same thing are what Compare is for.',
                'Or select Watch tool rows in Chat to bring verification records into this session.',
              ]}
            />
          )
        : (
            <>
              <Panel heading="Choose two records">
                <div style={S.picker}>
                  {([['Left', leftId, setLeftId], ['Right', rightId, setRightId]] as const).map(([name, value, set]) => (
                    <div key={name} style={S.field}>
                      <label style={S.label} htmlFor={`compare-${name.toLowerCase()}`}>{name}</label>
                      <select
                        id={`compare-${name.toLowerCase()}`}
                        style={S.select}
                        value={value}
                        onChange={event => { set(event.target.value) }}
                      >
                        <option value="">Nothing selected</option>
                        {records.map(record => (
                          <option key={record.recordId} value={record.recordId}>
                            {`${record.label} (${record.kind})`}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                  <button
                    type="button"
                    style={S.button}
                    onClick={() => { setLeftId(''); setRightId('') }}
                  >
                    Clear both
                  </button>
                </div>
              </Panel>

              {comparison.comparable
                ? (
                    <>
                      <Panel heading="Verification differences">
                        <Facts
                          rows={[
                            ['Matching', String(comparison.summary.matching)],
                            ['Claim changed', String(comparison.summary.changed)],
                            ['Verdict changed', String(comparison.summary.verdictChanged)],
                            ['Only on one side', String(comparison.summary.missing)],
                            ['Contradictory', String(comparison.summary.contradictory)],
                            ['Unverifiable', String(comparison.summary.unverifiable)],
                          ]}
                        />
                        {comparison.claims.map(difference => {
                          const meta = DISPOSITION[difference.disposition]
                          return (
                            <div key={difference.claimId} style={S.row}>
                              <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                                <strong style={{ fontSize: '12px', color: meta.tone }}>{meta.says}</strong>
                                <span data-watch-ltr style={{ fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)' }}>
                                  {difference.claimId}
                                </span>
                              </div>
                              <div style={S.side}>
                                {'Left: '}
                                {difference.left === null
                                  ? <em>absent</em>
                                  : `${difference.left.text} — ${difference.left.verdict ?? 'unchecked'} (${difference.left.provenance})`}
                              </div>
                              <div style={S.side}>
                                {'Right: '}
                                {difference.right === null
                                  ? <em>absent</em>
                                  : `${difference.right.text} — ${difference.right.verdict ?? 'unchecked'} (${difference.right.provenance})`}
                              </div>
                              <p style={S.why}>{difference.because}</p>
                            </div>
                          )
                        })}
                      </Panel>

                      <Panel heading="Output differences">
                        {comparison.output === null || comparison.output.identical
                          ? (
                              <p style={{ fontSize: '13px', margin: 0, color: 'var(--dsw-alias-label-tertiary)' }}>
                                The outputs are identical.
                              </p>
                            )
                          : (
                              <Facts
                                rows={[
                                  ['First divergence', `line ${String(comparison.output.firstDivergenceLine ?? 0)}`],
                                  ['Left', `${String(comparison.output.leftLines)} line(s)`],
                                  ['Right', `${String(comparison.output.rightLines)} line(s)`],
                                ]}
                              />
                            )}
                      </Panel>

                      <Note>
                        A comparison describes a difference. It never issues a
                        verdict of its own — that is why the verification column
                        and the output column are kept apart.
                      </Note>
                    </>
                  )
                : (
                    <div style={{ ...S.row, borderTop: 'none' }}>
                      <p style={{ ...S.side, margin: 0 }}>
                        {comparison.reason === null
                          ? 'Nothing to compare.'
                          : describeIncompatibility(comparison.reason)}
                      </p>
                    </div>
                  )}
            </>
          )}
    </ModeSurface>
  )
}
