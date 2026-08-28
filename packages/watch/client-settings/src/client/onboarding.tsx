/**
 * The first thing a person sees.
 *
 * What they saw before was "Add an API key to get started — configure the
 * official DeepSeek provider to start building". That screen is upstream's and
 * it is reasonable for upstream, but it misdescribes this product twice over:
 * it implies the workspace does nothing until a cloud provider is connected,
 * and it implies the only thing worth configuring is a chat model.
 *
 * Neither is true here. Watch's perception, memory, evidence and verification
 * layers are local. A useful installation can be assembled without any provider
 * at all, and the agent model is one role among nine.
 *
 * So this step goes first — `order: -50`, ahead of upstream's `deepseek-official`
 * at `order: 0` — and it leads with what the product is and what is actually
 * ready. It does not remove the DeepSeek step: that provider stays a perfectly
 * good choice, and skipping this screen lands on it as before.
 *
 * The readiness list is the honest part. Nothing on it is marked ready unless
 * it is, and on a machine where no capability check has run almost nothing is.
 * A first-run screen that greeted everyone with a column of green ticks would
 * be teaching people to ignore it by the second launch.
 *
 * @module @watchskill/dsh-client-settings/onboarding
 */

import type { ReactNode } from 'react'
import { PRODUCT_NAME, TAGLINE, tokenFor } from '@watchskill/dsh-client-brand'
import { StatusChip } from './components.js'
import type { ChipTone } from './components.js'

/** What DSH hands an onboarding step. */
export interface OnboardingProps {
  readonly stepId?: string
  readonly complete?: () => void
  readonly openSection?: (id: string) => void
}

/**
 * One capability, and how far it has actually got.
 *
 * `tone` is not decoration. `active` means this works right now; `caution`
 * means it needs a decision from you; `neutral` means nobody has looked yet.
 * Nothing is `success` — see the note on `ChipTone`.
 */
interface Readiness {
  readonly name: string
  readonly detail: string
  readonly status: string
  readonly tone: ChipTone
  readonly section?: string
}

const READINESS: readonly Readiness[] = [
  {
    name: 'Watch Core',
    detail: 'The engine that mints evidence and issues verdicts. Runs as a child of this workspace.',
    status: 'Ready',
    tone: 'active',
    section: 'watch-diagnostics',
  },
  {
    name: 'Memory',
    detail: 'Durable, correctable memory with provenance on every record.',
    status: 'Local',
    tone: 'active',
    section: 'watch-memory',
  },
  {
    name: 'Verification',
    detail: 'Deterministic checks against the world. Needs no model.',
    status: 'Local',
    tone: 'active',
    section: 'watch-verification',
  },
  {
    name: 'Browser',
    detail: 'A supervised browser that acts and returns a receipt.',
    status: 'Local',
    tone: 'active',
    section: 'watch-sources',
  },
  {
    name: 'Agent Model',
    detail: 'Plans, reasons and writes. Any provider DSH supports — DeepSeek is one of them.',
    status: 'Not configured',
    tone: 'caution',
    section: 'watch-roles',
  },
  {
    name: 'Visual Perception',
    detail: 'Reads what is on screen or in a frame. A local model works.',
    status: 'Not configured',
    tone: 'caution',
    section: 'watch-roles',
  },
  {
    name: 'OCR',
    detail: 'Text out of images and pages. A CPU engine is available.',
    status: 'Not tested',
    tone: 'neutral',
    section: 'watch-engines',
  },
  {
    name: 'ASR',
    detail: 'Speech to text, with timings a citation can point at.',
    status: 'Not configured',
    tone: 'caution',
    section: 'watch-roles',
  },
  {
    name: 'Audio Understanding',
    detail: 'Non-speech audio: events, tone, music.',
    status: 'Not configured',
    tone: 'caution',
    section: 'watch-roles',
  },
  {
    name: 'Speaker / Diarization',
    detail: 'Who spoke, and when.',
    status: 'Not configured',
    tone: 'caution',
    section: 'watch-roles',
  },
  {
    name: 'Embeddings / Retrieval',
    detail: 'Search over the library and over memory. Falls back to lexical matching.',
    status: 'Not configured',
    tone: 'caution',
    section: 'watch-roles',
  },
  {
    name: 'Capture',
    detail: 'Screen, window, camera and microphone. Permission is asked at first use.',
    status: 'Not requested',
    tone: 'neutral',
    section: 'watch-sources',
  },
]

/** The Watch first-run screen. */
export function WatchOnboarding({ complete, openSection }: OnboardingProps): ReactNode {
  const ready = READINESS.filter(item => item.tone === 'active').length

  return (
    <div style={{ padding: '4px 2px 8px', maxWidth: '720px' }}>
      <h2 style={{ fontSize: '20px', fontWeight: 600, margin: 0 }}>{PRODUCT_NAME}</h2>
      <p style={{
        fontSize: '15px',
        margin: '6px 0 2px',
        color: tokenFor('active'),
        letterSpacing: '0.01em',
      }}
      >
        See. Remember. Act. Verify.
      </p>
      <p style={{
        fontSize: '13px', lineHeight: 1.6, margin: '10px 0 18px',
        color: 'var(--dsw-alias-label-secondary)',
      }}
      >
        {TAGLINE}
        {' '}
        Perception, memory, evidence and verification run on this machine. You can
        start now and configure a provider whenever you want one — a chat model is
        one role among nine, not the price of entry.
      </p>

      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        margin: '0 0 8px',
      }}
      >
        <h3 style={{
          fontSize: '12px', fontWeight: 600, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary)', margin: 0,
        }}
        >
          System readiness
        </h3>
        <span style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)' }}>
          {`${String(ready)} of ${String(READINESS.length)} ready`}
        </span>
      </div>

      <div style={{
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '10px', overflow: 'hidden',
      }}
      >
        {READINESS.map((item, index) => (
          <div
            key={item.name}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: '12px',
              padding: '10px 14px',
              borderTop: index === 0 ? 'none' : '1px solid var(--dsw-alias-border-l2)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: '13px', fontWeight: 500 }}>{item.name}</div>
              <div style={{
                fontSize: '12px', lineHeight: 1.5, marginTop: '2px',
                color: 'var(--dsw-alias-label-tertiary)',
              }}
              >
                {item.detail}
              </div>
            </div>
            <span style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
              <StatusChip tone={item.tone}>{item.status}</StatusChip>
              {item.section === undefined || openSection === undefined
                ? null
                : (
                    <button
                      type="button"
                      onClick={() => { openSection(item.section as string) }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        fontSize: '11px', padding: '2px 4px',
                        color: 'var(--dsw-alias-label-secondary)',
                        textDecoration: 'underline',
                      }}
                    >
                      Configure
                    </button>
                  )}
            </span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: '18px', flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => { openSection?.('watch-roles') }}
          style={{
            padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
            border: `1px solid ${tokenFor('active')}`,
            background: 'transparent', color: tokenFor('active'), fontSize: '13px',
          }}
        >
          Configure capabilities
        </button>
        <button
          type="button"
          onClick={() => { complete?.() }}
          style={{
            padding: '8px 16px', borderRadius: '8px', cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)', fontSize: '13px',
          }}
        >
          Continue to the workspace
        </button>
      </div>

      <p style={{
        fontSize: '12px', lineHeight: 1.55, margin: '16px 0 0',
        color: 'var(--dsw-alias-label-tertiary)',
        borderLeft: `2px solid ${tokenFor('active')}`, paddingLeft: '10px',
      }}
      >
        Configuring a provider connects a model. It does not grant permission to
        upload frames, audio, transcripts or evidence — cloud media egress is a
        separate consent, and it is off.
      </p>
    </div>
  )
}
