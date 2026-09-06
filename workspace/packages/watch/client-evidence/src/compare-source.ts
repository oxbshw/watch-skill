/**
 * Where Compare's two sides come from.
 *
 * The engine next door is pure and has always been correct. What was missing is
 * the half that matters to a person: the mode was registered with no records at
 * all, so Compare rendered its empty state in the shipped product and there was
 * no path from a real verification to the surface that compares two of them.
 *
 * This is that path, and it is deliberately a **translation and nothing else**.
 * Every field is copied from a Library record that Watch Core minted; none is
 * derived, upgraded, defaulted or inferred. In particular:
 *
 *   - `verdict` is copied verbatim, including `null`. A record Core left
 *     without a verdict stays without one, and the engine reports it as
 *     unverifiable rather than as agreement. ADR-002 is not a rule this file
 *     obeys carefully; it is a rule this file has no way to break, because
 *     there is no expression here that produces a verdict value.
 *   - `INCONCLUSIVE`, `PARTIAL` and any state Core introduces later travel
 *     through untouched. Nothing here enumerates the verdicts it accepts, so
 *     nothing here can quietly drop one it does not recognise.
 *   - A superseded record keeps saying so. `current: false` becomes a stale
 *     marker on the label rather than a silently equal-looking row, because two
 *     records that disagree only in age is exactly the comparison somebody is
 *     trying to make.
 *
 * @module @deepwatch/dsh-client-evidence/compare-source
 */

import type { ComparableRecord } from './compare-engine.js'

/** The half of a Library record this translation reads. */
export interface SourceRecord {
  readonly recordId: string
  readonly revisionId: string
  readonly title: string
  readonly modality: string
  readonly observedAt: string | null
  readonly source: string
  readonly runId: string | null
  /** Core's verdict, when Core minted one. Copied, never invented. */
  readonly verdict: string | null
  readonly tags: readonly string[]
  readonly evidenceIds: readonly string[]
  /** False when a newer revision of the same source exists. */
  readonly current: boolean
}

/** How a record is labelled in the picker, and why. */
export function labelFor(record: SourceRecord): string {
  const when = record.observedAt === null ? 'time unknown' : record.observedAt
  const stale = record.current ? '' : ' · superseded'
  return `${record.title} — ${when}${stale}`
}

/**
 * A record's identity for comparison purposes.
 *
 * The revision, not the record. Two verifications of the same subject are two
 * revisions of one record, and comparing "a record with itself" is precisely
 * the comparison Compare exists to make — so the side identity has to be the
 * revision or both sides collapse into one.
 *
 * Runs minted in the same millisecond are distinguished by Core, which numbers
 * its evaluations rather than timestamping them alone; this preserves that
 * distinction instead of re-deriving one from the clock.
 */
export function sideIdOf(record: SourceRecord): string {
  return record.revisionId === '' ? record.recordId : record.revisionId
}

/**
 * Translate one Library record into a comparable side.
 *
 * The single claim is the record's own assertion — its title, carrying its own
 * verdict and its own evidence. A verification with per-check detail is a
 * richer shape than the Library index holds, and inventing sub-claims here to
 * make the diff look thorough would be inventing the very thing the surface is
 * supposed to be quoting.
 */
export function toComparable(record: SourceRecord): ComparableRecord {
  return {
    recordId: sideIdOf(record),
    kind: record.verdict === null ? 'evidence' : 'verification',
    label: labelFor(record),
    at: record.observedAt,
    output: '',
    claims: [{
      claimId: record.recordId,
      text: record.title,
      verdict: record.verdict,
      provenance: record.source,
      evidenceIds: record.evidenceIds,
    }],
  }
}

/**
 * The records worth offering, newest first.
 *
 * Verifications first because they are what Compare is for, but evidence is
 * kept rather than filtered away: a verification against a record Core never
 * ruled on is a real comparison, and hiding the unruled side would leave the
 * reader comparing a verdict with nothing and seeing agreement.
 *
 * Ordering is by observation time, and ties are broken by identity so the list
 * is stable — two records minted in the same millisecond must not swap places
 * between renders, or the picker's two selections silently mean different
 * things on the next paint.
 */
export function comparableRecords(
  records: readonly SourceRecord[],
): readonly ComparableRecord[] {
  const ranked = [...records].sort((left, right) => {
    const byVerdict = Number(right.verdict !== null) - Number(left.verdict !== null)
    if (byVerdict !== 0) return byVerdict
    const leftAt = left.observedAt ?? ''
    const rightAt = right.observedAt ?? ''
    if (leftAt !== rightAt) return rightAt.localeCompare(leftAt)
    return sideIdOf(left).localeCompare(sideIdOf(right))
  })
  // Two entries with one identity would make the picker ambiguous, and the
  // engine refuses to compare a record with itself for good reasons.
  const seen = new Set<string>()
  const unique: ComparableRecord[] = []
  for (const record of ranked) {
    const id = sideIdOf(record)
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(toComparable(record))
  }
  return unique
}
