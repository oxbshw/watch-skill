/**
 * What this installation can actually do, as data.
 *
 * Shared between the first-run notice and Diagnostics on purpose: the notice
 * shows a count and Diagnostics shows the list, and if they were two tables the
 * count would eventually disagree with the rows behind it.
 *
 * `tone` is not decoration, and the distinction it draws is deliberate.
 * `active` means this works right now. `neutral` means nobody has configured
 * or checked it — which is a fact, not a problem, and colouring it amber made
 * an unconfigured installation look like a broken one. `caution` is reserved
 * for something genuinely half-done or unproven.
 *
 * Nothing is `success` — green belongs to a VERIFIED verdict, and a configured
 * capability is not a verdict.
 *
 * @module @deepwatch/dsh-client-settings/readiness
 */

import type { ReactNode } from 'react'
import { StatusChip } from './components.js'
import type { ChipTone } from './components.js'

/** One capability, and how far it has actually got. */
export interface Readiness {
  readonly name: string
  readonly detail: string
  readonly status: string
  readonly tone: ChipTone
  /** The settings section that would change it, when there is one. */
  readonly section?: string
}

/**
 * The twelve capabilities a person is entitled to ask about.
 *
 * Four are genuinely local and genuinely working and say so. The other eight
 * are unconfigured or untested and say which, because a readiness list where
 * everything is ready is a readiness list nobody reads twice.
 */
export const READINESS: readonly Readiness[] = [
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
    tone: 'neutral',
    section: 'watch-roles',
  },
  {
    name: 'Visual Perception',
    detail: 'Reads what is on screen or in a frame. A local model works.',
    status: 'Not configured',
    tone: 'neutral',
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
    tone: 'neutral',
    section: 'watch-roles',
  },
  {
    name: 'Audio Understanding',
    detail: 'Non-speech audio: events, tone, music.',
    status: 'Not configured',
    tone: 'neutral',
    section: 'watch-roles',
  },
  {
    name: 'Speaker / Diarization',
    detail: 'Who spoke, and when.',
    status: 'Not configured',
    tone: 'neutral',
    section: 'watch-roles',
  },
  {
    name: 'Embeddings / Retrieval',
    detail: 'Search over the library and over memory. Falls back to lexical matching.',
    status: 'Not configured',
    tone: 'neutral',
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

/**
 * The readiness list, for a surface that has room for it.
 *
 * This belongs in Diagnostics, not in the first-run notice. The notice sits in
 * a 256px sidebar seat; this needs the settings panel's width, and putting it
 * anywhere narrower is how the sidebar got destroyed once already.
 */
export function ReadinessList(
  // `exactOptionalPropertyTypes` is on, and the settings slot renders a section
  // with no props at all — so the absence has to be part of the type rather
  // than smuggled in by a default.
  { openSection }: { readonly openSection?: ((id: string) => void) | undefined },
): ReactNode {
  return (
    <div style={{
      border: '1px solid var(--dsw-alias-border-l2)',
      borderRadius: '10px',
      overflow: 'hidden',
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
                    onClick={() => { openSection?.(item.section as string) }}
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
  )
}
