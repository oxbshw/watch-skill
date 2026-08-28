/**
 * The Library, as a working search surface.
 *
 * It is backed by `LibraryIndex` — a local, derived, rebuildable inverted index
 * — so search works offline, needs no service and needs no embedding model.
 * Semantic retrieval stays a future optional plugin; this is what runs on any
 * machine today.
 *
 * The records come from the evidence the workspace has actually seen. Where
 * there are none the surface says so and offers a rebuild, rather than
 * presenting an empty result set as though a search had run and found nothing —
 * those are different facts and a person acts differently on each.
 *
 * Accessibility is not an afterthought here because a search box is where
 * keyboard and screen-reader behaviour is most obviously felt: the field is
 * labelled, results are a live region announcing their own count, every filter
 * is a real control, and the index's condition is announced rather than only
 * coloured.
 *
 * @module @watchskill/dsh-library/client/search-view
 */

import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { LibraryIndex, MAX_LIMIT, tokenize } from '../index-store.js'
import type { IndexQuery, IndexQueryResult, IndexableRecord } from '../index-store.js'
import type { SourceKind } from '../sources.js'

const PAGE = 10

const S = {
  root: {
    display: 'flex', flexDirection: 'column' as const, gap: '14px',
    height: '100%', minHeight: 0,
  },
  bar: { display: 'flex', gap: '10px', flexWrap: 'wrap' as const, alignItems: 'flex-end' },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '4px', flex: '1 1 260px', minWidth: 0 },
  label: {
    fontSize: '11px', fontWeight: 600, letterSpacing: '.05em',
    textTransform: 'uppercase' as const, color: 'var(--dsw-alias-label-tertiary)',
  },
  input: {
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px', padding: '7px 10px', fontSize: '13px',
    color: 'inherit', font: 'inherit', minWidth: 0, width: '100%',
  },
  select: {
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px', padding: '7px 10px', fontSize: '13px', color: 'inherit',
  },
  button: {
    background: 'transparent', border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px', padding: '7px 12px', fontSize: '13px',
    color: 'inherit', cursor: 'pointer',
  },
  status: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
  list: { display: 'flex', flexDirection: 'column' as const, gap: '8px', margin: 0, padding: 0, listStyle: 'none' },
  hit: {
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
    padding: '12px 14px', background: 'var(--dsw-alias-bg-base)',
  },
  title: { fontSize: '13.5px', fontWeight: 600, margin: 0 },
  snippet: {
    fontSize: '12.5px', lineHeight: 1.6, margin: '6px 0 0',
    color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-word' as const,
  },
  meta: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '6px', display: 'flex', gap: '10px', flexWrap: 'wrap' as const },
}

/** What the index says about itself, in words a person can act on. */
const HEALTH: Record<string, { readonly says: string, readonly tone: string }> = {
  empty: { says: 'Nothing indexed yet.', tone: 'var(--watch-tone-neutral)' },
  ready: { says: 'Index ready.', tone: 'var(--watch-tone-active)' },
  indexing: { says: 'Indexing — results are partial.', tone: 'var(--watch-tone-caution)' },
  stale: { says: 'Index is behind the store.', tone: 'var(--watch-tone-caution)' },
  corrupt: { says: 'Index unreadable. Rebuild required.', tone: 'var(--watch-tone-error)' },
}

const KINDS: readonly SourceKind[] = ['video', 'audio', 'page', 'stream', 'document', 'screen_capture']

/**
 * Highlight matches without building markup.
 *
 * The snippet is evidence, so it is never altered and never handed to a
 * renderer as HTML. Splitting into plain segments and marking them with React
 * elements keeps escaping the renderer's job, which is the only place it is
 * reliably done.
 */
function Highlighted({ text, terms }: { readonly text: string, readonly terms: readonly string[] }): ReactNode {
  if (terms.length === 0 || text === '') return <>{text}</>
  const pattern = terms
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(term => term !== '')
    .join('|')
  if (pattern === '') return <>{text}</>
  const parts = text.split(new RegExp(`(${pattern})`, 'giu'))
  return (
    <>
      {parts.map((part, index) => (
        terms.includes(part.toLowerCase())
          ? <mark key={`${part}-${String(index)}`} style={{ background: 'var(--watch-wash-active)', color: 'inherit' }}>{part}</mark>
          : <span key={`${part}-${String(index)}`}>{part}</span>
      ))}
    </>
  )
}

export interface LibrarySearchProps {
  /** The records to index. The store remains the source of truth. */
  readonly records?: readonly IndexableRecord[]
  /** Injected for tests; production builds its own. */
  readonly index?: LibraryIndex
}

/** The Library search workflow: query, filter, sort, page, rebuild. */
export function LibrarySearch({ records = [], index: injected }: LibrarySearchProps): ReactNode {
  const queryId = useId()
  const kindId = useId()
  const verdictId = useId()
  const sortId = useId()

  const [text, setText] = useState('')
  const [kind, setKind] = useState<'' | SourceKind>('')
  const [verdict, setVerdict] = useState('')
  const [sort, setSort] = useState<NonNullable<IndexQuery['sort']>>('relevance')
  const [offset, setOffset] = useState(0)
  const [generation, setGeneration] = useState(0)
  const [result, setResult] = useState<IndexQueryResult | null>(null)

  const index = useMemo(() => {
    if (injected !== undefined) return injected
    const built = new LibraryIndex()
    built.addAll(records)
    return built
  }, [injected, records, generation])

  // Every query supersedes the one before it. Without this, a slow search over
  // a large corpus can land after a newer one and overwrite it with stale
  // results — the classic race that makes a search box feel haunted.
  const inFlight = useRef<AbortController | null>(null)

  const run = useCallback((nextOffset: number) => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setResult(index.search({
      text,
      ...(kind === '' ? {} : { kinds: [kind] }),
      ...(verdict === '' ? {} : { verdicts: [verdict] }),
      sort,
      offset: nextOffset,
      limit: PAGE,
      signal: controller.signal,
    }))
    setOffset(nextOffset)
  }, [index, text, kind, verdict, sort])

  useEffect(() => { run(0) }, [run])
  useEffect(() => () => { inFlight.current?.abort() }, [])

  const terms = useMemo(() => tokenize(text), [text])
  // `noUncheckedIndexedAccess` is on, so an index lookup is optional even
  // with a total record type. Falling back keeps the surface renderable
  // for a health value a future build adds before this one knows it.
  const health = HEALTH[result?.health ?? index.health] ?? { says: 'Index state unknown.', tone: 'var(--watch-tone-neutral)' }
  const total = result?.total ?? 0
  const shown = result?.results.length ?? 0
  const page = Math.floor(offset / PAGE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE))

  return (
    <div style={S.root}>
      <form
        style={S.bar}
        role="search"
        onSubmit={event => { event.preventDefault(); run(0) }}
      >
        <div style={S.field}>
          <label htmlFor={queryId} style={S.label}>Search evidence</label>
          <input
            id={queryId}
            style={S.input}
            type="search"
            value={text}
            placeholder="Words in a transcript, a title, a run…"
            onChange={event => { setText(event.target.value) }}
          />
        </div>

        <div style={S.field}>
          <label htmlFor={kindId} style={S.label}>Type</label>
          <select id={kindId} style={S.select} value={kind} onChange={event => { setKind(event.target.value as '' | SourceKind) }}>
            <option value="">Any type</option>
            {KINDS.map(value => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}
          </select>
        </div>

        <div style={S.field}>
          <label htmlFor={verdictId} style={S.label}>Verification</label>
          <select id={verdictId} style={S.select} value={verdict} onChange={event => { setVerdict(event.target.value) }}>
            <option value="">Any state</option>
            {['VERIFIED', 'FAILED', 'UNVERIFIED', 'INCONCLUSIVE'].map(value => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>

        <div style={S.field}>
          <label htmlFor={sortId} style={S.label}>Sort</label>
          <select id={sortId} style={S.select} value={sort} onChange={event => { setSort(event.target.value as NonNullable<IndexQuery['sort']>) }}>
            <option value="relevance">Relevance</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="title">Title</option>
          </select>
        </div>

        <button type="submit" style={S.button}>Search</button>
        <button
          type="button"
          style={S.button}
          // Rebuilding is safe precisely because the index is derived: it can
          // be thrown away and reconstructed from the records at any time.
          onClick={() => { setGeneration(value => value + 1) }}
        >
          Rebuild index
        </button>
      </form>

      <p style={{ ...S.status, color: health.tone }}>
        {health.says}
        {' '}
        <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
          {`${String(index.size)} record(s) indexed.`}
        </span>
      </p>

      {/* A live region: the result count is announced, not only drawn. */}
      <p style={S.status} role="status" aria-live="polite">
        {total === 0
          ? (terms.length === 0 ? 'No records to list.' : `No matches for “${text}”.`)
          : `${String(total)} match${total === 1 ? '' : 'es'}, showing ${String(shown)} (page ${String(page)} of ${String(pages)}).`}
      </p>

      {(result?.notes ?? []).map(note => (
        <p key={note} style={S.status}>{note}</p>
      ))}

      {total === 0
        ? (
            <div style={{ ...S.hit, borderStyle: 'dashed' }}>
              <p style={{ ...S.snippet, margin: 0 }}>
                {index.size === 0
                  ? 'Nothing has been indexed yet. Evidence appears here once the workspace has recorded some — then this searches it locally, with no service and no model.'
                  : 'Nothing matched. Every word has to appear in a record; try fewer words, or clear the filters.'}
              </p>
            </div>
          )
        : (
            <ul style={S.list}>
              {(result?.results ?? []).map(entry => (
                <li key={entry.sourceId} style={S.hit}>
                  <h4 style={S.title}><Highlighted text={entry.title} terms={terms} /></h4>
                  {entry.hits.map(hit => (
                    <p key={`${hit.sourceRevisionId}-${String(hit.score)}`} style={S.snippet}>
                      <Highlighted text={hit.text} terms={terms} />
                    </p>
                  ))}
                  <div style={S.meta}>
                    <span>{entry.kind}</span>
                    <span data-watch-ltr>{entry.sourceId}</span>
                    {(entry.hits[0]?.evidenceIds.length ?? 0) > 0
                      ? (
                          <span data-watch-ltr>
                            {`${String(entry.hits[0]?.evidenceIds.length ?? 0)} evidence ref(s)`}
                          </span>
                        )
                      : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

      {pages > 1
        ? (
            <nav style={{ display: 'flex', gap: '8px' }} aria-label="Search results pages">
              <button
                type="button"
                style={S.button}
                disabled={offset === 0}
                onClick={() => { run(Math.max(0, offset - PAGE)) }}
              >
                Previous
              </button>
              <button
                type="button"
                style={S.button}
                disabled={offset + PAGE >= total}
                onClick={() => { run(Math.min(offset + PAGE, Math.max(0, total - 1))) }}
              >
                Next
              </button>
            </nav>
          )
        : null}
    </div>
  )
}

export { MAX_LIMIT }
