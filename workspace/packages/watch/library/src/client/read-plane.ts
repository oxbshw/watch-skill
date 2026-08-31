/**
 * The Library's end of the read plane: what the surface asks, and what it does
 * with the answer.
 *
 * The Host end is `@deepwatch/dsh-tools`, which registers `WatchQueryService`
 * and lets Typert generate a strict Remote from it. The Library does not import
 * that generated artifact and does not mount it. Doing either would make the
 * package that owns the Library capability depend on the package that reads it,
 * which is the cycle `@deepwatch/dsh-client-remotes` exists to remove.
 *
 * So the namespace is described here from the contracts both ends already
 * share. `@deepwatch/dsh-contracts/query/wire` is the single definition of
 * every request and response on this wire — the generated declaration imports
 * its types from exactly that module — and `RemoteResult` is upstream's own
 * envelope. Nothing below restates a shape either side owns.
 *
 * That leaves one thing a shared contract cannot prove: that the namespace
 * really is called `watchQuery` and really carries these two methods. Two
 * things hold it. `@deepwatch/dsh-client-remotes` compares this interface
 * against the generated one at compile time, so a changed signature stops the
 * build; and `tests/remote-client-mount.test.mjs` mounts the real contribution
 * through the real Gateway and calls it, so a changed *name* fails a test
 * rather than a page.
 *
 * @module @deepwatch/dsh-library/client/read-plane
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  LibraryGetRequest,
  LibraryGetResponse,
  LibraryRecord,
  LibraryRefreshRequest,
  CoreHealthRequest,
  CoreHealthResponse,
  LibraryRefreshResponse,
  LibrarySearchPage,
  LibrarySearchRequest,
  LibrarySearchResponse,
} from '@deepwatch/dsh-contracts/query/wire'
import { WATCH_QUERY_WIRE_VERSION } from '@deepwatch/dsh-contracts/query/wire'
import type { IndexHealth, IndexQueryResult } from '../index-store.js'

/**
 * The `watchQuery` namespace, as the Library calls it.
 *
 * `ctx.remote.watchQuery` is a cordis service the Gateway installs when the
 * contribution is mounted, so a surface that injects `remote.watchQuery` is
 * handed exactly this.
 */
export interface WatchQueryRemote {
  readonly librarySearch: (
    request: LibrarySearchRequest, signal?: AbortSignal,
  ) => Promise<RemoteResult<LibrarySearchResponse>>
  readonly libraryGet: (
    request: LibraryGetRequest, signal?: AbortSignal,
  ) => Promise<RemoteResult<LibraryGetResponse>>
  /**
   * The only method here with a side effect.
   *
   * A separate operation rather than a flag on a search: a search that might
   * re-read the corpus has a cost nobody can predict, and leaves a caller no
   * way to ask for an answer from what the host already holds.
   */
  readonly libraryRefresh: (
    request: LibraryRefreshRequest, signal?: AbortSignal,
  ) => Promise<RemoteResult<LibraryRefreshResponse>>
  /**
   * The state of Watch Core, read from the running Bridge.
   *
   * Not a Library read, and on this namespace because this is the only channel
   * the browser has to the Host. Diagnostics is its caller: before it existed
   * that panel rendered the engine's connection state and version as literals,
   * because there was nowhere to read them from.
   */
  readonly coreHealth: (
    request: CoreHealthRequest, signal?: AbortSignal,
  ) => Promise<RemoteResult<CoreHealthResponse>>
}

/** One row of results, however the surface obtained it. */
export interface ResultRow {
  /** Stable across a re-render of the same answer. */
  readonly key: string
  readonly recordId: string
  readonly title: string
  readonly kind: string
  /** Matched text, verbatim. Empty when the answer carried no excerpt. */
  readonly snippets: readonly string[]
  readonly evidenceCount: number
  /** False when a newer revision of the same source exists. */
  readonly current: boolean
}

/** What one completed search left on the screen. */
export interface SearchState {
  readonly rows: readonly ResultRow[]
  /** Matches in total, not merely on this page. */
  readonly total: number
  readonly health: IndexHealth
  /** Which index generation answered. Zero when the host tracks none. */
  readonly generation: number
  /** Non-fatal facts about this answer: truncation, staleness, refusal. */
  readonly notes: readonly string[]
  /** Whether the caller may ask for another page of the same answer. */
  readonly pageable: boolean
}

/** What the surface is asking the host for. */
export interface LibraryQuery {
  readonly text: string
  /** One modality, or the empty string for all of them. */
  readonly modality: string
  readonly limit: number
  readonly deadlineMs: number
}

/**
 * Correlation ids, from a counter rather than from randomness.
 *
 * The host refuses a `requestId` that is not an identifier, and a counter
 * produces one by construction. It is also what makes a failing request
 * quotable: `library-7` names a call somebody can find twice.
 */
let sequence = 0

/** The next correlation id for a Library read. */
export function nextRequestId(): string {
  sequence += 1
  return `library-${String(sequence)}`
}

/** An answer that produced no rows, and says why. */
function nothing(note: string, health: IndexHealth = 'stale'): SearchState {
  return { rows: [], total: 0, health, generation: 0, notes: [note], pageable: false }
}

/** The host's own vocabulary for index condition, in the surface's terms. */
function healthOf(state: LibrarySearchPage['indexState']): IndexHealth {
  return state === 'rebuilding' ? 'indexing' : state
}

/** One wire record as a row. */
function rowOf(record: LibraryRecord): ResultRow {
  return {
    key: `${record.recordId}@${record.revisionId}`,
    recordId: record.recordId,
    title: record.title,
    kind: record.modality,
    // The wire record carries provenance, not excerpts: the Host answers with
    // what it persisted, and inventing a snippet from a title would put text on
    // screen that no record contains.
    snippets: [],
    evidenceCount: record.evidenceIds.length,
    current: record.current,
  }
}

/**
 * Ask the host, and turn whatever comes back into something renderable.
 *
 * Every outcome is an answer the surface shows rather than an exception it
 * swallows. A refusal, an elapsed deadline and an expired cursor are different
 * facts, and a person acts differently on each, so each keeps its own sentence.
 */
export async function readLibraryPage(
  reads: WatchQueryRemote, query: LibraryQuery, signal: AbortSignal,
): Promise<SearchState> {
  const answer = await reads.librarySearch({
    protocol: WATCH_QUERY_WIRE_VERSION,
    requestId: nextRequestId(),
    query: query.text,
    modalities: query.modality === '' ? [] : [query.modality],
    limit: query.limit,
    cursor: null,
    deadlineMs: query.deadlineMs,
  }, signal)

  // The transport envelope first. `ok: false` means the call never produced a
  // domain answer at all — no Connection, a Gateway refusal, a codec that
  // rejected the response — and reporting that as an empty library would be a
  // lie about what the workspace contains.
  if (!answer.ok) {
    return nothing(`The Library host did not answer: ${answer.error.message}`, 'corrupt')
  }

  const value = answer.value
  switch (value.outcome) {
    case 'page': {
      const notes = value.records.length < value.total
        ? [`Showing ${String(value.records.length)} of ${String(value.total)} matches; `
          + 'the host answered with one page and offered no cursor.']
        : []
      return {
        rows: value.records.map(rowOf),
        total: value.total,
        health: healthOf(value.indexState),
        generation: value.generation,
        notes,
        // `nextCursor` is the host's own statement about whether more remains.
        // Deriving it from `total` instead would offer a Next control the host
        // has no way to answer.
        pageable: value.nextCursor !== null,
      }
    }
    case 'rejected':
      return nothing(
        `The host refused the request (${value.reason}`
        + `${value.field === null ? '' : ` at ${value.field}`}).`,
      )
    case 'deadline_exceeded':
      return nothing(
        `The host did not answer within ${String(value.deadlineMs)}ms. Try a narrower query.`,
      )
    case 'cursor_expired':
      return nothing('That page is no longer held by the host. Search again.')
  }
}

/** A local index answer as the same view model, so the surface renders one shape. */
export function fromIndex(result: IndexQueryResult): SearchState {
  return {
    rows: result.results.map(entry => ({
      key: entry.sourceId,
      recordId: entry.sourceId,
      title: entry.title,
      kind: entry.kind,
      snippets: entry.hits.map(hit => hit.text),
      evidenceCount: entry.hits[0]?.evidenceIds.length ?? 0,
      current: entry.current,
    })),
    total: result.total,
    health: result.health,
    // The local index is not a host generation and does not pretend to be one.
    generation: 0,
    notes: result.notes,
    pageable: true,
  }
}

/** What a completed refresh left for the surface to say. */
export interface RefreshState {
  /** True only where the host swapped a new generation into service. */
  readonly refreshed: boolean
  /** The generation now answering searches. */
  readonly generation: number
  readonly recordCount: number
  /** One sentence a person can act on. Empty where there is nothing to say. */
  readonly note: string
  /** Whether the note describes a failure rather than a result. */
  readonly failed: boolean
}

/**
 * Ask the host to read its roots again.
 *
 * Every outcome is rendered, and none of them is an exception. A refusal, an
 * elapsed deadline, an abandoned rebuild and a failed one are four different
 * facts; so is a rebuild that succeeded and found nothing new. Reporting any
 * of them as "refreshed" would be a control that lies about what it did.
 */
export async function refreshLibrary(
  reads: WatchQueryRemote, deadlineMs: number, signal: AbortSignal,
): Promise<RefreshState> {
  const answer = await reads.libraryRefresh({
    protocol: WATCH_QUERY_WIRE_VERSION,
    requestId: nextRequestId(),
    deadlineMs,
  }, signal)

  if (!answer.ok) {
    return failedRefresh(`The Library host did not answer: ${answer.error.message}`)
  }

  const value = answer.value
  switch (value.outcome) {
    case 'refreshed':
      return {
        refreshed: true,
        generation: value.index.generation,
        recordCount: value.index.recordCount,
        note: value.skipped.length === 0
          ? ''
          : `${String(value.skipped.length)} file(s) were not readable: `
            + value.skipped.slice(0, 3).join('; '),
        failed: false,
      }
    case 'refresh_cancelled':
      return {
        refreshed: false,
        generation: value.index.generation,
        recordCount: value.index.recordCount,
        note: 'The refresh was abandoned. The Library is unchanged.',
        failed: false,
      }
    case 'refresh_failed':
      return {
        refreshed: false,
        generation: value.index.generation,
        recordCount: value.index.recordCount,
        note: `The refresh failed: ${value.reason}. The previous index is still searchable.`,
        failed: true,
      }
    case 'rejected':
      return failedRefresh(`The host refused the refresh (${value.reason}).`)
    case 'deadline_exceeded':
      return failedRefresh(
        `The refresh did not finish within ${String(value.deadlineMs)}ms. `
        + 'It may still be running on the host.',
      )
  }
}

/** A refresh that produced no generation, and why. */
function failedRefresh(note: string): RefreshState {
  return { refreshed: false, generation: 0, recordCount: 0, note, failed: true }
}
