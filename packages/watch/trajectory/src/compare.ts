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
import { toDeepLink } from './selection.js'

/** What is being compared. */
export type CompareSubject =
  /** Two runs of the same task. */
  | 'run'
  /** Two revisions of the same source. */
  | 'source_revision'
  /** Two time ranges, in the same source or in two. */
  | 'temporal_region'
  /**
   * The same thing before and after a change was made.
   *
   * Named separately from `temporal_region` because it carries an
   * expectation: somebody did something in between, and the question is
   * whether the difference is the one they intended. Compare still issues no
   * verdict — that remains a verification contract — but the surface reads
   * differently when it knows a change was deliberate.
   */
  | 'before_after'

/** Every subject, for enumerating the picker. */
export const COMPARE_SUBJECTS: readonly CompareSubject[] = [
  'run', 'source_revision', 'temporal_region', 'before_after',
]

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

/**
 * The minimum of an evidence record Compare needs to place it on a channel.
 *
 * A structural subset rather than an import of `EvidenceRecord`: the
 * trajectory package holds no evidence payloads, and taking the full type here
 * would invite one to be stored.
 */
export interface ChannelHint {
  readonly modality: 'visual' | 'text' | 'audio' | 'dom' | 'network' | 'filesystem'
}

/** Evidence ids to what sense produced them, when the caller has resolved any. */
export type ChannelHints = ReadonlyMap<string, ChannelHint>

/** The channel one evidence modality belongs to. */
function channelForModality(modality: ChannelHint['modality']): DivergenceChannel {
  switch (modality) {
    case 'visual':
      return 'visual'
    case 'audio':
      return 'transcript'
    case 'text':
      return 'ocr'
    case 'dom':
      return 'dom'
    case 'network':
      return 'network'
    case 'filesystem':
      return 'text'
  }
}

/**
 * Which channel a record's evidence belongs to.
 *
 * Verdicts and receipts are decided by the record type, because that is what
 * they are. Everything else needs the evidence, and when the caller has not
 * resolved it the answer is `text` rather than a guess — filing an unresolved
 * record under `visual` because most evidence is visual is how a transcript
 * divergence ends up reported as a picture changing.
 */
function channelFor(record: WatchTrajectoryRecord, hints: ChannelHints): DivergenceChannel {
  switch (record.type) {
    case 'verification.completed':
    case 'verification.requested':
      return 'verification'
    case 'browser.action.receipt':
    case 'browser.action.dispatched':
      return 'receipt'
    default: {
      for (const evidenceId of record.refs.evidenceIds) {
        const hint = hints.get(evidenceId)
        if (hint !== undefined) return channelForModality(hint.modality)
      }
      return 'text'
    }
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
function alignmentKey(record: WatchTrajectoryRecord, hints: ChannelHints): string {
  const at = record.refs.temporalRange?.startMs ?? null
  return `${channelFor(record, hints)}:${at === null ? 'untimed' : String(at)}`
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
  hints: ChannelHints = new Map(),
): Comparison {
  const leftByKey = new Map<string, WatchTrajectoryRecord>()
  const rightByKey = new Map<string, WatchTrajectoryRecord>()
  for (const record of left.records) leftByKey.set(alignmentKey(record, hints), record)
  for (const record of right.records) rightByKey.set(alignmentKey(record, hints), record)

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
        channel: channelFor(leftRecord, hints),
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
      channel: channelFor(present, hints),
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

/**
 * The first divergence that changed what was *established*.
 *
 * Distinct from `firstDivergence`, and the distinction is the useful one. The
 * earliest difference between two runs is frequently a timestamp or an extra
 * frame; the earliest difference in a verdict or a receipt is the moment the
 * two runs stopped being the same outcome. A surface that offered only the
 * first would send people to the wrong second.
 */
export function firstMeaningfulDivergence(comparison: Comparison): Divergence | null {
  return comparison.divergences.find(
    divergence => divergence.channel === 'verification' || divergence.channel === 'receipt',
  ) ?? comparison.firstDivergence
}

/**
 * A deep link to one side of a divergence.
 *
 * Built from the same selection model everything else in the product uses, so
 * a link out of Compare opens the same inspector a link out of Trajectory
 * would. Returns null when the side has nothing to point at, rather than a
 * link that resolves to an empty panel.
 */
export function divergenceLink(
  comparison: Comparison,
  divergence: Divergence,
  side: 'left' | 'right',
  context: { readonly workspaceId: string; readonly sessionId: string },
): string | null {
  const recordId = side === 'left' ? divergence.leftRecordId : divergence.rightRecordId
  const evidenceId = side === 'left' ? divergence.leftEvidenceId : divergence.rightEvidenceId
  if (recordId === null && evidenceId === null) return null

  return toDeepLink({
    workspaceId: context.workspaceId,
    sessionId: side === 'left' ? comparison.leftId : comparison.rightId,
    recordId,
    evidenceId,
    sourceId: null,
    sourceRevisionId: null,
    verificationId: null,
    receiptId: null,
    memoryId: null,
    atMs: divergence.atMs,
    endMs: null,
    inspectorTab: divergence.channel === 'verification' ? 'verification' : 'evidence',
    origin: 'compare',
  })
}

/**
 * A portable comparison.
 *
 * Identifiers, kinds and links — never evidence content, for the same reason
 * `Divergence` carries none. An exported bundle that inlined what it compared
 * would be a second copy of the evidence, and a second copy is one nobody can
 * invalidate.
 */
export interface ComparisonBundle {
  readonly digest: string
  readonly subject: CompareSubject
  readonly leftId: string
  readonly rightId: string
  readonly agreements: number
  readonly divergences: readonly Divergence[]
  readonly firstDivergence: Divergence | null
  readonly firstMeaningfulDivergence: Divergence | null
  readonly links: readonly { readonly side: 'left' | 'right'; readonly link: string }[]
}

/** Freeze a comparison into something that can be attached to a report. */
export function exportComparison(
  comparison: Comparison,
  context: { readonly workspaceId: string; readonly sessionId: string },
): ComparisonBundle {
  const meaningful = firstMeaningfulDivergence(comparison)
  const links: { side: 'left' | 'right'; link: string }[] = []
  if (meaningful !== null) {
    for (const side of ['left', 'right'] as const) {
      const link = divergenceLink(comparison, meaningful, side, context)
      if (link !== null) links.push({ side, link })
    }
  }
  return {
    digest: comparisonDigest(comparison),
    subject: comparison.subject,
    leftId: comparison.leftId,
    rightId: comparison.rightId,
    agreements: comparison.agreements,
    divergences: comparison.divergences,
    firstDivergence: comparison.firstDivergence,
    firstMeaningfulDivergence: meaningful,
    links,
  }
}

/**
 * One line summarizing a comparison.
 *
 * Deliberately never says "passed" or "failed". Compare reports where two
 * things stopped agreeing; whether that was the change somebody asked for is a
 * verification contract, and a summary that editorialized would be Compare
 * issuing the verdict it is not allowed to issue.
 */
export function describeComparison(comparison: Comparison): string {
  if (comparison.divergences.length === 0) {
    return `No divergence across ${String(comparison.agreements)} aligned record(s).`
  }
  const meaningful = firstMeaningfulDivergence(comparison)
  const where = meaningful?.atMs === null || meaningful === null
    ? 'at an untimed record'
    : `at ${String(meaningful.atMs)}ms`
  return `${String(comparison.divergences.length)} divergence(s), `
    + `${String(comparison.agreements)} agreement(s). `
    + `First meaningful: ${meaningful?.channel ?? 'none'} ${where}.`
}
