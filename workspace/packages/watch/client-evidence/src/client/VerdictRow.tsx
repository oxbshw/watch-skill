/**
 * The verdict card.
 *
 * This is the smallest surface in the product and the one most worth getting
 * right. Every other screen can be rebuilt; a verdict card that renders
 * `UNVERIFIED` in a way a tired person reads as "done" destroys the only claim
 * Watch makes.
 *
 * The rules it obeys are not defined here — they live in
 * `@watchskill/dsh-contracts/presentation`, where they can be tested without a
 * DOM and where there is exactly one place to change them. This file is the
 * rendering, and nothing about the rendering is allowed to widen them.
 */

import type { ReactNode } from 'react'
import type { PresentableVerdict } from '@watchskill/dsh-contracts'
import { verdictTone } from '@watchskill/dsh-contracts'
import css from './VerdictRow.module.css'

/** Symbol for one check outcome, chosen to survive a monochrome display. */
function checkMark(passed: boolean | null): string {
  if (passed === true) return '✓'
  if (passed === false) return '✕'
  return '–'
}

/** Accessible wording for one check outcome. */
function checkLabel(passed: boolean | null): string {
  if (passed === true) return 'passed'
  if (passed === false) return 'failed'
  return 'could not run'
}

/** Render the verdict of one verification run. */
export function VerdictRow({ payload }: { readonly payload: PresentableVerdict }): ReactNode {
  const tone = verdictTone(payload.verdict)
  const ran = payload.checks.filter(check => check.passed !== null).length

  return (
    <section className={css['card']} data-tone={tone} aria-label={`Verification ${payload.verdict}`}>
      <header className={css['head']}>
        {/* The verdict word itself is the badge. An icon alone would put the
            whole distinction in a glyph that colour-blind and monochrome
            readers cannot resolve. */}
        <span className={css['badge']} data-tone={tone}>{payload.verdict}</span>
        <p className={css['reason']}>{payload.reason}</p>
      </header>

      {payload.checks.length > 0 && (
        <ul className={css['checks']}>
          {payload.checks.map(check => (
            <li key={check.checkId} className={css['check']} data-passed={String(check.passed)}>
              <span className={css['mark']} aria-hidden="true">{checkMark(check.passed)}</span>
              <span className={css['checkName']}>{check.description ?? check.checkId}</span>
              <span className={css['visuallyHidden']}>{checkLabel(check.passed)}</span>
              {check.detail !== null && <span className={css['detail']}>{check.detail}</span>}
            </li>
          ))}
        </ul>
      )}

      <footer className={css['foot']}>
        {payload.checks.length > 0 && (
          <span>{ran} of {payload.checks.length} checks ran</span>
        )}
        {payload.assurance !== null && <span>assurance: {payload.assurance}</span>}
        {payload.contractDigest !== '' && (
          // Shown, not hidden behind a disclosure: the digest is what makes the
          // verdict auditable, and a contract frozen before it ran is the
          // reason this card can be trusted at all.
          <span className={css['digest']} title={payload.contractDigest}>
            contract {payload.contractDigest.slice(0, 12)}
          </span>
        )}
      </footer>
    </section>
  )
}
