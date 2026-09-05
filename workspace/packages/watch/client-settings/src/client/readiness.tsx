/** Truthful capability readiness shared by onboarding and Diagnostics. */

import type { ReactNode } from 'react'
import {
  BINDING_STATUS_LABEL, ROLE_LABEL, blockerMessage, isExecutable,
} from '@deepwatch/dsh-contracts'
import type { BindableRole } from '@deepwatch/dsh-contracts'
import type {
  CapabilityHealthDetail, CoreHealthReport,
} from '@deepwatch/dsh-contracts/query/wire'
import { StatusChip } from './components.js'
import type { ChipTone } from './components.js'
import type { RoleRow } from './binding-state.js'

/** The complete UI vocabulary. No surface may invent a more flattering state. */
export type ReadinessStatus =
  | 'loading'
  | 'ready'
  | 'degraded'
  | 'unconfigured'
  | 'unavailable'
  | 'not_tested'
  | 'error'

export const READINESS_STATUS_LABEL: Readonly<Record<ReadinessStatus, string>> = {
  loading: 'Loading…', ready: 'Ready', degraded: 'Degraded',
  unconfigured: 'Not configured', unavailable: 'Unavailable',
  not_tested: 'Not tested', error: 'Error',
}

/** One capability definition. Runtime state is deliberately not stored here. */
export interface ReadinessDefinition {
  readonly name: string
  readonly detail: string
  readonly section?: string
  readonly role?: BindableRole
  readonly coreCapabilities?: readonly string[]
  readonly defaultStatus?: 'unconfigured' | 'not_tested'
}

/** One capability after live facts have been folded through the shared model. */
export interface ReadinessRow extends ReadinessDefinition {
  readonly status: ReadinessStatus
  readonly statusLabel: string
  readonly tone: ChipTone
}

export const READINESS: readonly ReadinessDefinition[] = [
  {
    name: 'Watch Core',
    detail: 'The engine that mints evidence and issues verdicts. Runs as a child of this workspace.',
    section: 'watch-diagnostics',
  },
  {
    name: 'Memory', detail: 'Durable, correctable memory with provenance on every record.',
    section: 'watch-memory', coreCapabilities: ['watch.memory.recall'],
  },
  {
    name: 'Verification', detail: 'Deterministic checks against the world. Needs no model.',
    section: 'watch-verification', coreCapabilities: ['watch.verification.run'],
  },
  {
    name: 'Browser',
    detail: 'A supervised browser that acts and returns Core-owned evidence and a receipt.',
    section: 'watch-sources',
    coreCapabilities: ['watch.browser.observe', 'watch.browser.operate', 'watch.evidence.resolve'],
  },
  {
    name: 'Agent Model', role: 'agent_model',
    detail: 'Plans, reasons and writes. Any provider DSH supports — DeepSeek is one of them.',
    section: 'watch-roles',
  },
  {
    name: 'Visual Perception', role: 'visual_perception',
    detail: 'Reads what is on screen or in a frame. A local model works.', section: 'watch-roles',
  },
  {
    name: 'OCR', detail: 'Text out of images and pages. A CPU engine is available.',
    section: 'watch-engines', defaultStatus: 'not_tested',
  },
  {
    name: 'ASR', role: 'asr',
    detail: 'Speech to text, with timings a citation can point at.', section: 'watch-roles',
  },
  {
    name: 'Audio Understanding', role: 'audio_understanding',
    detail: 'Non-speech audio: events, tone, music.', section: 'watch-roles',
  },
  {
    name: 'Speaker / Diarization', detail: 'Who spoke, and when.',
    section: 'watch-roles', defaultStatus: 'unconfigured',
  },
  {
    name: 'Embeddings / Retrieval', role: 'embeddings',
    detail: 'Search over the library and over memory. Falls back to lexical matching.',
    section: 'watch-roles',
  },
  {
    name: 'Capture',
    detail: 'Screen, window, camera and microphone. Permission is asked at first use.',
    section: 'watch-sources', defaultStatus: 'unconfigured',
  },
]

export interface ReadinessFacts {
  readonly roles?: readonly RoleRow[] | undefined
  readonly health?: CoreHealthReport | null | undefined
  readonly reading?: boolean | undefined
}

function toneFor(status: ReadinessStatus): ChipTone {
  if (status === 'ready') return 'active'
  if (status === 'degraded' || status === 'unavailable' || status === 'error') return 'caution'
  return 'neutral'
}

function coreStatus(health: CoreHealthReport | null | undefined, reading: boolean): ReadinessStatus {
  if (reading) return 'loading'
  if (health === null || health === undefined) return 'error'
  if (health.isTestOnlyMock) return 'degraded'
  if (health.blocker === 'connected') return health.phase === 'ready' ? 'ready' : 'degraded'
  if (health.blocker === 'core_missing' || health.blocker === 'bridge_surface_missing') {
    return 'unavailable'
  }
  return health.phase === 'degraded' ? 'degraded' : 'error'
}

/**
 * Core's evidence level, said in the vocabulary a surface may use.
 *
 * The interesting line is `probed`. Core separates three facts on purpose:
 * the code exists, its dependencies were found (`probed`), and a real request
 * ran here and succeeded (`machine_tested`). Only the third is *ready*.
 *
 * `probed` was drawn as **Degraded** for one release, and that was a false
 * alarm in the opposite direction to the green dot: a machine with Chromium
 * installed and a healthy memory index reported two capabilities as impaired
 * when nothing was wrong with either — they simply had not been exercised.
 * Degraded means working and hurt. Ignorance is `not_tested`, which is a
 * neutral word and the accurate one.
 */
function capabilityStatus(detail: CapabilityHealthDetail | undefined): ReadinessStatus {
  if (detail === undefined) return 'not_tested'
  if (!detail.usable) return detail.status === 'unavailable' ? 'unavailable' : 'degraded'
  if (detail.status === 'machine_tested') return 'ready'
  if (detail.status === 'unavailable') return 'unavailable'
  return 'not_tested'
}

const STATUS_PRIORITY: Readonly<Record<ReadinessStatus, number>> = {
  error: 7, unavailable: 6, degraded: 5, loading: 4,
  not_tested: 3, unconfigured: 2, ready: 1,
}

/** Of two states, the one that promises less. */
function worse(left: ReadinessStatus, right: ReadinessStatus): ReadinessStatus {
  return STATUS_PRIORITY[right] > STATUS_PRIORITY[left] ? right : left
}

/** Derive every row from runtime facts. Used by both first-run and Diagnostics. */
export function deriveReadiness(facts: ReadinessFacts): readonly ReadinessRow[] {
  const reading = facts.reading === true
  const health = facts.health
  const details = new Map((health?.capabilityDetails ?? []).map(item => [item.capabilityId, item]))
  const roles = new Map((facts.roles ?? []).map(row => [row.role, row]))
  const core = coreStatus(health, reading)

  return READINESS.map((definition, index) => {
    let status: ReadinessStatus
    let detail = definition.detail
    let statusLabel: string | undefined

    if (index === 0) {
      status = core
      if (health !== null && health !== undefined && health.blocker !== 'connected' && health.fix !== '') {
        detail = health.fix
      }
    } else if (definition.coreCapabilities !== undefined) {
      // Core is the floor, not a separate row that happens to sit above these.
      // A capability cannot be in better shape than the engine carrying it,
      // and the case that proves it is the in-process fixture: it reports five
      // machine-tested capabilities, and without this fold a mock backend
      // renders as a working installation. Folding also means a group is only
      // as good as its weakest member — two thirds of a browser is not a
      // browser that can finish the job.
      const states = definition.coreCapabilities.map(id => capabilityStatus(details.get(id)))
      status = states.reduce(worse, core)
      const problem = definition.coreCapabilities
        .map(id => details.get(id))
        .find(item => item !== undefined && (!item.usable || item.status !== 'machine_tested'))
      if (problem !== undefined) {
        detail = problem.fixes[0] ?? (problem.missing.length === 0
          ? definition.detail
          : `Missing: ${problem.missing.join(', ')}.`)
      } else if (status !== 'ready' && health !== null && health !== undefined
        && health.fix !== '') {
        // Core could not be read, so these rows have nothing of their own to
        // report. What to do about Core is the only actionable sentence there is.
        detail = health.fix
      }
    } else if (definition.role !== undefined) {
      const role = roles.get(definition.role)
      if (role === undefined) status = 'unconfigured'
      else if (isExecutable(role.readiness)) status = 'ready'
      else if (role.readiness.status === 'bound_unverified') status = 'not_tested'
      else if (role.readiness.status === 'unbound') status = 'unconfigured'
      else status = 'error'
      if (role !== undefined) {
        statusLabel = BINDING_STATUS_LABEL[role.readiness.status]
        if (!isExecutable(role.readiness)) detail = blockerMessage(role.readiness) ?? detail
      }
    } else {
      status = definition.defaultStatus ?? 'not_tested'
    }

    return {
      ...definition, detail, status,
      statusLabel: statusLabel ?? READINESS_STATUS_LABEL[status], tone: toneFor(status),
    }
  })
}

export function ReadinessList(
  { openSection, roles, health, reading }: ReadinessFacts & {
    readonly openSection?: ((id: string) => void) | undefined
  },
): ReactNode {
  const rows = deriveReadiness({ roles, health, reading })
  return (
    <div style={{
      border: '1px solid color-mix(in srgb, var(--watch-accent) 10%, var(--dsw-alias-border-l2))',
      borderRadius: '14px', overflow: 'hidden',
      background: 'linear-gradient(145deg, color-mix(in srgb, var(--watch-accent) 3%, var(--dsw-alias-bg-layer-2)), var(--dsw-alias-bg-base))',
      boxShadow: '0 10px 28px color-mix(in srgb, black 8%, transparent)',
    }}
    >
      {rows.map((item, index) => (
        <div key={item.name} style={{
          display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 16px',
          borderTop: index === 0 ? 'none' : '1px solid var(--dsw-alias-border-l2)',
        }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 500 }}>
              {item.role === undefined ? item.name : ROLE_LABEL[item.role]}
            </div>
            <div style={{
              fontSize: '12px', lineHeight: 1.5, marginTop: '2px',
              color: 'var(--dsw-alias-label-tertiary)',
            }}
            >
              {item.detail}
            </div>
          </div>
          <span style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
            <StatusChip tone={item.tone}>{item.statusLabel}</StatusChip>
            {item.section === undefined || openSection === undefined ? null : (
              <button type="button" onClick={() => { openSection(item.section as string) }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px',
                  padding: '2px 4px', color: 'var(--dsw-alias-label-secondary)',
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
