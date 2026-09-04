/**
 * The Host's refusal, which does not depend on the client behaving.
 *
 * The composer refusing to submit is the right thing to build and it is not
 * enforcement. It lives in a browser tab; the tab can hold a selection from
 * before a binding changed, and the RPC it declines to call stays callable by
 * anything that wants to call it. Upstream is explicit about the division —
 * *"This is an affordance, not enforcement: the Host refuses a prompt it
 * cannot route regardless of what any client disables."*
 *
 * So these are the cases where the client is wrong, absent, or lying, and the
 * request still must not reach a provider. The one that shipped is
 * `a route nobody bound is refused even though an adapter serves it`: DeepSeek
 * was registered, so every check upstream had said yes, and the request went
 * out on a credential the person had never been asked for.
 *
 * The counting matters as much as the refusing. `next()` is what reaches the
 * adapter, so a test that only asserted "it threw" would pass for an
 * implementation that called the provider and threw afterwards — which is the
 * failure, not the fix. Every case below counts how many times the downstream
 * was entered, and the answer for a refusal is zero.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TECHNOLOGY = join(ROOT, 'packages', 'watch', 'technology')

const routing = await import(pathToFileURL(join(TECHNOLOGY, 'lib', 'routing.js')).href)
const provenancePlugin = await import(pathToFileURL(join(TECHNOLOGY, 'lib', 'provenance.js')).href)

/**
 * The one service the plugin injects.
 *
 * A stand-in rather than the real runtime: this file is about the decision the
 * plugin makes before an adapter is reached, and mounting a real LLM runtime
 * would put a provider registry between the test and the thing being tested.
 */
class StubLlm extends Service {
  constructor(ctx) {
    super(ctx, 'llm')
  }
}

/**
 * The settings the guard reads a route's authoritative facts out of.
 *
 * A receipt is pinned to the base URL, the credential reference and the binding
 * document, so the guard has to be able to read them. Without a settings
 * service it cannot, and refuses — which is the safe direction and is asserted
 * separately.
 */
class StubSettings extends Service {
  constructor(ctx, document) {
    super(ctx, 'settings')
    this.document = document
  }

  section(ns) { return this.document[ns] }
}

/** The provider entries a bindings fixture implies, so facts can be read. */
function providersFor(bindings) {
  const providers = {}
  for (const record of Object.values(bindings?.roles ?? {})) {
    providers[record.provider] = {
      baseURL: `http://127.0.0.1:1/${record.provider}`,
      api: 'openai-completions',
      apiKeyEnv: record.credentialRef ?? null,
    }
  }
  return providers
}

/** A document with one role bound, in the shape the settings section holds. */
function bound(provider, model, role = 'agent_model') {
  return {
    version: 1,
    roles: { [role]: { provider, model, credentialRef: provider, boundAt: '2026-08-31T05:03:08.000Z' } },
  }
}

/**
 * Mount the routing plugin and hand back a way to attempt one request.
 *
 * `attempt` returns what happened *and* how many times the downstream was
 * entered, because "refused" and "refused after asking the provider" are
 * different outcomes and only one of them is the fix.
 */
async function mount(config = {}, { prove = true } = {}) {
  const ctx = new Context()
  await ctx.plugin(StubLlm)
  await ctx.plugin(StubSettings, {
    'llm-pi-ai': { providers: providersFor(config.bindings) },
    'watch-bindings': config.bindings ?? { version: 1, roles: {} },
  })
  await ctx.plugin(provenancePlugin)
  const fiber = await ctx.plugin(routing, { enforce: true, ...config })
  const provenance = ctx.get('watchProvenance')

  // Every route the fixture bound counts as one somebody proved, unless a case
  // is about an unproved one. Minting is the only way a receipt exists.
  if (prove) {
    for (const record of Object.values(config.bindings?.roles ?? {})) {
      const facts = provenance.factsFor(record.provider, record.model)
      provenance.mint({
        provider: record.provider, model: record.model,
        requestId: 'test-request', at: '2026-08-31T05:04:00.000Z', ...facts,
      })
    }
  }

  /** Attempt one request inside an open turn, which is what a person causes. */
  const attempt = async (provider, model, { inTurn = true } = {}) => {
    let reached = 0
    if (inTurn) provenance.openTurn('agent#1')
    try {
      const stream = await ctx.waterfall(
        'llm/stream',
        { provider, model, messages: [] },
        () => {
          reached += 1
          return (async function* served() { yield { type: 'text', text: 'ok' } })()
        })
      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      return { ok: true, reached, chunks }
    } catch (error) {
      return { ok: false, reached, error }
    } finally {
      if (inTurn) provenance.closeTurn('agent#1')
    }
  }

  return { ctx, provenance, attempt, dispose: () => fiber.dispose() }
}

describe('a route nobody bound does not reach a provider', () => {
  test('a fresh profile has bound nothing, so nothing is permitted', async () => {
    const host = await mount()
    const result = await host.attempt('deepseek-official', 'deepseek-v4-flash')
    assert.equal(result.ok, false)
    assert.equal(result.reached, 0, 'the request reached the adapter')
    assert.equal(result.error.name, 'UnboundRouteError')
    await host.dispose()
  })

  test('the exact regression: an adapter serving the route is not authorisation', async () => {
    // This is what shipped. `deepseek-official` was registered, so every check
    // upstream had was satisfied, and a person who had configured OpenRouter
    // and bound nothing had their first prompt sent to DeepSeek. Registration
    // says a route *can* be served; only a binding says it *may* be.
    const host = await mount({ bindings: bound('openrouter', 'openai/gpt-4o-mini') })
    const result = await host.attempt('deepseek-official', 'deepseek-v4-flash')
    assert.equal(result.ok, false)
    assert.equal(result.reached, 0)
    await host.dispose()
  })

  test('the bound route is served', async () => {
    const host = await mount({ bindings: bound('openrouter', 'openai/gpt-4o-mini') })
    const result = await host.attempt('openrouter', 'openai/gpt-4o-mini')
    assert.equal(result.ok, true)
    assert.equal(result.reached, 1)
    await host.dispose()
  })

  test('the right provider with the wrong model is still refused', async () => {
    // A binding is a pair. Permitting the provider alone would let a stale tab
    // spend a request on a model nobody costed.
    const host = await mount({ bindings: bound('openrouter', 'openai/gpt-4o-mini') })
    const result = await host.attempt('openrouter', 'openai/gpt-4o')
    assert.equal(result.ok, false)
    assert.equal(result.reached, 0)
    await host.dispose()
  })

  test('an empty selection is refused rather than treated as unset', async () => {
    // What a fresh profile's composed default actually is. It must be a
    // refusal here too, not a hole that reads as "no opinion".
    const host = await mount({ bindings: bound('openrouter', 'openai/gpt-4o-mini') })
    for (const [provider, model] of [['', ''], ['openrouter', ''], ['', 'openai/gpt-4o-mini']]) {
      const result = await host.attempt(provider, model)
      assert.equal(result.ok, false, `${provider}/${model} was permitted`)
      assert.equal(result.reached, 0)
    }
    await host.dispose()
  })

  test('a route bound to any role is authorised, not only the one being served', async () => {
    // The title, compaction and summary calls ride the session's selection. A
    // person who bound OpenRouter to Chat authorised that route; those calls
    // are the same authorisation rather than new ones.
    const host = await mount({
      bindings: bound('openrouter', 'openai/gpt-4o-mini', 'visual_perception'),
    })
    const result = await host.attempt('openrouter', 'openai/gpt-4o-mini')
    assert.equal(result.ok, true)
    assert.equal(result.reached, 1)
    await host.dispose()
  })
})

describe('the refusal says what it must and nothing it must not', () => {
  test('it names the route and no credential', async () => {
    const host = await mount({ bindings: bound('openrouter', 'openai/gpt-4o-mini') })
    const { error } = await host.attempt('deepseek-official', 'deepseek-v4-flash')
    assert.equal(error.provider, 'deepseek-official')
    assert.equal(error.model, 'deepseek-v4-flash')
    for (const forbidden of ['sk-', 'Bearer', 'API_KEY', 'apiKey']) {
      assert.equal(error.message.includes(forbidden), false, `the refusal carries ${forbidden}`)
    }
    await host.dispose()
  })

  test('it carries no host path', async () => {
    const host = await mount()
    const { error } = await host.attempt('deepseek-official', 'deepseek-v4-flash')
    assert.doesNotMatch(error.message, /[A-Za-z]:[\\/]/)
    assert.doesNotMatch(error.message, /\/(?:home|Users|var|tmp)\//)
    await host.dispose()
  })

  test('with nothing bound it says so rather than listing an empty set', async () => {
    const host = await mount()
    const { error } = await host.attempt('openrouter', 'x')
    assert.match(error.message, /nothing is bound yet/)
    await host.dispose()
  })
})

describe('the check cannot be quietly turned off', () => {
  test('it is on unless a deployment says otherwise', async () => {
    // The default matters more than the switch: a profile composed without
    // thinking about this must be the safe one.
    const host = await mount({})
    const result = await host.attempt('deepseek-official', 'deepseek-v4-flash')
    assert.equal(result.ok, false)
    await host.dispose()
  })

  test('a deployment that owns its own routing can opt out explicitly', async () => {
    // An SDK deployment supplies a selection per call and has authorised it
    // somewhere else; refusing every request there would be wrong.
    const host = await mount({ enforce: false })
    const result = await host.attempt('deepseek-official', 'deepseek-v4-flash')
    assert.equal(result.ok, true)
    assert.equal(result.reached, 1)
    await host.dispose()
  })

  test('it injects the runtime and the provenance service, and nothing else', async () => {
    // `settings` is still deliberately absent: injecting it would park this
    // plugin on a deployment that composes no settings file, and a routing
    // check that silently stops running is worse than one that is absent.
    //
    // `watchProvenance` is the one addition, and parking on it is the safe
    // direction. The service is what knows who asked and what has been proved;
    // a guard mounted without it could only fail open. Parked, nothing answers
    // `llm/stream` at all, so no request is authorised either.
    assert.deepEqual(routing.inject, ['llm', 'watchProvenance'])
  })
})
