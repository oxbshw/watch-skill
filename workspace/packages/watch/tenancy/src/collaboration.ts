/**
 * Sharing, reviewing, and the two things sharing must not carry.
 *
 * Team collaboration in an evidence product is mostly about a single question:
 * when I share what I saw, what exactly did I hand over? The answer has to be
 * legible before the share happens, not discoverable afterwards.
 *
 * Two rules shape everything here.
 *
 * **Personal memory does not travel.** Sharing a workspace shares the work —
 * sources, evidence, decisions, comments. It does not share what the system
 * believes about a person, at any role, in any direction. That is not a
 * setting; {@link shareableKinds} simply does not include it.
 *
 * **A share is redaction-aware.** Evidence frequently contains things nobody
 * intended to circulate: a token in a URL bar, a name in a notification, a
 * customer record behind the thing being verified. A share carries the
 * redactions with it, and {@link redactedView} is what a recipient receives —
 * so a redaction is a property of the evidence rather than of the viewer, and
 * cannot be undone by forwarding.
 *
 * @module @deepwatch/dsh-tenancy/collaboration
 */

import type { SpatialRegion, TemporalRange } from '@deepwatch/dsh-contracts'
import type { ResourceKind, ResourceOwner, Role } from './identity.js'

/** What may be shared into a workspace. */
export const SHAREABLE_KINDS: readonly ResourceKind[] = [
  'source', 'evidence', 'artifact', 'collection', 'comment', 'session',
]

/** Whether a kind may be shared at all. */
export function shareableKinds(kind: ResourceKind): boolean {
  return SHAREABLE_KINDS.includes(kind)
}

/**
 * Whether a resource may be shared into a workspace.
 *
 * Memory is refused by kind, and personal ownership is refused separately —
 * both, because a memory record could be shared under another kind's name by a
 * caller that got the kind wrong, and a personal resource of any kind is still
 * personal.
 */
export function mayShare(owner: ResourceOwner): { readonly ok: boolean; readonly reason: string } {
  if (owner.kind === 'memory') {
    return {
      ok: false,
      reason: 'Memory is not shared by sharing a workspace. Move its scope deliberately instead.',
    }
  }
  if (owner.kind === 'credential') {
    return { ok: false, reason: 'A credential is never shared; grant credential.use instead.' }
  }
  if (!shareableKinds(owner.kind)) {
    return { ok: false, reason: `${owner.kind} is not a shareable kind.` }
  }
  if (owner.userId !== null) {
    return { ok: false, reason: 'That belongs to one person rather than to the workspace.' }
  }
  return { ok: true, reason: '' }
}

/** A named group of sources a team curates together. */
export interface SharedCollection {
  readonly collectionId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly name: string
  readonly sourceIds: readonly string[]
  readonly createdByUserId: string
}

/** One redaction applied to a piece of evidence. */
export interface Redaction {
  readonly redactionId: string
  /** Which evidence it applies to. */
  readonly evidenceId: string
  /** The region hidden, when it is spatial. */
  readonly region: SpatialRegion | null
  /** The range hidden, when it is temporal. */
  readonly range: TemporalRange | null
  /** Literal text removed from any derived text. */
  readonly textPatterns: readonly string[]
  readonly reason: string
  readonly createdByUserId: string
}

/** What a recipient of shared evidence actually receives. */
export interface RedactedEvidenceView {
  readonly evidenceId: string
  readonly text: string
  readonly redactedRegions: readonly SpatialRegion[]
  readonly redactedRanges: readonly TemporalRange[]
  /**
   * How many redactions were applied.
   *
   * Shown to the recipient. A redacted document that did not say it was
   * redacted would be a document somebody quotes as complete.
   */
  readonly redactionCount: number
}

/**
 * Apply redactions to evidence before it leaves the owner's view.
 *
 * The replacement marker is deliberately visible and constant. A redaction
 * that removed text silently would change the meaning of what remains — "the
 * deploy failed" and "the deploy failed for customer ██████" read very
 * differently, and only one of them is honest about what was removed.
 */
export function redactedView(
  evidence: { readonly evidenceId: string; readonly text: string },
  redactions: readonly Redaction[],
): RedactedEvidenceView {
  const applicable = redactions.filter(redaction => redaction.evidenceId === evidence.evidenceId)
  let text = evidence.text
  for (const redaction of applicable) {
    for (const pattern of redaction.textPatterns) {
      if (pattern === '') continue
      text = text.split(pattern).join('[redacted]')
    }
  }
  return {
    evidenceId: evidence.evidenceId,
    text,
    redactedRegions: applicable
      .map(redaction => redaction.region)
      .filter((region): region is SpatialRegion => region !== null),
    redactedRanges: applicable
      .map(redaction => redaction.range)
      .filter((range): range is TemporalRange => range !== null),
    redactionCount: applicable.length,
  }
}

/**
 * Whether a redacted view still contains something it was meant to remove.
 *
 * The guard on the guard. Used by the share path before anything is handed
 * over, and by the tests, because "we applied the redactions" and "the text no
 * longer contains the token" are different claims.
 */
export function leaksRedactedText(
  view: RedactedEvidenceView,
  redactions: readonly Redaction[],
): boolean {
  return redactions
    .filter(redaction => redaction.evidenceId === view.evidenceId)
    .flatMap(redaction => redaction.textPatterns)
    .some(pattern => pattern !== '' && view.text.includes(pattern))
}

/** A review note somebody left on a piece of evidence or a verdict. */
export interface ReviewNote {
  readonly commentId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly authorUserId: string
  /** What it is about: an evidence id, a verification id, a record id. */
  readonly subjectId: string
  readonly subjectKind: 'evidence' | 'verification' | 'receipt' | 'source'
  readonly body: string
  readonly createdAt: string
  readonly resolvedAt: string | null
}

/**
 * Whether a note may be resolved by this principal.
 *
 * Its author, or an admin. A reviewer resolving somebody else's open question
 * is how a review becomes a formality.
 */
export function mayResolveNote(
  note: ReviewNote,
  principal: { readonly userId: string },
  role: Role,
): boolean {
  return note.authorUserId === principal.userId || role === 'admin' || role === 'owner'
}

/** A decision a team recorded together. */
export interface SharedDecision {
  readonly decisionId: string
  readonly tenantId: string
  readonly workspaceId: string
  readonly statement: string
  readonly decidedByUserId: string
  readonly decidedAt: string
  /** Evidence the decision was based on. Ids only. */
  readonly evidenceIds: readonly string[]
  /** Verification that supported it, when there was one. */
  readonly verificationId: string | null
}

/**
 * The owner record for anything shared.
 *
 * `userId: null`, always. That is what makes a shared resource shared: it
 * belongs to the workspace rather than to the person who contributed it, and a
 * share that kept the contributor's user id would be denied to everybody else
 * by the personal-ownership rule.
 */
export function sharedOwner(
  kind: ResourceKind,
  resourceId: string,
  scope: { readonly tenantId: string; readonly workspaceId: string },
): ResourceOwner {
  return {
    kind,
    resourceId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    userId: null,
  }
}

/**
 * One line describing what a share hands over.
 *
 * Rendered in the share dialog before anything happens. "3 sources, 12
 * evidence records, 2 redactions applied, no personal memory" is a sentence
 * somebody can check; "Share workspace?" is not.
 */
export function describeShare(input: {
  readonly sources: number
  readonly evidence: number
  readonly redactions: number
  readonly comments: number
}): string {
  const parts = [
    `${String(input.sources)} source(s)`,
    `${String(input.evidence)} evidence record(s)`,
    `${String(input.comments)} comment(s)`,
  ]
  if (input.redactions > 0) parts.push(`${String(input.redactions)} redaction(s) applied`)
  // Stated every time, including when it is obvious. The reassurance is the
  // point: people share less when they are not sure what goes with it.
  parts.push('no personal memory')
  return parts.join(' · ')
}
