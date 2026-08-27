/**
 * The Evidence Inspector.
 *
 * Functionality first, deliberately: this is the panel that answers "what
 * exactly is this citation?", and it answers it from the record Watch Core
 * resolved, not from anything on screen. Two rules govern what it may show.
 *
 * **No evidence reconstruction from display text.** The inspector takes an
 * evidence id and asks for the record. It never assembles one from what a
 * message happens to contain — an inspector that could do that would let a
 * page's own text become the evidence for what that page said.
 *
 * **No fabricated verification state.** A record with no associated
 * verification shows that it has none. It never fills the gap with a default,
 * and the only green in this panel comes from a `VERIFIED` verdict that Watch
 * Core issued.
 *
 * The visual design is intentionally minimal — Phase 3 owns that.
 */

import type { ReactNode } from 'react'
import type { WatchSelection } from '@watchskill/dsh-trajectory'
import type { PresentableVerdict } from '@watchskill/dsh-contracts'
import { formatTimestamp, freshnessLabel, verdictTone } from '@watchskill/dsh-contracts'
import css from './EvidenceInspector.module.css'

/** The evidence record as Watch Core returns it. */
export interface InspectableEvidence {
  readonly evidenceId: string
  readonly sourceRevisionId: string
  readonly artifactIds: readonly string[]
  readonly temporalRange: { readonly startMs: number; readonly endMs: number } | null
  readonly modality: string
  readonly provenance: string
  readonly producer: string
  readonly producerVersion: string
  readonly freshness: string
  readonly contentDigest: string
  readonly retentionClass: string
  readonly confidence: number | null
  readonly text?: string
}

/** What the inspector is currently able to show. */
export type InspectorState =
  /** Nothing selected. */
  | { readonly status: 'idle' }
  /** Resolving from Watch Core. */
  | { readonly status: 'loading'; readonly evidenceId: string }
  /** Resolved. */
  | {
    readonly status: 'ready'
    readonly evidence: InspectableEvidence
    readonly verification: PresentableVerdict | null
    readonly receiptId: string | null
  }
  /** Could not resolve, with the engine's own fix. */
  | { readonly status: 'error'; readonly message: string; readonly fix: string }

/** Props assembled by whichever surface mounts the inspector. */
export interface EvidenceInspectorProps {
  readonly selection: WatchSelection
  readonly state: InspectorState
  /** Copy a link that restores this selection. */
  readonly onCopyLink?: () => void
}

/** One labelled fact. */
function Row({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className={css['row']}>
      <dt className={css['label']}>{label}</dt>
      <dd className={css['value']}>{children}</dd>
    </div>
  )
}

/** Render a temporal range the way a person reads a media position. */
function rangeLabel(range: InspectableEvidence['temporalRange']): string {
  if (range === null) return 'no timing'
  const start = formatTimestamp(range.startMs) ?? '0:00'
  if (range.endMs <= range.startMs) return start
  return `${start} – ${formatTimestamp(range.endMs) ?? start}`
}

/** Render the inspector for the current selection. */
export function EvidenceInspector({
  selection,
  state,
  onCopyLink,
}: EvidenceInspectorProps): ReactNode {
  if (state.status === 'idle') {
    return (
      <section className={css['panel']} aria-label="Evidence inspector">
        <p className={css['empty']}>
          Select a citation, or a Watch record in Trajectory, to see exactly what it is.
        </p>
      </section>
    )
  }

  if (state.status === 'loading') {
    return (
      <section className={css['panel']} aria-label="Evidence inspector" aria-busy="true">
        <p className={css['empty']}>Resolving <code>{state.evidenceId}</code>…</p>
      </section>
    )
  }

  if (state.status === 'error') {
    return (
      <section className={css['panel']} aria-label="Evidence inspector">
        <p className={css['error']}>{state.message}</p>
        {/* The engine's own remediation. A failure a person cannot act on is a
            failure that has not finished being reported. */}
        <p className={css['fix']}>{state.fix}</p>
      </section>
    )
  }

  const { evidence, verification, receiptId } = state
  const staleness = freshnessLabel(evidence.freshness as Parameters<typeof freshnessLabel>[0])

  return (
    <section className={css['panel']} aria-label="Evidence inspector">
      <header className={css['head']}>
        <code className={css['id']}>{evidence.evidenceId}</code>
        {onCopyLink !== undefined && (
          <button type="button" className={css['link']} onClick={onCopyLink}>
            Copy link
          </button>
        )}
      </header>

      <dl className={css['facts']}>
        <Row label="Source">
          <code>{evidence.sourceRevisionId}</code>
        </Row>
        <Row label="When">{rangeLabel(evidence.temporalRange)}</Row>
        <Row label="How it was produced">
          {/* Observation and inference are different claims about the world,
              and a panel that showed only "produced by Watch" would let a
              derived summary read as something the system saw. */}
          {evidence.provenance} · {evidence.modality}
        </Row>
        <Row label="Producer">
          {evidence.producer}
          {evidence.producerVersion === '' ? null : ` ${evidence.producerVersion}`}
        </Row>
        <Row label="Freshness">
          {staleness === null
            ? <span>current</span>
            : <span className={css['warn']}>{staleness}</span>}
        </Row>
        {evidence.confidence !== null && (
          <Row label="Confidence">{evidence.confidence.toFixed(2)}</Row>
        )}
        {evidence.artifactIds.length > 0 && (
          <Row label="Artifacts">
            <ul className={css['artifacts']}>
              {evidence.artifactIds.map(artifactId => (
                <li key={artifactId}><code>{artifactId}</code></li>
              ))}
            </ul>
          </Row>
        )}
        {evidence.contentDigest !== '' && (
          <Row label="Digest"><code>{evidence.contentDigest}</code></Row>
        )}
        <Row label="Retention">{evidence.retentionClass}</Row>
      </dl>

      {evidence.text !== undefined && evidence.text !== '' && (
        <blockquote className={css['quote']}>{evidence.text}</blockquote>
      )}

      <footer className={css['foot']}>
        {verification === null
          ? (
            // Stated, not omitted. A blank space where a verdict would be
            // reads as "fine"; this reads as what it is.
            <p className={css['unverified']}>
              No verification is associated with this evidence. It is what was observed,
              not what was proven.
            </p>
          )
          : (
            <p className={css['verdict']} data-tone={verdictTone(verification.verdict)}>
              <strong>{verification.verdict}</strong> — {verification.reason}
            </p>
          )}
        {receiptId !== null && (
          <p className={css['receipt']}>Receipt <code>{receiptId}</code></p>
        )}
        {selection.recordId !== null && (
          <p className={css['trace']}>Trajectory record <code>{selection.recordId}</code></p>
        )}
      </footer>
    </section>
  )
}
