/**
 * The Library's local search index.
 *
 * The evidence store is the source of truth. This is a *derived* structure: it
 * can be thrown away and rebuilt from the records at any time, and every design
 * decision here follows from that one fact. A derived index that cannot be
 * safely deleted is not derived, it is a second database with none of the
 * guarantees of the first.
 *
 * What it is:
 *
 *   - **Local.** An inverted index over tokens, held in memory and serialisable
 *     to plain JSON. No service, no network, no embedding model. Semantic
 *     retrieval stays a future optional plugin; lexical matching is what works
 *     offline on any machine, today.
 *   - **Versioned.** Every serialised index carries `INDEX_VERSION` and a
 *     digest of its own contents. A version it does not recognise, or a digest
 *     that does not match, is a corrupt index — detected on load, reported, and
 *     rebuilt rather than half-trusted.
 *   - **Incremental and idempotent.** Indexing the same record twice leaves the
 *     index identical. Re-indexing a changed record replaces its postings
 *     rather than adding a second copy, so a document cannot accumulate ghosts
 *     of its former text.
 *   - **Recoverable.** Indexing records progress, so an interrupted run resumes
 *     from what it completed instead of starting over or, worse, believing it
 *     finished.
 *
 * Queries are bounded, paginated and cancellable by construction: a query
 * carries its own limit, and a caller can pass an `AbortSignal`. An unbounded
 * search over a large corpus is a denial of service you wrote yourself.
 *
 * @module @watchskill/dsh-library/index-store
 */

import type { SearchHit, SearchResult } from './search.js'
import type { SourceKind } from './sources.js'

/**
 * Bumped when the serialised shape changes.
 *
 * An index written by a newer build is refused rather than reinterpreted. A
 * structure read under the wrong assumptions produces confident wrong answers,
 * which is worse than producing none.
 */
export const INDEX_VERSION = 1

/** How the index reports its own condition. */
export type IndexHealth =
  /** Never built. Not an error — nobody has indexed anything yet. */
  | 'empty'
  /** Built, current, queryable. */
  | 'ready'
  /** A build is in progress; results are partial and say so. */
  | 'indexing'
  /** Records changed after the last build. Queryable, but incomplete. */
  | 'stale'
  /** Unreadable: wrong version, failed digest, malformed. Must be rebuilt. */
  | 'corrupt'

/** One indexable record. Everything is optional except the identity. */
export interface IndexableRecord {
  readonly recordId: string
  readonly revisionId: string
  readonly title: string
  readonly kind: SourceKind
  /** Body text: extracted text, a transcript, a description. */
  readonly text: string
  /** Where it came from, for provenance filtering. */
  readonly source: string | null
  /** The run or task it belongs to. */
  readonly runId: string | null
  /** ISO-8601. Used for range filters and for ordering. */
  readonly observedAt: string | null
  /** The verification state, when the record has one. */
  readonly verdict: string | null
  readonly tags: readonly string[]
  /** Evidence this record resolves to. */
  readonly evidenceIds: readonly string[]
}

/** What a caller may narrow a query by. */
export interface IndexQuery {
  readonly text: string
  readonly kinds?: readonly SourceKind[]
  readonly runIds?: readonly string[]
  readonly verdicts?: readonly string[]
  readonly tags?: readonly string[]
  readonly sources?: readonly string[]
  /** Inclusive ISO-8601 bounds. */
  readonly from?: string
  readonly to?: string
  readonly sort?: 'relevance' | 'newest' | 'oldest' | 'title'
  readonly offset?: number
  readonly limit?: number
  readonly signal?: AbortSignal
}

/** A page of results, and enough context to page through the rest. */
export interface IndexQueryResult {
  readonly results: readonly SearchResult[]
  /** Matches before paging. The count a person is told. */
  readonly total: number
  readonly offset: number
  readonly limit: number
  readonly health: IndexHealth
  /** Non-fatal facts about this answer: truncation, staleness, degradation. */
  readonly notes: readonly string[]
}

/** The serialised form. Plain JSON so any store can hold it. */
export interface SerializedIndex {
  readonly version: number
  readonly digest: string
  readonly builtAt: string
  readonly documents: readonly IndexableRecord[]
  /** Token → the record ids carrying it. */
  readonly postings: Readonly<Record<string, readonly string[]>>
}

/** The largest page anyone may ask for. */
export const MAX_LIMIT = 200
const DEFAULT_LIMIT = 25

/** Han, Hiragana, Katakana — scripts written without spaces. */
const CJK = /[぀-ヿ㐀-䶿一-鿿]/u

/**
 * Split text into searchable tokens.
 *
 * Unicode-aware on purpose. Splitting on `[a-z0-9]+` would silently drop every
 * Arabic, Chinese, Cyrillic and Greek record in the corpus — they would index
 * as nothing and return nothing, and the failure would look like an empty
 * library rather than a broken tokenizer.
 *
 * CJK has no spaces, so a run is emitted as its characters and its adjacent
 * bigrams rather than whole. Keeping the run would make it a token only an
 * exact repetition could match, and since every query term must be present,
 * that run token would then fail a query whose characters are all indexed.
 *
 * Case folding is `toLowerCase`, which is a no-op for scripts without case and
 * correct for those with it. Diacritics are deliberately *kept*: the original
 * text is the evidence, and folding "عَلَم" into "علم" would make a citation
 * resolve to something the source does not say.
 *
 * `\p{M}` is in the continuation class for the same reason, and its absence was
 * a real bug. Arabic harakat are Unicode *Mark*, not *Letter*, so a class of
 * letters and numbers alone breaks at every vowel sign: vocalised "عَلَم"
 * tokenized as three separate consonants, and no query could ever match it.
 */
export function tokenize(text: string): readonly string[] {
  if (text === '') return []
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}_'-]*/gu)) {
    const token = match[0]
    if (CJK.test(token) && token.length > 1) {
      // Characters and adjacent bigrams, and deliberately *not* the whole run.
      //
      // Emitting the run would make "安装程序" a token only an exact repetition
      // could match: a document containing "安装程序报告错误" indexes that entire
      // string, and a search for the first four characters finds nothing. Since
      // every term has to be present, the run token would then fail the query
      // even though the characters are all there. Bigrams are the standard
      // answer to a script with no spaces and no segmenter.
      for (const character of token) tokens.push(character)
      for (let at = 0; at + 1 < token.length; at += 1) tokens.push(token.slice(at, at + 2))
      continue
    }
    tokens.push(token)
  }
  return tokens
}

/** A stable digest over the index's own contents, for corruption detection. */
function digestOf(documents: readonly IndexableRecord[], postings: Map<string, Set<string>>): string {
  // Order-independent: the same content must produce the same digest whatever
  // order it was added in, or every rebuild would look like corruption.
  let hash = 0x811c9dc5
  const parts = [
    ...documents.map(document => `${document.recordId}@${document.revisionId}`).sort(),
    ...[...postings.keys()].sort().map(token => `${token}:${String(postings.get(token)?.size ?? 0)}`),
  ]
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Decode one round of percent-escapes, without ever throwing.
 *
 * `decodeURIComponent` is the obvious tool and the wrong one: it throws on a
 * malformed escape, so a file legitimately named `100%.json` would be refused
 * as hostile. This decodes only well-formed `%XX` pairs and leaves everything
 * else exactly as it arrived.
 */
function decodeOnce(value: string): string {
  return value.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * Every form a path can decode to, including the one that arrived.
 *
 * A traversal survives encoding, and it survives being encoded twice. Checking
 * only the string as received missed `..%2f` — literal dots joined by an
 * encoded separator — which reads as harmless until something downstream
 * decodes it and it becomes `../`. Bounded at four rounds, which is three more
 * than anything legitimate needs.
 */
function decodings(candidate: string): readonly string[] {
  const forms = [candidate]
  let current = candidate
  for (let round = 0; round < 4; round += 1) {
    const next = decodeOnce(current)
    if (next === current) break
    forms.push(next)
    current = next
  }
  return forms
}

/**
 * Is this path inside one of the roots the caller allows?
 *
 * Refusal is the safe direction, so anything ambiguous is refused. The root
 * comparison is case-sensitive: on a case-insensitive filesystem that can
 * refuse a legitimate path, which is a nuisance, but it can never admit an
 * illegitimate one.
 */
export function isWithinRoots(candidate: string, roots: readonly string[]): boolean {
  if (candidate === '') return false

  // The traversal check runs against every form, not only the one that arrived.
  for (const form of decodings(candidate)) {
    const normalized = form.replace(/\\/g, '/')
    if (normalized.split('/').includes('..')) return false
    if (normalized.includes('\0')) return false
  }

  const normalized = candidate.replace(/\\/g, '/')
  return roots.some(root => {
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
    return normalized === base || normalized.startsWith(`${base}/`)
  })
}

/** The local, derived, rebuildable search index. */
export class LibraryIndex {
  #documents = new Map<string, IndexableRecord>()
  #postings = new Map<string, Set<string>>()
  #health: IndexHealth = 'empty'
  #builtAt: string | null = null
  #pending = new Set<string>()
  #notes: string[] = []

  get health(): IndexHealth {
    return this.#health
  }

  get size(): number {
    return this.#documents.size
  }

  /** Ids indexing began but did not finish, so a resumed run knows where it was. */
  get pending(): readonly string[] {
    return [...this.#pending]
  }

  get diagnostics(): readonly string[] {
    return [...this.#notes]
  }

  /**
   * Add or replace one record.
   *
   * Idempotent by construction: the record's existing postings are removed
   * before the new ones are written, so re-indexing changed text cannot leave
   * the old words behind still pointing at the document. Indexing identical
   * content twice is a no-op, which is what makes an interrupted run safe to
   * simply repeat.
   */
  add(input: IndexableRecord): void {
    // Normalized at the door, exactly as `load` already does. The type says
    // every field is present, and the type is not enforced at runtime: these
    // records are built by walking tool output, which crosses a JSON boundary
    // and arrives as whatever the tool actually returned. A record missing
    // `tags` used to throw "not iterable" from inside the indexer, turning one
    // malformed record into a failed index.
    const record = normalizeRecord(input)
    if (record.recordId === '') return
    this.#pending.add(record.recordId)
    this.#removePostings(record.recordId)
    this.#documents.set(record.recordId, record)

    const haystack = [
      record.title,
      record.text,
      record.source ?? '',
      record.runId ?? '',
      record.verdict ?? '',
      ...record.tags,
    ].join(' ')

    for (const token of tokenize(haystack)) {
      let postings = this.#postings.get(token)
      if (postings === undefined) {
        postings = new Set()
        this.#postings.set(token, postings)
      }
      postings.add(record.recordId)
    }

    this.#pending.delete(record.recordId)
    this.#health = this.#documents.size === 0 ? 'empty' : 'ready'
    this.#builtAt = new Date().toISOString()
  }

  /** Index many, reporting progress so an interrupted run can resume. */
  addAll(records: readonly IndexableRecord[], signal?: AbortSignal): number {
    this.#health = 'indexing'
    let done = 0
    for (const record of records) {
      if (signal?.aborted ?? false) {
        this.#health = this.#documents.size === 0 ? 'empty' : 'stale'
        this.#notes.push(`indexing cancelled after ${String(done)} of ${String(records.length)}`)
        return done
      }
      this.add(record)
      done += 1
    }
    this.#health = this.#documents.size === 0 ? 'empty' : 'ready'
    return done
  }

  /**
   * Forget a record entirely.
   *
   * A deleted record must not survive as a search hit. Removing the document
   * without its postings would leave a token pointing at an id that no longer
   * resolves — a result that cannot be opened, which is worse than no result.
   */
  remove(recordId: string): boolean {
    if (!this.#documents.has(recordId)) return false
    this.#removePostings(recordId)
    this.#documents.delete(recordId)
    this.#pending.delete(recordId)
    if (this.#documents.size === 0) this.#health = 'empty'
    return true
  }

  /** Throw everything away. The point of a derived index. */
  clear(): void {
    this.#documents.clear()
    this.#postings.clear()
    this.#pending.clear()
    this.#notes = []
    this.#health = 'empty'
    this.#builtAt = null
  }

  /** Mark the index as behind the store, without discarding what it has. */
  markStale(reason: string): void {
    if (this.#health === 'ready') this.#health = 'stale'
    this.#notes.push(reason)
  }

  #removePostings(recordId: string): void {
    for (const [token, ids] of this.#postings) {
      if (ids.delete(recordId) && ids.size === 0) this.#postings.delete(token)
    }
  }

  /**
   * Search.
   *
   * Every term must be present — an AND over tokens. OR would return a page of
   * documents sharing one common word, which reads as the search being broken.
   *
   * The query string is never interpreted: it is tokenized exactly like indexed
   * text, so a regular expression, a glob, a SQL fragment or a path traversal
   * in the box is simply a set of words that will not be found. There is no
   * escaping to get wrong because there is nothing to escape into.
   */
  search(query: IndexQuery): IndexQueryResult {
    const notes: string[] = []
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const offset = Math.max(0, query.offset ?? 0)
    // Read through a function, not a narrowed property. TypeScript narrows
    // `aborted` after the first check and then believes it can never be true
    // again — which is exactly what a cancellation signal is for.
    const cancelled = (): boolean => query.signal?.aborted ?? false

    if (this.#health === 'corrupt') {
      return {
        results: [], total: 0, offset, limit, health: 'corrupt',
        notes: ['The index is unreadable and must be rebuilt.', ...this.#notes],
      }
    }
    if (cancelled()) {
      return { results: [], total: 0, offset, limit, health: this.#health, notes: ['Search cancelled.'] }
    }

    const terms = tokenize(query.text)
    let candidates: Set<string>
    if (terms.length === 0) {
      // An empty query lists everything the filters allow rather than nothing.
      // "Show me the library" is a real request.
      candidates = new Set(this.#documents.keys())
      notes.push('No search terms: showing everything the filters allow.')
    } else {
      candidates = this.#intersect(terms)
    }

    const matched: { record: IndexableRecord, score: number }[] = []
    for (const recordId of candidates) {
      if (cancelled()) {
        return { results: [], total: 0, offset, limit, health: this.#health, notes: ['Search cancelled.'] }
      }
      const record = this.#documents.get(recordId)
      if (record === undefined) continue
      if (!passesFilters(record, query)) continue
      matched.push({ record, score: scoreOf(record, terms) })
    }

    sortMatches(matched, query.sort ?? 'relevance')

    const total = matched.length
    const page = matched.slice(offset, offset + limit)
    if (total > offset + page.length) {
      notes.push(`Showing ${String(offset + 1)}–${String(offset + page.length)} of ${String(total)}.`)
    }
    if (this.#health === 'stale') {
      notes.push('The index is behind the store; some recent records may be missing.')
    }
    if (this.#health === 'indexing') {
      notes.push('Indexing is still running; this answer is partial.')
    }

    return {
      results: page.map(({ record, score }) => toResult(record, terms, score)),
      total,
      offset,
      limit,
      health: this.#health,
      notes,
    }
  }

  #intersect(terms: readonly string[]): Set<string> {
    let smallest: Set<string> | null = null
    for (const term of terms) {
      const postings = this.#postings.get(term)
      if (postings === undefined) return new Set()
      if (smallest === null || postings.size < smallest.size) smallest = postings
    }
    if (smallest === null) return new Set()
    const out = new Set<string>()
    for (const candidate of smallest) {
      if (terms.every(term => this.#postings.get(term)?.has(candidate) === true)) out.add(candidate)
    }
    return out
  }

  /** Serialise, with a digest so a later load can tell it was not damaged. */
  serialize(): SerializedIndex {
    const documents = [...this.#documents.values()]
    return {
      version: INDEX_VERSION,
      digest: digestOf(documents, this.#postings),
      builtAt: this.#builtAt ?? new Date().toISOString(),
      documents,
      postings: Object.fromEntries(
        [...this.#postings.entries()].map(([token, ids]) => [token, [...ids].sort()]),
      ),
    }
  }

  /**
   * Load a serialised index, refusing anything it cannot trust.
   *
   * A wrong version, a failed digest or a malformed body all produce a
   * `corrupt` index rather than a partial one. Half-loading is the failure that
   * looks like success: queries answer, and they answer wrongly.
   */
  static load(value: unknown): LibraryIndex {
    const index = new LibraryIndex()
    const fail = (reason: string): LibraryIndex => {
      index.#health = 'corrupt'
      index.#notes.push(reason)
      return index
    }

    if (typeof value !== 'object' || value === null) return fail('The stored index is not an object.')
    const stored = value as Partial<SerializedIndex>
    if (stored.version !== INDEX_VERSION) {
      return fail(`Index version ${String(stored.version)} cannot be read by this build (expects ${String(INDEX_VERSION)}).`)
    }
    if (!Array.isArray(stored.documents) || typeof stored.postings !== 'object' || stored.postings === null) {
      return fail('The stored index is missing its documents or postings.')
    }

    const documents: IndexableRecord[] = []
    for (const document of stored.documents) {
      if (typeof document !== 'object' || document === null) return fail('A stored document is malformed.')
      const record = document as Partial<IndexableRecord>
      if (typeof record.recordId !== 'string' || record.recordId === '') {
        return fail('A stored document has no id.')
      }
      documents.push(normalizeRecord(record))
    }

    const postings = new Map<string, Set<string>>()
    for (const [token, ids] of Object.entries(stored.postings)) {
      if (!Array.isArray(ids)) return fail(`Postings for "${token}" are malformed.`)
      postings.set(token, new Set(ids.filter((id): id is string => typeof id === 'string')))
    }

    if (digestOf(documents, postings) !== stored.digest) {
      return fail('The stored index failed its own digest — it has been modified or truncated.')
    }

    for (const document of documents) index.#documents.set(document.recordId, document)
    index.#postings = postings
    index.#builtAt = typeof stored.builtAt === 'string' ? stored.builtAt : null
    index.#health = documents.length === 0 ? 'empty' : 'ready'
    return index
  }
}

/** Fill in what a stored record may be missing, without inventing content. */
function normalizeRecord(record: Partial<IndexableRecord>): IndexableRecord {
  return {
    recordId: record.recordId ?? '',
    revisionId: typeof record.revisionId === 'string' ? record.revisionId : '',
    title: typeof record.title === 'string' ? record.title : '',
    kind: record.kind ?? 'document',
    text: typeof record.text === 'string' ? record.text : '',
    source: typeof record.source === 'string' ? record.source : null,
    runId: typeof record.runId === 'string' ? record.runId : null,
    observedAt: typeof record.observedAt === 'string' ? record.observedAt : null,
    verdict: typeof record.verdict === 'string' ? record.verdict : null,
    tags: Array.isArray(record.tags) ? record.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    evidenceIds: Array.isArray(record.evidenceIds)
      ? record.evidenceIds.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

function passesFilters(record: IndexableRecord, query: IndexQuery): boolean {
  if (query.kinds !== undefined && query.kinds.length > 0 && !query.kinds.includes(record.kind)) return false
  if (query.runIds !== undefined && query.runIds.length > 0) {
    if (record.runId === null || !query.runIds.includes(record.runId)) return false
  }
  if (query.verdicts !== undefined && query.verdicts.length > 0) {
    if (record.verdict === null || !query.verdicts.includes(record.verdict)) return false
  }
  if (query.sources !== undefined && query.sources.length > 0) {
    if (record.source === null || !query.sources.includes(record.source)) return false
  }
  if (query.tags !== undefined && query.tags.length > 0) {
    if (!query.tags.some(tag => record.tags.includes(tag))) return false
  }
  if (query.from !== undefined && (record.observedAt === null || record.observedAt < query.from)) return false
  if (query.to !== undefined && (record.observedAt === null || record.observedAt > query.to)) return false
  return true
}

/**
 * Score a match.
 *
 * Term frequency with a title bonus, and nothing more. A more elaborate
 * relevance model would be guessing, and this one is at least explicable: a
 * record whose title contains your words outranks one that merely mentions
 * them, and more mentions outrank fewer.
 */
function scoreOf(record: IndexableRecord, terms: readonly string[]): number {
  if (terms.length === 0) return 0
  const title = new Set(tokenize(record.title))
  const body = tokenize(record.text)
  let score = 0
  for (const term of terms) {
    if (title.has(term)) score += 5
    score += body.filter(token => token === term).length
  }
  return score
}

function sortMatches(
  matched: { record: IndexableRecord, score: number }[],
  sort: NonNullable<IndexQuery['sort']>,
): void {
  const time = (record: IndexableRecord): string => record.observedAt ?? ''
  matched.sort((left, right) => {
    if (sort === 'newest') return time(right.record).localeCompare(time(left.record))
    if (sort === 'oldest') return time(left.record).localeCompare(time(right.record))
    if (sort === 'title') return left.record.title.localeCompare(right.record.title)
    const byScore = right.score - left.score
    // Ties break on id so the same corpus always pages identically. A stable
    // order is what makes "page 2" mean anything.
    return byScore !== 0 ? byScore : left.record.recordId.localeCompare(right.record.recordId)
  })
}

/**
 * Build the snippet a person reads, around the first match.
 *
 * The text is returned verbatim and un-escaped — it is evidence, and altering
 * it here would make the snippet disagree with the source. Rendering is the
 * caller's job, and React escapes by default; this deliberately produces no
 * markup for a renderer to trust.
 */
export function snippetFor(text: string, terms: readonly string[], radius = 90): string {
  if (text === '' || terms.length === 0) return text.slice(0, radius * 2)
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) return text.slice(0, radius * 2)
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + radius)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

function toResult(record: IndexableRecord, terms: readonly string[], score: number): SearchResult {
  const hit: SearchHit = {
    sourceId: record.recordId,
    sourceRevisionId: record.revisionId,
    range: null,
    text: snippetFor(record.text === '' ? record.title : record.text, terms),
    path: 'lexical',
    score,
    evidenceIds: record.evidenceIds,
  }
  return {
    sourceId: record.recordId,
    title: record.title,
    kind: record.kind,
    hits: [hit],
    current: true,
  }
}
