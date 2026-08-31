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
 * The second version was too small in the other direction. A 420-pixel column
 * with a 40-pixel mark, a bare product name as its title, and two ghost text
 * links reading "Set up capabilities" and "Continue" — a person could not tell
 * which was the way forward, the identity was a thumbnail, and "4 of 12
 * capabilities are ready" read as a warning about a broken installation rather
 * than an honest description of a local-first product nobody had pointed at a
 * model yet.
 *
 * So the rules are now three, and all of them are load-bearing:
 *
 *   1. Wrap in DSH's own `Modal`, the way upstream does. Not a hand-rolled
 *      overlay — that would duplicate the dimming, the focus handling and the
 *      inert root that already exist.
 *   2. Keep it short. A first-run notice is a sentence, a readiness statement
 *      and three actions. The full capability list lives in Diagnostics, where
 *      there is width for it and where somebody goes to look things up.
 *   3. Say which action is the way forward. One primary button, two quiet
 *      ones, and enough space between them to tell them apart.
 *
 * @module @deepwatch/dsh-client-settings/onboarding
 */

import type { CSSProperties, ReactNode } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { PRODUCT_NAME, WATCH_MARK_PNG, tokenFor } from '@deepwatch/dsh-client-brand'
import { READINESS } from './readiness.js'

/** What DSH hands an onboarding step. */
export interface OnboardingProps {
  readonly stepId?: string
  readonly complete?: () => void
  readonly openSection?: (id: string) => void
}

/**
 * Layout, kept out of the markup so the structure reads as structure.
 *
 * `min(560px, …)` rather than a fixed width: this renders from a seat inside
 * the sidebar, and a 560-pixel card in a 380-pixel viewport is a horizontal
 * scrollbar. `65ch` caps the prose where the viewport is wide, which is the
 * other half of readable.
 */
const S = {
  card: {
    width: 'min(560px, calc(100vw - 48px))',
    maxWidth: '100%',
    padding: '4px 2px',
    boxSizing: 'border-box',
  },
  head: { display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '18px' },
  mark: { width: '64px', height: '64px', objectFit: 'contain', flexShrink: 0 },
  title: { fontSize: '22px', fontWeight: 600, margin: 0, lineHeight: 1.25 },
  tagline: { fontSize: '14px', margin: '4px 0 0', color: tokenFor('active') },
  prose: {
    fontSize: '14px', lineHeight: 1.65, margin: '0 0 16px', maxWidth: '65ch',
    color: 'var(--dsw-alias-label-secondary)',
  },
  status: {
    display: 'flex', flexDirection: 'column', gap: '8px',
    padding: '12px 14px', marginBottom: '18px',
    border: '1px solid var(--dsw-alias-separator)', borderRadius: '8px',
  },
  statusRow: {
    display: 'flex', gap: '10px', alignItems: 'baseline', fontSize: '13.5px',
    lineHeight: 1.55, margin: 0, flexWrap: 'wrap',
  },
  statusWord: { flexShrink: 0, minWidth: '92px', fontWeight: 600 },
  actions: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' },
  note: {
    fontSize: '12.5px', lineHeight: 1.6, margin: '18px 0 0', maxWidth: '65ch',
    color: 'var(--dsw-alias-label-tertiary)',
  },
} satisfies Record<string, CSSProperties>

/**
 * The DeepWatch first-run notice.
 *
 * Readiness is stated as two facts rather than one fraction, because they are
 * two different things and collapsing them is what made "4 of 12" read as a
 * fault: what runs on this machine is ready *now*, and what needs a model is
 * waiting for a decision nobody has made yet. The count still comes from the
 * same table Diagnostics renders, so the two cannot disagree.
 */
export function WatchOnboarding({ complete, openSection }: OnboardingProps): ReactNode {
  const local = READINESS.filter(item => item.tone === 'active')
  const finish = (): void => { complete?.() }
  const go = (section: string): void => {
    openSection?.(section)
    finish()
  }

  return (
    <Modal open title={`Welcome to ${PRODUCT_NAME}`} onClose={finish} headless>
      <section style={S.card} aria-labelledby="watch-welcome-title">
        <header style={S.head}>
          {/* Decorative: the heading beside it says the name, and announcing
              it twice helps nobody using a screen reader. */}
          <img
            src={WATCH_MARK_PNG} width={64} height={64} alt="" aria-hidden="true" style={S.mark}
          />
          <div>
            <h2 id="watch-welcome-title" style={S.title}>{`Welcome to ${PRODUCT_NAME}`}</h2>
            <p style={S.tagline}>See. Remember. Act. Verify.</p>
          </div>
        </header>

        <p style={S.prose}>
          DeepWatch is an agent that watches what happens on your machine,
          remembers it with provenance, and can prove what actually worked.
        </p>

        {/* Two facts, not one fraction. Colour is never the only signal: each
            row is led by a word, so the meaning survives without it. */}
        <div style={S.status} role="group" aria-label="What is ready now">
          <p style={S.statusRow}>
            <span style={{ ...S.statusWord, color: tokenFor('active') }}>Ready now</span>
            <span>
              {`Watch Core, memory, verification and the browser — ${String(local.length)} local `}
              capabilities that need no provider and no network.
            </span>
          </p>
          <p style={S.statusRow}>
            <span style={{ ...S.statusWord, color: 'var(--dsw-alias-label-secondary)' }}>
              Needs setup
            </span>
            <span>
              Chat, and anything else that calls a model. No provider is
              configured yet, so nothing is sent anywhere until you choose one.
            </span>
          </p>
        </div>

        <div style={S.actions}>
          <Button onClick={() => { go('watch-roles') }}>Finish setup</Button>
          <Button variant="ghost" onClick={finish}>Explore offline</Button>
          <Button variant="ghost" onClick={() => { go('watch-diagnostics') }}>
            View diagnostics
          </Button>
        </div>

        <p style={S.note}>
          Connecting a provider connects a model. It does not permit uploading
          frames, audio, transcripts or evidence — that is a separate consent,
          and it is off.
        </p>
      </section>
    </Modal>
  )
}
