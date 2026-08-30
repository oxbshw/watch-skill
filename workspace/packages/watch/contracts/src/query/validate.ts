/**
 * Semantic validation for the Library read plane.
 *
 * The generated Typert codec proves *shape*: that `limit` is a number and
 * `modalities` is an array of strings. It does not prove that the number is
 * within a range anybody intended, that the array is a length the host will
 * answer for, or that a record id is an identifier rather than a path. Those
 * are policy, and a structural codec has no opinion about policy.
 *
 * There is one measured behaviour worth stating plainly, because it is easy to
 * assume the opposite. The generated codec is emitted as a plain `z.object`,
 * with neither `.strict()` nor `.passthrough()`, so **unknown fields are
 * stripped, not rejected**. Typert's own `mode: 'strict'` refers to strict
 * codec generation and not to zod's strict object mode. A caller can therefore
 * send extra fields and get a successful call; what it cannot do is have those
 * fields reach anything, because what continues past the boundary is the parsed
 * value and not the input. That is a defensible policy and it is not the one a
 * reader would guess, so it is asserted in the tests rather than described.
 *
 * These functions take `unknown` deliberately, which is why they live here and
 * not in the wire module: `query/wire` describes what crosses the wire and must
 * stay free of parsers, and this describes what the host will accept.
 *
 * Order matters. Everything here runs before the index is touched, so an
 * oversized or malformed request costs a bounds check and never a search.
 *
 * @module @deepwatch/dsh-contracts/query/validate
 */

import { QUERY_LIMITS, isIdentifier, isSafeCount } from '../query.js'
import type {
  LibraryGetRequest,
  LibraryRefreshRequest,
  LibraryRequestRejected,
  LibrarySearchRequest,
} from './wire.js'
import { WATCH_QUERY_WIRE_VERSION } from './wire.js'

/** The modalities the Library indexes. A closed set, not free text. */
export const LIBRARY_MODALITIES = [
  'video', 'audio', 'page', 'stream', 'document', 'screen_capture',
] as const

/** Accepted, or the refusal to send back. */
export type Validated<T> =
  | { readonly ok: true, readonly value: T }
  | { readonly ok: false, readonly refusal: LibraryRequestRejected }

/** Build the refusal a surface renders. */
function reject(
  requestId: unknown,
  reason: LibraryRequestRejected['reason'],
  field: string | null,
): { readonly ok: false, readonly refusal: LibraryRequestRejected } {
  return {
    ok: false,
    refusal: {
      outcome: 'rejected',
      protocol: WATCH_QUERY_WIRE_VERSION,
      // Echoed only when it is already a safe identifier: a refusal must not
      // become a way to have arbitrary text reflected back.
      requestId: isIdentifier(requestId) ? requestId : '',
      reason,
      field,
    },
  }
}

/**
 * How large the request is once serialised.
 *
 * Measured before anything is walked, because the cost of rejecting a
 * malformed request must not be a function of how malformed it is. A value
 * that cannot be serialised at all — a cycle — is refused for the same reason.
 */
function withinSizeBudget(value: unknown): boolean {
  try {
    return JSON.stringify(value)?.length <= QUERY_LIMITS.requestBytes
  } catch {
    return false
  }
}

/** Whether an object nests deeper than the budget allows. */
function withinDepth(value: unknown, depth = 0): boolean {
  if (depth > QUERY_LIMITS.depth) return false
  if (Array.isArray(value)) return value.every(entry => withinDepth(entry, depth + 1))
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).every(entry => withinDepth(entry, depth + 1))
  }
  return true
}

/** The envelope fields every Library request carries. */
function envelope(raw: Record<string, unknown>): Validated<{
  readonly protocol: number
  readonly requestId: string
  readonly deadlineMs: number
}> {
  if (!isSafeCount(raw.protocol) || raw.protocol !== WATCH_QUERY_WIRE_VERSION) {
    return reject(raw.requestId, 'protocol_mismatch', 'protocol')
  }
  if (typeof raw.requestId !== 'string'
    || raw.requestId === ''
    || raw.requestId.length > QUERY_LIMITS.requestIdLength
    || !isIdentifier(raw.requestId)) {
    return reject(raw.requestId, 'identifier_invalid', 'requestId')
  }
  if (!isSafeCount(raw.deadlineMs) || raw.deadlineMs <= 0) {
    return reject(raw.requestId, 'malformed_request', 'deadlineMs')
  }
  return {
    ok: true,
    value: {
      protocol: raw.protocol,
      requestId: raw.requestId,
      // Normalised rather than refused: a caller asking to wait longer than the
      // host will wait is not making a mistake worth failing over.
      deadlineMs: Math.min(raw.deadlineMs, QUERY_LIMITS.deadlineMs),
    },
  }
}

/** The common front half of both validators. */
function opened(value: unknown): Validated<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return reject(undefined, 'malformed_request', null)
  }
  if (!withinSizeBudget(value)) return reject((value as { requestId?: unknown }).requestId,
    'request_too_large', null)
  if (!withinDepth(value)) return reject((value as { requestId?: unknown }).requestId,
    'request_too_large', null)
  return { ok: true, value: value as Record<string, unknown> }
}

/**
 * Accept a Library search, or say why not.
 *
 * Normalises `limit` and `deadlineMs` rather than refusing them, and refuses
 * everything that is a statement about what the caller may name: the query
 * length, the modality vocabulary, and the cursor length.
 */
export function parseLibrarySearchRequest(value: unknown): Validated<LibrarySearchRequest> {
  const open = opened(value)
  if (!open.ok) return open
  const raw = open.value

  const head = envelope(raw)
  if (!head.ok) return head

  if (typeof raw.query !== 'string' || raw.query.length > QUERY_LIMITS.queryLength) {
    return reject(raw.requestId, 'malformed_request', 'query')
  }
  if (!Array.isArray(raw.modalities) || raw.modalities.length > QUERY_LIMITS.arrayLength) {
    return reject(raw.requestId, 'malformed_request', 'modalities')
  }
  // Collected while checking rather than spread afterwards: `Array.isArray`
  // narrows to `any[]`, and spreading that would carry an `any` into a value
  // the rest of the host treats as validated.
  const modalities: string[] = []
  for (const modality of raw.modalities as readonly unknown[]) {
    if (typeof modality !== 'string'
      || !(LIBRARY_MODALITIES as readonly string[]).includes(modality)) {
      return reject(raw.requestId, 'malformed_request', 'modalities')
    }
    modalities.push(modality)
  }
  if (raw.cursor !== null && raw.cursor !== undefined) {
    if (typeof raw.cursor !== 'string' || raw.cursor.length > QUERY_LIMITS.cursorLength) {
      return reject(raw.requestId, 'malformed_request', 'cursor')
    }
  }
  if (raw.limit !== undefined && !isSafeCount(raw.limit)) {
    return reject(raw.requestId, 'malformed_request', 'limit')
  }

  return {
    ok: true,
    value: {
      protocol: head.value.protocol,
      requestId: head.value.requestId,
      deadlineMs: head.value.deadlineMs,
      query: raw.query,
      modalities,
      limit: Math.min(
        typeof raw.limit === 'number' && raw.limit > 0 ? raw.limit : QUERY_LIMITS.limit,
        QUERY_LIMITS.limit,
      ),
      cursor: typeof raw.cursor === 'string' ? raw.cursor : null,
    },
  }
}

/**
 * Accept a Library get, or say why not.
 *
 * `recordId` is held to the identifier grammar, which has no separator, no
 * colon and no dot-dot — so it cannot carry a filesystem path, a UNC share or
 * a storage URL. The host decides where it reads; the caller says which record.
 */
export function parseLibraryGetRequest(value: unknown): Validated<LibraryGetRequest> {
  const open = opened(value)
  if (!open.ok) return open
  const raw = open.value

  const head = envelope(raw)
  if (!head.ok) return head

  if (typeof raw.recordId !== 'string'
    || raw.recordId.length > QUERY_LIMITS.identifierLength
    || !isIdentifier(raw.recordId)) {
    return reject(raw.requestId, 'identifier_invalid', 'recordId')
  }

  return {
    ok: true,
    value: {
      protocol: head.value.protocol,
      requestId: head.value.requestId,
      deadlineMs: head.value.deadlineMs,
      recordId: raw.recordId,
    },
  }
}

/**
 * Accept a Library refresh, or say why not.
 *
 * The envelope and nothing else. A refresh names no record, no query and no
 * location — it asks the host to read the roots it was configured with, which
 * is the only reason it can be a safe operation to expose at all. There is no
 * field here a caller could point somewhere.
 */
export function parseLibraryRefreshRequest(value: unknown): Validated<LibraryRefreshRequest> {
  const open = opened(value)
  if (!open.ok) return open

  const head = envelope(open.value)
  if (!head.ok) return head

  return {
    ok: true,
    value: {
      protocol: head.value.protocol,
      requestId: head.value.requestId,
      deadlineMs: head.value.deadlineMs,
    },
  }
}
