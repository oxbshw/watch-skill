/**
 * The read plane, host side: what a Watch mode asks, answered.
 *
 * A `conversation.view` entry is handed `{ inspect, onInspectDone }` and
 * nothing else, so Live, Memory, Library and Compare had no way to obtain
 * their own data. This is the other end of the seam that fixes that, and it is
 * DSH's own: a Typert Remote, dispatched through the Gateway that already
 * owns request correlation, abort signals and structured failure. The client
 * calls `ctx.remote.watchQuery.read(request)` and awaits a snapshot.
 *
 * It reads the same `LibraryIndex` the `watch_library_search` tool reads. One
 * index, one set of semantics, one place where "every term must match" is
 * decided -- two would drift inside a release and disagree about what the
 * library contains, and the disagreement would surface as a person searching
 * the UI and the agent searching the tool getting different answers to the
 * same question.
 *
 * Four things it will not do.
 *
 * It performs no write. Every operation answers a question, and the request
 * union has no member that changes anything, so a surface cannot acquire a
 * side effect and captured or model-generated content reaching these fields
 * cannot become an action.
 *
 * It reads nothing the caller names. Parameters are identifiers from a charset
 * with no separator or colon; the roots come from configuration. A caller
 * cannot point this at a path.
 *
 * It answers within the deadline it was given, or refuses. A slow host must
 * not become a hung surface, and the timer is cleared on every exit so a
 * completed read leaves nothing behind.
 *
 * And it never reports a partial answer as a whole one. A rebuilding or stale
 * index answers `complete: false` with what it has, because a search that
 * quietly returns less than it should is worse than one that says it is
 * behind.
 *
 * @module @watchskill/dsh-tools/read-plane
 */

import { type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import {
  encodeCursor,
  decodeCursor,
  parseQueryRequest,
  queryRefusal,
  WATCH_QUERY_PROTOCOL_VERSION,
} from '@watchskill/dsh-contracts/query'
import type {
  LibraryRecordView,
  QueryRequest,
  QuerySnapshot,
  QueryResult,
} from '@watchskill/dsh-contracts/query'
import type { WatchResult } from '@watchskill/dsh-contracts'
import type {
  IndexQuery, IndexQueryResult, LibraryIndex, SearchResult,
} from '@watchskill/dsh-library'

/** The two reads this namespace serves, narrowed off the request union. */
type LibraryRequest = Extract<QueryRequest, { namespace: 'library' }>

/** What the read plane needs from its host. */
export interface ReadPlaneConfig {
  /**
   * The index to read, built and cached by whoever owns it.
   *
   * A function rather than a value so a rebuild behind the tool is visible
   * here without either side holding a reference to a stale object.
   */
  readonly index: () => LibraryIndex
  /**
   * Which workspace this host is answering for.
   *
   * Cursors are bound to it, so one issued here cannot be replayed against
   * another workspace's snapshot.
   */
  readonly scope: string
}

/**
 * A revision that advances whenever the answer could have changed.
 *
 * Two things move it, and it needs both. `size` catches a record added or
 * removed. A rebuild that happens to produce the same count would not move
 * that, so each distinct index instance also gets a generation -- the host
 * builds a new `LibraryIndex` when it rebuilds, so a new object is exactly the
 * signal.
 *
 * It was briefly derived from a query's `total`, which is wrong in a way worth
 * recording: `total` is a property of the question, not of the index, so a
 * cursor issued by a two-match search was rejected by a three-record index and
 * paging never worked.
 *
 * Not a wall clock. Two hosts with unsynchronised clocks would order answers
 * wrongly rather than merely coarsely, which is the one thing a revision must
 * not do.
 */
const generations = new WeakMap<LibraryIndex, number>()
let nextGeneration = 1

function revisionOf(index: LibraryIndex): number {
  let generation = generations.get(index)
  if (generation === undefined) {
    generation = nextGeneration
    nextGeneration += 1
    generations.set(index, generation)
  }
  // Two small numbers in one, so both changes are visible and the result stays
  // a safe integer for any corpus anyone will hold in memory.
  return generation * 1_000_000 + index.size
}

/** Flatten one search result into the shape a surface renders. */
function toRecordView(result: SearchResult): LibraryRecordView {
  const evidenceIds = [...new Set(result.hits.flatMap(hit => hit.evidenceIds))]
  const firstHit = result.hits[0]
  return {
    recordId: result.sourceId,
    title: result.title,
    modality: result.kind,
    capturedAt: firstHit?.range === null || firstHit?.range === undefined
      ? null
      : new Date(firstHit.range.startMs).toISOString(),
    // Stated rather than implied: a hit is an observation of a source, and
    // whether the source's claim holds is `watch_verify`'s question.
    provenance: result.current ? 'observation' : 'observation (superseded revision)',
    evidenceIds,
  }
}

/**
 * Answer one read.
 *
 * Exported, and separate from the Service below, so the whole read path can be
 * exercised against a real index without standing up a DSH runtime. The
 * Service is a Typert adapter and nothing else; everything that decides an
 * answer is here.
 *
 * The request is parsed before anything else touches it, including one this
 * distribution's own client produced: a surface is reachable by anything that
 * can reach the page, and "our own code sent it" is an assumption.
 */
export async function answerQuery(
  request: unknown, config: ReadPlaneConfig,
): Promise<WatchResult<QuerySnapshot<unknown>>> {
  const parsed = parseQueryRequest(request)
  if (!parsed.ok) return parsed

  const query = parsed.value
  return await withDeadline(query, () => dispatch(query, config))
}

/**
 * The Typert Remote a Watch surface calls.
 *
 * `watchQuery` is both the Cordis service key and the wire namespace, so the
 * client reaches it as `ctx.remote.watchQuery`.
 */
export class WatchQueryService extends TypertRemoteService {
  readonly #config: ReadPlaneConfig

  constructor(ctx: Context, config: ReadPlaneConfig) {
    super(ctx, 'watchQuery')
    this.#config = config
  }

  /** The wire entry point. Everything it decides lives in `answerQuery`. */
  @Remote('read')
  async read(request: unknown): Promise<WatchResult<QuerySnapshot<unknown>>> {
    return await answerQuery(request, this.#config)
  }
}

/**
 * Run an answer against its deadline.
 *
 * The timer is cleared on every path. A read that completes must not leave a
 * pending timer behind, and a read that times out must not later resolve into
 * a surface that has stopped listening.
 */
async function withDeadline(
  query: QueryRequest,
  answer: () => QueryResult<unknown>,
): Promise<WatchResult<QuerySnapshot<unknown>>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(answer),
        new Promise<WatchResult<QuerySnapshot<unknown>>>((resolve) => {
          timer = setTimeout(() => {
            resolve(queryRefusal(
              'deadline_exceeded',
              `${query.namespace}/${query.operation} did not answer within `
              + `${String(query.deadlineMs)}ms.`,
              'Narrow the query, or raise the deadline the surface asks for.',
              { requestId: query.requestId },
            ))
          }, query.deadlineMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** Route a parsed request to the namespace that answers it. */
function dispatch(query: QueryRequest, config: ReadPlaneConfig): QueryResult<unknown> {
    if (query.namespace === 'library') return library(query, config)

    // Said plainly rather than answered with an empty page. An empty result
    // and an unimplemented capability look identical to a surface, and
    // conflating them is how a missing feature reads as "nothing here yet".
    return queryRefusal(
      'unavailable',
      `${query.namespace} is not served by this host yet.`,
      'Library is implemented; Memory, Compare and Live follow the same seam.',
      { requestId: query.requestId },
    )
  }

  /** Answer a Library read from the index the tool already owns. */
function library(query: LibraryRequest, config: ReadPlaneConfig): QueryResult<LibraryRecordView> {
    const index = config.index()

    if (query.operation === 'get') {
      const found = index.search({ text: '', limit: 1, offset: 0 })
      const match = found.results.find(result => result.sourceId === query.params.recordId)
      if (match === undefined) {
        return snapshot(query, [], revisionOf(index), null, found)
      }
      return snapshot(query, [toRecordView(match)], revisionOf(index), null, found)
    }

    // search
    const params = query.params
    const resumed = query.cursor === null
      ? null
      : decodeCursor(query.cursor, {
          namespace: 'library',
          operation: 'search',
          scope: config.scope,
          revision: revisionOf(index),
        })
    if (query.cursor !== null && resumed === null) {
      return queryRefusal(
        'cursor_expired',
        'That cursor was issued against a snapshot this host no longer holds.',
        'Search again without a cursor; the first page is current.',
        { requestId: query.requestId },
      )
    }

    const offset = resumed?.offset ?? 0
    // Built in two shapes rather than with an explicit `undefined`: the index
    // declares `kinds` optional, and `exactOptionalPropertyTypes` distinguishes
    // "absent" from "present and undefined".
    const base: IndexQuery = { text: params.query, limit: params.limit, offset }
    const found = index.search(
      params.modalities.length === 0
        ? base
        : {
            ...base,
            kinds: params.modalities as unknown as NonNullable<IndexQuery['kinds']>,
          },
    )

    const revision = revisionOf(index)
    const consumed = offset + found.results.length
    const nextCursor = consumed < found.total
      ? encodeCursor({
          namespace: 'library',
          operation: 'search',
          scope: config.scope,
          revision,
          offset: consumed,
        })
      : null

  return snapshot(query, found.results.map(toRecordView), revision, nextCursor, found)
}

/** Assemble a snapshot, and say honestly whether it is whole. */
function snapshot(
  query: QueryRequest,
  items: readonly LibraryRecordView[],
  revision: number,
  nextCursor: string | null,
  found: IndexQueryResult,
): QueryResult<LibraryRecordView> {
  return {
    ok: true,
    value: {
      protocol: WATCH_QUERY_PROTOCOL_VERSION,
      requestId: query.requestId,
      revision,
      items,
      nextCursor,
      // A stale or rebuilding index answers with what it has. The surface has
      // to be able to say so rather than presenting a partial answer as whole.
      complete: found.health === 'ready' && found.notes.length === 0,
    },
  }
}

/** Install the read plane onto a host context. */
export function applyReadPlane(ctx: Context, config: ReadPlaneConfig): void {
  new WatchQueryService(ctx, config)
}
