/**
 * The first thing a person sees.
 *
 * What they saw before was "Add an API key to get started — configure the
 * official DeepSeek provider to start building". Reasonable for upstream, and
 * wrong twice over for this product: it implies the workspace does nothing
 * until a cloud provider is connected, and that the only thing worth
 * configuring is a chat model. Perception, memory, evidence and verification
 * run on this machine, and the agent model is one role among nine.
 *
 * The first version of this replacement was a serious mistake, and the shape of
 * it is worth recording so it is not repeated. `settings.onboarding` is not a
 * modal seat. It renders inside the sidebar's foot area — 256 pixels wide — and
 * the content is expected to wrap *itself* in a modal, which is exactly what
 * upstream's own `WelcomeNotice` does. Rendering a twelve-row, 2400-pixel
 * readiness dashboard straight into it did not merely look wrong: it spilled
 * two thousand pixels out of a clipped 280px column and destroyed the sidebar.
 *
 * So there are two rules here now, and both are load-bearing:
 *
 *   1. Wrap in DSH's own `Modal`, the way upstream does. Not a hand-rolled
 *      overlay — that would duplicate the dimming, the focus handling and the
 *      inert root that already exist.
 *   2. Keep it short. A first-run notice is a paragraph and two buttons. The
 *      full capability readiness list lives in Diagnostics, where there is
 *      width for it and where somebody goes to look things up.
 *
 * @module @watchskill/dsh-client-settings/onboarding
 */

import type { ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { PRODUCT_NAME, WATCH_MARK_PNG, tokenFor } from '@watchskill/dsh-client-brand'
import { READINESS } from './readiness.js'

/** What DSH hands an onboarding step. */
export interface OnboardingProps {
  readonly stepId?: string
  readonly complete?: () => void
  readonly openSection?: (id: string) => void
}

/**
 * The Watch first-run notice.
 *
 * The count is computed from the same readiness table Diagnostics renders, so
 * the number on this screen and the list behind it cannot disagree. It reads
 * "4 of 12" rather than a row of ticks, because a first-run screen that
 * congratulated everyone would be ignored by the second launch.
 */
export function WatchOnboarding({ complete, openSection }: OnboardingProps): ReactNode {
  const ready = READINESS.filter(item => item.tone === 'active').length
  const finish = (): void => { complete?.() }

  return (
    <Modal open title={PRODUCT_NAME} onClose={finish} headless>
      <div style={{ maxWidth: '420px', padding: '4px 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' }}>
          <img src={WATCH_MARK_PNG} width={40} height={40} alt="" aria-hidden="true"
            style={{ width: '40px', height: '40px', objectFit: 'contain', flexShrink: 0 }}
          />
          <div>
            <h2 style={{ fontSize: '17px', fontWeight: 600, margin: 0 }}>{PRODUCT_NAME}</h2>
            <p style={{ fontSize: '14px', margin: '2px 0 0', color: tokenFor('active') }}>
              See. Remember. Act. Verify.
            </p>
          </div>
        </div>
        <p style={{
          fontSize: '13px', lineHeight: 1.6, margin: '0 0 12px',
          color: 'var(--dsw-alias-label-secondary)',
        }}
        >
          Perception, memory, evidence and verification run on this machine.
          You can start now and connect a provider whenever you want one — a
          chat model is one role among nine, not the price of entry.
        </p>
        <p style={{
          fontSize: '13px', lineHeight: 1.6, margin: '0 0 16px',
          color: 'var(--dsw-alias-label-secondary)',
        }}
        >
          <strong style={{ color: tokenFor('active') }}>
            {`${String(ready)} of ${String(READINESS.length)} capabilities are ready.`}
          </strong>
          {' '}
          Watch Core, memory, verification and the browser work now. The rest are
          unconfigured or untested, and Diagnostics lists exactly which.
        </p>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <Button
            onClick={() => {
              openSection?.('watch-roles')
              finish()
            }}
          >
            Set up capabilities
          </Button>
          <Button variant="ghost" onClick={finish}>Continue</Button>
        </div>
        <p style={{
          fontSize: '12px', lineHeight: 1.5, margin: '14px 0 0',
          color: 'var(--dsw-alias-label-tertiary)',
        }}
        >
          Connecting a provider connects a model. It does not permit uploading
          frames, audio, transcripts or evidence — that is a separate consent,
          and it is off.
        </p>
      </div>
    </Modal>
  )
}
