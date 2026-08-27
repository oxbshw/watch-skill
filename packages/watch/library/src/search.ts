/**
 * Library search: finding the source, and saying how it was found.
 *
 * Search here has one unusual requirement. It has to report *which retrieval
 * path produced a result*, because the two paths make different promises. A
 * lexical hit means those characters are in that source at that moment. A
 * semantic hit means something in that source was near the query in an
 * embedding space, which is a much weaker claim and occasionally a wrong one.
 *
 * A product that merged them into one ranked list with one relevance number
 * would be a product where "it found nothing" and "the embedding model was not
 * installed" look identical, and where a paraphrase match and an exact quote
 * look equally certain. So {@link searchPlan} states the path before anything
 * runs, and every hit carries the path that produced it.
 *
 * Facets are computed from the results rather than from a fixed taxonomy. A
 * facet that offers "Arabic (0)" on a library with no Arabic in it is a filter
 * that teaches people the filter is broken.
 *
 * @module @watchskill/dsh-library/search
 */

import type { TemporalRange } from '@watchskill/dsh-contracts'
import type { Source, SourceKind, IndexState } from './sources.js'

/** How a result was retrieved. */
export type RetrievalPath = 'lexical' | 'semantic' | 'both'

/** What the engine can actually do here. */
export interface SearchCapabilities {
  /** Substring and token matching over extracted text. */
  readonly lexical: boolean
  /** Embedding retrieval. Requires a bound embeddings role. */
  readonly semantic: boolean
}

/** What search will do, decided before it runs. */
export interface SearchPlan {
  readonly path: RetrievalPath | 'none'
  /** One sentence for the results header. Always populated. */
  readonly explanation: string
  /** What is missing, and what to do about it. Empty when nothing is. */
  readonly degradedBecause: string
  readonly fix: string
}

/**
 * Decide the retrieval path.
 *
 * Semantic-only is a real state and is reported as one rather than silently
 * treated as "search works". A library where exact-phrase search is
 * unavailable behaves very differently from one where it is not, and a user
 * searching for an error code needs to know which they are in.
 */
export function searchPlan(capabilities: SearchCapabilities): SearchPlan {
  if (capabilities.lexical && capabilities.semantic) {
    return {
      path: 'both',
      explanation: 'Hybrid search: exact matches and meaning-based matches, marked separately.',
      degradedBecause: '',
      fix: '',
    }
  }
  if (capabilities.lexical) {
    return {
      path: 'lexical',
      explanation: 'Exact matching only. A paraphrase of what was said will not be found.',
      degradedBecause: 'No embeddings role is bound, so semantic retrieval is unavailable.',
      fix: 'Bind an embeddings role in Settings to search by meaning as well.',
    }
  }
  if (capabilities.semantic) {
    return {
      path: 'semantic',
      explanation: 'Meaning-based matching only. An exact phrase may rank below a paraphrase.',
      degradedBecause: 'The lexical index is unavailable.',
      fix: 'Re-index the library to restore exact matching.',
    }
  }
  return {
    path: 'none',
    explanation: 'Search is unavailable.',
    degradedBecause: 'Neither the lexical index nor an embeddings role is available.',
    fix: 'Index a source, or bind an embeddings role in Settings.',
  }
}

/** One hit inside one source. */
export interface SearchHit {
  readonly sourceId: string
  readonly sourceRevisionId: string
  /** Where in the source, when the modality has a clock. */
  readonly range: TemporalRange | null
  /** The matched text, verbatim and in its original script. */
  readonly text: string
  /** Which path produced this hit. */
  readonly path: RetrievalPath
  /**
   * Score, in the producing path's own units.
   *
   * Deliberately not normalized across paths. A lexical rank and a cosine
   * similarity are not comparable, and putting them on one 0–1 scale would
   * manufacture a comparison that does not exist.
   */
  readonly score: number
  /** Evidence this hit resolves to, when the engine minted any. */
  readonly evidenceIds: readonly string[]
}

/** A result: one source, and the hits inside it. */
export interface SearchResult {
  readonly sourceId: string
  readonly title: string
  readonly kind: SourceKind
  readonly hits: readonly SearchHit[]
  /** Whether the hits are against the source's current revision. */
  readonly current: boolean
}

/** One facet value and how many results carry it. */
export interface FacetValue {
  readonly value: string
  readonly count: number
}

/** The facets computed from a result set. */
export interface Facets {
  readonly kind: readonly FacetValue[]
  readonly indexState: readonly FacetValue[]
  readonly collection: readonly FacetValue[]
  readonly script: readonly FacetValue[]
  readonly path: readonly FacetValue[]
}

/** What a search was narrowed to. */
export interface SearchFilters {
  readonly kinds?: readonly SourceKind[]
  readonly collections?: readonly string[]
  readonly indexStates?: readonly IndexState[]
  readonly scripts?: readonly string[]
  /** Only hits from the current revision of each source. */
  readonly currentOnly?: boolean
}

/** Count values, dropping the empty ones. */
function tally(values: readonly string[]): readonly FacetValue[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
}

/**
 * Compute facets over a result set.
 *
 * Only values that actually occur. A facet list generated from the schema
 * rather than from the results offers filters that return nothing, and a
 * filter that returns nothing is indistinguishable from a broken one.
 */
export function facetsFor(
  results: readonly SearchResult[],
  sources: readonly Source[],
): Facets {
  const byId = new Map(sources.map(source => [source.sourceId, source]))
  const kinds: string[] = []
  const indexStates: string[] = []
  const collections: string[] = []
  const scripts: string[] = []
  const paths: string[] = []

  for (const result of results) {
    kinds.push(result.kind)
    const source = byId.get(result.sourceId)
    if (source !== undefined) {
      for (const collection of source.collections) collections.push(collection)
      for (const revision of source.revisions) {
        if (!result.hits.some(hit => hit.sourceRevisionId === revision.sourceRevisionId)) continue
        indexStates.push(revision.indexState)
        for (const script of revision.scripts) scripts.push(script)
      }
    }
    for (const hit of result.hits) paths.push(hit.path)
  }

  return {
    kind: tally(kinds),
    indexState: tally(indexStates),
    collection: tally(collections),
    script: tally(scripts),
    path: tally(paths),
  }
}

/** Apply filters to a result set. Pure; the engine does the retrieval. */
export function applyFilters(
  results: readonly SearchResult[],
  sources: readonly Source[],
  filters: SearchFilters,
): readonly SearchResult[] {
  const byId = new Map(sources.map(source => [source.sourceId, source]))
  return results.filter(result => {
    if (filters.kinds !== undefined && !filters.kinds.includes(result.kind)) return false
    if (filters.currentOnly === true && !result.current) return false

    const source = byId.get(result.sourceId)
    if (filters.collections !== undefined) {
      if (source === undefined) return false
      if (!filters.collections.some(collection => source.collections.includes(collection))) return false
    }
    if (filters.indexStates !== undefined) {
      if (source === undefined) return false
      const states = source.revisions
        .filter(revision => result.hits.some(hit => hit.sourceRevisionId === revision.sourceRevisionId))
        .map(revision => revision.indexState)
      if (!states.some(state => filters.indexStates?.includes(state) === true)) return false
    }
    if (filters.scripts !== undefined) {
      if (source === undefined) return false
      const present = new Set(source.revisions.flatMap(revision => revision.scripts))
      if (!filters.scripts.some(script => present.has(script as never))) return false
    }
    return true
  })
}

/**
 * Order results for display.
 *
 * Within a source, hits are ordered by path and then by time — not by score
 * across paths, because the scores are not comparable. Across sources, the
 * source with the strongest lexical evidence leads, because an exact match is
 * the strongest claim search can make.
 */
export function rankResults(results: readonly SearchResult[]): readonly SearchResult[] {
  const lexicalWeight = (result: SearchResult): number =>
    result.hits.filter(hit => hit.path === 'lexical' || hit.path === 'both').length
  return [...results].sort((left, right) => {
    const byLexical = lexicalWeight(right) - lexicalWeight(left)
    if (byLexical !== 0) return byLexical
    const byHits = right.hits.length - left.hits.length
    if (byHits !== 0) return byHits
    return left.sourceId.localeCompare(right.sourceId)
  })
}

/**
 * One line above the results, stating what was searched and how.
 *
 * Always says the path. "12 results" alone invites the reading that the library
 * was searched thoroughly, which may not be true.
 */
export function describeSearch(
  plan: SearchPlan,
  results: readonly SearchResult[],
): string {
  const hits = results.reduce((total, result) => total + result.hits.length, 0)
  const count = `${String(hits)} hit(s) in ${String(results.length)} source(s)`
  return plan.degradedBecause === ''
    ? `${count} · ${plan.explanation}`
    : `${count} · ${plan.explanation} ${plan.degradedBecause}`
}
