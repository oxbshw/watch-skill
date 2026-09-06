/**
 * The Library surface.
 *
 * Visually and structurally separate from Memory, and that separation is
 * enforced rather than encouraged: this module imports nothing from the memory
 * packages, so a memory record cannot be rendered here even by mistake. The
 * two surfaces answer different questions — what has been seen, and what is
 * believed — and a person needs to be able to tell at a glance which one they
 * are looking at.
 *
 * Every result says how it was found and whether it is still current. A search
 * result that showed neither would be a list of claims about a library whose
 * state the reader cannot check.
 *
 * @module @deepwatch/dsh-library/components
 */

import type { ReactNode } from 'react'
import { toneFor, tokenFor } from '@deepwatch/dsh-client-brand'
import type { Freshness } from '@deepwatch/dsh-contracts'
import {
  currentRevision,
  type Source,
  type SourceRevision,
} from '../sources.js'
import {
  describeSearch,
  type Facets,
  type SearchHit,
  type SearchPlan,
  type SearchResult,
} from '../search.js'

/** The glyph half of a freshness state, so colour is never the only signal. */
const FRESHNESS_GLYPH: Readonly<Record<Freshness, string>> = {
  current: '●',
  stale: '⌛',
  gap: '⌇',
  expired: '⊘',
  unavailable: '?',
}

/** Props for {@link FreshnessBadge}. */
export interface FreshnessBadgeProps {
  readonly freshness: Freshness
}

/** Freshness as glyph, word and tone. */
export function FreshnessBadge({ freshness }: FreshnessBadgeProps): ReactNode {
  return (
    <span data-watch-freshness={freshness} style={{ color: tokenFor(toneFor(freshness)) }}>
      <span aria-hidden="true">{FRESHNESS_GLYPH[freshness]}</span>
      <span>{` ${freshness}`}</span>
    </span>
  )
}

/** Props for {@link RevisionHistory}. */
export interface RevisionHistoryProps {
  readonly source: Source
  readonly onOpen: (revision: SourceRevision) => void
}

/**
 * A source's revisions, newest last.
 *
 * Every revision is listed, including superseded ones, and every one is
 * openable. A history that showed only the current revision would make old
 * evidence unreachable through the interface even though it remains
 * addressable underneath, which is the same failure with extra steps.
 */
export function RevisionHistory({ source, onOpen }: RevisionHistoryProps): ReactNode {
  const current = currentRevision(source)
  return (
    <ol data-watch-revisions={source.sourceId} style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {source.revisions.map(revision => (
        <li key={revision.sourceRevisionId} data-watch-revision={revision.sourceRevisionId}>
          <button
            type="button"
            data-watch-index-state={revision.indexState}
            aria-current={current?.sourceRevisionId === revision.sourceRevisionId ? 'true' : undefined}
            onClick={() => { onOpen(revision) }}
            style={{ font: 'inherit', color: 'inherit', background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <span dir="ltr">{`r${String(revision.revision)}`}</span>
            <span>{` ${revision.indexState}`}</span>
            <time dateTime={revision.observedAt}>{` ${revision.observedAt}`}</time>
            {current?.sourceRevisionId === revision.sourceRevisionId && <span>{' · current'}</span>}
          </button>
          {revision.indexError !== null && (
            <span data-watch-index-error="">{` ${revision.indexError}`}</span>
          )}
        </li>
      ))}
    </ol>
  )
}

/** Props for {@link SearchHitRow}. */
export interface SearchHitRowProps {
  readonly hit: SearchHit
  readonly freshness: Freshness
  readonly onOpen: (hit: SearchHit) => void
}

/**
 * One hit.
 *
 * The retrieval path is on the row, not in a legend. A person reading a
 * semantic hit needs to know it is a semantic hit at the moment they read it,
 * because that is what decides whether they should check it.
 */
export function SearchHitRow({ hit, freshness, onOpen }: SearchHitRowProps): ReactNode {
  return (
    <li data-watch-hit={hit.sourceRevisionId} data-watch-path={hit.path}>
      <button
        type="button"
        onClick={() => { onOpen(hit) }}
        style={{ font: 'inherit', color: 'inherit', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'start' }}
      >
        {hit.range !== null && (
          <span dir="ltr" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {`${String(Math.floor(hit.range.startMs / 1000))}s `}
          </span>
        )}
        {/* Verbatim, in its own script and its own direction. A hit rendered
            left-to-right because the surrounding interface is would show the
            wrong text to the person best able to check it. */}
        <span dir="auto">{hit.text}</span>
        <span data-watch-hit-path={hit.path}>{` (${hit.path})`}</span>
        <FreshnessBadge freshness={freshness} />
      </button>
    </li>
  )
}

/** Props for {@link FacetPanel}. */
export interface FacetPanelProps {
  readonly facets: Facets
  readonly onFilter: (facet: string, value: string) => void
}

/** The facet rail. Only values that actually occur are offered. */
export function FacetPanel({ facets, onFilter }: FacetPanelProps): ReactNode {
  const groups: readonly (readonly [string, Facets[keyof Facets]])[] = [
    ['kind', facets.kind],
    ['indexState', facets.indexState],
    ['collection', facets.collection],
    ['script', facets.script],
    ['path', facets.path],
  ]
  return (
    <aside data-watch-facets="" aria-label="Filters">
      {groups.map(([name, values]) => (
        values.length === 0 ? null : (
          <section key={name} data-watch-facet={name}>
            <h3 style={{ font: 'inherit', fontSize: '11px' }}>{name}</h3>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {values.map(value => (
                <li key={value.value}>
                  <button
                    type="button"
                    data-watch-facet-value={value.value}
                    onClick={() => { onFilter(name, value.value) }}
                    style={{ font: 'inherit', color: 'inherit', background: 'none', border: 'none', cursor: 'pointer' }}
                  >
                    {`${value.value} (${String(value.count)})`}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )
      ))}
    </aside>
  )
}

/** Props for {@link LibrarySurface}. */
export interface LibrarySurfaceProps {
  readonly plan: SearchPlan
  readonly results: readonly SearchResult[]
  readonly facets: Facets
  readonly sources: readonly Source[]
  readonly freshnessOf: (hit: SearchHit) => Freshness
  readonly onOpenHit: (hit: SearchHit) => void
  readonly onOpenRevision: (revision: SourceRevision) => void
  readonly onFilter: (facet: string, value: string) => void
}

/** The Library mode body. */
export function LibrarySurface(props: LibrarySurfaceProps): ReactNode {
  const byId = new Map(props.sources.map(source => [source.sourceId, source]))
  return (
    <section data-watch-library="" aria-label="Library">
      <p data-watch-search-plan={props.plan.path}>{describeSearch(props.plan, props.results)}</p>
      {props.plan.fix !== '' && <p data-watch-search-fix="">{props.plan.fix}</p>}
      <FacetPanel facets={props.facets} onFilter={props.onFilter} />
      {props.results.length === 0
        ? <p data-watch-library-empty="">Nothing in the Library matches.</p>
        : props.results.map(result => {
          const source = byId.get(result.sourceId)
          return (
            <article key={result.sourceId} data-watch-source={result.sourceId}>
              <h3 style={{ font: 'inherit' }} dir="auto">{result.title}</h3>
              <span data-watch-source-kind={result.kind}>{result.kind}</span>
              {!result.current && (
                <span data-watch-source-superseded="">
                  {' The source has changed since these were observed.'}
                </span>
              )}
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {result.hits.map(hit => (
                  <SearchHitRow
                    key={`${hit.sourceRevisionId}:${String(hit.range?.startMs ?? 0)}:${hit.text}`}
                    hit={hit}
                    freshness={props.freshnessOf(hit)}
                    onOpen={props.onOpenHit}
                  />
                ))}
              </ul>
              {source !== undefined && (
                <RevisionHistory source={source} onOpen={props.onOpenRevision} />
              )}
            </article>
          )
        })}
    </section>
  )
}
