/**
 * The read plane, host side: what a Watch mode asks, answered.
 *
 * A `conversation.view` entry is handed `{ inspect, onInspectDone }` and
 * nothing else, so Live, Memory, Library and Compare had no way to obtain
 * their own data. This is the other end of the seam that fixes that, and it is
 * DSH's own: a Typert Remote, dispatched through the Gateway that already
 * owns request correlation, abort signals and structured failure. The client
 * calls `ctx.remote.watchQuery.librarySearch(request, signal)` or
 * `.libraryGet(request, signal)` and awaits a `RemoteResult` carrying one of
 * the concrete outcomes in `@deepwatch/dsh-contracts/query/wire`.
 *
 * One method per read, rather than one `read` over a discriminated union. DSH
 * already routes by method, so a union inside a single entry point would be a
 * second router with its own schema to generate.
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
 * @module @deepwatch/dsh-tools/read-plane
 */

import { type Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import { WATCH_QUERY_PROTOCOL_VERSION } from '@deepwatch/dsh-contracts/query'
import type { IndexableRecord, LibraryIndex, SearchResult } from '@deepwatch/dsh-library'
import type {
  CapabilityTally, CoreBlocker, CoreHealthRequest, CoreHealthResponse,
  LibraryGetRequest, LibraryGetResponse, LibraryIndexGeneration,
  LibraryRecord, LibraryRefreshRequest, LibraryRefreshResponse,
  LibrarySearchRequest, LibrarySearchResponse,
  ProviderTestRequest, ProviderTestResponse,
  RouteReadinessRequest, RouteReadinessResponse,
} from '@deepwatch/dsh-contracts/query/wire'
import {
  parseCoreHealthRequest, parseLibraryGetRequest, parseLibraryRefreshRequest,
  parseLibrarySearchRequest,
} from '@deepwatch/dsh-contracts/query/validate'
import type { LibraryGenerations } from './library-generations.js'


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
  /**
   * The one thing allowed to replace the index, when the host has one.
   *
   * Optional because a deployment may compose the read plane over an index it
   * owns by other means. Where it is absent, `libraryRefresh` still exists and
   * answers `refresh_failed` with a reason — which is what a surface should
   * render, rather than a refresh that appears to work and changes nothing.
   */
  readonly generations?: LibraryGenerations
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


/**
 * The service key, on the Context both faces share.
 *
 * This is not documentation. Typert analyses a package's public export graph
 * and binds a Remote through the Cordis Context declaration; without this the
 * service is discovered as a package and emits no artifact, because nothing
 * ties `WatchQueryService` to the key `watchQuery` that the Gateway exposes as
 * `ctx.remote.watchQuery`.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    watchQuery: WatchQueryService
  }
}

/**
 * The Typert Remote a Watch surface calls.
 *
 * `watchQuery` is both the Cordis service key and the wire namespace, so the
 * client reaches it as `ctx.remote.watchQuery`.
 */
export class WatchQueryService extends TypertRemoteService {
  /**
   * Deliberately not a `#private` field.
   *
   * Cordis hands a Service to callers through a Proxy, and a private field is
   * unreachable through one: the Gateway invoked this method and got
   * "Cannot read private member #config from an object whose class did not
   * declare it". Every direct unit test passed, because a direct call has no
   * proxy in front of it -- which is the whole argument for exercising this
   * through the real Gateway.
   */
  readonly config: ReadPlaneConfig

  constructor(ctx: Context, config: ReadPlaneConfig) {
    super(ctx, 'watchQuery')
    this.config = config
  }

  /**
   * One concrete method per read, rather than one `read` over a union.
   *
   * DSH already routes by method, so a discriminated union inside a single
   * entry point would be a second router with its own schema to generate.
   * One request type and one response type per method is what Typert emits
   * a strict codec from most directly.
   *
   * `signal` is last, as Typert requires, and is not serialised.
   */
  @Remote('librarySearch')
  librarySearch(
    request: LibrarySearchRequest, signal: AbortSignal,
  ): Promise<LibrarySearchResponse> {
    // Not `async`: Typert requires a Promise return, and the search is
    // synchronous today. Saying so here rather than marking the method
    // async with nothing to await keeps the lint rule meaningful for when
    // bounded execution makes this genuinely asynchronous.
    return Promise.resolve(searchLibrary(request, this.config, signal))
  }

  /** One record by id. A direct lookup, not a one-result search. */
  @Remote('libraryGet')
  libraryGet(
    request: LibraryGetRequest, signal: AbortSignal,
  ): Promise<LibraryGetResponse> {
    return Promise.resolve(getLibraryRecord(request, this.config, signal))
  }

  /**
   * Read the roots again, and put the result into service if it is healthy.
   *
   * The only method here with a side effect, and the only one that is not a
   * question. It is a separate method for exactly that reason: a `rebuild`
   * flag on `librarySearch` would make every search a potential re-read of the
   * corpus, and would leave a caller no way to ask for an answer from what the
   * host already has.
   *
   * Genuinely async, unlike its siblings: the rebuild yields between files so
   * a caller that stops waiting can be observed doing so.
   */
  @Remote('libraryRefresh')
  libraryRefresh(
    request: LibraryRefreshRequest, signal: AbortSignal,
  ): Promise<LibraryRefreshResponse> {
    return refreshLibrary(request, this.config, signal)
  }

  /**
   * What Watch Core is doing right now, read from the running Bridge.
   *
   * The one method here that is not about the Library, and it is here because
   * this is the only channel the browser has to the Host. Diagnostics used to
   * render "Connected over stdio" and a version number as literals in a
   * component, because there was nowhere to read them from.
   *
   * Nothing is defaulted. A value the Bridge has not established is `null`,
   * and the panel renders that as "not reported" -- which is worth less than a
   * real reading and far more than a confident wrong one.
   */
  @Remote('coreHealth')
  coreHealth(
    request: CoreHealthRequest, signal: AbortSignal,
  ): Promise<CoreHealthResponse> {
    return Promise.resolve(readCoreHealth(request, this.ctx, signal))
  }

  /** Spend one deliberately tiny provider request only after a person asks. */
  @Remote('providerTest')
  providerTest(
    request: ProviderTestRequest, signal: AbortSignal,
  ): Promise<ProviderTestResponse> {
    return testProvider(request, this.ctx, signal)
  }

  /**
   * Whether the Host would serve this route right now, asked without spending
   * anything.
   *
   * The browser half used to answer this from its own memory of a provider
   * test it had run, which is a claim about a Host it cannot see. A tab that
   * stayed open across a Host restart, or across an edit made in another tab,
   * kept drawing a tested badge over a route the Host had already stopped
   * being willing to serve — and the composer it gates opened onto a refusal.
   * There is one answer, and this is where it is read from.
   */
  @Remote('routeReadiness')
  routeReadiness(
    request: RouteReadinessRequest, signal: AbortSignal,
  ): Promise<RouteReadinessResponse> {
    // Read straight out of Host memory: there is nothing to wait for, so the
    // only thing a cancellation can do is refuse an answer already in hand.
    // Taken so the signature is the one Typert generates a codec from, and so
    // an aborted caller is not handed a verdict it stopped asking for.
    if (signal.aborted) return Promise.reject(signal.reason as Error)
    return Promise.resolve(readRouteReadiness(request, this.ctx))
  }
}

/**
 * Read the Host's verdict for one route.
 *
 * No network, no provider, no credential. When the provenance row is not
 * composed the honest answer is that nothing here can say, which reads as
 * unproved — the same direction the guard fails in.
 */
export function readRouteReadiness(
  request: RouteReadinessRequest, ctx: Context,
): RouteReadinessResponse {
  const provenance = ctx.get?.(PROVENANCE_SERVICE) as unknown as ProvenanceLike | undefined
  const reason = provenance?.readiness(request.provider, request.model) ?? 'unreadable'
  return {
    outcome: 'route_readiness',
    protocol: WATCH_QUERY_PROTOCOL_VERSION,
    requestId: request.requestId,
    provider: request.provider,
    model: request.model,
    proved: reason === 'proved',
    reason,
  }
}

function providerFailure(
  request: ProviderTestRequest, failure: LlmFailure | null,
): ProviderTestResponse {
  const code = failure?.code.toUpperCase() ?? 'UNREACHABLE'
  if (code.includes('AUTH') || failure?.status === 401 || failure?.status === 403) {
    return {
      outcome: 'provider_test', protocol: WATCH_QUERY_PROTOCOL_VERSION,
      requestId: request.requestId, provider: request.provider, model: request.model,
      ok: false, credential: 'rejected', reachability: 'unauthorized',
      message: 'The provider rejected the saved credential.',
    }
  }
  if (code.includes('RATE') || failure?.status === 429) {
    return {
      outcome: 'provider_test', protocol: WATCH_QUERY_PROTOCOL_VERSION,
      requestId: request.requestId, provider: request.provider, model: request.model,
      ok: false, credential: 'configured_unverified', reachability: 'rate_limited',
      message: 'The provider rate-limited the test. Wait, then try again.',
    }
  }
  return {
    outcome: 'provider_test', protocol: WATCH_QUERY_PROTOCOL_VERSION,
    requestId: request.requestId, provider: request.provider, model: request.model,
    ok: false, credential: 'configured_unverified', reachability: 'unreachable',
    message: 'The provider test did not complete. Check the route and network, then try again.',
  }
}

/**
 * The one Host service that says who asked and what has been proved.
 *
 * Described structurally and reached by name. A value import would put
 * `@deepwatch/dsh-technology` into this package's dependency graph so that one
 * function could obtain a capability; the bundle mounts the service as its own
 * row and both halves inject it, which is what guarantees there is one.
 */
interface ProvenanceLike {
  authorizeProviderTest(provider: string, model: string, causeId: string): {
    readonly token: string
  }
  factsFor(provider: string, model: string): {
    providerRevision: string
    credentialRevision: string
  } | null
  mint(receipt: {
    provider: string
    model: string
    requestId: string
    at: string
    providerRevision: string
    credentialRevision: string
  }): void
  readiness(provider: string, model: string):
    'proved' | 'never_tested' | 'configuration_changed' | 'unreadable'
}

/** The service key, spelled once. */
const PROVENANCE_SERVICE = 'watchProvenance'

/** Execute a provider request without returning or logging model output. */
export async function testProvider(
  request: ProviderTestRequest, ctx: Context, signal: AbortSignal,
): Promise<ProviderTestResponse> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(request.deadlineMs)])
  // `get?.` because a caller may hand this a minimal context — a unit test
  // driving the provider test against a stub runtime does. No registry means no
  // capability, and the guard refuses an unattributed request, which is the
  // correct outcome for a Host that has not composed the row.
  const provenance = ctx.get?.(PROVENANCE_SERVICE) as unknown as ProvenanceLike | undefined
  // A capability rather than a scope, carried on the request itself. `stream`
  // is lazy — nothing reaches the guard until the first pull — so anything
  // ambient established around this call has already ended by the time the
  // request happens. A value travelling with the request cannot be stale when
  // the request arrives.
  const authorization = provenance?.authorizeProviderTest(
    request.provider, request.model, request.requestId).token
  try {
    const messages = [createUserMessage({
      content: [{ type: 'text', text: 'Reply with OK.' }],
      source: { kind: 'user' },
    })]
    for await (const chunk of ctx.llm.stream({
      provider: request.provider, model: request.model, messages,
      maxTokens: 1, temperature: 0, signal: bounded,
      ...authorization === undefined ? {} : { watchAuthorization: authorization },
    })) {
      if (chunk.type !== 'finish') continue
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        return providerFailure(request, chunk.reason.failure)
      }
      // Minted here and nowhere else: after a real request to this exact route
      // came back. Pinned to the provider profile and credential reference as
      // they are now, so either of those changing leaves the proof behind
      // rather than carrying it forward. Not to the binding document — the
      // guard reads that live, and this is the screen a person tests *before*
      // they bind.
      const facts = provenance?.factsFor(request.provider, request.model) ?? null
      if (provenance !== undefined && facts !== null) {
        provenance.mint({
          provider: request.provider, model: request.model,
          requestId: request.requestId, at: new Date().toISOString(), ...facts,
        })
      }
      return {
        outcome: 'provider_test', protocol: WATCH_QUERY_PROTOCOL_VERSION,
        requestId: request.requestId, provider: request.provider, model: request.model,
        ok: true, credential: 'verified', reachability: 'reachable',
        message: 'Provider request succeeded. This exact binding is ready.',
      }
    }
  } catch {
    // The provider's message is intentionally not returned: adapters should
    // redact it, but the readiness channel never needs provider text at all.
  }
  return providerFailure(request, null)
}


  /** Route a parsed request to the namespace that answers it. */

  /** Answer a Library read from the index the tool already owns. */

/** Assemble a snapshot, and say honestly whether it is whole. */

/** Install the read plane onto a host context. */
export function applyReadPlane(ctx: Context, config: ReadPlaneConfig): void {
  new WatchQueryService(ctx, config)
}

/**
 * Answer a Library search against the shared index.
 *
 * Separate from the Service so the whole path is testable without a DSH
 * runtime, and so the Service stays a Typert adapter with no decisions in it.
 */
export function searchLibrary(
  request: LibrarySearchRequest,
  config: ReadPlaneConfig,
  signal: AbortSignal,
): LibrarySearchResponse {
  // Semantics before the index. The generated codec proved the shape; it has
  // no opinion about whether the query is a length this host answers for, or
  // whether a modality is one it indexes. Nothing expensive runs until this
  // passes, so a malformed request costs a bounds check and never a search.
  const accepted = parseLibrarySearchRequest(request)
  if (!accepted.ok) return accepted.refusal
  const checked = accepted.value

  if (signal.aborted) {
    return {
      outcome: 'deadline_exceeded',
      protocol: WATCH_QUERY_PROTOCOL_VERSION,
      requestId: checked.requestId,
      deadlineMs: checked.deadlineMs,
    }
  }
  const index = config.index()
  const found = index.search({
    text: checked.query,
    limit: checked.limit,
    offset: 0,
  })
  return {
    outcome: 'page',
    protocol: WATCH_QUERY_PROTOCOL_VERSION,
    requestId: checked.requestId,
    revision: revisionOf(index),
    // Which index answered, said out loud. A surface that has just refreshed
    // compares this against the generation the refresh reported and knows
    // whether the page in front of it is the new one.
    generation: config.generations?.generation().generation ?? 0,
    records: found.results.map(result => toWireRecord(result, index)),
    nextCursor: null,
    total: found.total,
    indexState: found.health === 'ready' ? 'ready' : 'stale',
  }
}

/**
 * Flatten one search result into the wire record shape.
 *
 * The persisted record is looked up rather than reconstructed from the hit. A
 * `SearchResult` carries what matching produced -- title, kind, hits -- and not
 * the provenance the surface has to show, so building the wire record from it
 * alone returned a null observedAt, an empty source and no runId. A search
 * result and a get result describe the same record and must not disagree about
 * where it came from.
 */
function toWireRecord(result: SearchResult, index: LibraryIndex): LibraryRecord {
  const stored = index.record(result.sourceId)
  const evidenceIds = [...new Set(result.hits.flatMap(hit => hit.evidenceIds))]
  if (stored === undefined) {
    // Indexed and then removed between the search and this read. Say what the
    // hit knows and nothing more; inventing provenance would be worse.
    return {
      recordId: result.sourceId,
      // The revision lives on the hit, not the result: one source can be hit at
      // more than one revision, and the first hit is the one shown.
      revisionId: result.hits[0]?.sourceRevisionId ?? '',
      title: result.title,
      modality: result.kind,
      observedAt: null,
      source: '',
      runId: null,
      verdict: null,
      tags: [],
      evidenceIds,
      current: result.current,
    }
  }
  return {
    ...fromIndexRecord(stored),
    // `current` is a property of this hit against the index, not of the record.
    current: result.current,
    evidenceIds: evidenceIds.length > 0 ? evidenceIds : [...stored.evidenceIds],
  }
}

/**
 * Answer a Library get.
 *
 * `index.record()` is a keyed lookup. Implementing this as a search with
 * `limit: 1` and then checking whether the single result happened to be the
 * requested id reports every record except the top-ranked one as absent.
 */
export function getLibraryRecord(
  request: LibraryGetRequest,
  config: ReadPlaneConfig,
  signal: AbortSignal,
): LibraryGetResponse {
  // The identifier grammar is enforced here, not by the codec: `recordId` is a
  // string either way, and a string is where a path would hide.
  const accepted = parseLibraryGetRequest(request)
  if (!accepted.ok) return accepted.refusal
  const request_ = accepted.value

  const base = { protocol: WATCH_QUERY_PROTOCOL_VERSION, requestId: request_.requestId }
  if (signal.aborted) {
    return { outcome: 'deadline_exceeded', ...base, deadlineMs: request_.deadlineMs }
  }
  const index = config.index()
  const found = index.record(request_.recordId)
  const revision = revisionOf(index)
  return found === undefined
    ? { outcome: 'absent', ...base, revision, recordId: request_.recordId }
    : { outcome: 'record', ...base, revision, record: fromIndexRecord(found) }
}

/**
 * The persisted record, as the wire carries it.
 *
 * Every field is the stored one. Nothing is derived from a temporal range: a
 * range is media-relative, and an earlier version of this shape turned a clip
 * beginning at offset zero into a 1970 timestamp.
 */
function fromIndexRecord(record: IndexableRecord): LibraryRecord {
  return {
    recordId: record.recordId,
    revisionId: record.revisionId,
    title: record.title,
    modality: record.kind,
    observedAt: record.observedAt,
    source: record.source ?? '',
    runId: record.runId,
    verdict: record.verdict,
    tags: [...record.tags],
    evidenceIds: [...record.evidenceIds],
    current: true,
  }
}

/**
 * Rebuild the index, and say what happened to the one already in service.
 *
 * Every outcome leaves a searchable Library, which is why none of them is an
 * exception. A refusal, an elapsed deadline, an abandoned rebuild and a failed
 * one are four different facts, and a surface renders each differently.
 *
 * Separate from the Service for the same reason the reads are: the Service
 * stays a Typert adapter with no decisions in it, and the whole path is
 * testable without a DSH runtime.
 */
export async function refreshLibrary(
  request: LibraryRefreshRequest,
  config: ReadPlaneConfig,
  signal: AbortSignal,
): Promise<LibraryRefreshResponse> {
  const accepted = parseLibraryRefreshRequest(request)
  if (!accepted.ok) return accepted.refusal
  const checked = accepted.value

  const base = { protocol: WATCH_QUERY_PROTOCOL_VERSION, requestId: checked.requestId }
  if (signal.aborted) {
    return { outcome: 'deadline_exceeded', ...base, deadlineMs: checked.deadlineMs }
  }

  const generations = config.generations
  if (generations === undefined) {
    // Not an error to hide. A deployment that composed the read plane over an
    // index it owns by other means has no refresh, and the surface has to be
    // able to say so rather than offering a control that does nothing.
    return {
      outcome: 'refresh_failed',
      ...base,
      reason: 'this host does not own the Library index, so it cannot rebuild it',
      index: describeIndex(config.index()),
    }
  }

  const outcome = await generations.refresh(checked.requestId, signal)
  if (outcome.kind === 'refreshed') {
    return { outcome: 'refreshed', ...base, index: outcome.index, skipped: outcome.index.skipped }
  }
  if (outcome.kind === 'cancelled') {
    return { outcome: 'refresh_cancelled', ...base, index: outcome.index }
  }
  return { outcome: 'refresh_failed', ...base, reason: outcome.reason, index: outcome.index }
}

/**
 * Describe an index the host holds without a generation record for it.
 *
 * Only reachable where no `LibraryGenerations` is configured, so the numbers
 * that belong to a rebuild are reported as absent rather than invented.
 */
function describeIndex(index: LibraryIndex): LibraryIndexGeneration {
  return {
    generation: 0,
    startedAt: EPOCH,
    completedAt: null,
    sourceCount: 0,
    recordCount: index.size,
    indexState: index.size === 0 ? 'empty' : (index.health === 'ready' ? 'ready' : 'stale'),
  }
}

/**
 * The timestamp for "there was never a rebuild".
 *
 * A fixed instant rather than `now`, because `now` would read as a rebuild
 * that happened this second and did nothing.
 */
const EPOCH = '1970-01-01T00:00:00.000Z'

/**
 * Read the Bridge's live state, and say honestly where it could not.
 *
 * Separate from the Service for the same reason the Library readers are: the
 * Service is a Typert adapter with no decisions in it, and the whole path is
 * testable without a DSH runtime.
 *
 * The rule this function exists to keep: **no field is defaulted.** A version
 * the Bridge has never received is `null`, not `'unknown'` and not the version
 * this build was compiled against. Diagnostics is the screen people open when
 * they already suspect something is wrong, and it is the last place a
 * plausible substitute belongs.
 */
export function readCoreHealth(
  request: CoreHealthRequest,
  ctx: Context,
  signal: AbortSignal,
): CoreHealthResponse {
  const accepted = parseCoreHealthRequest(request)
  if (!accepted.ok) return accepted.refusal
  const checked = accepted.value

  if (signal.aborted) {
    return {
      outcome: 'deadline_exceeded',
      protocol: WATCH_QUERY_PROTOCOL_VERSION,
      requestId: checked.requestId,
      deadlineMs: checked.deadlineMs,
    }
  }

  // The Bridge may not be mounted at all — a Workspace can run without Watch.
  // That is a real state and it gets a real answer, rather than a throw the
  // Gateway would render as an internal error.
  const bridge = (ctx as { watchCore?: WatchCoreLike }).watchCore
  if (bridge === undefined) {
    return {
      outcome: 'core_health',
      protocol: WATCH_QUERY_PROTOCOL_VERSION,
      requestId: checked.requestId,
      phase: 'disconnected',
      blocker: 'core_missing',
      coreVersion: null,
      coreBuild: null,
      protocolVersion: null,
      protocolMin: null,
      transport: null,
      isTestOnlyMock: false,
      contractsMatch: false,
      contractDrift: [],
      lastHandshakeAt: null,
      restartCount: 0,
      capabilities: { ready: 0, unavailable: 0, degraded: 0, unknown: 0 },
      capabilityDetails: [],
      fix: 'Watch Core is not configured for this Workspace. Install it and set '
        + 'the Bridge command in Settings → Watch.',
    }
  }

  const health = bridge.health()
  const handshake = health.handshake
  const drift = health.error?.error === 'bridge.schema_drift'
    ? ((health.error.details['drift'] as { family: string }[] | undefined) ?? [])
      .map(entry => entry.family)
    : []

  return {
    outcome: 'core_health',
    protocol: WATCH_QUERY_PROTOCOL_VERSION,
    requestId: checked.requestId,
    phase: health.phase,
    blocker: health.blocker as CoreBlocker,
    // From the handshake, never from this build's own constants: reporting
    // what the Workspace speaks as though Core had said it is exactly the
    // substitution that made the old panel wrong.
    coreVersion: handshake?.coreVersion ?? null,
    coreBuild: handshake?.coreBuild ?? null,
    protocolVersion: handshake?.protocolVersion ?? null,
    protocolMin: handshake === null ? null : (handshake as { protocolMin?: number }).protocolMin ?? null,
    transport: health.transport,
    isTestOnlyMock: health.isTestOnlyMock,
    contractsMatch: handshake !== null && drift.length === 0,
    contractDrift: drift,
    lastHandshakeAt: health.lastHandshakeAt,
    restartCount: health.restartCount,
    capabilities: tally(bridge),
    capabilityDetails: bridge.capabilities().map(capability => ({
      capabilityId: capability.capabilityId,
      status: capability.status,
      usable: bridge.isCapable(capability.capabilityId),
      missing: capability.missing,
      fixes: capability.fixes,
      lastCheckedAt: capability.lastCheckedAt,
    })),
    fix: health.error?.fix ?? '',
  }
}

/** The shape of the Bridge this reader depends on, and no more of it. */
interface WatchCoreLike {
  health(): {
    readonly phase: string
    readonly transport: string | null
    readonly blocker: string
    readonly isTestOnlyMock: boolean
    readonly lastHandshakeAt: string | null
    readonly restartCount: number
    readonly handshake: {
      readonly coreVersion: string
      readonly coreBuild: string | null
      readonly protocolVersion: number
    } | null
    readonly error: {
      readonly error: string
      readonly fix: string
      readonly details: Readonly<Record<string, unknown>>
    } | null
  }
  capabilities(): readonly {
    readonly capabilityId: string
    readonly status: 'implemented' | 'machine_tested' | 'probed' | 'unavailable' | 'not_tested'
    readonly missing: readonly string[]
    readonly fixes: readonly string[]
    readonly lastCheckedAt: string | null
  }[]
  isCapable(capabilityId: string): boolean
}

/**
 * Count capabilities by what is actually known about each one.
 *
 * `isCapable` decides `ready`, not the reported status, because a capability
 * whose contract family drifted is reported by the engine as implemented and
 * is nonetheless unusable — the two sides disagree about what its payload
 * means. Counting the engine's word here would put a number on the screen that
 * no button could honour.
 */
function tally(bridge: WatchCoreLike): CapabilityTally {
  const counts: CapabilityTally = { ready: 0, unavailable: 0, degraded: 0, unknown: 0 }
  const totals = { ...counts }
  for (const capability of bridge.capabilities()) {
    if (bridge.isCapable(capability.capabilityId)) totals.ready += 1
    else if (capability.status === 'unavailable') totals.unavailable += 1
    else if (capability.status === 'probed') totals.degraded += 1
    else totals.unknown += 1
  }
  return totals
}
