/**
 * The sensory timeline: one more projection, never a second record.
 *
 * The bottom of the workspace shows what was seen, heard, read, done and
 * decided, laid out on one clock. It is tempting to build that as its own
 * store — capture events as they stream, keep them in a ring buffer, render
 * from there. That is exactly the mistake this module refuses to make. A
 * second store means two answers to "what happened", and the moment they
 * disagree the receipt stops being worth anything.
 *
 * So the timeline is a pure fold over state that already exists: DSH's session
 * events and the Watch projection built from them, plus resolved evidence when
 * the caller has it. Nothing here reads a clock, fetches anything, or invents
 * an entry. Two things follow, and both are tested:
 *
 * - **A gap stays a gap.** Evidence that reports missing capture produces a
 *   `gap` entry with its own range. It is never interpolated, never smoothed,
 *   and never omitted because it looks untidy next to entries around it.
 * - **Density hides, it does not decide.** `collapsed` shows less than
 *   `analysis`, but verdicts, actions and errors survive every density. A
 *   timeline that could hide a FAILED at low density would be a timeline whose
 *   default setting makes the product look better than it is.
 *
 * Memory events are deliberately absent. The timeline is *sensory*: it answers
 * what was perceived. What the agent remembered is a Trajectory row and a
 * Memory surface, and putting it in a perception lane would blur the one
 * distinction ADR-006 exists to keep.
 *
 * @module @deepwatch/dsh-workspace/timeline
 */

import type { EvidenceRecord, TemporalRange, Verdict } from '@deepwatch/dsh-contracts'
import type {
  SessionEventLike,
  WatchProjection,
  WatchTrajectoryRecord,
} from '@deepwatch/dsh-trajectory'

/** The lanes the timeline lays out, top to bottom. */
export type TimelineLane =
  | 'media'
  | 'speech'
  | 'ocr'
  | 'actions'
  | 'tools'
  | 'network'
  | 'errors'
  | 'verdicts'

/** Every lane, in presentation order. */
export const TIMELINE_LANES: readonly TimelineLane[] = [
  'media', 'speech', 'ocr', 'actions', 'tools', 'network', 'errors', 'verdicts',
]

/** How much of the timeline is on screen. */
export type TimelineDensity = 'collapsed' | 'compact' | 'analysis'

/**
 * Which lanes each density renders.
 *
 * The three sets are nested on purpose — increasing density only ever adds. A
 * density that swapped one lane for another would make "I did not see it"
 * depend on a setting rather than on the record.
 */
export const DENSITY_LANES: Readonly<Record<TimelineDensity, readonly TimelineLane[]>> = {
  collapsed: ['verdicts', 'actions', 'errors'],
  compact: ['verdicts', 'actions', 'errors', 'media', 'speech', 'ocr'],
  analysis: TIMELINE_LANES,
}

/**
 * Lanes that no density may hide.
 *
 * Stated separately from the table above so the invariant is checkable
 * directly rather than inferred from three lists staying in sync.
 */
export const ALWAYS_VISIBLE_LANES: readonly TimelineLane[] = ['verdicts', 'actions', 'errors']

/** What kind of thing an entry is, which decides how it draws. */
export type TimelineKind = 'point' | 'span' | 'gap'

/** One thing that happened, on one lane. */
export interface TimelineEntry {
  /** Stable across rebuilds of the same input; what a deep link points at. */
  readonly entryId: string
  readonly lane: TimelineLane
  readonly kind: TimelineKind
  /** DSH log sequence. The only ordering authority — never wall clock. */
  readonly seq: number
  /** Wall clock, epoch milliseconds, for the header ruler. */
  readonly time: number
  /** Position on the source's own clock, when the entry has one. */
  readonly range: TemporalRange | null
  /** One line. Presentation only; nothing resolves from it. */
  readonly label: string
  /** The Trajectory record this came from, when it came from one. */
  readonly recordId: string | null
  readonly evidenceId: string | null
  readonly verdict: Verdict | null
  /**
   * Where the lane assignment came from.
   *
   * `evidence` means a resolved EvidenceRecord's modality decided it.
   * `record` means only the record type was known. The field exists so the UI
   * can avoid implying a precision it does not have, and so a test can assert
   * that an unresolved evidence record is never filed under a sensory lane it
   * was merely assumed to belong to.
   */
  readonly laneSource: 'evidence' | 'record' | 'event'
}

/** A built timeline: entries, and the lanes actually populated. */
export interface Timeline {
  readonly sessionId: string
  readonly density: TimelineDensity
  readonly entries: readonly TimelineEntry[]
  /** Lanes with at least one entry, in presentation order. */
  readonly populated: readonly TimelineLane[]
  /**
   * How many entries the density is hiding.
   *
   * Shown in the collapsed control. A timeline that hid things silently would
   * make its own default setting a way to miss something.
   */
  readonly hidden: number
}

/** What the builder reads. All of it already exists elsewhere. */
export interface TimelineInput {
  readonly sessionId: string
  /** The same events the projection was folded from. */
  readonly events: readonly SessionEventLike[]
  readonly projection: WatchProjection
  /** Resolved evidence, when the caller has fetched it. Optional by design. */
  readonly evidence?: ReadonlyMap<string, EvidenceRecord>
}

/** The lane an evidence modality belongs on. */
function laneForModality(modality: EvidenceRecord['modality']): TimelineLane {
  switch (modality) {
    case 'visual':
      return 'media'
    case 'audio':
      return 'speech'
    case 'text':
      return 'ocr'
    case 'dom':
      return 'ocr'
    case 'network':
      return 'network'
    case 'filesystem':
      return 'tools'
  }
}

/** The lane a Watch record belongs on when no evidence has been resolved. */
function laneForRecord(type: WatchTrajectoryRecord['type']): TimelineLane | null {
  switch (type) {
    case 'verification.requested':
    case 'verification.completed':
      return 'verdicts'
    case 'browser.action.dispatched':
    case 'browser.action.receipt':
      return 'actions'
    case 'source.bound':
      return 'media'
    case 'observation.created':
    case 'evidence.created':
      // Deliberately unplaced. Which sense produced it is a property of the
      // evidence, and guessing "probably visual" is how a transcript ends up
      // drawn on the video lane.
      return 'tools'
    case 'memory.context.injected':
    case 'memory.record.corrected':
    case 'memory.record.forgotten':
      // Not perception. See the module note.
      return null
  }
}

/** Whether an event is a tool call worth a `tools` lane entry. */
function isToolCall(event: SessionEventLike): boolean {
  return event.type === 'tool/call'
}

/** Whether an event settled as an error. */
function isErrorResult(event: SessionEventLike): boolean {
  if (event.type === 'error') return true
  if (event.type !== 'tool/result') return false
  const message = event.data['message'] as Record<string, unknown> | undefined
  return message?.['isError'] === true || event.data['isError'] === true
}

/** Read a string field, or null. */
function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Build the timeline.
 *
 * Deterministic: the same input produces the same entries in the same order,
 * including entry ids. Ordering is by DSH sequence and then by lane, so two
 * things logged at the same sequence never swap places between renders.
 */
export function buildTimeline(input: TimelineInput, density: TimelineDensity): Timeline {
  const all: TimelineEntry[] = []
  const evidence = input.evidence ?? new Map<string, EvidenceRecord>()

  for (const record of input.projection.records) {
    // Evidence records fan out: one entry per evidence id, on the lane its
    // modality names. This is the only place the timeline is finer-grained
    // than Trajectory, and it is finer because the evidence says so.
    if (record.refs.evidenceIds.length > 0 && record.type === 'evidence.created') {
      let index = 0
      for (const evidenceId of record.refs.evidenceIds) {
        const resolved = evidence.get(evidenceId)
        const lane = resolved === undefined ? 'tools' : laneForModality(resolved.modality)
        all.push({
          entryId: `${record.recordId}#${String(index)}`,
          lane,
          kind: resolved?.temporalRange == null ? 'point' : 'span',
          seq: record.seq,
          time: record.time,
          range: resolved?.temporalRange ?? record.refs.temporalRange,
          label: resolved === undefined
            ? `evidence ${evidenceId}`
            : `${resolved.modality} · ${resolved.producer}`,
          recordId: record.recordId,
          evidenceId,
          verdict: null,
          laneSource: resolved === undefined ? 'record' : 'evidence',
        })
        index += 1

        // Gaps are their own entries. A gap inside an evidence record is a
        // statement that capture stopped, and it has to be as visible as the
        // capture around it.
        if (resolved === undefined) continue
        let gapIndex = 0
        for (const gap of resolved.gaps) {
          all.push({
            entryId: `${record.recordId}#${evidenceId}:gap${String(gapIndex)}`,
            lane,
            kind: 'gap',
            seq: record.seq,
            time: record.time,
            range: gap,
            label: `capture gap ${String(gap.endMs - gap.startMs)}ms`,
            recordId: record.recordId,
            evidenceId,
            verdict: null,
            laneSource: 'evidence',
          })
          gapIndex += 1
        }
        if (resolved.gaps.length === 0 && resolved.freshness === 'gap') {
          all.push({
            entryId: `${record.recordId}#${evidenceId}:gap`,
            lane,
            kind: 'gap',
            seq: record.seq,
            time: record.time,
            range: resolved.temporalRange,
            label: 'capture gap',
            recordId: record.recordId,
            evidenceId,
            verdict: null,
            laneSource: 'evidence',
          })
        }
      }
      continue
    }

    const lane = laneForRecord(record.type)
    if (lane === null) continue
    all.push({
      entryId: record.recordId,
      lane,
      kind: record.refs.temporalRange === null ? 'point' : 'span',
      seq: record.seq,
      time: record.time,
      range: record.refs.temporalRange,
      label: record.summary,
      recordId: record.recordId,
      evidenceId: record.refs.evidenceIds[0] ?? null,
      verdict: record.refs.verdict,
      laneSource: 'record',
    })
  }

  // Tools and errors come straight off the session log, because they are not
  // Watch's to record: DSH already logged every tool call and every failure,
  // and re-deriving them from Watch records would show only Watch's half.
  for (const event of input.events) {
    if (isErrorResult(event)) {
      all.push({
        entryId: `event:${String(event.seq)}:error`,
        lane: 'errors',
        kind: 'point',
        seq: event.seq,
        time: event.time,
        range: null,
        label: str(event.data['name']) ?? str(event.data['message']) ?? 'error',
        recordId: null,
        evidenceId: null,
        verdict: null,
        laneSource: 'event',
      })
      continue
    }
    if (!isToolCall(event)) continue
    all.push({
      entryId: `event:${String(event.seq)}:tool`,
      lane: 'tools',
      kind: 'point',
      seq: event.seq,
      time: event.time,
      range: null,
      label: str(event.data['name']) ?? 'tool',
      recordId: null,
      evidenceId: null,
      verdict: null,
      laneSource: 'event',
    })
  }

  const laneOrder = new Map(TIMELINE_LANES.map((lane, index) => [lane, index]))
  all.sort((left, right) => {
    if (left.seq !== right.seq) return left.seq - right.seq
    const byLane = (laneOrder.get(left.lane) ?? 0) - (laneOrder.get(right.lane) ?? 0)
    if (byLane !== 0) return byLane
    return left.entryId.localeCompare(right.entryId)
  })

  const visible = new Set(DENSITY_LANES[density])
  const entries = all.filter(entry => visible.has(entry.lane))
  const populated = TIMELINE_LANES.filter(lane => entries.some(entry => entry.lane === lane))

  return {
    sessionId: input.sessionId,
    density,
    entries,
    populated,
    hidden: all.length - entries.length,
  }
}

/**
 * Digest of a built timeline.
 *
 * The same input must produce the same timeline, and this is how that is
 * asserted rather than assumed — the same reason `projectionHash` exists next
 * door. Implemented as FNV-1a over the entry identities, which is enough to
 * catch a reordering or a changed field and cheap enough to run in a render.
 */
export function timelineDigest(timeline: Timeline): string {
  let hash = 0x811c9dc5
  const feed = (text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  feed(timeline.sessionId)
  for (const entry of timeline.entries) {
    feed(`|${entry.entryId}|${entry.lane}|${entry.kind}|${String(entry.seq)}|${entry.verdict ?? ''}`)
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Whether a timeline contains a gap the density is hiding.
 *
 * Used by the collapsed control to say "3 hidden, including a capture gap"
 * rather than "3 hidden". The count alone is not enough: a hidden gap is the
 * one thing whose absence changes what the timeline appears to prove.
 */
export function hasHiddenGap(input: TimelineInput, density: TimelineDensity): boolean {
  const full = buildTimeline(input, 'analysis')
  const shown = new Set(buildTimeline(input, density).entries.map(entry => entry.entryId))
  return full.entries.some(entry => entry.kind === 'gap' && !shown.has(entry.entryId))
}
