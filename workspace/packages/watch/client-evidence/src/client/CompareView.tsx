/**
 * The Compare surface.
 *
 * Two columns and one answer. The answer is at the top, because it is the
 * thing people came for: *where did these first stop agreeing, in a way that
 * mattered?* Everything below it is context for that sentence.
 *
 * The surface never says passed or failed. A difference between two runs is
 * usually the change somebody asked for, and deciding whether it was the one
 * they wanted is a verification contract. So a verdict divergence is drawn in
 * the verdicts' own tones — because the verdicts have tones — and the
 * comparison itself is drawn neutrally, however dramatic the difference.
 *
 * @module @deepwatch/dsh-client-evidence/CompareView
 */

import type { ReactNode } from 'react'
import { toneFor, tokenFor } from '@deepwatch/dsh-client-brand'
import {
  describeComparison,
  firstMeaningfulDivergence,
  type Comparison,
  type Divergence,
} from '@deepwatch/dsh-trajectory'

/** A non-colour signal for each kind of difference. */
const KIND_GLYPH: Readonly<Record<Divergence['kind'], string>> = {
  added: '+',
  removed: '−',
  changed: '≠',
  retimed: '⇄',
}

/** Props for {@link DivergenceRow}. */
export interface DivergenceRowProps {
  readonly divergence: Divergence
  readonly leading: boolean
  readonly onOpen: (divergence: Divergence, side: 'left' | 'right') => void
}

/**
 * One divergence, with a way into each side.
 *
 * Two buttons rather than one. A divergence is a statement about two things,
 * and a single "open" would have to pick a side on the reader's behalf — which
 * is exactly the choice they are trying to make.
 */
export function DivergenceRow({ divergence, leading, onOpen }: DivergenceRowProps): ReactNode {
  const verdictish = divergence.channel === 'verification'
  return (
    <li
      data-watch-divergence={divergence.channel}
      data-watch-divergence-kind={divergence.kind}
      data-watch-leading={leading ? 'true' : undefined}
      style={{
        borderInlineStart: leading
          ? '3px solid var(--watch-accent)'
          : '3px solid transparent',
        paddingInlineStart: '8px',
      }}
    >
      <span aria-hidden="true">{KIND_GLYPH[divergence.kind]}</span>
      <span data-watch-field="channel">{` ${divergence.channel} `}</span>
      <span data-watch-field="at" dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {divergence.atMs === null ? 'untimed' : `${String(divergence.atMs)}ms`}
      </span>
      <span
        data-watch-field="summary"
        style={verdictish ? { color: tokenFor(toneFor('INCONCLUSIVE')) } : undefined}
      >
        {` ${divergence.summary}`}
      </span>
      <button
        type="button"
        data-watch-open="left"
        disabled={divergence.leftRecordId === null && divergence.leftEvidenceId === null}
        onClick={() => { onOpen(divergence, 'left') }}
      >
        Open first
      </button>
      <button
        type="button"
        data-watch-open="right"
        disabled={divergence.rightRecordId === null && divergence.rightEvidenceId === null}
        onClick={() => { onOpen(divergence, 'right') }}
      >
        Open second
      </button>
    </li>
  )
}

/** Props for {@link CompareView}. */
export interface CompareViewProps {
  readonly comparison: Comparison
  /** What the two sides are called, for the column headers. */
  readonly leftLabel: string
  readonly rightLabel: string
  readonly onOpen: (divergence: Divergence, side: 'left' | 'right') => void
}

/** The Compare mode body. */
export function CompareView(
  { comparison, leftLabel, rightLabel, onOpen }: CompareViewProps,
): ReactNode {
  const leading = firstMeaningfulDivergence(comparison)
  return (
    <section data-watch-compare={comparison.subject} aria-label="Compare">
      <p data-watch-compare-summary="">{describeComparison(comparison)}</p>
      <div data-watch-compare-sides="" style={{ display: 'flex', gap: '12px' }}>
        <span data-watch-side="left" dir="auto">{leftLabel}</span>
        <span data-watch-side="right" dir="auto">{rightLabel}</span>
      </div>
      {comparison.divergences.length === 0
        ? <p data-watch-compare-empty="">These two agree everywhere they align.</p>
        : (
          <ul data-watch-divergences="" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {comparison.divergences.map(divergence => (
              <DivergenceRow
                key={`${divergence.channel}:${String(divergence.atMs ?? -1)}:${divergence.kind}:${divergence.leftRecordId ?? ''}:${divergence.rightRecordId ?? ''}`}
                divergence={divergence}
                leading={divergence === leading}
                onOpen={onOpen}
              />
            ))}
          </ul>
        )}
      <p data-watch-compare-disclaimer="">
        {'A difference is not a failure. Whether this was the intended change is a '}
        {'verification contract, not something Compare decides.'}
      </p>
    </section>
  )
}
