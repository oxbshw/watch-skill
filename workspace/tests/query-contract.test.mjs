/**
 * The read plane's wire contract.
 *
 * These are the guarantees the four data-backed modes rest on, asserted
 * against the built module rather than a description of it.
 *
 * Three of them are worth reading twice.
 *
 * The revision test: two reads issued in order can return out of order, and a
 * surface that renders whichever arrived last shows older data than it had a
 * moment before -- intermittently, under load, which is where that bug
 * survives review.
 *
 * The identifier tests: an id is the only thing a caller supplies that the
 * host looks something up by. If a path, a UNC share, a drive letter or a
 * dot-dot can survive parsing, the read plane has become a way to name a
 * location, and nothing downstream is obliged to notice.
 *
 * The response tests: the host is trusted to be the host and not trusted to be
 * correct. A snapshot that does not satisfy the contract is a defect
 * somewhere, and rendering it anyway turns a defect into a wrong answer shown
 * confidently.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  QUERY_LIMITS,
  QUERY_NAMESPACES,
  QUERY_OPERATIONS,
  WATCH_QUERY_PROTOCOL_MIN,
  WATCH_QUERY_PROTOCOL_VERSION,
  clampDeadline,
  clampLimit,
  decodeCursor,
  encodeCursor,
  isIdentifier,
  isNewerRevision,
  isQueryNamespace,
  isQueryOperation,
  isSafeCount,
  negotiateQueryProtocol,
  parseLibraryRecord,
  parseQueryRequest,
  parseQuerySnapshot,
  queryRefusal,
} from '../packages/watch/contracts/lib/query.js'

/** A request that satisfies the contract, for tests that break one field. */
const valid = (overrides = {}) => ({
  protocol: WATCH_QUERY_PROTOCOL_VERSION,
  requestId: 'req-1',
  namespace: 'library',
  operation: 'search',
  deadlineMs: 5000,
  cursor: null,
  params: { query: 'kettle', limit: 10, modalities: [] },
  ...overrides,
})

const code = result => result.error.error.replace('watch.query.', '')

// ── shape ───────────────────────────────────────────────────────────────────

test('every namespace declares the operations it serves', () => {
  assert.deepEqual([...QUERY_NAMESPACES].sort(), ['compare', 'library', 'live', 'memory'])
  for (const namespace of QUERY_NAMESPACES) {
    assert.ok(QUERY_OPERATIONS[namespace].length > 0, namespace)
    for (const operation of QUERY_OPERATIONS[namespace]) {
      assert.equal(isQueryOperation(namespace, operation), true, `${namespace}/${operation}`)
    }
  }
})

test('an operation that is not declared is refused', () => {
  for (const [namespace, operation] of [
    ['library', 'delete'], ['library', 'list'], ['memory', 'search'],
    ['compare', 'search'], ['live', 'start'], ['live', 'stop'],
  ]) {
    assert.equal(isQueryOperation(namespace, operation), false, `${namespace}/${operation}`)
    const parsed = parseQueryRequest(valid({ namespace, operation }))
    assert.equal(parsed.ok, false)
    assert.equal(code(parsed), 'unknown_operation', `${namespace}/${operation}`)
  }
})

test('the read plane exposes no operation that changes anything', () => {
  const verbs = /^(create|update|delete|remove|write|set|start|stop|forget|rebuild|run|exec)/
  for (const namespace of QUERY_NAMESPACES) {
    for (const operation of QUERY_OPERATIONS[namespace]) {
      assert.doesNotMatch(operation, verbs, `${namespace}/${operation} reads like a command`)
    }
  }
})

// ── request parsing ─────────────────────────────────────────────────────────

test('a well-formed request is normalised rather than merely accepted', () => {
  const parsed = parseQueryRequest(valid({
    deadlineMs: 1_000_000,
    cursor: undefined,
    params: { query: 'kettle', limit: 100_000, modalities: [] },
  }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.deadlineMs, QUERY_LIMITS.deadlineMs,
    'a caller cannot ask the host to wait longer than the host will wait')
  assert.equal(parsed.value.params.limit, QUERY_LIMITS.limit, 'clampLimit applies to search')
  assert.equal(parsed.value.cursor, null, 'an absent cursor normalises to null')
})

test('clampLimit applies to every operation that takes one', () => {
  const listed = parseQueryRequest(valid({
    namespace: 'memory', operation: 'list',
    params: { scope: 'personal', limit: 9999 },
  }))
  assert.equal(listed.ok, true)
  assert.equal(listed.value.params.limit, QUERY_LIMITS.limit)

  const absent = parseQueryRequest(valid({ params: { query: 'x', modalities: [] } }))
  assert.equal(absent.ok, true)
  assert.equal(absent.value.params.limit, QUERY_LIMITS.limit, 'an absent limit takes the maximum')
})

test('every field the contract requires is actually required', () => {
  for (const [override, expected] of [
    [{ protocol: 99 }, 'protocol_mismatch'],
    [{ protocol: 'one' }, 'protocol_mismatch'],
    [{ protocol: -1 }, 'protocol_mismatch'],
    [{ protocol: 1.5 }, 'protocol_mismatch'],
    [{ requestId: '' }, 'malformed_request'],
    [{ requestId: 42 }, 'malformed_request'],
    [{ requestId: 'a'.repeat(QUERY_LIMITS.requestIdLength + 1) }, 'malformed_request'],
    [{ namespace: 'chat' }, 'unknown_namespace'],
    [{ namespace: 7 }, 'unknown_namespace'],
    [{ operation: '' }, 'unknown_operation'],
    [{ cursor: 12 }, 'malformed_request'],
    [{ cursor: 'c'.repeat(QUERY_LIMITS.cursorLength + 1) }, 'malformed_request'],
    [{ params: [] }, 'malformed_request'],
    [{ params: null }, 'malformed_request'],
    [{ params: { limit: 5, modalities: [] } }, 'malformed_request'],
  ]) {
    const parsed = parseQueryRequest(valid(override))
    assert.equal(parsed.ok, false, JSON.stringify(override))
    assert.equal(code(parsed), expected, JSON.stringify(override))
    assert.notEqual(parsed.error.fix, '', 'a refusal has to say what to do instead')
  }
})

test('a non-object request is refused rather than crashing the host', () => {
  for (const value of [null, undefined, 'request', 42, [], true]) {
    assert.equal(parseQueryRequest(value).ok, false, String(value))
  }
})

// ── bounds ──────────────────────────────────────────────────────────────────

test('an oversized request is refused before it is walked', () => {
  const parsed = parseQueryRequest(valid({
    params: { query: 'x'.repeat(QUERY_LIMITS.requestBytes + 100), limit: 1, modalities: [] },
  }))
  assert.equal(parsed.ok, false)
  assert.equal(code(parsed), 'request_too_large')
})

test('a long search term is refused even when the request fits', () => {
  const parsed = parseQueryRequest(valid({
    params: { query: 'x'.repeat(QUERY_LIMITS.queryLength + 1), limit: 1, modalities: [] },
  }))
  assert.equal(parsed.ok, false)
  assert.equal(code(parsed), 'malformed_request')
})

test('an over-long array is refused', () => {
  const parsed = parseQueryRequest(valid({
    params: {
      query: 'x', limit: 1,
      modalities: Array.from({ length: QUERY_LIMITS.arrayLength + 1 }, () => 'text'),
    },
  }))
  assert.equal(parsed.ok, false)
})

test('deeply nested params are refused', () => {
  let nested = { deep: true }
  for (let level = 0; level < QUERY_LIMITS.depth + 3; level += 1) nested = { nested }
  const parsed = parseQueryRequest(valid({ params: nested }))
  assert.equal(parsed.ok, false)
  assert.ok(['request_too_large', 'malformed_request'].includes(code(parsed)))
})

test('protocol and revision must be non-negative safe integers', () => {
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '1', null]) {
    assert.equal(isSafeCount(bad), false, String(bad))
  }
  for (const good of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isSafeCount(good), true, String(good))
  }
})

// ── no locations ────────────────────────────────────────────────────────────

test('an identifier cannot carry a path, a share, a drive or a dot-dot', () => {
  const rejected = [
    '../etc/passwd', '..', 'a/../b', 'C:/Windows/System32', 'C:\\Windows',
    '/etc/shadow', '\\\\server\\share', 'foo/bar', 'foo\\bar',
    'https://example.com', 'file:///etc', 'cmd.exe /c', 'a:b',
    '', ' ', '.hidden', '-leading', 'x'.repeat(QUERY_LIMITS.identifierLength + 1),
  ]
  for (const value of rejected) assert.equal(isIdentifier(value), false, JSON.stringify(value))
  for (const value of ['rec-1', 'a.b.c', 'A1_2-3', 'evidence.2026']) {
    assert.equal(isIdentifier(value), true, value)
  }
})

test('a parameter that names a location is refused at the boundary', () => {
  for (const recordId of ['../secrets', 'C:/Windows/System32/config/SAM', '/etc/passwd', 'a/b']) {
    const parsed = parseQueryRequest(valid({
      operation: 'get', params: { recordId },
    }))
    assert.equal(parsed.ok, false, recordId)
    assert.equal(code(parsed), 'malformed_request', recordId)
  }
})

test('live/state accepts no parameters at all', () => {
  const empty = parseQueryRequest(valid({ namespace: 'live', operation: 'state', params: {} }))
  assert.equal(empty.ok, true)
  const smuggled = parseQueryRequest(valid({
    namespace: 'live', operation: 'state', params: { sourcePath: 'C:/x' },
  }))
  assert.equal(smuggled.ok, false, 'a parameterless read must not carry parameters')
})

// ── revisions ───────────────────────────────────────────────────────────────

test('a late answer to an earlier question never replaces a newer one', () => {
  assert.equal(isNewerRevision(2, 1), true)
  assert.equal(isNewerRevision(1, 2), false, 'this is the out-of-order case')
  assert.equal(isNewerRevision(5, null), true, 'the first answer always renders')
  assert.equal(isNewerRevision(3, 3), false, 'an identical revision costs a frame and gains nothing')
  assert.equal(isNewerRevision(-1, null), false, 'a nonsense revision is not newer than anything')
})

// ── cursors ─────────────────────────────────────────────────────────────────

const scope = {
  namespace: 'library', operation: 'search', scope: 'workspace-1', revision: 7,
}

test('a cursor round-trips within its own scope', () => {
  const encoded = encodeCursor({ ...scope, offset: 40 })
  assert.ok(encoded.length <= QUERY_LIMITS.cursorLength)
  const decoded = decodeCursor(encoded, scope)
  assert.notEqual(decoded, null)
  assert.equal(decoded.offset, 40)
})

test('a cursor from another namespace, operation, scope or revision expires', () => {
  const encoded = encodeCursor({ ...scope, offset: 40 })
  for (const wrong of [
    { ...scope, namespace: 'memory' },
    { ...scope, operation: 'get' },
    { ...scope, scope: 'another-workspace' },
    { ...scope, revision: 8 },
  ]) {
    assert.equal(decodeCursor(encoded, wrong), null, JSON.stringify(wrong))
  }
})

test('a malformed or oversized cursor decodes to nothing', () => {
  for (const value of ['', 'garbage', 'v1:library', 'v2:library:search:w:7:0',
    'x'.repeat(QUERY_LIMITS.cursorLength + 1)]) {
    assert.equal(decodeCursor(value, scope), null, JSON.stringify(value.slice(0, 24)))
  }
})

// ── protocol ────────────────────────────────────────────────────────────────

test('protocol negotiation refuses a range with no overlap', () => {
  assert.equal(negotiateQueryProtocol(WATCH_QUERY_PROTOCOL_MIN, WATCH_QUERY_PROTOCOL_VERSION),
    WATCH_QUERY_PROTOCOL_VERSION)
  assert.equal(negotiateQueryProtocol(2, 3), null, 'a peer entirely ahead')
  assert.equal(negotiateQueryProtocol(0, 0), null, 'a peer entirely behind')
  assert.equal(negotiateQueryProtocol(-1, 5), null, 'a nonsense range')
})

test('only the declared namespaces are readable', () => {
  for (const name of QUERY_NAMESPACES) assert.equal(isQueryNamespace(name), true, name)
  for (const name of ['watch', 'chat', 'trajectory', '', null, 3]) {
    assert.equal(isQueryNamespace(name), false, String(name))
  }
})

// ── refusals ────────────────────────────────────────────────────────────────

test('a refusal carries the request it refused, so a caller can correlate it', () => {
  const refusal = queryRefusal('deadline_exceeded', 'Too slow.', 'Retry.', { requestId: 'req-7' })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.error.correlationId, 'req-7')
  assert.equal(refusal.error.retryable, true, 'a deadline is worth retrying')
  assert.equal(queryRefusal('unavailable', 'x', 'y').error.retryable, true)
  assert.equal(queryRefusal('malformed_request', 'x', 'y').error.retryable, false,
    'a malformed request will be malformed again')
  assert.equal(queryRefusal('cancelled', 'x', 'y').error.retryable, false)
})

test('every refusal code is distinguishable on the wire', () => {
  const codes = ['protocol_mismatch', 'unknown_namespace', 'unknown_operation',
    'malformed_request', 'request_too_large', 'deadline_exceeded', 'cancelled',
    'unavailable', 'cursor_expired', 'malformed_response']
  const seen = new Set(codes.map(c => queryRefusal(c, 'm', 'f').error.error))
  assert.equal(seen.size, codes.length)
  for (const value of seen) assert.match(value, /^watch\.query\./)
})

// ── responses ───────────────────────────────────────────────────────────────

const record = {
  recordId: 'rec-1', title: 'A kettle boiling', modality: 'visual',
  capturedAt: '2026-08-29T10:00:00Z', provenance: 'observation', evidenceIds: ['ev-1'],
}
const snapshot = (overrides = {}) => ({
  protocol: WATCH_QUERY_PROTOCOL_VERSION,
  requestId: 'req-1',
  revision: 3,
  items: [record],
  nextCursor: null,
  complete: true,
  ...overrides,
})

test('a well-formed snapshot parses into typed records', () => {
  const parsed = parseQuerySnapshot(snapshot(), parseLibraryRecord)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.items.length, 1)
  assert.equal(parsed.value.items[0].recordId, 'rec-1')
  assert.equal(parsed.value.complete, true)
})

test('a snapshot the host malformed is refused rather than rendered', () => {
  for (const [override, expected] of [
    [{ protocol: 99 }, 'protocol_mismatch'],
    [{ revision: -1 }, 'malformed_response'],
    [{ revision: 'three' }, 'malformed_response'],
    [{ items: 'none' }, 'malformed_response'],
    [{ complete: 'yes' }, 'malformed_response'],
    [{ nextCursor: 42 }, 'malformed_response'],
    [{ requestId: 7 }, 'malformed_response'],
  ]) {
    const parsed = parseQuerySnapshot(snapshot(override), parseLibraryRecord)
    assert.equal(parsed.ok, false, JSON.stringify(override))
    assert.equal(code(parsed), expected, JSON.stringify(override))
  }
  assert.equal(parseQuerySnapshot(null, parseLibraryRecord).ok, false)
  assert.equal(parseQuerySnapshot([], parseLibraryRecord).ok, false)
})

test('one bad record refuses the whole snapshot', () => {
  const parsed = parseQuerySnapshot(
    snapshot({ items: [record, { ...record, recordId: '../escape' }] }), parseLibraryRecord)
  assert.equal(parsed.ok, false)
  assert.equal(code(parsed), 'malformed_response')
})

test('a record carrying a path in its evidence is refused', () => {
  for (const evidenceIds of [['C:/Windows'], ['../x'], ['a/b'], [42]]) {
    assert.equal(parseLibraryRecord({ ...record, evidenceIds }), null, JSON.stringify(evidenceIds))
  }
})

test('an incomplete snapshot is still a valid answer, and says so', () => {
  const parsed = parseQuerySnapshot(snapshot({ complete: false }), parseLibraryRecord)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.complete, false,
    'a rebuilding index answers with what it has and must not claim to be whole')
})

test('deadlines clamp, including from nonsense', () => {
  assert.equal(clampDeadline(1000), 1000)
  assert.equal(clampDeadline(QUERY_LIMITS.deadlineMs * 10), QUERY_LIMITS.deadlineMs)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined, 1.5]) {
    assert.equal(clampDeadline(bad), QUERY_LIMITS.deadlineMs, `deadline ${String(bad)}`)
    assert.equal(clampLimit(bad), QUERY_LIMITS.limit, `limit ${String(bad)}`)
  }
})
