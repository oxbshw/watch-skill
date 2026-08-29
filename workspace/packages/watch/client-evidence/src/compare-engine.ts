/**
 * The comparison engine.
 *
 * Deterministic, typed, and entirely separate from both the UI and any model.
 * The same two records always produce the same comparison, byte for byte, on
 * any machine — which is what makes a difference something you can cite rather
 * than something you were told.
 *
 * A model may one day *explain* a comparison. It may never compute one. An
 * explanation that changes between runs is a nuisance; a diff that changes
 * between runs is a lie about what happened.
 *
 * The engine's one structural opinion is that **output differences and
 * verification differences are different kinds of fact**, and it keeps them in
 * separate lists rather than one merged timeline. An agent producing different
 * text is ordinary. The same claim going from VERIFIED to FAILED is not, and a
 * surface that blends them invites the reader to treat a changed answer as a
 * changed truth.
 *
 * @module @watchskill/dsh-client-evidence/compare-engine
 */

/** What kind of thing is being compared. Mixing kinds is refused. */
export type ComparableKind = 'run' | 'verification' | 'evidence' | 'receipt' | 'artifact'

/** One claim a record makes, with where it came from. */
export interface ComparableClaim {
  readonly claimId: string
  /** What is asserted, verbatim. */
  readonly text: string
  /** The verification state of this claim, when it has one. */
  readonly verdict: string | null
  /** Where this claim came from — a source, a tool, a check. */
  readonly provenance: string
  /** Evidence backing it. */
  readonly evidenceIds: readonly string[]
}

/** One side of a comparison. */
export interface ComparableRecord {
  readonly recordId: string
  readonly kind: ComparableKind
  readonly label: string
  readonly at: string | null
  /** Free-form output the agent produced, when there is any. */
  readonly output: string
  readonly claims: readonly ComparableClaim[]
}

/** How a single claim differs between the two sides. */
export type ClaimDisposition =
  /** Present on both sides, same text, same verdict. */
  | 'matching'
  /** Present on both, but the text changed. */
  | 'changed'
  /** Present on both, same text, but the verdict changed. */
  | 'verdict_changed'
  /** On the left only. */
  | 'missing_right'
  /** On the right only. */
  | 'missing_left'
  /** Present on both and the verdicts disagree in a way that cannot both hold. */
  | 'contradictory'
  /** Present on both, but neither side was checked, so nothing can be said. */
  | 'unverifiable'

/** One line of the comparison, with both sides and where each came from. */
export interface ClaimDifference {
  readonly claimId: string
  readonly disposition: ClaimDisposition
  readonly left: ComparableClaim | null
  readonly right: ComparableClaim | null
  /** Why this disposition, in words a person can check. */
  readonly because: string
}

/** How the free-form outputs differ, kept apart from the claims. */
export interface OutputDifference {
  readonly identical: boolean
  /** The first line number where they diverge, 1-based. Null when identical. */
  readonly firstDivergenceLine: number | null
  readonly leftLines: number
  readonly rightLines: number
}

/** Why a comparison could not be made. */
export type IncompatibilityReason =
  | 'different_kinds'
  | 'left_missing'
  | 'right_missing'
  | 'same_record'

/** The comparison. A typed contract, not a rendering. */
export interface Comparison {
  readonly comparable: boolean
  readonly reason: IncompatibilityReason | null
  readonly left: ComparableRecord | null
  readonly right: ComparableRecord | null
  /** Verification differences. The ones that change what is true. */
  readonly claims: readonly ClaimDifference[]
  /** Output differences. The ones that change what was said. */
  readonly output: OutputDifference | null
  readonly summary: {
    readonly matching: number
    readonly changed: number
    readonly verdictChanged: number
    readonly missing: number
    readonly contradictory: number
    readonly unverifiable: number
  }
}

/** Verdicts that cannot both be true of the same claim. */
const OPPOSED = new Set(['VERIFIED|FAILED', 'FAILED|VERIFIED'])

/** Verdicts that assert nothing either way. */
const UNSETTLED = new Set([null, '', 'UNVERIFIED', 'INCONCLUSIVE'])

function disposeOf(left: ComparableClaim, right: ComparableClaim): { readonly disposition: ClaimDisposition, readonly because: string } {
  const sameText = left.text === right.text
  const sameVerdict = left.verdict === right.verdict

  if (OPPOSED.has(`${String(left.verdict)}|${String(right.verdict)}`)) {
    return {
      disposition: 'contradictory',
      because: `One side verified this and the other failed it. Both cannot hold.`,
    }
  }
  if (sameText && sameVerdict) {
    if (UNSETTLED.has(left.verdict)) {
      return {
        disposition: 'unverifiable',
        because: 'Identical on both sides, and neither side was checked — so this comparison says nothing about whether it is true.',
      }
    }
    return { disposition: 'matching', because: 'Same text, same verdict.' }
  }
  if (sameText && !sameVerdict) {
    return {
      disposition: 'verdict_changed',
      because: `The claim is unchanged but its verification went from ${left.verdict ?? 'unchecked'} to ${right.verdict ?? 'unchecked'}.`,
    }
  }
  return { disposition: 'changed', because: 'The claim itself is different.' }
}

/**
 * Compare two records.
 *
 * Pure: no clock, no randomness, no I/O, no model. Given the same two inputs it
 * returns the same output forever, which is the property that lets a comparison
 * be quoted in an argument.
 */
export function compareRecords(
  left: ComparableRecord | null,
  right: ComparableRecord | null,
): Comparison {
  const empty = {
    matching: 0, changed: 0, verdictChanged: 0, missing: 0, contradictory: 0, unverifiable: 0,
  }

  if (left === null) {
    return { comparable: false, reason: 'left_missing', left, right, claims: [], output: null, summary: empty }
  }
  if (right === null) {
    return { comparable: false, reason: 'right_missing', left, right, claims: [], output: null, summary: empty }
  }
  if (left.recordId === right.recordId) {
    // Comparing something with itself is not an error, but it is not a
    // comparison either, and saying so is more useful than a page of matches.
    return { comparable: false, reason: 'same_record', left, right, claims: [], output: null, summary: empty }
  }
  if (left.kind !== right.kind) {
    return { comparable: false, reason: 'different_kinds', left, right, claims: [], output: null, summary: empty }
  }

  const rightById = new Map(right.claims.map(claim => [claim.claimId, claim]))
  const seen = new Set<string>()
  const claims: ClaimDifference[] = []

  for (const leftClaim of left.claims) {
    const rightClaim = rightById.get(leftClaim.claimId)
    if (rightClaim === undefined) {
      claims.push({
        claimId: leftClaim.claimId,
        disposition: 'missing_right',
        left: leftClaim,
        right: null,
        because: 'Present on the left and absent on the right.',
      })
      continue
    }
    seen.add(leftClaim.claimId)
    const { disposition, because } = disposeOf(leftClaim, rightClaim)
    claims.push({ claimId: leftClaim.claimId, disposition, left: leftClaim, right: rightClaim, because })
  }

  for (const rightClaim of right.claims) {
    if (seen.has(rightClaim.claimId)) continue
    if (left.claims.some(claim => claim.claimId === rightClaim.claimId)) continue
    claims.push({
      claimId: rightClaim.claimId,
      disposition: 'missing_left',
      left: null,
      right: rightClaim,
      because: 'Present on the right and absent on the left.',
    })
  }

  // Stable ordering, so the same comparison reads the same every time.
  claims.sort((a, b) => a.claimId.localeCompare(b.claimId))

  const summary = {
    matching: claims.filter(c => c.disposition === 'matching').length,
    changed: claims.filter(c => c.disposition === 'changed').length,
    verdictChanged: claims.filter(c => c.disposition === 'verdict_changed').length,
    missing: claims.filter(c => c.disposition === 'missing_left' || c.disposition === 'missing_right').length,
    contradictory: claims.filter(c => c.disposition === 'contradictory').length,
    unverifiable: claims.filter(c => c.disposition === 'unverifiable').length,
  }

  return {
    comparable: true,
    reason: null,
    left,
    right,
    claims,
    output: diffOutput(left.output, right.output),
    summary,
  }
}

/**
 * How the free-form outputs differ.
 *
 * Only the first divergence and the shapes, not a full line diff. The claims
 * are where the meaning lives; the output difference exists so a reader can see
 * *that* the text changed without being invited to read a changed sentence as a
 * changed fact.
 */
export function diffOutput(left: string, right: string): OutputDifference {
  if (left === right) {
    const lines = left === '' ? 0 : left.split('\n').length
    return { identical: true, firstDivergenceLine: null, leftLines: lines, rightLines: lines }
  }
  const leftLines = left === '' ? [] : left.split('\n')
  const rightLines = right === '' ? [] : right.split('\n')
  let at: number | null = null
  for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      at = index + 1
      break
    }
  }
  return {
    identical: false,
    firstDivergenceLine: at,
    leftLines: leftLines.length,
    rightLines: rightLines.length,
  }
}

/** Whether two records could be compared at all, without doing the work. */
export function isComparable(left: ComparableRecord, right: ComparableRecord): boolean {
  return left.kind === right.kind && left.recordId !== right.recordId
}

/** A sentence for why a comparison could not be made. */
export function describeIncompatibility(reason: IncompatibilityReason): string {
  return {
    different_kinds: 'These are different kinds of record. A run and a verification do not line up claim for claim.',
    left_missing: 'The left side is empty. Choose a record to compare from.',
    right_missing: 'The right side is empty. Choose a record to compare against.',
    same_record: 'Both sides are the same record. Choose a different one for either side.',
  }[reason]
}
