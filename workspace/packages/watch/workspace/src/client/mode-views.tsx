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
 * @module @deepwatch/dsh-workspace/client/mode-views
 */

import type { ReactNode } from 'react'
import { parseVerdict } from '@deepwatch/dsh-contracts'
import type { PresentableCheck } from '@deepwatch/dsh-contracts'
import { EmptyState, Facts, ModeSurface, Note, Panel, readToolResult } from './surface.js'
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
