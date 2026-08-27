/**
 * Comparing two observations of the same thing.
 *
 * The question Compare answers is narrower than "what changed", and much more
 * useful: **where did these first stop agreeing?** A diff of two long runs
 * produces hundreds of differences, most of them consequences of the first
 * one, and a person reading it has to work backwards to find the moment that
 * mattered. So the first divergence is a first-class result rather than
 * something to scroll for.
 *
 * Two rules carry over from the rest of the product.
 *
 * **A difference is not a failure.** Most changes between two runs are the
 * change somebody asked for. Compare surfaces divergences; deciding whether
 * one was expected is a verification contract, and Compare never issues a
 * verdict of its own.
 *
 * **Comparison is over identifiers, not content.** Two evidence records are
 * compared by revision, range and digest. Compare holds no evidence payloads,
 * so it cannot become a second place where evidence lives.
 *
 * @module @watchskill/dsh-trajectory/compare
 */

import type { WatchTrajectoryRecord } from './events.js'
import type { WatchProjection } from './projection.js'

/** What is being compared. */
export type CompareSubject = 'run' | 'source_revision' | 'temporal_region'

/** Which signal a divergence was found in. */
export type DivergenceChannel =
  | 'visual'
  | 'text'
  | 'ocr'
  | 'transcript'
  | 'dom'
  | 'network'
  | 'console'
  | 'verification'
  | 'receipt'

/** How the two sides differ. */
export type DivergenceKind =
  /** Present on the left, absent on the right. */
  | 'removed'
  /** Absent on the left, present on the right. */
  | 'added'
  /** Present on both, different. */
  | 'changed'
  /** Present on both, and the difference is only in timing. */
  | 'retimed'

/** One place two sides stopped agreeing. */
export interface Divergence {
  readonly channel: DivergenceChannel
  readonly kind: DivergenceKind
  /** Where in the source, so the player can go there. */
  readonly atMs: number | null
  /** The record on each side, by id. Never the content. */
  readonly leftRecordId: string | null
  readonly rightRecordId: string | null
  readonly leftEvidenceId: string | null
  readonly rightEvidenceId: string | null
  /** One line for a list. Presentation only; nothing resolves from it. */
  readonly summary: string
}

/** The result of comparing two sides. */
export interface Comparison {
  readonly subject: CompareSubject
  readonly leftId: string
  readonly rightId: string
  readonly divergences: readonly Divergence[]
  /**
   * The earliest divergence, or null when the two agree.
   *
   * The answer people actually want. Everything after the first divergence is
   * usually a consequence of it, and presenting a hundred differences equally
   * makes the one that mattered harder to find, not easier.
   */
  readonly firstDivergence: Divergence | null
  /** Records present on both sides and identical. */
  readonly agreements: number
}

/** Which channel a record's evidence belongs to. */
function channelFor(record: WatchTrajectoryRecord): DivergenceChannel {
  switch (record.type) {
    case 'verification.completed':
    case 'verification.requested':
      return 'verification'
    case 'browser.action.receipt':
    case 'browser.action.dispatched':
      return 'receipt'
    case 'evidence.created':
    case 'observation.created':
      return 'text'
    default:
      return 'text'
  }
}

/**
 * A key identifying "the same thing" across two sides.
 *
 * Deliberately not the record id: two runs produce different ids for the same
 * step, and comparing by id would report every record as both added and
 * removed. What makes two records comparable is what they are *about* — the
 * channel and the moment.
 */
function alignmentKey(record: WatchTrajectoryRecord): string {
  const at = record.refs.temporalRange?.startMs ?? null
  return `${channelFor(record)}:${at === null ? 'untimed' : String(at)}`
}

/** Whether two aligned records actually agree. */
function agrees(left: WatchTrajectoryRecord, right: WatchTrajectoryRecord): boolean {
  // Compared by identifier, never by content: the evidence itself lives at
  // Watch Core, and a comparison that read payloads would need a copy of them.
  return left.refs.sourceRevisionId === right.refs.sourceRevisionId
    && left.refs.evidenceIds.join(',') === right.refs.evidenceIds.join(',')
    && left.refs.verdict === right.refs.verdict
    && left.refs.receiptId === right.refs.receiptId
}

/** Describe how two aligned records differ. */
function describeChange(
  left: WatchTrajectoryRecord,
  right: WatchTrajectoryRecord,
): { readonly kind: DivergenceKind; readonly summary: string } {
  if (left.refs.verdict !== right.refs.verdict) {
    // The most important difference there is: the same step reached a
    // different conclusion. Named explicitly rather than folded into "changed".
    return {
      kind: 'changed',
      summary: `verdict ${left.refs.verdict ?? 'none'} → ${right.refs.verdict ?? 'none'}`,
    }
  }
  if (left.refs.sourceRevisionId !== right.refs.sourceRevisionId) {
    return { kind: 'changed', summary: 'a different source revision' }
  }
  if (left.refs.evidenceIds.join(',') !== right.refs.evidenceIds.join(',')) {
    return {
      kind: 'changed',
      summary: `${String(left.refs.evidenceIds.length)} → ${String(right.refs.evidenceIds.length)} evidence record(s)`,
    }
  }
  return { kind: 'changed', summary: 'differs' }
}

/**
 * Compare two projections.
 *
 * Pure, and deterministic for the same inputs — which is what lets a
 * comparison be deep-linked and replayed like anything else in the product.
 *
 * @param subject - what the two sides are: two runs, two revisions, two regions.
 */
export function compareProjections(
  left: WatchProjection,
  right: WatchProjection,
  subject: CompareSubject,
  ids: { readonly leftId: string; readonly rightId: string },
): Comparison {
  const leftByKey = new Map<string, WatchTrajectoryRecord>()
  const rightByKey = new Map<string, WatchTrajectoryRecord>()
  for (const record of left.records) leftByKey.set(alignmentKey(record), record)
  for (const record of right.records) rightByKey.set(alignmentKey(record), record)

  const divergences: Divergence[] = []
  let agreements = 0

  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort()
  for (const key of keys) {
    const leftRecord = leftByKey.get(key)
    const rightRecord = rightByKey.get(key)

    if (leftRecord !== undefined && rightRecord !== undefined) {
      if (agrees(leftRecord, rightRecord)) {
        agreements += 1
        continue
      }
      const change = describeChange(leftRecord, rightRecord)
      divergences.push({
        channel: channelFor(leftRecord),
        kind: change.kind,
        atMs: leftRecord.refs.temporalRange?.startMs ?? null,
        leftRecordId: leftRecord.recordId,
        rightRecordId: rightRecord.recordId,
        leftEvidenceId: leftRecord.refs.evidenceIds[0] ?? null,
        rightEvidenceId: rightRecord.refs.evidenceIds[0] ?? null,
        summary: change.summary,
      })
      continue
    }

    const present = leftRecord ?? rightRecord
    if (present === undefined) continue
    const removed = rightRecord === undefined
    divergences.push({
      channel: channelFor(present),
      kind: removed ? 'removed' : 'added',
      atMs: present.refs.temporalRange?.startMs ?? null,
      leftRecordId: removed ? present.recordId : null,
      rightRecordId: removed ? null : present.recordId,
      leftEvidenceId: removed ? present.refs.evidenceIds[0] ?? null : null,
      rightEvidenceId: removed ? null : present.refs.evidenceIds[0] ?? null,
      summary: removed ? 'only in the first' : 'only in the second',
    })
  }

  // Ordered by when they happened, so "first" means first in the source rather
  // than first in an arbitrary map iteration. Untimed divergences sort last:
  // they cannot be placed on a timeline, and putting them first would hide a
  // real early divergence behind them.
  const ordered = [...divergences].sort((a, b) => {
    if (a.atMs === b.atMs) return a.channel.localeCompare(b.channel)
    if (a.atMs === null) return 1
    if (b.atMs === null) return -1
    return a.atMs - b.atMs
  })

  return {
    subject,
    leftId: ids.leftId,
    rightId: ids.rightId,
    divergences: ordered,
    firstDivergence: ordered[0] ?? null,
    agreements,
  }
}

/**
 * Whether a comparison found a change in what was *established*.
 *
 * Separate from "found any difference" on purpose. Two runs producing
 * different evidence at a different moment is normal; two runs reaching
 * different verdicts is the thing somebody needs to look at.
 */
export function hasVerdictDivergence(comparison: Comparison): boolean {
  return comparison.divergences.some(divergence => divergence.channel === 'verification')
}

/**
 * A stable digest of a comparison.
 *
 * Same inputs, same digest — so a comparison can be deep-linked, replayed and
 * checked for change the same way a projection can. Over identifiers and kinds
 * only, never over the summary text.
 */
export function comparisonDigest(comparison: Comparison): string {
  const canonical = [
    comparison.subject,
    comparison.leftId,
    comparison.rightId,
    String(comparison.agreements),
    ...comparison.divergences.map(divergence => [
      divergence.channel,
      divergence.kind,
      divergence.atMs === null ? '' : String(divergence.atMs),
      divergence.leftRecordId ?? '',
      divergence.rightRecordId ?? '',
    ].join('|')),
  ].join('\n')

  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const byte of new TextEncoder().encode(canonical)) {
    hash = ((hash ^ BigInt(byte)) * prime) & mask
  }
  return `fnv1a64:${hash.toString(16).padStart(16, '0')}`
}
