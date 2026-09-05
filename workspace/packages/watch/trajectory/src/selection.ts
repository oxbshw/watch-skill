/**
 * The Unified Selection Model, and the deep links that serialize it.
 *
 * One canonical selection, not one per panel. That is the whole design: a
 * citation in an answer, a row in Trajectory, a position in a player and the
 * Evidence Inspector are four *projections* of the same value, so selecting in
 * any of them moves all of them, and there is no state to reconcile between
 * them because there is only one.
 *
 * DSH's own Trajectory selection is documented as local to Trajectory, with no
 * anchor deep links. This is the smallest additive Watch-owned extension
 * around it: Watch holds the canonical selection for Watch-related records and
 * drives Trajectory's local selection from it, rather than replacing anything
 * upstream owns.
 *
 * Everything here is pure. A selection is a value, not a store.
 *
 * @module @deepwatch/dsh-trajectory/selection
 */

import type { WatchTrajectoryRecord } from './events.js'

/** Which inspector panel a selection opens. */
export type InspectorTab = 'evidence' | 'verification' | 'receipt' | 'memory' | 'source'

/**
 * The one selection every Watch surface responds to.
 *
 * Identifiers only. A selection that carried evidence *content* would be a
 * second copy of it, and the copy in a URL would be one nobody could
 * invalidate.
 */
export interface WatchSelection {
  readonly workspaceId: string
  readonly sessionId: string
  /** The Trajectory record, when the selection came from or points at one. */
  readonly recordId: string | null
  readonly evidenceId: string | null
  readonly sourceId: string | null
  readonly sourceRevisionId: string | null
  readonly verificationId: string | null
  readonly receiptId: string | null
  readonly memoryId: string | null
  /** Where in the source, in milliseconds. */
  readonly atMs: number | null
  readonly endMs: number | null
  readonly inspectorTab: InspectorTab | null
  /** Which surface initiated it, so a surface can skip echoing itself. */
  readonly origin: string
}

/** A selection with nothing selected, for a fresh session. */
export function emptySelection(workspaceId: string, sessionId: string): WatchSelection {
  return {
    workspaceId,
    sessionId,
    recordId: null,
    evidenceId: null,
    sourceId: null,
    sourceRevisionId: null,
    verificationId: null,
    receiptId: null,
    memoryId: null,
    atMs: null,
    endMs: null,
    inspectorTab: null,
    origin: 'none',
  }
}

/**
 * Which inspector panel a record should open.
 *
 * Derived rather than stored, so a record selected from Trajectory and the
 * same record reached from a citation land on the same panel.
 */
export function tabForRecord(record: WatchTrajectoryRecord): InspectorTab {
  switch (record.type) {
    case 'verification.requested':
    case 'verification.completed':
      return 'verification'
    case 'browser.action.dispatched':
    case 'browser.action.receipt':
      return 'receipt'
    case 'memory.context.injected':
    case 'memory.record.corrected':
    case 'memory.record.forgotten':
      return 'memory'
    case 'source.bound':
      return 'source'
    case 'evidence.created':
    case 'observation.created':
      return 'evidence'
  }
}

/**
 * Select one Trajectory record.
 *
 * This is the reverse direction of the round trip: a Watch row in Trajectory
 * resolves to the same evidence, timestamp and receipt a citation would.
 */
export function selectRecord(
  base: WatchSelection,
  record: WatchTrajectoryRecord,
  origin = 'trajectory',
): WatchSelection {
  return {
    ...base,
    recordId: record.recordId,
    evidenceId: record.refs.evidenceIds[0] ?? null,
    sourceId: record.refs.sourceId,
    sourceRevisionId: record.refs.sourceRevisionId,
    verificationId: record.refs.verificationId,
    receiptId: record.refs.receiptId,
    memoryId: record.refs.memoryIds[0] ?? null,
    atMs: record.refs.temporalRange?.startMs ?? null,
    endMs: record.refs.temporalRange?.endMs ?? null,
    inspectorTab: tabForRecord(record),
    origin,
  }
}

/** One citation as an answer carries it. */
export interface CitationRef {
  readonly evidenceId: string
  readonly sourceRevisionId: string | null
  readonly atMs: number | null
  readonly endMs?: number | null
}

/**
 * Select a citation from an agent answer.
 *
 * The forward direction: clicking a timestamp in an answer resolves the exact
 * source revision and moment, and finds the Trajectory record that produced
 * it. `records` is searched rather than trusted from the citation, because the
 * record is the thing Trajectory can highlight and the citation only knows its
 * own evidence id.
 */
export function selectCitation(
  base: WatchSelection,
  citation: CitationRef,
  records: readonly WatchTrajectoryRecord[],
  origin = 'conversation',
): WatchSelection {
  const owning = records.find(record => record.refs.evidenceIds.includes(citation.evidenceId))
  return {
    ...base,
    recordId: owning?.recordId ?? null,
    evidenceId: citation.evidenceId,
    // The citation's own revision wins when it has one: it is what was cited,
    // and the record may aggregate several.
    sourceId: citation.sourceRevisionId ?? owning?.refs.sourceId ?? null,
    sourceRevisionId: citation.sourceRevisionId ?? owning?.refs.sourceRevisionId ?? null,
    verificationId: owning?.refs.verificationId ?? null,
    receiptId: owning?.refs.receiptId ?? null,
    memoryId: null,
    atMs: citation.atMs,
    endMs: citation.endMs ?? citation.atMs,
    inspectorTab: 'evidence',
    origin,
  }
}

/** Whether two selections point at the same thing, ignoring which surface moved. */
export function sameSelection(left: WatchSelection, right: WatchSelection): boolean {
  return left.workspaceId === right.workspaceId
    && left.sessionId === right.sessionId
    && left.recordId === right.recordId
    && left.evidenceId === right.evidenceId
    && left.sourceRevisionId === right.sourceRevisionId
    && left.verificationId === right.verificationId
    && left.receiptId === right.receiptId
    && left.memoryId === right.memoryId
    && left.atMs === right.atMs
    && left.inspectorTab === right.inspectorTab
}

// ── deep links ──────────────────────────────────────────────────────────────

/** The parameter names a deep link uses. Stable; changing one breaks old links. */
const PARAM = {
  workspaceId: 'w',
  sessionId: 's',
  recordId: 'r',
  evidenceId: 'e',
  sourceId: 'src',
  sourceRevisionId: 'rev',
  verificationId: 'v',
  receiptId: 'rc',
  memoryId: 'm',
  atMs: 't',
  endMs: 'te',
  inspectorTab: 'tab',
} as const

/**
 * Serialize a selection as a deep link fragment.
 *
 * A fragment rather than a query string, and identifiers rather than content.
 * A fragment is not sent to a server, which matters because these ids point at
 * someone's private session; and a link that carried evidence *text* would be
 * a copy nobody could invalidate when the underlying source changed.
 *
 * @returns the fragment including its leading `#`, so it can be appended
 * directly to a workspace URL.
 */
export function toDeepLink(selection: WatchSelection): string {
  const params = new URLSearchParams()
  const put = (key: string, value: string | number | null): void => {
    if (value === null || value === '') return
    params.set(key, String(value))
  }
  put(PARAM.workspaceId, selection.workspaceId)
  put(PARAM.sessionId, selection.sessionId)
  put(PARAM.recordId, selection.recordId)
  put(PARAM.evidenceId, selection.evidenceId)
  put(PARAM.sourceId, selection.sourceId)
  put(PARAM.sourceRevisionId, selection.sourceRevisionId)
  put(PARAM.verificationId, selection.verificationId)
  put(PARAM.receiptId, selection.receiptId)
  put(PARAM.memoryId, selection.memoryId)
  put(PARAM.atMs, selection.atMs)
  put(PARAM.endMs, selection.endMs)
  put(PARAM.inspectorTab, selection.inspectorTab)
  return `#watch=${encodeURIComponent(params.toString())}`
}

/** Inspector tabs that may appear in a link, so a bad one cannot be injected. */
const TABS = new Set<string>(['evidence', 'verification', 'receipt', 'memory', 'source'])

/**
 * Restore a selection from a deep link.
 *
 * Returns null when the fragment is not a Watch link or names no session — a
 * link that cannot identify what it points at should leave the current
 * selection alone rather than clearing it to a half-restored state.
 *
 * Unknown parameters are ignored rather than rejected, so a link produced by a
 * newer build still opens the part this one understands.
 */
export function fromDeepLink(fragment: string): WatchSelection | null {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment
  const marker = 'watch='
  const at = raw.startsWith(marker) ? 0 : raw.indexOf(`&${marker}`)
  if (at < 0) return null
  const encoded = raw.slice(at === 0 ? marker.length : at + marker.length + 1)
  const params = new URLSearchParams(decodeURIComponent(encoded))

  const sessionId = params.get(PARAM.sessionId)
  if (sessionId === null || sessionId === '') return null

  const number = (key: string): number | null => {
    const value = params.get(key)
    if (value === null) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const tab = params.get(PARAM.inspectorTab)

  return {
    workspaceId: params.get(PARAM.workspaceId) ?? '',
    sessionId,
    recordId: params.get(PARAM.recordId),
    evidenceId: params.get(PARAM.evidenceId),
    sourceId: params.get(PARAM.sourceId),
    sourceRevisionId: params.get(PARAM.sourceRevisionId),
    verificationId: params.get(PARAM.verificationId),
    receiptId: params.get(PARAM.receiptId),
    memoryId: params.get(PARAM.memoryId),
    atMs: number(PARAM.atMs),
    endMs: number(PARAM.endMs),
    inspectorTab: tab !== null && TABS.has(tab) ? tab as InspectorTab : null,
    // A restored selection did not come from a panel, and saying so stops the
    // surfaces from treating it as an echo of their own change.
    origin: 'deep-link',
  }
}
