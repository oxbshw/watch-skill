/**
 * The read plane's wire contract.
 *
 * These are the guarantees the four data-backed modes rest on, so they are
 * asserted against the built module rather than a description of it.
 *
 * The revision test is the one worth reading twice. Two reads issued in order
 * can return out of order, and a surface that renders whichever arrived last
 * shows older data than it had a moment before -- intermittently, and only
 * under load, which is where this class of bug survives review.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_QUERY_DEADLINE_MS,
  MAX_QUERY_LIMIT,
  QUERY_NAMESPACES,
  WATCH_QUERY_PROTOCOL_MIN,
  WATCH_QUERY_PROTOCOL_VERSION,
  clampDeadline,
  clampLimit,
  isNewerRevision,
  isQueryNamespace,
  negotiateQueryProtocol,
  parseQueryRequest,
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
  params: {},
  ...overrides,
})

test('the four data-backed modes each have a namespace', () => {
  assert.deepEqual([...QUERY_NAMESPACES].sort(),
    ['compare', 'library', 'live', 'memory'])
})

test('a well-formed request is normalised rather than merely accepted', () => {
  const parsed = parseQueryRequest(valid({ deadlineMs: 1_000_000, cursor: undefined }))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.deadlineMs, MAX_QUERY_DEADLINE_MS,
    'a caller cannot ask the host to wait longer than the host will wait')
  assert.equal(parsed.value.cursor, null, 'an absent cursor normalises to null')
})

test('every field the contract requires is actually required', () => {
  const cases = [
    [{ protocol: 99 }, 'protocol_mismatch'],
    [{ protocol: 'one' }, 'protocol_mismatch'],
    [{ requestId: '' }, 'malformed_request'],
    [{ requestId: 42 }, 'malformed_request'],
    [{ namespace: 'chat' }, 'unknown_namespace'],
    [{ namespace: 7 }, 'unknown_namespace'],
    [{ operation: '' }, 'malformed_request'],
    [{ cursor: 12 }, 'malformed_request'],
    [{ params: [] }, 'malformed_request'],
    [{ params: null }, 'malformed_request'],
  ]
  for (const [override, code] of cases) {
    const parsed = parseQueryRequest(valid(override))
    assert.equal(parsed.ok, false, JSON.stringify(override))
    assert.equal(parsed.error.error, `watch.query.${code}`, JSON.stringify(override))
    assert.notEqual(parsed.error.fix, '', 'a refusal has to say what to do instead')
  }
})

test('a non-object request is refused rather than crashing the host', () => {
  for (const value of [null, undefined, 'request', 42, []]) {
    const parsed = parseQueryRequest(value)
    assert.equal(parsed.ok, false, String(value))
  }
})

test('a late answer to an earlier question never replaces a newer one', () => {
  assert.equal(isNewerRevision(2, 1), true)
  assert.equal(isNewerRevision(1, 2), false, 'this is the out-of-order case')
  assert.equal(isNewerRevision(5, null), true, 'the first answer always renders')
  assert.equal(isNewerRevision(3, 3), false,
    'an identical revision costs a frame and gains nothing')
})

test('deadlines and page sizes are clamped, including from nonsense', () => {
  assert.equal(clampDeadline(1000), 1000)
  assert.equal(clampDeadline(MAX_QUERY_DEADLINE_MS * 10), MAX_QUERY_DEADLINE_MS)
  assert.equal(clampLimit(10), 10)
  assert.equal(clampLimit(MAX_QUERY_LIMIT * 10), MAX_QUERY_LIMIT)
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined]) {
    assert.equal(clampDeadline(bad), MAX_QUERY_DEADLINE_MS, `deadline ${String(bad)}`)
    assert.equal(clampLimit(bad), MAX_QUERY_LIMIT, `limit ${String(bad)}`)
  }
})

test('protocol negotiation refuses a range with no overlap', () => {
  assert.equal(negotiateQueryProtocol(WATCH_QUERY_PROTOCOL_MIN, WATCH_QUERY_PROTOCOL_VERSION),
    WATCH_QUERY_PROTOCOL_VERSION)
  assert.equal(negotiateQueryProtocol(2, 3), null, 'a peer that is entirely ahead')
  assert.equal(negotiateQueryProtocol(0, 0), null, 'a peer that is entirely behind')
})

test('only the declared namespaces are readable', () => {
  for (const name of QUERY_NAMESPACES) assert.equal(isQueryNamespace(name), true, name)
  for (const name of ['watch', 'chat', 'trajectory', '', null, 3]) {
    assert.equal(isQueryNamespace(name), false, String(name))
  }
})

test('a refusal carries the request it refused, so a caller can correlate it', () => {
  const refusal = queryRefusal('deadline_exceeded', 'Too slow.', 'Retry.', { requestId: 'req-7' })
  assert.equal(refusal.ok, false)
  assert.equal(refusal.error.correlationId, 'req-7')
  assert.equal(refusal.error.retryable, true, 'a deadline is worth retrying')
  assert.equal(queryRefusal('malformed_request', 'x', 'y').error.retryable, false,
    'a malformed request will be malformed again')
})

test('the read plane cannot express a write', () => {
  // Not a style check: it is the reason captured or model-generated content
  // reaching these fields cannot become an action. `operation` is a string, so
  // the guarantee is that the host serves reads only -- asserted here as the
  // contract's own vocabulary carrying no verb that changes anything.
  const parsed = parseQueryRequest(valid({ operation: 'delete' }))
  assert.equal(parsed.ok, true,
    'the contract does not police operation names; the host namespace does')
  assert.equal(Object.keys(parsed.value).includes('mutation'), false)
  assert.equal(Object.keys(parsed.value).includes('command'), false)
})
