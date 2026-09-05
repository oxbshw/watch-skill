/**
 * An evidence-linked answer.
 *
 * The card's job is to keep apart two things that look identical in prose: an
 * answer grounded in something the system observed, and an answer that has been
 * proven correct. This one is the first. It shows the citations behind it, and
 * it says — every time, not only when something went wrong — that nothing here
 * has been verified.
 *
 * The parsing and labelling rules live in
 * `@deepwatch/dsh-contracts/presentation`; this file renders them.
 */

import type { ReactNode } from 'react'
import type { PresentableAnswer } from '@deepwatch/dsh-contracts'
import { formatTimestamp, freshnessLabel } from '@deepwatch/dsh-contracts'
import css from './SourceAnswerRow.module.css'

/** Render one evidence-linked answer and the citations behind it. */
export function SourceAnswerRow({ payload }: { readonly payload: PresentableAnswer }): ReactNode {
  return (
    <section className={css['card']} aria-label="Answer from a source">
      <p className={css['answer']}>{payload.answer}</p>

      {payload.citations.length > 0 && (
        <ul className={css['citations']}>
          {payload.citations.map(citation => {
            const at = formatTimestamp(citation.atMs)
            const staleness = freshnessLabel(citation.freshness)
            return (
              <li key={citation.evidenceId} className={css['citation']}>
                {at !== null && <span className={css['time']}>{at}</span>}
                <span className={css['quote']}>{citation.text}</span>
                {/* Inference is not observation. Saying which one a citation is
                    stops a derived summary from being read as something the
                    system actually saw. */}
                {citation.provenance !== 'observation' && (
                  <span className={css['tag']}>derived</span>
                )}
                {staleness !== null && (
                  <span className={css['tag']} data-warn="true">{staleness}</span>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <footer className={css['foot']}>
        {/* Stated on every answer, not only when something is wrong. An
            evidence-linked answer is not a verified one, and the moment that
            reminder becomes conditional is the moment it stops being read. */}
        <span className={css['unverified']}>
          Not verified — run a verification contract to establish this.
        </span>
        {payload.groundedness === 'insufficient' && (
          <span className={css['thin']}>
            The engine reported it could not fully ground this answer.
          </span>
        )}
        {payload.citations.length === 0 && (
          <span className={css['thin']}>No citations were returned.</span>
        )}
      </footer>
    </section>
  )
}
