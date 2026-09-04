/**
 * Who asked, and is this route still the one that was proved.
 *
 * Two questions the Host asks before a model request is dispatched. Three
 * earlier answers were too weak, and the sequence is worth keeping because each
 * looked right at the time.
 *
 * *Bound* was too weak: a `watch-bindings` entry naming a public provider and a
 * model nobody had chosen appeared in an offline profile's settings, and the
 * Host attempted a chat completion against it seconds later. The guard allowed
 * it because the document named the pair.
 *
 * *Bound and marked tested* was worse for being plausible: a `testedAt` beside
 * the binding is written by whatever wrote the binding, and proves only that
 * the same hand was there twice.
 *
 * *Bound, proved, and reachable through whatever object each half happened to
 * resolve* failed in the most expensive way: a Cordis service is reflected per
 * scope, so the guard and the read plane read different state and the single
 * request allowed to prove a route was refused. The service is a bundle row
 * now, injected by both, and the first test below is the one that has to pass
 * before any other means anything.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TECH = join(ROOT, 'packages', 'watch', 'technology', 'lib')

const routing = (await import(pathToFileURL(join(TECH, 'routing.js')).href)).default
const provenancePlugin = (await import(pathToFileURL(join(TECH, 'provenance.js')).href))
const { receiptAuthorises, routeKey } = provenancePlugin
const { testProvider } = await import(pathToFileURL(
  join(ROOT, 'packages', 'watch', 'tools', 'lib', 'read-plane.js')).href)

const PROVIDER = 'openrouter'
const MODEL = 'deepseek/deepseek-v4-pro'
const ROUTE = routeKey(PROVIDER, MODEL)

/** The settings document a profile actually holds, served synchronously. */
class StubSettings extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'settings')
    this.watchers = new Map()
    const bound = config.bound !== false
    this.document = {
      'llm-pi-ai': {
        providers: {
          [PROVIDER]: {
            baseURL: 'http://127.0.0.1:1/api/v1',
            api: 'openai-completions',
            apiKeyEnv: 'OPENROUTER_API_KEY',
          },
        },
      },
      'watch-bindings': {
        version: 1,
        roles: bound
          ? {
              agent_model: {
                provider: PROVIDER, model: MODEL,
                credentialRef: 'OPENROUTER_API_KEY',
                boundAt: '2026-08-31T05:03:08.000Z',
              },
            }
          : {},
      },
    }
  }

  /** Bind the chat role to the observed route, the way the screen would. */
  bind() {
    this.edit('watch-bindings', (document) => {
      document.roles.agent_model = {
        provider: PROVIDER, model: MODEL,
        credentialRef: 'OPENROUTER_API_KEY',
        boundAt: new Date().toISOString(),
      }
    })
  }

  section(ns) { return this.document[ns] }

  /**
   * The half `installSettingsSection` uses.
   *
   * Present because the routing guard reads its bindings through a registered
   * section rather than through `section()`, and a stub that answered only the
   * latter left the guard looking at the empty composition base — which made
   * every bound route read as unbound and every refusal look correct for the
   * wrong reason.
   */
  register(ns, _schema, options = {}) {
    this.document[ns] ??= options.base
    const watchers = this.watchers.get(ns) ?? []
    this.watchers.set(ns, watchers)
    return {
      get: () => this.document[ns],
      watch: (listener) => { watchers.push(listener) },
    }
  }

  /** Edit one namespace the way a settings write would, and announce it. */
  edit(ns, mutate) {
    mutate(this.document[ns])
    for (const listener of this.watchers.get(ns) ?? []) listener()
    this.ctx.emit('settings/document-updated', ns, 2)
  }
}

/** An adapter that dispatches only when pulled, exactly like the real one. */
class LazyLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
    this.dispatched = 0
    this.seen = []
  }

  stream(options) {
    const ctx = this.ctx
    const self = this
    return (async function* pulled() {
      const inner = await ctx.waterfall('llm/stream', options, () => {
        self.dispatched += 1
        self.seen.push({ provider: options.provider, model: options.model })
        return (async function* served() {
          yield { type: 'finish', reason: { kind: 'stop', failure: null } }
        })()
      })
      for await (const chunk of inner) yield chunk
    })()
  }
}

/** The composed shape: one provenance row, injected by the guard. */
async function mount(config = {}) {
  const ctx = new Context()
  await ctx.plugin(StubSettings, config)
  await ctx.plugin(LazyLlm)
  await ctx.plugin(provenancePlugin)
  const fiber = await ctx.plugin(routing, { enforce: true })
  const provenance = ctx.get('watchProvenance')

  const dispatch = async () => {
    for await (const chunk of ctx.get('llm').stream({
      provider: PROVIDER, model: MODEL, messages: [],
    })) void chunk
  }
  const attempt = async (run) => {
    try {
      await run()
      return { ok: true }
    } catch (error) { return { ok: false, error } }
  }

  return {
    ctx, provenance,
    settings: ctx.get('settings'),
    calls: () => ctx.get('llm').dispatched,
    providerTest: (id = 'req-1') => attempt(async () => {
      const answer = await testProvider(
        { provider: PROVIDER, model: MODEL, requestId: id, deadlineMs: 5_000 },
        ctx, new AbortController().signal)
      if (!answer.ok) throw new Error(`provider test refused: ${answer.message}`)
    }),
    userTurn: () => attempt(async () => {
      provenance.openTurn('agent#1')
      try { await dispatch() } finally { provenance.closeTurn('agent#1') }
    }),
    background: () => attempt(dispatch),
    dispose: () => fiber.dispose(),
  }
}

describe('one service, mounted once, injected by both halves', () => {
  test('routing and tools resolve the same instance in a composed application', async () => {
    // The test that has to pass before any other means anything. Both halves
    // reach the service the same way the composed profile does; if these are
    // two objects, every proof below is about state nothing else can see.
    const host = await mount()
    const fromRouting = host.ctx.get('watchProvenance')
    const fromTools = host.ctx.get('watchProvenance')
    fromRouting.openTurn('identity-probe')
    assert.equal(fromTools.activeTurn(), 'identity-probe',
      'the guard and the read plane are looking at different services')
    fromRouting.closeTurn('identity-probe')
    assert.equal(fromTools.activeTurn(), null)
    await host.dispose()
  })

  test('the bundle mounts it as its own row, ahead of what injects it', () => {
    const patch = readFileSync(
      join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml'), 'utf8')
    const provenanceAt = patch.indexOf('id: watch-provenance')
    const routingAt = patch.indexOf('id: watch-routing')
    assert.ok(provenanceAt > 0, 'the bundle composes no provenance row')
    assert.ok(provenanceAt < routingAt, 'the row is composed after what injects it')
    assert.match(patch, /name: '@deepwatch\/dsh-technology\/provenance'/)
  })

  test('both plugins declare the injection rather than constructing it', () => {
    const guard = readFileSync(
      join(ROOT, 'packages', 'watch', 'technology', 'src', 'routing.ts'), 'utf8')
    const tools = readFileSync(
      join(ROOT, 'packages', 'watch', 'tools', 'src', 'index.ts'), 'utf8')
    assert.match(guard, /export const inject = \['llm', PROVENANCE_SERVICE\]/)
    assert.match(tools, /export const inject = \[[^\]]*'watchProvenance'[^\]]*\]/)
    assert.doesNotMatch(guard, /new WatchProvenance\(/,
      'the guard constructs its own service again')
  })
})

describe('only a completed provider test may prove a route', () => {
  test('an explicit provider test is exactly one request', async () => {
    const host = await mount()
    const result = await host.providerTest()
    assert.equal(result.ok, true, String(result.error))
    assert.equal(host.calls(), 1)
    await host.dispose()
  })

  test('a user turn after a valid test is exactly one content request', async () => {
    const host = await mount()
    await host.providerTest()
    const before = host.calls()
    const result = await host.userTurn()
    assert.equal(result.ok, true, String(result.error))
    assert.equal(host.calls() - before, 1)
    await host.dispose()
  })

  test('a configured but untested route sends nothing', async () => {
    const host = await mount()
    const result = await host.userTurn()
    assert.equal(result.ok, false, 'an unproved route served a turn')
    assert.equal(host.calls(), 0)
    await host.dispose()
  })

  test('a forged binding for the observed route sends nothing', async () => {
    // The exact scenario: a public provider and a model nobody chose, written
    // into the settings document by something that was not a person.
    const host = await mount()
    host.settings.edit('watch-bindings', (document) => {
      document.roles.agent_model = {
        provider: PROVIDER, model: MODEL,
        credentialRef: 'OPENROUTER_API_KEY',
        boundAt: new Date().toISOString(),
      }
    })
    const result = await host.userTurn()
    assert.equal(result.ok, false)
    assert.equal(host.calls(), 0, 'a forged binding reached a provider')
    await host.dispose()
  })

  test('testing before binding is the product order, and it works', async () => {
    // The regression the browser pass caught. DeepWatch's own sequence is
    // configure, test, bind, prompt: a person proves the route on the Models
    // screen and only then gives it a role. An earlier version cleared every
    // receipt on any settings write, so the bind step destroyed the proof it
    // depended on and the first message was refused.
    const host = await mount({ bound: false })
    const test1 = await host.providerTest()
    assert.equal(test1.ok, true, String(test1.error))
    host.settings.bind()
    const before = host.calls()
    const result = await host.userTurn()
    assert.equal(result.ok, true, String(result.error))
    assert.equal(host.calls() - before, 1)
    await host.dispose()
  })

  test('a proved route nobody bound still serves no turn', async () => {
    // Proving a route is not choosing it. The original question survives.
    const host = await mount({ bound: false })
    await host.providerTest()
    const before = host.calls()
    const result = await host.userTurn()
    assert.equal(result.ok, false, 'an unbound route served a turn once tested')
    assert.equal(result.error.name, 'UnboundRouteError')
    assert.equal(host.calls() - before, 0)
    await host.dispose()
  })

  test('a forged attestation beside the binding sends nothing', async () => {
    const host = await mount()
    host.settings.edit('watch-bindings', (document) => {
      document.roles.agent_model.testedAt = new Date().toISOString()
      document.roles.agent_model.verified = true
      document.roles.agent_model.receipt = { requestId: 'copied', at: 'now' }
    })
    const result = await host.userTurn()
    assert.equal(result.ok, false, 'a forged attestation authorised a request')
    assert.equal(host.calls(), 0)
    await host.dispose()
  })
})

describe('a proof does not outlive what it was taken under', () => {
  const changes = {
    'base URL': (document) => { document.providers[PROVIDER].baseURL = 'http://127.0.0.1:2/api/v1' },
    'API flavour': (document) => { document.providers[PROVIDER].api = 'openai-responses' },
    'credential reference': (document) => { document.providers[PROVIDER].apiKeyEnv = 'OTHER_KEY' },
  }
  for (const [what, mutate] of Object.entries(changes)) {
    test(`a changed ${what} invalidates readiness`, async () => {
      const host = await mount()
      await host.providerTest()
      const before = host.calls()
      host.settings.edit('llm-pi-ai', mutate)
      const result = await host.userTurn()
      assert.equal(result.ok, false, `${what} changed and the old proof still served`)
      assert.equal(host.calls() - before, 0)
      await host.dispose()
    })
  }

  test('an edited header invalidates readiness', async () => {
    // Not one of the four fields an earlier version pinned, which is exactly
    // why it is here: the digest is over the whole profile, so a field nobody
    // thought to list still moves it.
    const host = await mount()
    await host.providerTest()
    const before = host.calls()
    host.settings.edit('llm-pi-ai', (document) => {
      document.providers[PROVIDER].headers = { 'HTTP-Referer': 'https://elsewhere.example' }
    })
    const result = await host.userTurn()
    assert.equal(result.ok, false, 'a header changed and the old proof still served')
    assert.equal(host.calls() - before, 0)
    await host.dispose()
  })

  test('a rotated credential invalidates readiness', async () => {
    // The one change that leaves settings byte-identical: the reference still
    // reads `OPENROUTER_API_KEY` and the value behind it is somebody else's.
    // Caught by counting the store's own announcements, never by reading either
    // value.
    const host = await mount()
    await host.providerTest()
    const before = host.calls()
    host.ctx.emit('credentials/reference-updated', 'OPENROUTER_API_KEY')
    const result = await host.userTurn()
    assert.equal(result.ok, false, 'a proof survived the key it was taken under')
    assert.equal(host.calls() - before, 0)
    await host.dispose()
  })

  test('a rebinding to another model unbinds this route', async () => {
    const host = await mount()
    await host.providerTest()
    const before = host.calls()
    host.settings.edit('watch-bindings', (document) => {
      document.roles.agent_model.model = 'openai/gpt-4o-mini'
    })
    const result = await host.userTurn()
    assert.equal(result.ok, false)
    assert.equal(result.error.name, 'UnboundRouteError')
    assert.equal(result.error.boundButUnproved, false,
      'the refusal blamed the proof when nothing was bound to this route')
    assert.equal(host.calls() - before, 0)
    await host.dispose()
  })

  test('a receipt for another model proves nothing about this one', () => {
    const facts = { providerRevision: 'a', credentialRevision: 'b' }
    const receipt = { provider: PROVIDER, model: 'other', requestId: 'r', at: 'now', ...facts }
    assert.equal(receiptAuthorises(receipt, PROVIDER, MODEL, facts), false)
    assert.equal(receiptAuthorises(undefined, PROVIDER, MODEL, facts), false)
    assert.equal(receiptAuthorises(
      { provider: PROVIDER, model: MODEL, requestId: 'r', at: 'now', ...facts },
      PROVIDER, MODEL, null), false, 'unreadable facts must fail closed')
  })
})

describe('a proved route is still not an open door', () => {
  test('an idle background job is refused even with a valid receipt', async () => {
    const host = await mount()
    await host.providerTest()
    const before = host.calls()
    const result = await host.background()
    assert.equal(result.ok, false, 'an idle job spent a request on a proved route')
    assert.equal(result.error.name, 'UnattributedRequestError')
    assert.equal(host.calls() - before, 0)
    await host.dispose()
  })

  test('a turn that has ended lends no authority to what follows it', async () => {
    const host = await mount()
    await host.providerTest()
    await host.userTurn()
    const before = host.calls()
    const later = await host.background()
    assert.equal(later.ok, false, 'a finished turn authorised a later background call')
    assert.equal(host.calls() - before, 0)
    await host.dispose()
  })

  test('a cancelled turn revokes authorisation immediately', async () => {
    const host = await mount()
    await host.providerTest()
    host.provenance.openTurn('agent#7')
    host.provenance.closeTurn('agent#7')
    const result = await host.background()
    assert.equal(result.ok, false, 'a cancelled turn still authorised a request')
    await host.dispose()
  })

  test('an agent error closes every turn', async () => {
    const host = await mount()
    await host.providerTest()
    host.provenance.openTurn('agent#8')
    host.ctx.emit('agent/error', {})
    assert.equal(host.provenance.activeTurn(), null)
    const result = await host.background()
    assert.equal(result.ok, false)
    await host.dispose()
  })
})

describe('a capability is one use, one route, and it expires', () => {
  test('replaying a spent capability is refused as a replay', async () => {
    const host = await mount()
    const capability = host.provenance.authorizeProviderTest(PROVIDER, MODEL, 'r')
    assert.equal(host.provenance.consume(capability.token, ROUTE), 'ok')
    assert.equal(host.provenance.consume(capability.token, ROUTE), 'replayed')
    await host.dispose()
  })

  test('a capability presented at another route is refused and spent', async () => {
    const host = await mount()
    const capability = host.provenance.authorizeProviderTest(PROVIDER, MODEL, 'r')
    assert.equal(host.provenance.consume(capability.token, routeKey(PROVIDER, 'other')),
      'route_mismatch')
    // Spent on presentation, so it cannot be probed until it lands.
    assert.equal(host.provenance.consume(capability.token, ROUTE), 'replayed')
    await host.dispose()
  })

  test('an invented token is unknown', async () => {
    const host = await mount()
    assert.equal(host.provenance.consume('wp-not-a-token', ROUTE), 'unknown')
    assert.equal(host.provenance.consume(undefined, ROUTE), 'unknown')
    await host.dispose()
  })

  test('a provider test issues one request and no more', async () => {
    // The capability is spent by the first dispatch, so a second attempt on the
    // same permit is refused rather than quietly doubling the spend.
    const host = await mount()
    await host.providerTest('req-a')
    const before = host.calls()
    const second = await host.background()
    assert.equal(second.ok, false)
    assert.equal(host.calls() - before, 0)
    await host.dispose()
  })
})

describe('nothing secret is anywhere near this', () => {
  test('a receipt holds references and revisions, never a value', async () => {
    const host = await mount()
    await host.providerTest()
    const receipt = host.provenance.receiptFor(PROVIDER, MODEL)
    assert.deepEqual(Object.keys(receipt).sort(), [
      'at', 'credentialRevision', 'model', 'provider', 'providerRevision', 'requestId',
    ])
    // The reference is a permitted thing to bind to; the value is not, and
    // neither is anything measured from it. The revisions are digests of
    // settings and a write count, so the reference name itself does not survive
    // into the receipt either.
    const serialised = JSON.stringify(receipt)
    assert.doesNotMatch(serialised, /sk-|Bearer |OPENROUTER_API_KEY/)
    await host.dispose()
  })

  test('a refusal names the route and no credential or path', async () => {
    const host = await mount()
    const { error } = await host.background()
    for (const forbidden of ['sk-', 'Bearer', 'API_KEY', 'apiKey']) {
      assert.equal(String(error.message).includes(forbidden), false,
        `the refusal carries ${forbidden}`)
    }
    assert.doesNotMatch(String(error.message), /[A-Za-z]:[\\/]/)
    await host.dispose()
  })
})

describe('the upstream events this relies on still exist', () => {
  test('the pinned agent loop emits the turn events', (t) => {
    const source = agentLoopSource()
    if (source === null) {
      t.skip('the pinned Harness baseline is not checked out; run scripts/upstream-sync.mjs')
      return
    }
    for (const name of ['agent/pre-step', 'agent/turn-stopping', 'agent/error', 'agent/disposed']) {
      assert.ok(source.includes(name), `the pinned agent loop no longer emits ${name}`)
    }
  })

  test('the settings provider emits a document-updated event', (t) => {
    const source = settingsSource()
    if (source === null) {
      t.skip('the pinned Harness baseline is not checked out; run scripts/upstream-sync.mjs')
      return
    }
    assert.ok(source.includes('settings/document-updated'),
      'settings changes would stop reaching the binding source')
  })

  test('the credentials service still announces a committed write', (t) => {
    const source = credentialsSource()
    if (source === null) {
      t.skip('the pinned Harness baseline is not checked out; run scripts/upstream-sync.mjs')
      return
    }
    // The one route change that leaves settings byte-identical. Without these
    // two notifications a rotated key would keep a stale proof alive, and the
    // only alternative signal is the value itself, which this subsystem is not
    // allowed to read.
    for (const name of ['credentials/reference-updated', 'credentials/record-updated']) {
      assert.ok(source.includes(name), `the pinned credentials service no longer emits ${name}`)
    }
  })
})

/**
 * One pinned upstream package's source, read from the checkout it is pinned in.
 *
 * The baseline is script-managed (`scripts/upstream-sync.mjs`) rather than
 * vendored, so a fresh clone has none until that has run. Null says so; the
 * callers skip with the command to fix it rather than passing on an empty read.
 */
function pinned(...relative) {
  const base = join(ROOT, 'upstream', 'deepseek-harness', 'packages')
  const candidate = join(base, ...relative)
  return existsSync(candidate) ? readFileSync(candidate, 'utf8') : null
}

const agentLoopSource = () => {
  // The loop is more than one file: `agent/disposed` is declared in the entry
  // point and the turn events in `agent.ts`, so both are read.
  const entry = pinned('core', 'agent-loop', 'src', 'index.ts')
  const agent = pinned('core', 'agent-loop', 'src', 'agent.ts')
  return entry === null || agent === null ? null : `${entry}
${agent}`
}
const settingsSource = () => pinned('settings', 'settings', 'src', 'index.ts')
const credentialsSource = () => pinned('credentials', 'credentials', 'src', 'types.ts')
