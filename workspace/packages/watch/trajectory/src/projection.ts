/**
 * The Watch projection over DSH's session log, and its replay guarantee.
 *
 * Replay is the property that makes a receipt worth anything. If reopening a
 * finished session could produce a different picture of it, then the picture
 * is an opinion rather than a record, and a verdict shown in it proves nothing
 * about what happened at the time.
 *
 * So this is a pure fold: the same events in, the same projection out, with no
 * clock read, no network, no model, and nothing regenerated. `projectionHash`
 * makes that assertable rather than assumed — two runs over the same log
 * produce the same hash, and a change to what a record carries changes it.
 *
 * @module @deepwatch/dsh-trajectory/projection
 */

import type {
  ExtractionContext,
  SessionEventLike,
  WatchTrajectoryRecord,
} from './events.js'
import { isWatchTool, recordsFromToolResult, toolResultValue } from './events.js'

/** The Watch view of one session. */
export interface WatchProjection {
  readonly sessionId: string
  /** Records in log order. Ordering is by DSH sequence, never by wall clock. */
  readonly records: readonly WatchTrajectoryRecord[]
  /** Evidence id to the record that produced it, for citation resolution. */
  readonly byEvidence: ReadonlyMap<string, WatchTrajectoryRecord>
  /** Record id to record, for deep-link restoration. */
  readonly byRecord: ReadonlyMap<string, WatchTrajectoryRecord>
}

/** An empty projection, so a session with no Watch activity is still a value. */
export function emptyProjection(sessionId: string): WatchProjection {
  return {
    sessionId,
    records: [],
    byEvidence: new Map(),
    byRecord: new Map(),
  }
}

/** What a `tool/call` event told us, kept until its result arrives. */
interface PendingCall {
  readonly name: string
  readonly turn: number | null
  readonly step: number | null
  readonly correlationId: string | null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Fold a session's events into the Watch projection.
 *
 * Deliberately takes the events rather than a live session: the same function
 * serves the live view and replay, so there is no second code path whose
 * output could differ from the one people trust.
 *
 * @param events - DSH session events in ascending sequence order.
 * @param sessionId - the session these belong to.
 */
export function project(
  events: readonly SessionEventLike[],
  sessionId: string,
): WatchProjection {
  const pending = new Map<string, PendingCall>()
  const records: WatchTrajectoryRecord[] = []

  for (const event of events) {
    if (event.type === 'tool/call') {
      const name = str(event.data['name'])
      if (!isWatchTool(name)) continue
      const callId = str(event.data['callId'])
      if (callId === null) continue
      pending.set(callId, {
        name: name as string,
        turn: num(event.data['turn']),
        step: num(event.data['step']),
        // Correlation travels in the tool arguments when the caller set one;
        // it is what ties this row to Watch Core's own logs and receipts.
        correlationId: str(
          (event.data['arguments'] as Record<string, unknown> | undefined)?.['correlationId'],
        ),
      })
      continue
    }

    if (event.type !== 'tool/result') continue
    const message = event.data['message'] as Record<string, unknown> | undefined
    const source = message?.['source'] as Record<string, unknown> | undefined
    const callId = str(source?.['callId'])
    if (callId === null) continue
    const call = pending.get(callId)
    if (call === undefined) continue
    pending.delete(callId)

    const context: ExtractionContext = {
      sessionId,
      turn: call.turn,
      step: call.step,
      callId,
      toolName: call.name,
      correlationId: call.correlationId,
    }
    records.push(...recordsFromToolResult(event, context, toolResultValue(event)))
  }

  return index(sessionId, records)
}

/**
 * Merge externally-produced records into a projection.
 *
 * Memory records do not come from tool results — memory influences a turn
 * without the agent calling anything — so they are contributed rather than
 * derived. They are sorted into the same sequence order so the ledger stays
 * one chronology rather than two lists shown together.
 */
export function withRecords(
  projection: WatchProjection,
  extra: readonly WatchTrajectoryRecord[],
): WatchProjection {
  if (extra.length === 0) return projection
  const merged = [...projection.records, ...extra]
    .sort((a, b) => {
      const bySeq = a.seq - b.seq
      return bySeq !== 0 ? bySeq : a.recordId.localeCompare(b.recordId)
    })
  return index(projection.sessionId, merged)
}

/** Build the lookup maps once, so callers never scan. */
function index(sessionId: string, records: readonly WatchTrajectoryRecord[]): WatchProjection {
  const byEvidence = new Map<string, WatchTrajectoryRecord>()
  const byRecord = new Map<string, WatchTrajectoryRecord>()
  for (const record of records) {
    byRecord.set(record.recordId, record)
    for (const evidenceId of record.refs.evidenceIds) {
      // First writer wins: the record that produced a piece of evidence is the
      // one a citation should select, not a later one that merely cites it.
      if (!byEvidence.has(evidenceId)) byEvidence.set(evidenceId, record)
    }
  }
  return { sessionId, records, byEvidence, byRecord }
}

/**
 * A stable hash of what a projection contains.
 *
 * Over the identifiers and the verdict, not over wall-clock times or free
 * text: a replay that produced the same records at the same sequence numbers
 * with the same verdicts *is* the same projection, and a hash that also
 * covered the summary line would fail whenever someone improved the wording.
 *
 * Not cryptographic, and not trying to be. It exists to catch a projection
 * that changed, not to resist someone forging one.
 */
export function projectionHash(projection: WatchProjection): string {
  const canonical = projection.records.map(record => [
    record.recordId,
    record.type,
    String(record.seq),
    record.refs.sourceRevisionId ?? '',
    record.refs.evidenceIds.join(','),
    record.refs.verificationId ?? '',
    record.refs.verdict ?? '',
    record.refs.receiptId ?? '',
    record.refs.memoryIds.join(','),
    record.refs.temporalRange === null
      ? ''
      : `${String(record.refs.temporalRange.startMs)}-${String(record.refs.temporalRange.endMs)}`,
    record.redacted ? 'redacted' : '',
  ].join('|')).join('\n')

  // FNV-1a, 64-bit, in BigInt. Chosen because it is short, dependency-free,
  // and identical in every runtime this projection is compared across.
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const byte of new TextEncoder().encode(canonical)) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}

/**
 * Resolve a deep-linked selection against a projection.
 *
 * Returns the record a link points at, preferring the record id and falling
 * back to the evidence id — a link made before a record id changed still opens
 * the right evidence, which is the part a person cared about.
 */
export function resolveRecord(
  projection: WatchProjection,
  selection: { readonly recordId: string | null; readonly evidenceId: string | null },
): WatchTrajectoryRecord | null {
  if (selection.recordId !== null) {
    const byId = projection.byRecord.get(selection.recordId)
    if (byId !== undefined) return byId
  }
  if (selection.evidenceId !== null) {
    return projection.byEvidence.get(selection.evidenceId) ?? null
  }
  return null
}
