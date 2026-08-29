/**
 * Watch records, derived from DeepSeek Harness's own session event log.
 *
 * The single most important thing about this module is what it does *not* do:
 * it does not store anything. DSH already records every Watch tool call and
 * result in the session log it owns, and these are a projection over that log.
 * There is one event store, and it is DSH's.
 *
 * That constraint is what keeps the authority boundaries honest. A second
 * Watch-owned ledger for UI tracking would immediately become a place where
 * evidence could be copied, then edited, then disagree with Watch Core — and
 * the disagreement would be invisible, because both would look authoritative.
 *
 * So what a record carries is **stable foreign identifiers plus presentation
 * metadata**, never a mutable evidence payload. An `evidenceId` is a handle
 * that Watch Core resolves; the text of the evidence lives at Watch Core and
 * is fetched when someone opens it.
 *
 * @module @watchskill/dsh-trajectory/events
 */

import type { Verdict } from '@watchskill/dsh-contracts'

/**
 * The Watch event family.
 *
 * Deliberately small and capability-driven. Each one exists because something
 * in the vertical slice needs to select it, deep-link to it, or replay it.
 */
export type WatchEventType =
  /** A source was attached to this session. */
  | 'source.bound'
  /** Watch looked at something and reported what it saw. */
  | 'observation.created'
  /** Watch Core minted an evidence record. */
  | 'evidence.created'
  /** A verification contract was submitted. */
  | 'verification.requested'
  /** A verdict came back. */
  | 'verification.completed'
  /** A browser action was sent to the page. */
  | 'browser.action.dispatched'
  /** A receipt settled for a browser action. */
  | 'browser.action.receipt'
  /** Memory was selected for a turn. */
  | 'memory.context.injected'
  /** A memory was corrected. */
  | 'memory.record.corrected'
  /** A memory was forgotten. */
  | 'memory.record.forgotten'

/** Every event type, for exhaustive checks and registration. */
export const WATCH_EVENT_TYPES: readonly WatchEventType[] = [
  'source.bound',
  'observation.created',
  'evidence.created',
  'verification.requested',
  'verification.completed',
  'browser.action.dispatched',
  'browser.action.receipt',
  'memory.context.injected',
  'memory.record.corrected',
  'memory.record.forgotten',
]

/**
 * Stable references a Watch record carries into Trajectory.
 *
 * All identifiers, no payloads. Every field here is a handle that resolves
 * somewhere with its own authority: DSH owns the session and turn ids, Watch
 * Core owns the source, evidence, verification and receipt ids, and Watch
 * Memory owns the memory id.
 */
export interface WatchRefs {
  /** DSH session this happened in. */
  readonly sessionId: string
  /** DSH turn, when the event happened inside one. */
  readonly turn: number | null
  /** DSH step within the turn. */
  readonly step: number | null
  /** The tool call this record came from. */
  readonly callId: string | null
  /** Travels with the Bridge request; the same id appears in Core's logs. */
  readonly correlationId: string | null
  readonly sourceId: string | null
  /** Which revision of the source. A source that changed is a different one. */
  readonly sourceRevisionId: string | null
  readonly evidenceIds: readonly string[]
  readonly verificationId: string | null
  readonly verdict: Verdict | null
  readonly receiptId: string | null
  /** Half-open range on the source's own clock, in milliseconds. */
  readonly temporalRange: { readonly startMs: number; readonly endMs: number } | null
  /** Artifact handle, resolved by Watch Core when someone opens it. */
  readonly artifactId: string | null
  readonly memoryIds: readonly string[]
}

/** An empty reference set, so a record never carries `undefined` fields. */
export const NO_REFS: WatchRefs = Object.freeze({
  sessionId: '',
  turn: null,
  step: null,
  callId: null,
  correlationId: null,
  sourceId: null,
  sourceRevisionId: null,
  evidenceIds: [],
  verificationId: null,
  verdict: null,
  receiptId: null,
  temporalRange: null,
  artifactId: null,
  memoryIds: [],
})

/**
 * One Watch record as Trajectory shows it.
 *
 * `summary` is the only free text, and it is presentation metadata: a short
 * line a person reads in a ledger. It is derived, never authoritative, and
 * nothing resolves anything from it.
 */
export interface WatchTrajectoryRecord {
  /** Stable within a session; what a deep link points at. */
  readonly recordId: string
  readonly type: WatchEventType
  /** DSH log sequence, for ordering against every other Trajectory row. */
  readonly seq: number
  /** Wall clock, in epoch milliseconds. */
  readonly time: number
  readonly refs: WatchRefs
  /** One line for the ledger. Presentation only. */
  readonly summary: string
  /**
   * Whether this record's detail may be shown without further permission.
   *
   * Memory records about a person can be sensitive, and a ledger is a place
   * people scroll past rather than read carefully. A redacted record still
   * appears — hiding that memory influenced a turn would be worse — but its
   * content is withheld until someone asks for it.
   */
  readonly redacted: boolean
}

/** The minimum of a DSH session event this module reads. */
export interface SessionEventLike {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
}

/** Watch tools whose results carry evidence, verdicts or receipts. */
const WATCH_TOOL_PREFIX = 'watch_'

/** Read a string field, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Read a plain object, or null. */
function obj(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Read an array of ids, dropping anything that is not one. */
function ids(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.map(str).filter((entry): entry is string => entry !== null)
    : []
}

/**
 * Pull the JSON a Watch tool returned out of a `tool/result` event.
 *
 * Returns null on anything unexpected. A result this cannot read produces no
 * Watch record at all, which is correct: an unreadable result is not evidence
 * that something happened, and inventing a row for it would put a claim in the
 * ledger that nothing backs.
 */
export function toolResultValue(event: SessionEventLike): unknown {
  const message = obj(obj(event.data['message'])?.['content'])
  const content = Array.isArray(obj(event.data['message'])?.['content'])
    ? (obj(event.data['message'])?.['content'] as unknown[])
    : null
  if (content === null) return message
  const first = obj(content[0])
  const inner = first?.['content']
  const text = Array.isArray(inner)
    ? inner.map(part => str(obj(part)?.['text'])).filter(Boolean).join('')
    : str(inner)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Whether a tool name belongs to Watch. */
export function isWatchTool(name: unknown): boolean {
  return typeof name === 'string' && name.startsWith(WATCH_TOOL_PREFIX)
}

/** Everything one extraction needs from its surrounding DSH context. */
export interface ExtractionContext {
  readonly sessionId: string
  readonly turn: number | null
  readonly step: number | null
  readonly callId: string | null
  readonly toolName: string
  readonly correlationId: string | null
}

/**
 * Derive Watch records from one Watch tool result.
 *
 * One tool call can produce several records — a query that returns evidence
 * and a verification that returns a verdict are different things to select and
 * to deep-link to, even when they arrived together.
 */
export function recordsFromToolResult(
  event: SessionEventLike,
  context: ExtractionContext,
  value: unknown,
): readonly WatchTrajectoryRecord[] {
  const payload = obj(value)
  if (payload === null) return []
  // A refusal is not a Watch record. It is a tool that did not do anything,
  // and DSH's own tool row already shows that it failed.
  if (payload['ok'] === false) return []

  const base = {
    seq: event.seq,
    time: event.time,
    redacted: false,
  }
  const refs: WatchRefs = {
    ...NO_REFS,
    sessionId: context.sessionId,
    turn: context.turn,
    step: context.step,
    callId: context.callId,
    correlationId: context.correlationId,
  }

  const records: WatchTrajectoryRecord[] = []

  const evidence = Array.isArray(payload['evidence']) ? payload['evidence'] : []
  if (evidence.length > 0) {
    const first = obj(evidence[0])
    const range = obj(first?.['temporalRange'])
    records.push({
      ...base,
      recordId: `${context.callId ?? String(event.seq)}:evidence`,
      type: 'evidence.created',
      summary: `${String(evidence.length)} evidence record(s)`,
      refs: {
        ...refs,
        sourceId: str(first?.['sourceRevisionId']),
        sourceRevisionId: str(first?.['sourceRevisionId']),
        evidenceIds: evidence
          .map(entry => str(obj(entry)?.['evidenceId']))
          .filter((entry): entry is string => entry !== null),
        temporalRange: range === null ? null : {
          startMs: Number(range['startMs'] ?? 0),
          endMs: Number(range['endMs'] ?? 0),
        },
      },
    })
  }

  const verdict = str(payload['verdict'])
  if (verdict !== null) {
    records.push({
      ...base,
      recordId: `${context.callId ?? String(event.seq)}:verification`,
      type: 'verification.completed',
      // The verdict itself, verbatim. Never widened, never defaulted.
      summary: verdict,
      refs: {
        ...refs,
        verificationId: str(payload['verificationId']),
        verdict: verdict as Verdict,
        evidenceIds: ids(payload['evidenceRefs']),
      },
    })
  }

  const receiptVerdict = str(payload['verdict'] ?? payload['status'])
  if (str(payload['idempotencyKey']) !== null && verdict === null) {
    records.push({
      ...base,
      recordId: `${context.callId ?? String(event.seq)}:receipt`,
      type: 'browser.action.receipt',
      summary: receiptVerdict ?? 'receipt',
      refs: {
        ...refs,
        receiptId: str(payload['idempotencyKey']),
        verdict: null,
      },
    })
  }

  const sources = Array.isArray(payload['sources']) ? payload['sources'] : []
  if (sources.length > 0) {
    records.push({
      ...base,
      recordId: `${context.callId ?? String(event.seq)}:sources`,
      type: 'source.bound',
      summary: `${String(sources.length)} source(s)`,
      refs: { ...refs, sourceId: str(obj(sources[0])?.['sourceId']) },
    })
  }

  // An answer with no evidence is still an observation worth showing: it says
  // Watch looked and found nothing to cite, which is different from Watch not
  // having been asked.
  if (records.length === 0 && str(payload['answer']) !== null) {
    records.push({
      ...base,
      recordId: `${context.callId ?? String(event.seq)}:observation`,
      type: 'observation.created',
      summary: 'observation with no citations',
      refs,
    })
  }

  return records
}

/**
 * Derive a Watch record from a memory event.
 *
 * Memory is *not* an evidence plane, and these records carry no memory text.
 * What they establish is that memory influenced a turn and which record did
 * it, so a person can follow the id to the Memory surface and correct it
 * there. Sensitive records are marked redacted: the row still appears, because
 * hiding that memory influenced a turn would be worse than showing a withheld
 * one.
 */
export function recordFromMemoryEvent(input: {
  readonly kind: 'injected' | 'corrected' | 'forgotten'
  readonly memoryId: string
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly turn?: number | null
  /** Why this memory was included. Presentation metadata, never the content. */
  readonly reason?: string
  readonly sensitive?: boolean
}): WatchTrajectoryRecord {
  const type: WatchEventType = input.kind === 'injected'
    ? 'memory.context.injected'
    : input.kind === 'corrected'
      ? 'memory.record.corrected'
      : 'memory.record.forgotten'

  const redacted = input.sensitive === true
  return {
    recordId: `mem:${input.memoryId}:${String(input.seq)}`,
    type,
    seq: input.seq,
    time: input.time,
    refs: {
      ...NO_REFS,
      sessionId: input.sessionId,
      turn: input.turn ?? null,
      memoryIds: [input.memoryId],
    },
    summary: redacted
      // Withheld, not omitted. The reason text can quote a preference, and a
      // ledger is somewhere people scroll rather than read carefully.
      ? 'memory used (details withheld)'
      : input.reason ?? type,
    redacted,
  }
}
