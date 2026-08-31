/**
 * The browser end of the read plane, called rather than described.
 *
 * `read-plane-gateway.test.mjs` proves the Host: the generated contribution
 * registers, the service mounts, and requests crossing the Gateway come back
 * decoded. It proves nothing at all about the client, and the distinction is
 * not academic — a correct boot graph and a correct dependency composition
 * demonstrate that the modules *load*. They do not demonstrate that
 *
 *   - the mounting plugin's `apply` ran rather than parking or throwing,
 *   - `ctx.remote.$mount` accepted the generated contribution,
 *   - `ctx.remote.watchQuery` came into existence,
 *   - its methods are callable,
 *   - a call reaches the Host over a Connection,
 *   - the answer decodes through the generated codec,
 *   - or the namespace goes away when the plugin does.
 *
 * Every one of those is asserted below, against the real parts: upstream's own
 * Typert registry and Gateway client halves, the artifact `npm run build`
 * actually emits for `@deepwatch/dsh-client-remotes`, and the Library's own
 * consumer code reading through the namespace it ends up with.
 *
 * The one thing that is a fixture is the carrier. There is no browser here and
 * no HTTP, so the Connection is a function that hands the Host Gateway the wire
 * frame the client produced — and it round-trips that frame through JSON in
 * both directions, because a client that "works" only when it is handed a live
 * Host object has not been shown to work at all.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import * as cordis from '@deepseek-ai/cordis'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistryPlugin from '@deepseek-ai/dsh-typert-registry'
import GatewayPlugin from '@deepseek-ai/dsh-api-gateway'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { sep } from 'node:path'

import { LibraryIndex } from '../packages/watch/library/lib/index.js'
import { LibraryGenerations } from '../packages/watch/tools/lib/library-generations.js'
import { WatchQueryService } from '../packages/watch/tools/lib/read-plane.js'
import { readLibraryPage, refreshLibrary } from '../packages/watch/library/lib/client/read-plane.js'
import * as LIBRARY_CLIENT from '../packages/watch/library/lib/client/index.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { TYPERT } = await import('../packages/watch/tools/lib/typert.host.js')

// ── the shell's module table, as far as a bundle can tell ───────────────────

/**
 * The loader contract a DSH client bundle is built against.
 *
 * A bundle's only top-level effect is `window.__ModuleLoader__.load({ id,
 * factory })`, and the factory takes a synchronous `require` bound to the
 * shell's table. That is the whole interface, so it is the whole shim: the
 * seeded entries are the shell's baseline modules, and everything else has to
 * have been inlined by the bundler or it would throw in a browser too.
 */
const factories = new Map()
const materialized = new Map()
const seeded = new Map([['@deepseek-ai/cordis', cordis]])

globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) },
}

function moduleRequire(id) {
  const seed = seeded.get(id)
  if (seed !== undefined) return seed
  if (materialized.has(id)) return materialized.get(id)
  const factory = factories.get(id)
  assert.ok(factory !== undefined, `the module table cannot answer require(${JSON.stringify(id)})`)
  const exports = factory(moduleRequire)
  materialized.set(id, exports)
  return exports
}

/** Execute one bundle the way the shell does, and materialize its factory. */
async function loadBundle(relativePath, id) {
  await import(pathToFileURL(join(ROOT, relativePath)).href)
  assert.ok(factories.has(id), `${relativePath} did not register as ${id}`)
  return moduleRequire(id)
}

const dsh = name => {
  const manifest = JSON.parse(readFileSync(
    join(ROOT, 'node_modules', name, 'package.json'), 'utf8'))
  return join('node_modules', name, manifest.exports['./client'].default)
}

const REGISTRY_CLIENT = await loadBundle(
  dsh('@deepseek-ai/dsh-typert-registry'), '@deepseek-ai/dsh-typert-registry')
const GATEWAY_CLIENT = await loadBundle(
  dsh('@deepseek-ai/dsh-api-gateway'), '@deepseek-ai/dsh-api-gateway')
const WATCH_REMOTES = await loadBundle(
  'packages/watch/client-remotes/lib/client.js', '@deepwatch/dsh-client-remotes')

// ── the two ends, and the carrier between them ──────────────────────────────

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

const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })

/** The Host: registry, Gateway, the generated contribution, the service. */
async function host(records = CORPUS) {
  const ctx = new Context()
  ctx.plugin(TypertRegistryPlugin)
  ctx.plugin(GatewayPlugin)
  await settle()

  ctx.typert.register(TYPERT)
  const index = new LibraryIndex()
  index.addAll(records)
  new WatchQueryService(ctx, { index: () => index, scope: 'workspace-1' })
  await settle()

  return { ctx, index, gateway: ctx.typertGateway }
}

/**
 * The Connection, as the Gateway's browser half uses it.
 *
 * `connection.rpc.call('/api', endpoint, { args }, signal)` is the only thing
 * the client asks of a carrier. Frames go through `JSON.parse(JSON.stringify())`
 * in both directions on purpose: it is what makes "the answer decoded" a
 * measurement rather than a coincidence of sharing a heap.
 */
class ConnectionService extends Service {
  constructor(ctx, gateway, log) {
    super(ctx, 'connection')
    this.rpc = {
      call: async (route, endpoint, payload, signal) => {
        log.push({ route, endpoint, args: payload.args })
        const [namespace, method] = endpoint.split('/')
        const frame = JSON.parse(JSON.stringify(payload.args))
        try {
          const value = await gateway.invoke({ namespace, method, args: frame, signal })
          return { ok: true, value: JSON.parse(JSON.stringify(value)) }
        } catch (cause) {
          return {
            ok: false,
            error: {
              code: cause?.code ?? 'internal',
              message: String(cause?.message ?? cause),
              details: {},
            },
          }
        }
      },
    }
  }
}

/** The Client: its own fiber, its own registry, upstream's Remote service. */
async function client(gateway) {
  const ctx = new Context()
  const wire = []
  ctx.plugin(REGISTRY_CLIENT)
  new ConnectionService(ctx, gateway, wire)
  ctx.plugin(GATEWAY_CLIENT)
  await settle()
  return { ctx, wire }
}

/** Both ends, joined, with `@deepwatch/dsh-client-remotes` applied. */
async function mounted(records = CORPUS) {
  const { gateway, index } = await host(records)
  const { ctx, wire } = await client(gateway)
  const fiber = ctx.plugin(WATCH_REMOTES)
  await fiber
  await settle()
  return { ctx, wire, index, fiber }
}

// ── the mount itself ────────────────────────────────────────────────────────

test('the mounting plugin declares the service it cannot run without', () => {
  assert.deepEqual(WATCH_REMOTES.inject, ['remote'],
    'without this the plugin applies beside the Gateway and calls $mount on undefined')
  assert.equal(typeof WATCH_REMOTES.apply, 'function')
})

test('a plugin whose Remote service is absent parks rather than throwing', async () => {
  // The comment this replaces called an undefined `remote` a mount that "fails
  // silently". It would not have been silent: `undefined.$mount` throws, and
  // whether anybody sees the throw depends on what the loader does with it.
  // Declaring the injection removes the question — cordis never calls `apply`.
  const ctx = new Context()
  const fiber = ctx.plugin(WATCH_REMOTES)
  await settle()

  assert.equal(ctx.get('remote'), undefined, 'no Remote service exists')
  assert.equal(ctx.get('remote.watchQuery'), undefined,
    'and nothing was mounted, because apply never ran')
  await fiber.dispose()
})

test('$mount installs the namespace and its generated methods', async () => {
  const { ctx } = await mounted()

  assert.equal(typeof ctx.remote, 'object', 'the Gateway client half is present')
  assert.notEqual(ctx.get('remote.watchQuery'), undefined,
    'the namespace is a service, which is what a surface can inject on')
  assert.equal(typeof ctx.remote.watchQuery.librarySearch, 'function')
  assert.equal(typeof ctx.remote.watchQuery.libraryGet, 'function')
  assert.equal(typeof ctx.remote.watchQuery.libraryRefresh, 'function')
})

test('what the client mounted is the strict generated descriptor', async () => {
  const { ctx } = await mounted()

  const endpoints = ctx.typert.remotes.list().map(entry => `${entry.namespace}/${entry.method}`)
  assert.deepEqual(endpoints.sort(),
    ['watchQuery/coreHealth', 'watchQuery/libraryGet', 'watchQuery/libraryRefresh',
      'watchQuery/librarySearch'],
    'the client registry holds exactly the endpoints the bundle carried')

  // Typert can also dispatch from an SRC claim collected at runtime, and a
  // contribution that lost its generated codecs would degrade to that quietly
  // — the answers below would still be right. Measuring `strict` is what makes
  // "the generated protocol is in use" a fact rather than an inference.
  for (const descriptor of ctx.typert.remotes.list()) {
    assert.equal(descriptor.result.mode, 'strict', `${descriptor.method} result`)
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${descriptor.method} ${parameter.name}`)
    }
    assert.deepEqual(descriptor.cancellation, { parameter: 'signal' }, descriptor.method)
  }
})

// ── a call, all the way through ─────────────────────────────────────────────

const searchRequest = (overrides = {}) => ({
  protocol: 1, requestId: 'library-1', query: 'kettle', modalities: [],
  limit: 10, cursor: null, deadlineMs: 5000, ...overrides,
})

test('a search reaches the Host and comes back decoded', async () => {
  const { ctx, wire } = await mounted()
  const answer = await ctx.remote.watchQuery.librarySearch(searchRequest())

  assert.equal(answer.ok, true, `the call failed: ${JSON.stringify(answer.error)}`)
  assert.equal(answer.value.outcome, 'page')
  assert.deepEqual(answer.value.records.map(entry => entry.recordId).sort(), ['rec-1', 'rec-2'])

  // It went over the carrier, as one frame, addressed by the generated endpoint.
  assert.equal(wire.length, 1)
  assert.equal(wire[0].route, '/api')
  assert.equal(wire[0].endpoint, 'watchQuery/librarySearch')
  assert.equal(wire[0].args.request.query, 'kettle')

  // And what came back is the persisted record, not a shape reconstructed on
  // this side: the client never sees the store, so these fields can only have
  // crossed the wire.
  const [first] = answer.value.records
  assert.equal(first.source, 'fixture-store')
  assert.equal(first.observedAt, '2026-08-29T10:00:00.000Z')
  assert.equal(first.current, true)
})

test('a get reaches the Host, and an absent record is an answer', async () => {
  const { ctx } = await mounted()

  const found = await ctx.remote.watchQuery.libraryGet(
    { protocol: 1, requestId: 'library-2', recordId: 'rec-3', deadlineMs: 5000 })
  assert.equal(found.ok, true)
  assert.equal(found.value.outcome, 'record')
  assert.equal(found.value.record.title, 'A toaster')

  const missing = await ctx.remote.watchQuery.libraryGet(
    { protocol: 1, requestId: 'library-3', recordId: 'rec-absent', deadlineMs: 5000 })
  assert.equal(missing.ok, true)
  assert.equal(missing.value.outcome, 'absent')
})

test('the client codec refuses a malformed request before the wire', async () => {
  const { ctx, wire } = await mounted()

  await assert.rejects(
    () => ctx.remote.watchQuery.librarySearch(searchRequest({ limit: 'ten' })),
    /rejected/,
    'a strict parameter codec must refuse on this side too',
  )
  assert.deepEqual(wire, [], 'nothing was sent, so the Host was never asked')
})

test('the caller’s AbortSignal reaches the Host operation', async () => {
  const { ctx } = await mounted()
  const controller = new AbortController()
  controller.abort()

  const answer = await ctx.remote.watchQuery.librarySearch(searchRequest(), controller.signal)
  assert.equal(answer.ok, true)
  assert.equal(answer.value.outcome, 'deadline_exceeded',
    'the signal crossed the boundary and the operation declined to start')
})

// ── the Library reads through it ────────────────────────────────────────────

test('the Library’s own consumer renders rows from the Host', async () => {
  const { ctx } = await mounted()
  const state = await readLibraryPage(
    ctx.remote.watchQuery,
    { text: 'kettle', modality: '', limit: 10, deadlineMs: 5000 },
    new AbortController().signal,
  )

  assert.equal(state.rows.length, 2)
  assert.deepEqual(state.rows.map(row => row.recordId).sort(), ['rec-1', 'rec-2'])
  assert.equal(state.total, 2)
  assert.equal(state.health, 'ready')
  assert.equal(state.rows[0].evidenceCount, 1)
  assert.deepEqual(state.notes, [], 'a whole answer carries no caveat')
})

test('a Host refusal becomes a sentence, never an empty library', async () => {
  const { ctx } = await mounted()
  // Structurally valid, semantically not: the codec passes it and the host's
  // own validator refuses it. An empty result set here would tell somebody
  // their library is empty, which is a different and untrue statement.
  const state = await readLibraryPage(
    ctx.remote.watchQuery,
    { text: 'kettle', modality: 'not an identifier', limit: 10, deadlineMs: 5000 },
    new AbortController().signal,
  )
  assert.equal(state.rows.length, 0)
  assert.equal(state.notes.length, 1)
  assert.match(state.notes[0], /refused/)
})

test('an empty Host library says so rather than reporting no matches', async () => {
  const { ctx } = await mounted([])
  const state = await readLibraryPage(
    ctx.remote.watchQuery,
    { text: 'kettle', modality: '', limit: 10, deadlineMs: 5000 },
    new AbortController().signal,
  )
  assert.equal(state.total, 0)
  assert.notEqual(state.health, 'ready',
    'an index nobody has built is not a complete answer to anything')
})

// ── the Library half waits for it, and binds it to the mode body ────────────

/** DSH's slot service, reduced to what the Library half calls. */
class SlotsService extends Service {
  constructor(ctx, registrations) {
    super(ctx, 'slots')
    this.registrations = registrations
  }

  inject(_name, register) { register() }
  register(entry, component) { this.registrations.push({ entry, component }) }
}

test('the Library half parks until the namespace exists, then binds it', async () => {
  const { gateway } = await host()
  const { ctx } = await client(gateway)
  const registrations = []
  new SlotsService(ctx, registrations)
  await settle()

  ctx.plugin({ ...LIBRARY_CLIENT })
  await settle()
  assert.deepEqual(registrations, [],
    'a Library tab drawn before the read plane exists would search nothing at all')

  const remotes = ctx.plugin(WATCH_REMOTES)
  await remotes
  await settle()

  assert.equal(registrations.length, 1, 'the parked plugin resumed once the mount landed')
  assert.equal(registrations[0].entry.id, 'library')
  assert.equal(registrations[0].entry.name, 'conversation.view')

  // Registered is not bound. DSH calls a view entry with `{ inspect,
  // onInspectDone }` and nothing else, so the only evidence that the namespace
  // reached the body is what the body says when it is rendered that way.
  const markup = renderToStaticMarkup(createElement(registrations[0].component, {
    inspect: undefined, onInspectDone: () => {},
  }))
  assert.match(markup, /workspace/, 'the body renders')
  assert.match(markup, /own host/,
    'the body still describes a local-only search, so `reads` never reached it')
})

// ── and it goes away with the plugin ────────────────────────────────────────

test('disposing the plugin removes the namespace it mounted', async () => {
  const { ctx, fiber } = await mounted()
  assert.notEqual(ctx.get('remote.watchQuery'), undefined)

  await fiber.dispose()
  await settle()

  assert.equal(ctx.get('remote.watchQuery'), undefined,
    'a namespace that outlives its plugin points at a fiber that has gone')
  assert.equal(ctx.typert.remotes.list().length, 0,
    'and the contribution is deregistered with it')
})

// ── refresh, all the way through ────────────────────────────────────────────

/** Both ends over a real directory, so a refresh has something to find. */
async function mountedOverDisk(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'rcm-'))
  const write = (name, text) => {
    writeFileSync(join(dir, name), JSON.stringify({ kind: 'document', text }))
  }
  for (const [name, text] of Object.entries(initial)) write(name, text)

  const hostCtx = new Context()
  hostCtx.plugin(TypertRegistryPlugin)
  hostCtx.plugin(GatewayPlugin)
  await settle()
  hostCtx.typert.register(TYPERT)
  const generations = new LibraryGenerations({ roots: [dir.split(sep).join('/')] })
  new WatchQueryService(hostCtx, {
    index: () => generations.index(), scope: 'workspace-1', generations,
  })
  await settle()

  const { ctx, wire } = await client(hostCtx.typertGateway)
  const fiber = ctx.plugin(WATCH_REMOTES)
  await fiber
  await settle()
  return { ctx, wire, write, dispose: () => { rmSync(dir, { recursive: true, force: true }) } }
}

test('the Library’s own refresh reaches the Host and changes what it finds', async () => {
  const app = await mountedOverDisk({ 'one.json': 'the kettle boiled' })
  try {
    const query = { text: '', modality: '', limit: 20, deadlineMs: 5000 }
    const signal = new AbortController().signal

    const before = await readLibraryPage(app.ctx.remote.watchQuery, query, signal)
    assert.equal(before.rows.length, 1)

    // Written after the host started, and invisible to a search on purpose.
    app.write('two.json', 'the toaster popped')
    const stale = await readLibraryPage(app.ctx.remote.watchQuery, query, signal)
    assert.equal(stale.rows.length, 1, 'a search must not re-read the corpus on its own')

    const refreshed = await refreshLibrary(app.ctx.remote.watchQuery, 5000, signal)
    assert.equal(refreshed.failed, false, refreshed.note)
    assert.equal(refreshed.refreshed, true)
    assert.equal(refreshed.recordCount, 2)
    assert.ok(refreshed.generation > before.generation)

    const after = await readLibraryPage(app.ctx.remote.watchQuery, query, signal)
    assert.equal(after.rows.length, 2, 'the browser sees the new record without a restart')
    assert.equal(after.generation, refreshed.generation)

    // It went over the carrier as its own endpoint, not folded into a search.
    assert.equal(app.wire.filter(frame => frame.endpoint === 'watchQuery/libraryRefresh').length, 1)
  } finally {
    app.dispose()
  }
})

test('a refresh against a Host that cannot rebuild is rendered, not hidden', async () => {
  // The capability-absent path, as the surface sees it: a note a person can
  // read, `failed` set, and no claim that anything was refreshed.
  const { ctx } = await mounted()
  const state = await refreshLibrary(
    ctx.remote.watchQuery, 5000, new AbortController().signal)

  assert.equal(state.refreshed, false)
  assert.equal(state.failed, true)
  assert.match(state.note, /previous index is still searchable/)
})
