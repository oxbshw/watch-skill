/**
 * The Library: sources, their revisions, and what is still true about them.
 *
 * The Library is not memory. That separation is the first thing this module
 * exists to hold: memory is what the system believes, and the Library is what
 * it has *seen*. Conflating them produces the worst version of both — a
 * knowledge base you cannot cite and an evidence store that argues with you.
 * So nothing here has a scope, a confidence or a status; those are memory's
 * vocabulary. A source has revisions, and evidence is addressed to one of them.
 *
 * The second thing it holds is the revision rule, which is the whole reason
 * evidence ids are worth anything:
 *
 * > A source that changed is a different source revision, and evidence stays
 * > addressed to the revision it was taken from — forever.
 *
 * When a page is re-indexed, the evidence from last week does not become
 * wrong, and it does not become unreachable. It becomes *stale*: it still
 * opens, still resolves to the same frame at the same millisecond, and now
 * carries a note saying the source has moved on. Deleting it would destroy the
 * receipt; silently re-pointing it at the new revision would be worse, because
 * the citation would then be to something nobody observed.
 *
 * @module @watchskill/dsh-library/sources
 */

import type { EvidenceRecord, Freshness, TemporalRange } from '@watchskill/dsh-contracts'
import type { ScriptTag } from '@watchskill/dsh-technology'

/** What kind of thing a source is. */
export type SourceKind = 'video' | 'audio' | 'page' | 'stream' | 'document' | 'screen_capture'

/** Where an index is in its life. */
export type IndexState =
  /** Known to the Library, nothing extracted. */
  | 'not_indexed'
  | 'indexing'
  /** Extracted and searchable. */
  | 'indexed'
  /** Indexed, but against an older revision than the current one. */
  | 'stale'
  | 'failed'

/** One immutable version of a source. */
export interface SourceRevision {
  readonly sourceRevisionId: string
  readonly sourceId: string
  /** Monotonic within a source. Revision 1 is the first thing observed. */
  readonly revision: number
  /** Digest of the bytes, which is what makes "changed" a fact. */
  readonly contentDigest: string
  readonly observedAt: string
  readonly durationMs: number | null
  readonly indexState: IndexState
  /** Why indexing failed, when it did. */
  readonly indexError: string | null
  /** Scripts detected in this revision's text. Structural, not measured. */
  readonly scripts: readonly ScriptTag[]
}

/** A source, with every revision the Library holds. */
export interface Source {
  readonly sourceId: string
  readonly kind: SourceKind
  /** What it is called. Presentation only; nothing resolves from it. */
  readonly title: string
  /** URL or path. */
  readonly locator: string
  readonly revisions: readonly SourceRevision[]
  /** Collections this source belongs to. */
  readonly collections: readonly string[]
  /** Entities extracted from it, when the engine extracts any. */
  readonly entities: readonly string[]
}

/** A named group of sources. Curation, not classification. */
export interface Collection {
  readonly collectionId: string
  readonly name: string
  readonly sourceIds: readonly string[]
}

/**
 * The current revision of a source.
 *
 * Highest revision number, not most recently observed — a re-index of an old
 * revision must not become "current" because it happened last.
 */
export function currentRevision(source: Source): SourceRevision | null {
  let best: SourceRevision | null = null
  for (const revision of source.revisions) {
    if (best === null || revision.revision > best.revision) best = revision
  }
  return best
}

/** Find one revision by id, wherever it sits in the history. */
export function findRevision(
  source: Source,
  sourceRevisionId: string,
): SourceRevision | null {
  return source.revisions.find(revision => revision.sourceRevisionId === sourceRevisionId) ?? null
}

/**
 * Whether a source revision is still the one a fresh observation would produce.
 *
 * Separated from freshness below because they are different questions: this is
 * about the *source*, and freshness is about one piece of evidence taken from
 * it. A source can be current while a specific observation from it is stale,
 * when the observation covers a range the new revision no longer contains.
 */
export function isCurrentRevision(source: Source, sourceRevisionId: string): boolean {
  return currentRevision(source)?.sourceRevisionId === sourceRevisionId
}

/**
 * Freshness of one evidence record, given what the Library now holds.
 *
 * The rules, in order:
 *
 * - Evidence whose source the Library does not hold is `unavailable`. Not
 *   `expired` — nobody knows whether it expired; it simply cannot be checked.
 * - Evidence against the current revision keeps whatever freshness the engine
 *   assigned it, including `gap`. Freshness is not the Library's to upgrade.
 * - Evidence against a superseded revision is `stale`. It still resolves; it
 *   no longer describes the source.
 *
 * Note what this function never returns: `current` for something it was not
 * already told was current. A Library that could promote evidence to fresh
 * would be a Library that re-validates by assertion.
 */
export function freshnessOf(
  evidence: Pick<EvidenceRecord, 'sourceRevisionId' | 'freshness'>,
  sources: readonly Source[],
): Freshness {
  const owner = sources.find(source =>
    source.revisions.some(revision => revision.sourceRevisionId === evidence.sourceRevisionId))
  if (owner === undefined) return 'unavailable'
  if (!isCurrentRevision(owner, evidence.sourceRevisionId)) return 'stale'
  return evidence.freshness
}

/**
 * Whether an evidence id can still be opened.
 *
 * Always true when the Library holds its revision, whatever the freshness. The
 * function exists to make that a stated guarantee rather than an accident of
 * whichever query happens to run: a stale citation that stopped opening would
 * turn every old receipt into a dead link.
 */
export function isAddressable(
  evidence: Pick<EvidenceRecord, 'sourceRevisionId'>,
  sources: readonly Source[],
): boolean {
  return sources.some(source =>
    source.revisions.some(revision => revision.sourceRevisionId === evidence.sourceRevisionId))
}

/** A place in a source that a citation resolves to. */
export interface EvidenceLocation {
  readonly sourceId: string
  readonly sourceRevisionId: string
  readonly revision: number
  readonly range: TemporalRange | null
  readonly freshness: Freshness
  /** Whether the source has moved on since this was observed. */
  readonly supersededBy: string | null
}

/**
 * Resolve an evidence record to a place in the Library.
 *
 * Returns null only when the revision is not held. Everything else resolves,
 * including evidence from four revisions ago — with `supersededBy` naming what
 * replaced it, so the surface can offer "look at the same moment in the
 * current revision" without silently doing it.
 */
export function locate(
  evidence: Pick<EvidenceRecord, 'sourceRevisionId' | 'temporalRange' | 'freshness'>,
  sources: readonly Source[],
): EvidenceLocation | null {
  for (const source of sources) {
    const revision = findRevision(source, evidence.sourceRevisionId)
    if (revision === null) continue
    const current = currentRevision(source)
    return {
      sourceId: source.sourceId,
      sourceRevisionId: revision.sourceRevisionId,
      revision: revision.revision,
      range: evidence.temporalRange,
      freshness: freshnessOf(evidence, sources),
      supersededBy: current === null || current.sourceRevisionId === revision.sourceRevisionId
        ? null
        : current.sourceRevisionId,
    }
  }
  return null
}

/**
 * Record a new revision of a source.
 *
 * Old revisions are kept, and their index state is marked `stale` rather than
 * removed. That is the mechanism behind every "old evidence still opens"
 * guarantee above — there is no code path that discards a revision, so there is
 * no code path that could orphan a citation.
 */
export function withRevision(source: Source, revision: SourceRevision): Source {
  const existing = source.revisions.filter(
    entry => entry.sourceRevisionId !== revision.sourceRevisionId)
  const superseded: readonly SourceRevision[] = existing.map(entry =>
    entry.revision < revision.revision && entry.indexState === 'indexed'
      ? { ...entry, indexState: 'stale' }
      : entry)
  return {
    ...source,
    revisions: [...superseded, revision].sort((left, right) => left.revision - right.revision),
  }
}
