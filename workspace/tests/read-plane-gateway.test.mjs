/**
 * The Library read plane through the real Gateway, not around it.
 *
 * Everything else about this transport is tested by calling `searchLibrary`
 * directly, which proves the answer and nothing about the path to it. This
 * composes what the product composes: a Cordis context, the Typert registry,
 * the API Gateway, the generated Host contribution registered into it, and the
 * service mounted as `ctx.watchQuery`. Requests go in as wire values and come
 * back through the generated codecs.
 *
 * It has already earned its place. The service stored its configuration in a
 * `#private` field, every direct test passed, and the first Gateway invocation
 * failed with "Cannot read private member #config from an object whose class
 * did not declare it" — because Cordis hands a Service to callers through a
 * Proxy and a private field cannot be reached through one. No amount of unit
 * testing would have found that.
 *
 * The SRC assertion is the other reason this exists. Typert can dispatch from a
 * generated strict descriptor or from an SRC claim collected at runtime, and a
 * missing generated artifact degrades to the second silently. A test that only
 * checked the answer would pass either way, so the registry is inspected: the
 * descriptor must be strict, and there must be no SRC claim standing in for it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import TypertRegistryPlugin from '@deepseek-ai/dsh-typert-registry'
import GatewayPlugin from '@deepseek-ai/dsh-api-gateway'

import { LibraryIndex } from '../packages/watch/library/lib/index.js'
import { WatchQueryService } from '../packages/watch/tools/lib/read-plane.js'

const { TYPERT } = await import('../packages/watch/tools/lib/typert.host.js')

const record = (id, title, text) => ({
  recordId: id, revisionId: `${id}-r1`, title, kind: 'document', text,
  source: 'fixture-store', runId: 'run-1',
  observedAt: '2026-08-29T10:00:00.000Z', verdict: null,
  tags: ['kitchen'], evidenceIds: [`ev-${id}`],
})

const CORPUS = [
  record('rec-1', 'A kettle boiling', 'the kettle boiled and clicked off'),
  record('rec-2', 'A kettle descaled', 'descaling the kettle with vinegar'),
  record('rec-3', 'A toaster', 'the toaster popped'),
]

/** Compose the real host: registry, Gateway, generated contribution, service. */
async function host(records = CORPUS) {
  const ctx = new Context()
  ctx.plugin(TypertRegistryPlugin)
  ctx.plugin(GatewayPlugin)
  await new Promise(resolve => { setTimeout(resolve, 0) })

  ctx.typert.register(TYPERT)

  const index = new LibraryIndex()
  index.addAll(records)
  new WatchQueryService(ctx, { index: () => index, scope: 'workspace-1' })
  await new Promise(resolve => { setTimeout(resolve, 0) })

  return { ctx, index, gateway: ctx.typertGateway }
}

const searchRequest = (overrides = {}) => ({
  protocol: 1, requestId: 'req-1', query: 'kettle', modalities: [],
  limit: 10, cursor: null, deadlineMs: 5000, ...overrides,
})

const invoke = (gateway, method, request, signal = new AbortController().signal) =>
  gateway.invoke({ namespace: 'watchQuery', method, args: { request }, signal })

// ── the contribution is mounted, and it is the strict one ───────────────────

test('the generated contribution registers and the service mounts', async () => {
  const { ctx } = await host()
  assert.equal(typeof ctx.typert, 'object', 'the Typert registry is present')
  assert.equal(typeof ctx.typertGateway, 'object', 'the Gateway is present')
  assert.equal(typeof ctx.watchQuery, 'object', 'the service mounted on its key')

  const packages = ctx.typert.listPackages()
  const mine = packages.find(entry => entry.package === '@watchskill/dsh-tools')
  assert.ok(mine !== undefined, 'the generated package is registered')
  assert.equal(mine.face, 'host')
})

test('both Library methods are strict descriptors, not SRC claims', async () => {
  const { ctx, gateway } = await host()

  const invocations = TYPERT.invocations.filter(entry => entry.service === 'watchQuery')
  assert.deepEqual(invocations.map(entry => entry.method).sort(), ['libraryGet', 'librarySearch'])

  for (const invocation of invocations) {
    assert.equal(invocation.result.mode, 'strict', `${invocation.method} result`)
    for (const parameter of invocation.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${invocation.method} ${parameter.name}`)
    }
    assert.deepEqual(invocation.cancellation, { parameter: 'signal' }, invocation.method)
  }

  // If a generated artifact were missing, Typert would fall back to an SRC
  // claim collected from the live service and the answers below would still be
  // correct. An empty claim set is what makes "strict" a measurement.
  // Compared by content, not by identity: the Gateway returns its own object
  // and `assert/strict` distinguishes that from a plain literal.
  const claims = gateway.collectSrcClaims()
  assert.deepEqual(Object.keys(claims), [],
    'no SRC claim may stand in for a generated descriptor')
  assert.equal(typeof ctx.watchQuery.librarySearch, 'function')
  assert.equal(typeof ctx.watchQuery.libraryGet, 'function')
})

// ── requests cross the boundary as wire values ──────────────────────────────

test('a search crosses the Gateway and returns persisted records', async () => {
  const { gateway } = await host()
  const answer = await invoke(gateway, 'librarySearch', searchRequest())

  assert.equal(answer.outcome, 'page')
  assert.deepEqual(answer.records.map(entry => entry.recordId).sort(), ['rec-1', 'rec-2'])

  // Provenance is the stored record, not something reconstructed from the hit.
  const [first] = answer.records
  assert.equal(first.observedAt, '2026-08-29T10:00:00.000Z')
  assert.equal(first.source, 'fixture-store')
  assert.equal(first.runId, 'run-1')
  assert.deepEqual(first.tags, ['kitchen'])
  assert.match(first.revisionId, /-r1$/)
})

test('a get crosses the Gateway and returns one record', async () => {
  const { gateway } = await host()
  const answer = await invoke(gateway, 'libraryGet',
    { protocol: 1, requestId: 'req-2', recordId: 'rec-3', deadlineMs: 5000 })

  assert.equal(answer.outcome, 'record')
  assert.equal(answer.record.recordId, 'rec-3')
  assert.equal(answer.record.title, 'A toaster')
  assert.equal(answer.record.source, 'fixture-store')
})

test('an absent record is an answer, not a failure', async () => {
  const { gateway } = await host()
  const answer = await invoke(gateway, 'libraryGet',
    { protocol: 1, requestId: 'req-3', recordId: 'rec-absent', deadlineMs: 5000 })
  assert.equal(answer.outcome, 'absent')
  assert.equal(answer.recordId, 'rec-absent')
})

// ── the codecs refuse before anything runs ──────────────────────────────────

test('a structurally invalid request is refused by the codec', async () => {
  const { gateway, index } = await host()
  const before = index.size

  for (const [field, value] of [['query', 42], ['limit', 'ten'], ['modalities', null]]) {
    const refused = await invoke(gateway, 'librarySearch', searchRequest({ [field]: value }))
      .then(() => null, cause => cause)
    assert.notEqual(refused, null, `${field} was accepted`)
    assert.equal(refused.code, 'input-invalid', field)
  }
  assert.equal(index.size, before, 'the index was untouched')
})

test('a semantically invalid request is refused inside the host', async () => {
  const { gateway } = await host()
  // Structurally valid, semantically not: the codec passes it and the
  // operation validator refuses it, which is the layering these two have.
  const answer = await invoke(gateway, 'libraryGet',
    { protocol: 1, requestId: 'req-4', recordId: '../escape', deadlineMs: 5000 })
  assert.equal(answer.outcome, 'rejected')
  assert.equal(answer.reason, 'identifier_invalid')
  assert.equal(answer.field, 'recordId')
})

// ── cancellation reaches the operation ──────────────────────────────────────

test('an aborted signal reaches the Library operation', async () => {
  const { gateway } = await host()
  const controller = new AbortController()
  controller.abort()

  const answer = await invoke(gateway, 'librarySearch', searchRequest(), controller.signal)
  assert.equal(answer.outcome, 'deadline_exceeded',
    'the signal arrived and the operation declined to start')
  assert.equal(answer.requestId, 'req-1')
})

test('a live signal does not abort a healthy request', async () => {
  const { gateway } = await host()
  const controller = new AbortController()
  const answer = await invoke(gateway, 'librarySearch', searchRequest(), controller.signal)
  assert.equal(answer.outcome, 'page')
  controller.abort()
})

// ── what the host returns satisfies the wire contract ───────────────────────

test('every field the response declares is present and typed', async () => {
  const { gateway } = await host()
  const answer = await invoke(gateway, 'librarySearch', searchRequest())

  for (const key of ['outcome', 'protocol', 'requestId', 'revision', 'records', 'nextCursor', 'total', 'indexState']) {
    assert.ok(key in answer, `missing ${key}`)
  }
  assert.ok(Number.isSafeInteger(answer.revision) && answer.revision >= 0)
  assert.ok(Number.isSafeInteger(answer.total) && answer.total >= 0)
  assert.ok(['ready', 'rebuilding', 'stale', 'empty'].includes(answer.indexState))

  for (const entry of answer.records) {
    for (const key of ['recordId', 'revisionId', 'title', 'modality', 'observedAt',
      'source', 'runId', 'verdict', 'tags', 'evidenceIds', 'current']) {
      assert.ok(key in entry, `record missing ${key}`)
    }
    assert.equal(typeof entry.current, 'boolean')
    assert.ok(Array.isArray(entry.evidenceIds))
  }
})

test('an empty index answers, and says it is empty', async () => {
  const { gateway } = await host([])
  const answer = await invoke(gateway, 'librarySearch', searchRequest())
  assert.equal(answer.outcome, 'page')
  assert.deepEqual(answer.records, [])
  assert.notEqual(answer.indexState, 'ready',
    'an index nobody has built is not a complete answer to anything')
})
