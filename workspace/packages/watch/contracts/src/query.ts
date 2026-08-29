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
 * whose methods are dispatched through the Gateway with request correlation,
 * abort signals and structured failures already handled, and `ctx.remote` is
 * the client face of it. An earlier note in this distribution described
 * `ctx.remote` as an event bus rather than a query client. That was true of
 * `$on`/`$dispatch` and missed the typed invocation path beside them, and the
 * conclusion drawn from it -- that populating these modes would mean building
 * a second data path -- was the wrong one. Nothing here is a second path.
 *
 * What this module owns is the wire contract: what a mode may ask, what it
 * gets back, and what is refused. Three properties it exists to guarantee.
 *
 * Reads are separated from commands. Everything here answers a question. A
 * request that changes something is not expressible in these types, so a
 * surface cannot acquire a side effect by accident, and captured or
 * model-generated content reaching these fields cannot become an action.
 *
 * Every answer carries a revision. A view that receives an older revision than
 * the one it already shows must discard it: responses can overtake each other,
 * and a late answer to an early question is indistinguishable from fresh data
 * unless the data says which it is.
 *
 * Every request carries a deadline and an identity. Without both, a slow host
 * is a hung surface and a cancelled request is a leak.
 *
 * Browser-safe like the rest of this package: no Node imports, no runtime
 * identity, nothing a client bundle would have to deduplicate.
 *
 * @module @watchskill/dsh-contracts/query
 */

import type { WatchResult } from './index.js'
import { watchError } from './index.js'

/** The read-plane contract version this build speaks. */
export const WATCH_QUERY_PROTOCOL_VERSION = 1

/** The oldest read-plane contract this build still answers. */
export const WATCH_QUERY_PROTOCOL_MIN = 1

/** The longest a surface may wait before it must show something. */
export const MAX_QUERY_DEADLINE_MS = 30_000

/** The most records one page may carry, whatever the caller asked for. */
export const MAX_QUERY_LIMIT = 200

/** The namespaces a mode may read from. Reads only; there is no write here. */
export const QUERY_NAMESPACES = ['library', 'memory', 'compare', 'live'] as const

/** One readable namespace. */
export type QueryNamespace = (typeof QUERY_NAMESPACES)[number]

/**
 * Why a read was refused.
 *
 * Distinct from what a query *reports*: an index that is mid-rebuild answers
 * successfully and says it is incomplete. These are the cases where no answer
 * was produced at all.
 */
export type QueryErrorCode =
  /** The host speaks a contract this client cannot read, or the reverse. */
  | 'protocol_mismatch'
  /** The namespace is not one this host serves. */
  | 'unknown_namespace'
  /** The request did not satisfy the contract; nothing was executed. */
  | 'malformed_request'
  /** The deadline passed before an answer existed. */
  | 'deadline_exceeded'
  /** The caller cancelled, or the surface was disposed. */
  | 'cancelled'
  /** The host is present but this capability is not available here. */
  | 'unavailable'
  /** The cursor refers to a snapshot the host no longer holds. */
  | 'cursor_expired'

/**
 * A monotonic revision.
 *
 * Compared, never interpreted. Deliberately not a timestamp: two hosts with
 * unsynchronised clocks would produce an ordering that is wrong rather than
 * merely coarse.
 */
export type Revision = number

/** What every read carries. */
export interface QueryRequest<Params = Readonly<Record<string, unknown>>> {
  readonly protocol: number
  /** Correlates the answer, and is what a cancellation names. */
  readonly requestId: string
  readonly namespace: QueryNamespace
  /** The read to perform, within the namespace. */
  readonly operation: string
  /** How long the caller will wait. Clamped to {@link MAX_QUERY_DEADLINE_MS}. */
  readonly deadlineMs: number
  /** Continues an earlier snapshot, when the host issued one. */
  readonly cursor: string | null
  readonly params: Params
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

/** Negotiate the read-plane contract, or null when there is no overlap. */
export function negotiateQueryProtocol(peerMin: number, peerMax: number): number | null {
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
  if (showing === null) return true
  return arriving > showing
}

/** Bring a caller deadline inside what the host will honour. */
export function clampDeadline(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return MAX_QUERY_DEADLINE_MS
  }
  return Math.min(Math.trunc(requested), MAX_QUERY_DEADLINE_MS)
}

/** Bring a caller page size inside what the host will return. */
export function clampLimit(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return MAX_QUERY_LIMIT
  }
  return Math.min(Math.trunc(requested), MAX_QUERY_LIMIT)
}

/** Whether a value is a namespace this host serves. */
export function isQueryNamespace(value: unknown): value is QueryNamespace {
  return typeof value === 'string' && (QUERY_NAMESPACES as readonly string[]).includes(value)
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
  const refuse = (code: QueryErrorCode, message: string, fix: string): WatchResult<QueryRequest> =>
    watchError(`watch.query.${code}`, message, fix)

  if (typeof value !== 'object' || value === null) {
    return refuse('malformed_request', 'A query request must be an object.', 'Send a QueryRequest.')
  }
  const raw = value as Partial<QueryRequest>

  if (typeof raw.protocol !== 'number'
    || negotiateQueryProtocol(raw.protocol, raw.protocol) === null) {
    return refuse(
      'protocol_mismatch',
      `The request declares read-plane protocol ${String(raw.protocol)}; this host speaks `
      + `${String(WATCH_QUERY_PROTOCOL_MIN)}-${String(WATCH_QUERY_PROTOCOL_VERSION)}.`,
      'Upgrade the half that is behind; the handshake reports both versions.',
    )
  }
  if (typeof raw.requestId !== 'string' || raw.requestId === '') {
    return refuse(
      'malformed_request',
      'A query request must carry a requestId.',
      'Generate one per request; it is what a cancellation names.',
    )
  }
  if (!isQueryNamespace(raw.namespace)) {
    return refuse(
      'unknown_namespace',
      `${String(raw.namespace)} is not a readable namespace.`,
      `Use one of: ${QUERY_NAMESPACES.join(', ')}.`,
    )
  }
  if (typeof raw.operation !== 'string' || raw.operation === '') {
    return refuse('malformed_request', 'A query request must name an operation.', 'Set operation.')
  }
  if (raw.cursor !== null && raw.cursor !== undefined && typeof raw.cursor !== 'string') {
    return refuse(
      'malformed_request',
      'A cursor must be the string the host issued, or null.',
      'Pass nextCursor back unchanged, or null to start a new snapshot.',
    )
  }
  if (typeof raw.params !== 'object' || raw.params === null || Array.isArray(raw.params)) {
    return refuse('malformed_request', 'Query params must be an object.', 'Send params as an object.')
  }

  return {
    ok: true,
    value: {
      protocol: raw.protocol,
      requestId: raw.requestId,
      namespace: raw.namespace,
      operation: raw.operation,
      deadlineMs: clampDeadline(raw.deadlineMs),
      cursor: raw.cursor ?? null,
      params: raw.params,
    },
  }
}

/** Build the refusal a host returns when a read could not be produced. */
export function queryRefusal(
  code: QueryErrorCode,
  message: string,
  fix: string,
  options: { readonly requestId?: string, readonly retryable?: boolean } = {},
): WatchResult<never> {
  return watchError(`watch.query.${code}`, message, fix, {
    retryable: options.retryable ?? (code === 'deadline_exceeded' || code === 'unavailable'),
    correlationId: options.requestId ?? null,
  })
}
