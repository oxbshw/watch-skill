/**
 * The seven ways of looking at one session.
 *
 * The decision that shapes this whole module: a mode is a *view*, not a place.
 * Agent, Watch, Live, Memory, Library, Compare and Trajectory all read the
 * same DSH session and the same correlated state; switching between them
 * changes what is rendered and nothing about what exists. That is why there is
 * no per-mode session store here and no per-mode state to lose — the only
 * thing a mode owns is which surface is on screen.
 *
 * The alternative, which is what happens by accident, is seven small
 * applications that each keep their own idea of the session. Then "the agent
 * says it verified it, but Watch shows nothing" becomes a real answer rather
 * than a bug, and the product's central claim stops being checkable.
 *
 * Availability is the other structural rule. A mode whose capability is absent
 * is **degraded and says so**, never quietly missing and never quietly enabled.
 * A missing Live surface that simply vanished from the switcher would teach a
 * person that Watch cannot watch live; a Live tab that opens onto nothing
 * would teach them it can, and is broken. Both are worse than one line saying
 * the engine is not connected and what to do about it.
 *
 * @module @watchskill/dsh-workspace/modes
 */

import type {
  CapabilityStatus,
  CapabilityTruth,
  WatchCoreHealth,
} from '@watchskill/dsh-contracts'

/** The product modes, in the order they are presented. */
export type WorkspaceMode =
  | 'agent'
  | 'watch'
  | 'live'
  | 'memory'
  | 'library'
  | 'compare'
  | 'trajectory'

/** Every mode, in presentation order. */
export const WORKSPACE_MODES: readonly WorkspaceMode[] = [
  'agent', 'watch', 'live', 'memory', 'library', 'compare', 'trajectory',
]

/**
 * What a mode is, as data.
 *
 * `requires` names Watch Core capabilities by the id Core publishes at
 * handshake. It is deliberately a list of *capability* ids rather than a
 * boolean the client computes: the client does not get to decide that
 * something is available.
 */
export interface ModeDescriptor {
  readonly id: WorkspaceMode
  /** What the tab says. */
  readonly label: string
  /** One line for a tooltip and for the empty state. */
  readonly description: string
  /** Watch Core capabilities this mode cannot function without. */
  readonly requires: readonly string[]
  /** Whether this mode needs the Bridge at all. */
  readonly needsCore: boolean
  /**
   * Whether the mode is part of DSH's own product surface.
   *
   * `agent` is: it is DSH's conversation, preserved. Watch renders it through
   * the same shell rather than replacing it, which is what keeps the parity
   * promise honest.
   */
  readonly inheritedFromDsh: boolean
}

/** The shipped mode table. */
export const MODE_DESCRIPTORS: Readonly<Record<WorkspaceMode, ModeDescriptor>> = {
  agent: {
    id: 'agent',
    label: 'Agent',
    description: 'The conversation. DeepSeek Harness’s own surface, unchanged.',
    requires: [],
    needsCore: false,
    inheritedFromDsh: true,
  },
  watch: {
    id: 'watch',
    label: 'Watch',
    description: 'Sources this session has observed, and the evidence they produced.',
    requires: ['source.ask'],
    needsCore: true,
    inheritedFromDsh: false,
  },
  live: {
    id: 'live',
    label: 'Live',
    description: 'Watch something as it happens, with gaps shown rather than filled.',
    requires: ['live.observe'],
    needsCore: true,
    inheritedFromDsh: false,
  },
  memory: {
    id: 'memory',
    label: 'Memory',
    description: 'What Watch remembers, why it remembered it, and how to change it.',
    requires: [],
    needsCore: false,
    inheritedFromDsh: false,
  },
  library: {
    id: 'library',
    label: 'Library',
    description: 'Every indexed source, its revisions, and the evidence addressed to them.',
    requires: ['library.search'],
    needsCore: true,
    inheritedFromDsh: false,
  },
  compare: {
    id: 'compare',
    label: 'Compare',
    description: 'Where two runs, revisions or moments first stopped agreeing.',
    requires: [],
    needsCore: false,
    inheritedFromDsh: false,
  },
  trajectory: {
    id: 'trajectory',
    label: 'Trajectory',
    description: 'The event ledger. Every other view is a projection of this one.',
    requires: [],
    needsCore: false,
    inheritedFromDsh: true,
  },
}

/** Why a mode is not fully usable right now. */
export type ModeAvailability = 'available' | 'degraded' | 'unavailable'

/** A mode's availability, and the sentence that explains it. */
export interface ModeState {
  readonly id: WorkspaceMode
  readonly availability: ModeAvailability
  /**
   * One sentence, shown in the tab and in the mode's empty state.
   *
   * Empty when the mode is simply available: a reason for a working thing is
   * noise, and noise is what stops people reading the reasons that matter.
   */
  readonly reason: string
  /** What the person can do about it, when there is something. */
  readonly fix: string
  /** Capability ids this mode wanted and did not get. */
  readonly missing: readonly string[]
}

/** What the shell knows about the engine when it computes availability. */
export interface ModeEnvironment {
  /** Capability truth as Watch Core published it. Empty when not connected. */
  readonly capabilities: readonly CapabilityTruth[]
  /** Bridge health, or null when no Bridge has been configured. */
  readonly health: WatchCoreHealth | null
}

/** Whether the Bridge is in a phase that can serve requests. */
function coreIsUsable(health: WatchCoreHealth | null): boolean {
  return health !== null && (health.phase === 'ready' || health.phase === 'degraded')
}

/**
 * Capability statuses that count as "this actually works here".
 *
 * Only `machine_tested`. The distinction is ADR-002's: code being wired, a
 * probe passing and a real request succeeding are three different facts, and a
 * mode that opens on the first one is a mode that lies for as long as nobody
 * tries it.
 */
function isProven(status: CapabilityStatus): boolean {
  return status === 'machine_tested'
}

/** Capability statuses that mean the mode cannot function at all. */
function isRefused(status: CapabilityStatus): boolean {
  return status === 'unavailable'
}

/** The first sentence a capability offers about itself, if it offers one. */
function firstFix(capability: CapabilityTruth | undefined): string {
  return capability?.fixes[0] ?? ''
}

/**
 * Resolve one mode's availability.
 *
 * Three outcomes, deliberately distinct:
 *
 * - `available` — every capability it needs has actually run here.
 * - `degraded` — the mode opens and does something useful, but part of it is
 *   unproven or the Bridge negotiated less than it asked for.
 * - `unavailable` — nothing it does can work. Live with no engine is this.
 *
 * A mode is never removed from the switcher. Removing it hides a capability
 * the product claims to have, which is the failure mode this function exists
 * to prevent.
 */
export function resolveMode(mode: WorkspaceMode, env: ModeEnvironment): ModeState {
  const descriptor = MODE_DESCRIPTORS[mode]

  if (!descriptor.needsCore) {
    return { id: mode, availability: 'available', reason: '', fix: '', missing: [] }
  }

  if (!coreIsUsable(env.health)) {
    const phase = env.health?.phase ?? 'not configured'
    return {
      id: mode,
      availability: 'unavailable',
      reason: `Watch Core is ${phase}, so ${descriptor.label} has nothing to read.`,
      fix: env.health?.error?.fix
        ?? 'Start Watch Core, or check the engine connection in Settings.',
      missing: [...descriptor.requires],
    }
  }

  const byId = new Map(env.capabilities.map(capability => [capability.capabilityId, capability]))
  const missing: string[] = []
  const unproven: string[] = []
  for (const id of descriptor.requires) {
    const capability = byId.get(id)
    if (capability === undefined || isRefused(capability.status)) {
      missing.push(id)
      continue
    }
    if (!isProven(capability.status)) unproven.push(id)
  }

  if (missing.length > 0) {
    const first = byId.get(missing[0] ?? '')
    return {
      id: mode,
      availability: 'unavailable',
      reason: first === undefined
        ? `${descriptor.label} needs ${missing.join(', ')}, which this engine does not provide.`
        : `${descriptor.label} needs ${missing.join(', ')}, reported ${first.status}.`,
      fix: firstFix(first) === ''
        ? 'Install the missing capability and reconnect.'
        : firstFix(first),
      missing,
    }
  }

  if (unproven.length > 0) {
    const first = byId.get(unproven[0] ?? '')
    return {
      id: mode,
      availability: 'degraded',
      reason: `${unproven.join(', ')} is ${first?.status ?? 'not_tested'}, not machine tested here.`,
      fix: firstFix(first),
      missing: unproven,
    }
  }

  if (env.health?.phase === 'degraded') {
    return {
      id: mode,
      availability: 'degraded',
      reason: env.health.error?.message
        ?? 'Watch Core connected with a reduced feature set.',
      fix: env.health.error?.fix ?? '',
      missing: [],
    }
  }

  return { id: mode, availability: 'available', reason: '', fix: '', missing: [] }
}

/** Resolve every mode at once, in presentation order. */
export function resolveModes(env: ModeEnvironment): readonly ModeState[] {
  return WORKSPACE_MODES.map(mode => resolveMode(mode, env))
}

/**
 * The workspace's mode selection.
 *
 * `sessionId` is on the state rather than under it. The invariant this encodes
 * — one session across every mode — is enforced by `switchMode` refusing to
 * change it, and asserted by the tests: a shell that could switch mode and
 * session in one step is a shell where the two can drift.
 */
export interface WorkspaceState {
  readonly workspaceId: string
  readonly sessionId: string
  readonly mode: WorkspaceMode
  /** Where the person was before, so a temporary detour can return. */
  readonly previousMode: WorkspaceMode | null
}

/** Open a workspace on its default mode. */
export function initialState(workspaceId: string, sessionId: string): WorkspaceState {
  return { workspaceId, sessionId, mode: 'agent', previousMode: null }
}

/**
 * Switch mode within the same session.
 *
 * Returns the same object when nothing changed, so a re-render is skippable,
 * and refuses to touch the session under any circumstances.
 */
export function switchMode(state: WorkspaceState, mode: WorkspaceMode): WorkspaceState {
  if (state.mode === mode) return state
  return {
    workspaceId: state.workspaceId,
    sessionId: state.sessionId,
    mode,
    previousMode: state.mode,
  }
}

/**
 * Move to a different session, keeping the mode.
 *
 * The counterpart to `switchMode`, and the only function that may change the
 * session. Keeping them separate is what makes "did switching mode change the
 * session?" answerable by reading two short functions.
 */
export function switchSession(state: WorkspaceState, sessionId: string): WorkspaceState {
  if (state.sessionId === sessionId) return state
  return { ...state, sessionId }
}

/**
 * Which mode a selection should be read in.
 *
 * A deep link points at a record, not at a screen. This is how one resolves
 * into the other, so a link shared from Trajectory and a link shared from a
 * citation both land somewhere that can show the thing.
 */
export function modeForSelection(selection: {
  readonly memoryId: string | null
  readonly sourceId: string | null
  readonly verificationId: string | null
  readonly receiptId: string | null
  readonly evidenceId: string | null
}): WorkspaceMode {
  if (selection.memoryId !== null) return 'memory'
  if (selection.verificationId !== null || selection.receiptId !== null) return 'trajectory'
  if (selection.evidenceId !== null) return 'watch'
  if (selection.sourceId !== null) return 'library'
  return 'agent'
}
