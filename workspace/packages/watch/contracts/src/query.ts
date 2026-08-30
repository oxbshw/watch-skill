/**
 * The read plane: how a Watch mode asks the host what it should render.
 *
 * Watch contributes tools, and a tool result is how evidence reaches the
 * *conversation*. It is not how a surface populates itself. A
 * `conversation.view` entry is handed `{ inspect, onInspectDone }` and nothing
 * else, so Live, Memory, Library and Compare had no way to obtain their own
 * data and each defaulted to an empty array. Four of the seven modes rendered
 * an honest empty state, which is a truthful surface and not a working one.
 *
 * The seam this uses is DSH's own. `packages/typert` defines Remote services
 * dispatched through a Gateway that already owns request correlation, abort
 * signals and structured failure, and `ctx.remote` is the client face of it.
 * An earlier note in this distribution described `ctx.remote` as an event bus
 * rather than a query client. That is true of `$on`/`$dispatch` and misses the
 * typed invocation path beside them, and the conclusion drawn from it -- that
 * populating these modes would mean building a second data path -- was the
 * wrong one. Nothing here is a second path.
 *
 * Every operation is enumerated. There is no open `operation: string` with a
 * free-form `params` object: a request is one member of a discriminated union
 * or it is refused, so a surface cannot ask for something the host does not
 * implement and the host cannot receive a shape it did not expect.
 *
 * Four properties this exists to guarantee.
 *
 * **Reads cannot express a write.** Every operation answers a question. A
 * request that changes something is not in the union, so a surface cannot
 * acquire a side effect by accident and captured or model-generated content
 * reaching these fields cannot become an action.
 *
 * **Nothing here names a location.** Identifiers are drawn from a charset with
 * no separator, no colon and no dot-dot, so a parameter cannot carry a
 * filesystem path, a UNC share, an executable name or a storage URL. The host
 * decides where it reads; the caller only says which record.
 *
 * **Every answer carries a revision, and a stale one is dropped.** Two reads
 * issued in order can return out of order, and a surface that renders whichever
 * arrived last shows older data than it had a moment ago -- intermittently, and
 * under load, which is where that bug survives review.
 *
 * **Everything is bounded.** Request size, string length, array length, nesting
 * depth, identifier length and cursor length all have limits, because the cost
 * of a malformed request must not be a function of how malformed it is.
 *
 * Cancellation is deliberately absent from this module. Typert dispatches with
 * an `AbortSignal`, and a second cancellation protocol carried in the payload
 * would be a way for the two to disagree about whether a call is still live.
 *
 * Browser-safe like the rest of this package: no Node imports, no runtime
 * identity, nothing a client bundle would have to deduplicate.
 *
 * @module @deepwatch/dsh-contracts/query
 */

import type { WatchResult } from './index.js'
import { watchError } from './index.js'

/** The read-plane contract version this build speaks. */
export const WATCH_QUERY_PROTOCOL_VERSION = 1

/** The oldest read-plane contract this build still answers. */
export const WATCH_QUERY_PROTOCOL_MIN = 1

/**
 * Every bound the read plane enforces.
 *
 * Stated in one place so a reviewer can see the whole budget at once, and so a
 * test can assert against the same numbers the parser uses.
 */
export const QUERY_LIMITS = {
  /** A whole request, serialised. Generous for a query, useless as a channel. */
  requestBytes: 8192,
  /** Any single string the caller supplies. */
  stringLength: 2048,
  /** A free-text search term. Shorter than a general string on purpose. */
  queryLength: 512,
  /** Any array the caller supplies. */
  arrayLength: 64,
  /** How deep a params object may nest before it is refused. */
  depth: 6,
  /** An identifier: record ids, session ids, scope names. */
  identifierLength: 128,
  /** A request id. */
  requestIdLength: 64,
  /** A cursor, which the host issued and the caller returns unchanged. */
  cursorLength: 512,
  /** The most records one page may carry, whatever the caller asked for. */
  limit: 200,
  /** The longest a surface may wait before it must show something. */
  deadlineMs: 30_000,
} as const

/** The namespaces a mode may read from. Reads only; there is no write here. */
export const QUERY_NAMESPACES = ['library', 'memory', 'compare', 'live'] as const

/** One readable namespace. */
export type QueryNamespace = (typeof QUERY_NAMESPACES)[number]

/**
 * Every operation the host implements, by namespace.
 *
 * The parser rejects anything absent from this table, so adding an operation
 * is one edit and forgetting to implement one is a refusal rather than an
 * undefined call.
 */
export const QUERY_OPERATIONS = {
  library: ['search', 'get'],
  memory: ['list', 'get'],
  compare: ['pair'],
  live: ['state'],
} as const satisfies Record<QueryNamespace, readonly string[]>

/** Why a read was refused. */
export type QueryErrorCode =
  /** The host speaks a contract this client cannot read, or the reverse. */
  | 'protocol_mismatch'
  /** The namespace is not one this host serves. */
  | 'unknown_namespace'
  /** The namespace exists; this operation in it does not. */
  | 'unknown_operation'
  /** The request did not satisfy the contract; nothing was executed. */
  | 'malformed_request'
  /** The request exceeded a size, depth or length bound. */
  | 'request_too_large'
  /** The deadline passed before an answer existed. */
  | 'deadline_exceeded'
  /** The caller aborted, or the surface was disposed. */
  | 'cancelled'
  /** The host is present but this capability is not available here. */
  | 'unavailable'
  /** The cursor is not one this host issued for this scope and snapshot. */
  | 'cursor_expired'
  /** The host answered, and the answer did not satisfy the contract. */
  | 'malformed_response'

/**
 * A monotonic revision.
 *
 * Compared, never interpreted. Deliberately not a timestamp: two hosts with
 * unsynchronised clocks would produce an ordering that is wrong rather than
 * merely coarse.
 */
export type Revision = number

// ── parameter shapes ────────────────────────────────────────────────────────

/** What a Library search asks for. */
export interface LibrarySearchParams {
  /** Free text. Every term must match; the host decides how it tokenises. */
  readonly query: string
  readonly limit: number
  /** Restrict to these modalities, or all of them when empty. */
  readonly modalities: readonly string[]
}

/** One Library record, by id. */
export interface LibraryGetParams {
  readonly recordId: string
}

/** What a Memory listing asks for. */
export interface MemoryListParams {
  /** Which memory scope to read. The host maps this to a store. */
  readonly scope: string
  readonly limit: number
}

/** One memory card, by id. */
export interface MemoryGetParams {
  readonly cardId: string
}

/** The two records a comparison is over. */
export interface ComparePairParams {
  readonly leftId: string
  readonly rightId: string
}

/** Live has no parameters: it reports the session the host already has. */
export type LiveStateParams = Record<string, never>

// ── the request union ───────────────────────────────────────────────────────

/** What every read carries, whatever it asks for. */
export interface QueryEnvelope {
  readonly protocol: number
  /** Correlates the answer. Typert owns cancellation; this is for logs. */
  readonly requestId: string
  /** How long the caller will wait. Clamped to the limit above. */
  readonly deadlineMs: number
  /** Continues an earlier snapshot, when the host issued one. */
  readonly cursor: string | null
}

/** One fully-typed read. */
export type QueryRequest =
  | (QueryEnvelope & { readonly namespace: 'library', readonly operation: 'search', readonly params: LibrarySearchParams })
  | (QueryEnvelope & { readonly namespace: 'library', readonly operation: 'get', readonly params: LibraryGetParams })
  | (QueryEnvelope & { readonly namespace: 'memory', readonly operation: 'list', readonly params: MemoryListParams })
  | (QueryEnvelope & { readonly namespace: 'memory', readonly operation: 'get', readonly params: MemoryGetParams })
  | (QueryEnvelope & { readonly namespace: 'compare', readonly operation: 'pair', readonly params: ComparePairParams })
  | (QueryEnvelope & { readonly namespace: 'live', readonly operation: 'state', readonly params: LiveStateParams })

// ── result shapes ───────────────────────────────────────────────────────────

/** A Library record as the surface renders it. */
export interface LibraryRecordView {
  readonly recordId: string
  readonly title: string
  readonly modality: string
  readonly capturedAt: string | null
  /** Where this came from, stated rather than implied. */
  readonly provenance: string
  /** The evidence this record points at. Never a filesystem path. */
  readonly evidenceIds: readonly string[]
}

/** A memory card as the surface renders it. */
export interface MemoryCardView {
  readonly cardId: string
  readonly scope: string
  readonly text: string
  readonly writtenAt: string | null
  /** Which earlier card this one corrects, when it corrects one. */
  readonly correctsCardId: string | null
  readonly forgotten: boolean
  readonly provenance: string
}

/** The result of comparing two records. */
export interface CompareResultView {
  readonly leftId: string
  readonly rightId: string
  /** Differences in what the two produced. */
  readonly outputDifferences: readonly string[]
  /**
   * Differences in what was verified about them.
   *
   * Separate from output on purpose: two records can agree on their output and
   * disagree on whether anybody checked it, and collapsing those is how an
   * unverified result inherits a verified one's credibility.
   */
  readonly verificationDifferences: readonly string[]
  /** Whether the same inputs would produce this same comparison again. */
  readonly reproducible: boolean
}

/** The Live session, flattened for the wire. */
export interface LiveStateView {
  readonly sessionId: string | null
  readonly sourceId: string | null
  readonly state: string
  readonly permission: string
  readonly startedAt: string | null
  readonly reason: string
  readonly observationCount: number
}

/** What a receipt records about a session that ended. */
export interface LiveReceiptView {
  readonly sessionId: string
  readonly sourceId: string
  readonly endedAt: string | null
  readonly outcome: string
  readonly observationCount: number
}

/** The item type each operation returns. */
export interface QueryResultMap {
  'library/search': LibraryRecordView
  'library/get': LibraryRecordView
  'memory/list': MemoryCardView
  'memory/get': MemoryCardView
  'compare/pair': CompareResultView
  'live/state': LiveStateView | LiveReceiptView
}

/** What every read returns. */
export interface QuerySnapshot<Item> {
  readonly protocol: number
  readonly requestId: string
  /** The host revision at the moment this answer was produced. */
  readonly revision: Revision
  readonly items: readonly Item[]
  /** Non-null when more remains; pass it back as `cursor`. */
  readonly nextCursor: string | null
  /**
   * Whether the host answered from complete data.
   *
   * A rebuilding index answers `false` and still returns what it has. The
   * surface has to say so rather than presenting a partial answer as the whole.
   */
  readonly complete: boolean
}

/** A read outcome. */
export type QueryResult<Item> = WatchResult<QuerySnapshot<Item>>

// ── cursors ─────────────────────────────────────────────────────────────────

/**
 * What a cursor is bound to.
 *
 * A cursor is meaningless outside the snapshot it was issued against, and
 * dangerous outside its scope: replaying one from another session would page
 * through data the caller never asked for. So the binding travels in the
 * cursor and the host checks it rather than trusting the caller to.
 */
export interface CursorScope {
  readonly namespace: QueryNamespace
  readonly operation: string
  /** The workspace, profile or session the snapshot belongs to. */
  readonly scope: string
  /** The revision the snapshot was taken at. */
  readonly revision: Revision
}

/** A decoded cursor: its binding, and where it resumes. */
export interface DecodedCursor extends CursorScope {
  readonly offset: number
}

/** Encode a cursor. Opaque to the caller, checkable by the host. */
export function encodeCursor(cursor: DecodedCursor): string {
  return [
    'v1', cursor.namespace, cursor.operation, cursor.scope,
    String(cursor.revision), String(cursor.offset),
  ].join(':')
}

/**
 * Decode a cursor and confirm it belongs here.
 *
 * Returns null for anything that does not decode or does not match the scope
 * it is being replayed into. The caller turns that into `cursor_expired`,
 * which is the honest description: the host cannot serve it, and saying why in
 * more detail would describe another session's state.
 */
export function decodeCursor(value: string, expected: CursorScope): DecodedCursor | null {
  if (value.length > QUERY_LIMITS.cursorLength) return null
  const parts = value.split(':')
  if (parts.length !== 6 || parts[0] !== 'v1') return null
  const [, namespace, operation, scope, revision, offset] = parts
  if (namespace !== expected.namespace) return null
  if (operation !== expected.operation) return null
  if (scope !== expected.scope) return null
  if (!isSafeCount(Number(revision)) || Number(revision) !== expected.revision) return null
  if (!isSafeCount(Number(offset))) return null
  return {
    namespace: expected.namespace,
    operation,
    scope,
    revision: Number(revision),
    offset: Number(offset),
  }
}

// ── primitives ──────────────────────────────────────────────────────────────

/** A non-negative safe integer. Protocol numbers and revisions must be one. */
export function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * An identifier this contract will carry.
 *
 * No slash, no backslash, no colon, no leading dot: an id cannot become a
 * relative path, an absolute path, a UNC share, a drive letter or a URL. This
 * is the single reason a caller cannot name a location.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Whether a value is an identifier of an acceptable shape and length. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= QUERY_LIMITS.identifierLength
    && !value.includes('..')
    && IDENTIFIER.test(value)
}

/** Whether a value is a namespace this host serves. */
export function isQueryNamespace(value: unknown): value is QueryNamespace {
  return typeof value === 'string' && (QUERY_NAMESPACES as readonly string[]).includes(value)
}

/** Whether an operation exists in a namespace. */
export function isQueryOperation(namespace: QueryNamespace, operation: unknown): boolean {
  return typeof operation === 'string'
    && (QUERY_OPERATIONS[namespace] as readonly string[]).includes(operation)
}

/** Negotiate the read-plane contract, or null when there is no overlap. */
export function negotiateQueryProtocol(peerMin: number, peerMax: number): number | null {
  if (!isSafeCount(peerMin) || !isSafeCount(peerMax)) return null
  const agreed = Math.min(peerMax, WATCH_QUERY_PROTOCOL_VERSION)
  return agreed >= Math.max(peerMin, WATCH_QUERY_PROTOCOL_MIN) ? agreed : null
}

/**
 * Whether an arriving snapshot is newer than what a surface already shows.
 *
 * The equal case is deliberately false. Re-rendering an identical revision
 * costs a frame and gains nothing, and treating equal as newer would let two
 * in-flight answers to the same revision fight.
 */
export function isNewerRevision(arriving: Revision, showing: Revision | null): boolean {
  if (!isSafeCount(arriving)) return false
  if (showing === null) return true
  return arriving > showing
}

/** Bring a caller deadline inside what the host will honour. */
export function clampDeadline(requested: unknown): number {
  if (!isSafeCount(requested) || requested === 0) return QUERY_LIMITS.deadlineMs
  return Math.min(requested, QUERY_LIMITS.deadlineMs)
}

/** Bring a caller page size inside what the host will return. */
export function clampLimit(requested: unknown): number {
  if (!isSafeCount(requested) || requested === 0) return QUERY_LIMITS.limit
  return Math.min(requested, QUERY_LIMITS.limit)
}

/** How deeply a value nests, stopping as soon as the budget is blown. */
function depthOf(value: unknown, budget: number): number {
  if (budget < 0) return Number.POSITIVE_INFINITY
  if (Array.isArray(value)) {
    let deepest = 1
    for (const entry of value) deepest = Math.max(deepest, 1 + depthOf(entry, budget - 1))
    return deepest
  }
  if (typeof value === 'object' && value !== null) {
    let deepest = 1
    for (const entry of Object.values(value)) deepest = Math.max(deepest, 1 + depthOf(entry, budget - 1))
    return deepest
  }
  return 0
}

/** Build the refusal a host returns when a read could not be produced. */
export function queryRefusal(
  code: QueryErrorCode,
  message: string,
  fix: string,
  options: { readonly requestId?: string, readonly retryable?: boolean } = {},
): WatchResult<never> {
  const retryableByDefault = code === 'deadline_exceeded' || code === 'unavailable'
  return watchError(`watch.query.${code}`, message, fix, {
    retryable: options.retryable ?? retryableByDefault,
    correlationId: options.requestId ?? null,
  })
}

// ── request parsing ─────────────────────────────────────────────────────────

const refuse = (code: QueryErrorCode, message: string, fix: string): WatchResult<never> =>
  queryRefusal(code, message, fix)

/** Parse the parameters of one operation, or refuse them. */
function parseParams(
  namespace: QueryNamespace,
  operation: string,
  raw: Record<string, unknown>,
): WatchResult<unknown> {
  const strings = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length <= max

  if (namespace === 'library' && operation === 'search') {
    if (!strings(raw.query, QUERY_LIMITS.queryLength)) {
      return refuse('malformed_request',
        `library/search needs a query string of at most ${String(QUERY_LIMITS.queryLength)} characters.`,
        'Shorten the search term.')
    }
    const modalities = raw.modalities ?? []
    if (!Array.isArray(modalities) || modalities.length > QUERY_LIMITS.arrayLength) {
      return refuse('malformed_request', 'library/search modalities must be an array within bounds.',
        `Send at most ${String(QUERY_LIMITS.arrayLength)} modalities.`)
    }
    if (!modalities.every(entry => isIdentifier(entry))) {
      return refuse('malformed_request', 'every modality must be a plain identifier.',
        'Modalities carry no path separators.')
    }
    return { ok: true, value: {
      query: raw.query, limit: clampLimit(raw.limit), modalities,
    } satisfies LibrarySearchParams }
  }

  if (namespace === 'library' && operation === 'get') {
    if (!isIdentifier(raw.recordId)) {
      return refuse('malformed_request', 'library/get needs a recordId identifier.',
        'A record id carries no path separator, colon or dot-dot.')
    }
    return { ok: true, value: { recordId: raw.recordId } satisfies LibraryGetParams }
  }

  if (namespace === 'memory' && operation === 'list') {
    if (!isIdentifier(raw.scope)) {
      return refuse('malformed_request', 'memory/list needs a scope identifier.',
        'A scope names a store the host knows, not a location.')
    }
    return { ok: true, value: {
      scope: raw.scope, limit: clampLimit(raw.limit),
    } satisfies MemoryListParams }
  }

  if (namespace === 'memory' && operation === 'get') {
    if (!isIdentifier(raw.cardId)) {
      return refuse('malformed_request', 'memory/get needs a cardId identifier.', 'Send a card id.')
    }
    return { ok: true, value: { cardId: raw.cardId } satisfies MemoryGetParams }
  }

  if (namespace === 'compare' && operation === 'pair') {
    if (!isIdentifier(raw.leftId) || !isIdentifier(raw.rightId)) {
      return refuse('malformed_request', 'compare/pair needs two record identifiers.',
        'Send leftId and rightId.')
    }
    return { ok: true, value: {
      leftId: raw.leftId, rightId: raw.rightId,
    } satisfies ComparePairParams }
  }

  if (namespace === 'live' && operation === 'state') {
    if (Object.keys(raw).length > 0) {
      return refuse('malformed_request', 'live/state takes no parameters.',
        'Send an empty params object.')
    }
    const empty: LiveStateParams = {}
    return { ok: true, value: empty }
  }

  return refuse('unknown_operation', `${namespace}/${operation} is not implemented.`,
    `Use one of: ${QUERY_OPERATIONS[namespace].join(', ')}.`)
}

/**
 * Validate a request at the boundary.
 *
 * Everything crossing into the host is parsed here, including requests this
 * distribution's own client produced: a surface is reachable by anything that
 * can reach the page, and "our own code sent it" is an assumption rather than
 * a guarantee. Returns the normalised request, or the refusal to send back.
 */
export function parseQueryRequest(value: unknown): WatchResult<QueryRequest> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('malformed_request', 'A query request must be an object.', 'Send a QueryRequest.')
  }

  // Size first: everything after this walks the structure, and the cost of
  // rejecting a request must not scale with how large the caller made it.
  let serialised: string
  try {
    serialised = JSON.stringify(value)
  } catch {
    return refuse('malformed_request', 'A query request must be serialisable.',
      'Remove cycles and non-JSON values.')
  }
  if (serialised.length > QUERY_LIMITS.requestBytes) {
    return refuse('request_too_large',
      `A query request may be at most ${String(QUERY_LIMITS.requestBytes)} bytes.`,
      'Narrow the query, or page with the cursor the host returned.')
  }

  const raw = value as Record<string, unknown>

  if (!isSafeCount(raw.protocol) || negotiateQueryProtocol(raw.protocol, raw.protocol) === null) {
    return refuse('protocol_mismatch',
      `The request declares read-plane protocol ${String(raw.protocol)}; this host speaks `
      + `${String(WATCH_QUERY_PROTOCOL_MIN)}-${String(WATCH_QUERY_PROTOCOL_VERSION)}.`,
      'Upgrade the half that is behind; the handshake reports both versions.')
  }
  if (typeof raw.requestId !== 'string' || !isIdentifier(raw.requestId)
    || raw.requestId.length > QUERY_LIMITS.requestIdLength) {
    return refuse('malformed_request',
      `A requestId must be an identifier of at most ${String(QUERY_LIMITS.requestIdLength)} characters.`,
      'Generate one per request; it appears in logs and correlates the answer.')
  }
  if (!isQueryNamespace(raw.namespace)) {
    return refuse('unknown_namespace', `${String(raw.namespace)} is not a readable namespace.`,
      `Use one of: ${QUERY_NAMESPACES.join(', ')}.`)
  }
  if (!isQueryOperation(raw.namespace, raw.operation)) {
    return refuse('unknown_operation',
      `${raw.namespace}/${String(raw.operation)} is not implemented.`,
      `Use one of: ${QUERY_OPERATIONS[raw.namespace].join(', ')}.`)
  }
  if (raw.cursor !== null && raw.cursor !== undefined
    && (typeof raw.cursor !== 'string' || raw.cursor.length > QUERY_LIMITS.cursorLength)) {
    return refuse('malformed_request',
      `A cursor must be the string the host issued, at most ${String(QUERY_LIMITS.cursorLength)} characters.`,
      'Pass nextCursor back unchanged, or null to start a new snapshot.')
  }
  if (typeof raw.params !== 'object' || raw.params === null || Array.isArray(raw.params)) {
    return refuse('malformed_request', 'Query params must be an object.', 'Send params as an object.')
  }
  if (depthOf(raw.params, QUERY_LIMITS.depth) > QUERY_LIMITS.depth) {
    return refuse('request_too_large',
      `Query params may nest at most ${String(QUERY_LIMITS.depth)} deep.`,
      'Flatten the request; the read plane takes no nested structures.')
  }

  const params = parseParams(raw.namespace, raw.operation as string, raw.params as Record<string, unknown>)
  if (!params.ok) return params

  return {
    ok: true,
    value: {
      protocol: raw.protocol,
      requestId: raw.requestId,
      namespace: raw.namespace,
      operation: raw.operation,
      deadlineMs: clampDeadline(raw.deadlineMs),
      cursor: raw.cursor ?? null,
      params: params.value,
    } as QueryRequest,
  }
}

// ── response parsing ────────────────────────────────────────────────────────

/**
 * Validate a snapshot before a surface renders it.
 *
 * The host is trusted to be the host and not trusted to be correct. A response
 * that does not satisfy this contract is a defect somewhere, and rendering it
 * anyway turns a defect into a wrong answer displayed confidently.
 */
export function parseQuerySnapshot<Item>(
  value: unknown,
  parseItem: (item: unknown) => Item | null,
): WatchResult<QuerySnapshot<Item>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return refuse('malformed_response', 'A snapshot must be an object.', 'The host returned something else.')
  }
  const raw = value as Record<string, unknown>

  if (!isSafeCount(raw.protocol) || negotiateQueryProtocol(raw.protocol, raw.protocol) === null) {
    return refuse('protocol_mismatch',
      `The host answered with read-plane protocol ${String(raw.protocol)}.`,
      'Upgrade the half that is behind.')
  }
  if (typeof raw.requestId !== 'string') {
    return refuse('malformed_response', 'A snapshot must name the request it answers.', 'Report this as a defect.')
  }
  if (!isSafeCount(raw.revision)) {
    return refuse('malformed_response', 'A snapshot must carry a non-negative revision.',
      'Without one, a stale answer cannot be told from a fresh one.')
  }
  if (!Array.isArray(raw.items)) {
    return refuse('malformed_response', 'A snapshot must carry an items array.', 'Report this as a defect.')
  }
  if (raw.nextCursor !== null && typeof raw.nextCursor !== 'string') {
    return refuse('malformed_response', 'nextCursor must be a string or null.', 'Report this as a defect.')
  }
  if (typeof raw.complete !== 'boolean') {
    return refuse('malformed_response', 'A snapshot must say whether it is complete.',
      'A partial answer presented as whole is worse than no answer.')
  }

  const items: Item[] = []
  for (const entry of raw.items) {
    const parsed = parseItem(entry)
    if (parsed === null) {
      return refuse('malformed_response', 'A record in the snapshot did not satisfy its contract.',
        'Report this as a defect; the surface will not render a shape it cannot read.')
    }
    items.push(parsed)
  }

  return {
    ok: true,
    value: {
      protocol: raw.protocol,
      requestId: raw.requestId,
      revision: raw.revision,
      items,
      nextCursor: raw.nextCursor ?? null,
      complete: raw.complete,
    },
  }
}

/** Read a Library record off the wire, or null when it is not one. */
export function parseLibraryRecord(value: unknown): LibraryRecordView | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (!isIdentifier(raw.recordId)) return null
  if (typeof raw.title !== 'string' || raw.title.length > QUERY_LIMITS.stringLength) return null
  if (typeof raw.modality !== 'string') return null
  if (raw.capturedAt !== null && typeof raw.capturedAt !== 'string') return null
  if (typeof raw.provenance !== 'string') return null
  if (!Array.isArray(raw.evidenceIds) || !raw.evidenceIds.every(id => isIdentifier(id))) return null
  return {
    recordId: raw.recordId,
    title: raw.title,
    modality: raw.modality,
    capturedAt: raw.capturedAt ?? null,
    provenance: raw.provenance,
    evidenceIds: raw.evidenceIds,
  }
}
