/**
 * Where the first prompt actually goes, proved against a provider we own.
 *
 * The failure this pins is not subtle and it is not hypothetical: a person
 * configured OpenRouter, and their first message was sent to DeepSeek. Every
 * layer above believed something reasonable — a credential was stored, a route
 * was registered, a model was selected — and the request still went to a
 * provider nobody had chosen.
 *
 * So the assertions here are about *the wire*. A local OpenRouter-compatible
 * provider records every request it receives, and the tests count them: one
 * request to the bound route, zero to anything else, and nothing in the body
 * that should not have left the machine. Counting is the point. A test that
 * only checked the answer would pass for an implementation that called two
 * providers and rendered the second.
 *
 * Nothing here reaches the internet. The stub binds `127.0.0.1` on a port the
 * operating system picks, its credential is a fake one it checks for, and no
 * code path in this file reads an environment variable.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const { startOpenRouterStub, STUB_API_KEY, STUB_REPLY } = await import(
  pathToFileURL(join(ROOT, 'scripts', 'lib', 'openrouter-stub.mjs')).href)
const routing = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'technology', 'lib', 'routing.js')).href)
const provenancePlugin = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'technology', 'lib', 'provenance.js')).href)
const { relativeToRoot, findAbsolutePaths } = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'contracts', 'lib', 'paths.js')).href)

/** The service the routing plugin injects; a stand-in, since it is not the subject. */
class StubLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
  }
}

/** The settings the guard reads a route's authoritative facts out of. */
class StubSettings extends Service {
  constructor(ctx, document) {
    super(ctx, 'settings')
    this.document = document
  }

  section(ns) { return this.document[ns] }
}

const running = []
after(async () => { for (const stub of running) await stub.stop() })

async function stubProvider(options) {
  const stub = await startOpenRouterStub(options)
  running.push(stub)
  return stub
}

/** A document binding Chat to the stub route. */
function bound(model = 'stub/echo-small') {
  return {
    version: 1,
    roles: {
      agent_model: {
        provider: 'openrouter-stub',
        model,
        credentialRef: 'OPENROUTER_STUB_KEY',
        boundAt: '2026-08-31T05:03:08.000Z',
      },
    },
  }
}

/**
 * A Host whose downstream really speaks to a provider.
 *
 * `next()` is not a spy here — it performs the HTTP request an adapter would.
 * That is what makes "zero requests reached the provider" a claim about the
 * network rather than about a mock nobody wired up.
 */
async function host(stub, { bindings, enforce = true, prove = true } = {}) {
  const ctx = new Context()
  await ctx.plugin(StubLlm)
  await ctx.plugin(StubSettings, {
    'llm-pi-ai': {
      providers: {
        'openrouter-stub': {
          baseURL: stub.baseURL, api: 'openai-completions',
          apiKeyEnv: 'OPENROUTER_STUB_KEY',
        },
      },
    },
    'watch-bindings': bindings ?? { version: 1, roles: {} },
  })
  await ctx.plugin(provenancePlugin)
  const fiber = await ctx.plugin(routing, {
    enforce,
    ...bindings === undefined ? {} : { bindings },
  })

  // A route the fixture bound counts as proved unless the case is about an
  // unproved one, and a send happens inside an open turn — which is what a
  // person pressing enter causes.
  const provenance = ctx.get('watchProvenance')
  if (prove) {
    for (const record of Object.values(bindings?.roles ?? {})) {
      const facts = provenance.factsFor(record.provider, record.model)
      provenance.mint({
        provider: record.provider, model: record.model,
        requestId: 'stub-test', at: '2026-08-31T05:04:00.000Z', ...facts,
      })
    }
  }

  const send = async (provider, model, messages, { apiKey = STUB_API_KEY } = {}) => {
    provenance.openTurn('agent#1')
    try {
      const stream = await ctx.waterfall(
        'llm/stream',
        { provider, model, messages },
        () => (async function* served() {
          const response = await fetch(`${stub.baseURL}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model, messages, stream: false }),
          })
          const body = await response.json()
          if (!response.ok) throw new Error(`provider answered ${String(response.status)}`)
          yield { type: 'text', text: body.choices[0].message.content }
        })())
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return { ok: true, chunks }
    } catch (error) {
      return { ok: false, error }
    } finally {
      provenance.closeTurn('agent#1')
    }
  }

  return { ctx, provenance, send, dispose: () => fiber.dispose() }
}

describe('the bound route is the route that is called', () => {
  test('exactly one request reaches the provider, and it carries the chosen model', async () => {
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound() })

    const result = await deployment.send('openrouter-stub', 'stub/echo-small', [
      { role: 'user', content: 'ready?' },
    ])

    assert.equal(result.ok, true)
    assert.equal(result.chunks[0].text, STUB_REPLY)
    const completions = stub.completions()
    assert.equal(completions.length, 1, `${String(completions.length)} requests reached the provider`)
    assert.equal(completions[0].body.model, 'stub/echo-small')
    assert.equal(completions[0].authorized, true)
    await deployment.dispose()
  })

  test('a route nobody bound reaches the provider zero times', async () => {
    // The regression, on the wire. `deepseek-official` is a real registered
    // route in a stock profile, so every check upstream had said yes.
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound() })

    const result = await deployment.send('deepseek-official', 'deepseek-v4-flash', [
      { role: 'user', content: 'ready?' },
    ])

    assert.equal(result.ok, false)
    assert.equal(result.error.name, 'UnboundRouteError')
    assert.equal(stub.completions().length, 0, 'a refused route still spent a request')
    await deployment.dispose()
  })

  test('a bound route nobody proved reaches the provider zero times', async () => {
    // The regression that escaped, on the wire: a binding naming a route
    // appeared in a profile nobody had pointed at it, and the Host attempted a
    // completion because the document said it was bound. Being in the document
    // is not evidence — only a completed provider test is.
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound(), prove: false })

    const result = await deployment.send('openrouter-stub', 'stub/echo-small', [
      { role: 'user', content: 'ready?' },
    ])

    assert.equal(result.ok, false)
    assert.equal(result.error.name, 'UnboundRouteError')
    assert.match(String(result.error.message), /no provider test has proved it/)
    assert.equal(stub.completions().length, 0, 'an unproved binding spent a request')
    await deployment.dispose()
  })

  test('an idle background call reaches the provider zero times', async () => {
    // Proved route, no turn. The wire-level form of "nobody asked".
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound() })
    let threw = null
    try {
      const stream = await deployment.ctx.waterfall('llm/stream', {
        provider: 'openrouter-stub', model: 'stub/echo-small', messages: [],
      }, () => (async function* served() { yield { type: 'text', text: 'x' } })())
      for await (const chunk of stream) void chunk
    } catch (error) { threw = error }
    assert.equal(threw?.name, 'UnattributedRequestError')
    assert.equal(stub.completions().length, 0, 'an idle call spent a request')
    await deployment.dispose()
  })

  test('a refused request spends nothing at all', async () => {
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound() })
    await deployment.send('deepseek-official', 'deepseek-v4-flash', [{ role: 'user', content: 'x' }])
    await deployment.send('openrouter-stub', 'stub/echo-large', [{ role: 'user', content: 'x' }])
    // Neither reached it: the first is an unbound provider, the second an
    // unbound model on a bound provider.
    assert.equal(stub.requests.length, 0)
    await deployment.dispose()
  })

  test('a second prompt is a second request, not a second provider', async () => {
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound() })
    await deployment.send('openrouter-stub', 'stub/echo-small', [{ role: 'user', content: 'one' }])
    await deployment.send('openrouter-stub', 'stub/echo-small', [{ role: 'user', content: 'two' }])
    const completions = stub.completions()
    assert.equal(completions.length, 2)
    for (const entry of completions) {
      assert.equal(entry.body.model, 'stub/echo-small')
    }
    await deployment.dispose()
  })
})

describe('what the provider is not sent', () => {
  test('no absolute workspace path reaches the request body', async () => {
    // The other half of the incident: selecting a workspace put `D:\Ws` into
    // the Context panel, the session log, and the text handed to the model.
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound() })

    const workspace = 'D:\\Ws'
    const file = 'D:\\Ws\\src\\index.ts'
    const relative = relativeToRoot(file, workspace)
    assert.equal(relative, 'src/index.ts')

    await deployment.send('openrouter-stub', 'stub/echo-small', [
      { role: 'user', content: `explain ${relative}` },
    ])

    const [sent] = stub.completions()
    assert.deepEqual(findAbsolutePaths(sent.raw), [],
      `the request body carries ${findAbsolutePaths(sent.raw).join(', ')}`)
    assert.ok(sent.raw.includes('src/index.ts'), 'the relative path did not survive')
    await deployment.dispose()
  })

  test('a path-boundary collision is not mistaken for the workspace', () => {
    // `D:\Wsuite` is not inside `D:\Ws`, and a prefix match without a
    // separator check would rewrite it into a directory that never existed.
    assert.equal(relativeToRoot('D:\\Wsuite\\cv.md', 'D:\\Ws'), null)
    // The drive letter folds, because `d:` and `D:` are one directory and a
    // case-sensitive comparison would miss half the matches.
    assert.equal(relativeToRoot('d:\\Ws\\src\\a.ts', 'D:\\Ws'), 'src/a.ts')
    assert.equal(relativeToRoot('D:/Ws/src/a.ts', 'd:\\Ws'), 'src/a.ts')
    // The rest of the path does not fold, and that is the deliberate side of
    // the trade the module documents: a missed redaction is caught by a test,
    // a wrong one rewrites a directory nobody named.
    assert.equal(relativeToRoot('d:/em/src/a.ts', 'D:\\Ws'), null)
  })

  test('the recorded request never echoes the credential', async () => {
    // The recorder is printed in failing assertions. A fixture that stored the
    // token would put it in every CI log that ever failed here.
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound() })
    await deployment.send('openrouter-stub', 'stub/echo-small', [{ role: 'user', content: 'x' }])
    const [sent] = stub.completions()
    assert.equal(JSON.stringify(sent).includes(STUB_API_KEY), false)
    assert.equal(sent.authorized, true)
    await deployment.dispose()
  })
})

describe('the provider states the product has to render', () => {
  test('a rejected credential is a 401 the product can classify', async () => {
    const stub = await stubProvider()
    const deployment = await host(stub, { bindings: bound() })
    const result = await deployment.send(
      'openrouter-stub', 'stub/echo-small', [{ role: 'user', content: 'x' }],
      { apiKey: 'sk-stub-wrong' })
    assert.equal(result.ok, false)
    assert.match(result.error.message, /401/)
    assert.equal(stub.completions()[0].authorized, false)
    await deployment.dispose()
  })

  test('a rate limit is a 429', async () => {
    const stub = await stubProvider({ failWith: 429 })
    const deployment = await host(stub, { bindings: bound() })
    const result = await deployment.send('openrouter-stub', 'stub/echo-small', [
      { role: 'user', content: 'x' },
    ])
    assert.equal(result.ok, false)
    assert.match(result.error.message, /429/)
    await deployment.dispose()
  })

  test('a model the provider dropped is absent from its catalogue', async () => {
    const stub = await stubProvider({ models: [{ id: 'stub/echo-large', name: 'Stub Echo Large' }] })
    const response = await fetch(`${stub.baseURL}/models`)
    const body = await response.json()
    assert.deepEqual(body.data.map(model => model.id), ['stub/echo-large'])
  })

  test('the catalogue is readable before a credential is', async () => {
    // Discovering models must not require a working key, or a person cannot
    // choose one before finishing setup.
    const stub = await stubProvider()
    const response = await fetch(`${stub.baseURL}/models`)
    assert.equal(response.status, 200)
    assert.equal(stub.requests.at(-1).authorized, false)
  })
})

describe('the stub cannot become a real provider', () => {
  test('it listens on loopback only', async () => {
    const stub = await stubProvider()
    assert.match(stub.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/)
  })

  test('its source names no external host', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(join(ROOT, 'scripts', 'lib', 'openrouter-stub.mjs'), 'utf8')
    assert.equal(/openrouter\.ai|api\.openai\.com|https:\/\//.test(source), false,
      'the stub names a real provider endpoint')
  })

  test('its credential is obviously not one', () => {
    assert.match(STUB_API_KEY, /stub-not-a-real-key/)
  })
})
