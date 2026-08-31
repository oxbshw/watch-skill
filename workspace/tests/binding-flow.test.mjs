/**
 * The setup a person could not finish.
 *
 * Sayed saved an OpenRouter credential. The row went green, the screen said
 * "Saved openrouter.", and that was the end of the path — no model to choose,
 * nothing to assign it to, and a composer still reading `DeepSeek-V4-Flash
 * High`. He sent a message. It was routed to DeepSeek, failed on a
 * `DEEPSEEK_API_KEY` he had never been asked for, and left a failed turn and a
 * page of internal detail in his session.
 *
 * Every assertion here is one step of that, held to the opposite outcome. The
 * load-bearing one is `a saved credential is not a configured product`: it is
 * the exact belief the green dot created, and the one the whole readiness
 * model exists to stop this product expressing.
 *
 * The screen is rendered rather than read as source. A test that greps a
 * component for the word "Ready" passes for a component that renders it inside
 * a branch nobody reaches; `renderToStaticMarkup` is what makes these
 * assertions about what a person sees.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SETTINGS = join(ROOT, 'packages', 'watch', 'client-settings')

const { BindingStore, chatReadiness, credentialRefOf, credentialStatusOf, roleRowOf } =
  await import(pathToFileURL(join(SETTINGS, 'lib', 'client', 'binding-state.js')).href)
const { RoleBindings } = await import(
  pathToFileURL(join(SETTINGS, 'lib', 'client', 'role-bindings.js')).href)
const { EMPTY_BINDINGS, withBinding } = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'contracts', 'lib', 'bindings.js')).href)
const { isExecutable } = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'contracts', 'lib', 'readiness.js')).href)

const ok = value => ({ result: { ok: true, value } })
const failed = message => ({ result: { ok: false, error: { code: 'internal', message } } })

/**
 * A Host that answers exactly what a case is about.
 *
 * Every knob here is one of the four facts readiness is derived from, so a
 * case can vary one and hold the rest — which is the only way to show that a
 * credential alone changes nothing.
 */
function host({
  credentialConfigured = false,
  credentialReadable = true,
  models = [{ id: 'openai/gpt-4o-mini', name: 'GPT-4o mini' }],
  bindings = null,
  active = true,
  writable = true,
  catalogFailure = null,
  onReplace = null,
} = {}) {
  const namespaces = [
    {
      ns: 'llm-pi-ai',
      value: { profiles: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } },
      revision: 1,
    },
  ]
  if (bindings !== null) {
    namespaces.push({ ns: 'watch-bindings', value: bindings, revision: 7 })
  }
  const calls = { replace: [], credentials: [] }
  return {
    calls,
    api: {
      settings: {
        describe: async () => ok({ writable, namespaces }),
        replace: async (payload) => {
          calls.replace.push(payload)
          if (onReplace !== null) return onReplace(payload)
          return ok({ ns: payload.ns, value: payload.section, revision: 8 })
        },
      },
      llm: {
        providers: async () => ok({
          providers: [{
            provider: 'openrouter',
            displayName: 'OpenRouter',
            settingsNs: 'llm-pi-ai',
            settingsPath: ['profiles', 'openrouter'],
            active,
          }],
        }),
        models: async () => ok({
          groups: catalogFailure === null
            ? [{ id: 'openrouter', name: 'OpenRouter', models }]
            : [],
          failures: catalogFailure === null ? [] : [{ id: 'openrouter', message: catalogFailure }],
        }),
      },
      credentials: {
        describe: async (payload) => {
          calls.credentials.push(payload)
          if (!credentialReadable) return failed('the credential store could not be opened')
          return ok({
            credentials: Object.fromEntries(payload.refs.map(ref => [ref, {
              configured: credentialConfigured, writable: true,
            }])),
          })
        },
      },
    },
  }
}

/** A loaded store, which is what every case here starts from. */
async function loaded(options) {
  const stub = host(options)
  const store = new BindingStore(stub.api)
  await store.load()
  return { store, stub }
}

/** The markup a person would be looking at. */
function screen(store) {
  return renderToStaticMarkup(createElement(RoleBindings, { store }))
}

/** A stored document with Chat bound to OpenRouter. */
const BOUND = {
  version: 1,
  roles: {
    agent_model: {
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      credentialRef: 'OPENROUTER_API_KEY',
      boundAt: '2026-08-31T05:03:08.000Z',
    },
  },
}

describe('a saved credential is not a configured product', () => {
  test('the credential is stored, and Chat still cannot run', async () => {
    // The regression, stated once. Everything downstream of the green dot
    // followed from this one confusion.
    const { store } = await loaded({ credentialConfigured: true })
    const snapshot = store.getSnapshot()
    const provider = snapshot.providers[0]
    assert.equal(provider.credential, 'configured_unverified')
    assert.equal(isExecutable(chatReadiness(snapshot)), false)
    assert.equal(chatReadiness(snapshot).primaryBlocker, 'no_binding')
  })

  test('the screen says stored, not ready', async () => {
    const { store } = await loaded({ credentialConfigured: true })
    const markup = screen(store)
    assert.ok(markup.includes('Credential saved · not yet assigned'),
      'the honest post-save state is not on screen')
    assert.equal(markup.includes('>Ready<'), false, 'the screen claims Chat is ready')
  })

  test('the screen offers the next step by name', async () => {
    const { store } = await loaded({ credentialConfigured: true })
    const markup = screen(store)
    assert.ok(markup.includes('Choose models and roles'),
      'there is no way forward from a saved credential')
    assert.ok(markup.includes('Chat is not configured yet'))
  })

  test('saving a credential contacts nobody', async () => {
    // Reachability stays unknown because opening a settings page must not
    // spend a request. A product that probed on render would bill somebody for
    // looking.
    const { store } = await loaded({ credentialConfigured: true })
    const chat = chatReadiness(store.getSnapshot())
    assert.equal(chat.blockers.includes('credential_rejected'), false)
    assert.equal(screen(store).includes('Not tested'), true)
  })
})

describe('nothing is selected on somebody’s behalf', () => {
  test('a fresh profile has no role bound, whatever is configured', async () => {
    const { store } = await loaded({ credentialConfigured: true })
    for (const row of store.getSnapshot().roles) {
      assert.equal(row.provider, null, `${row.role} was bound without being chosen`)
      assert.equal(row.model, null)
    }
  })

  test('one configured provider does not become the choice', async () => {
    // The tempting shortcut, and the one that produces a product which spends
    // money on a model nobody picked.
    const { store } = await loaded({ credentialConfigured: true })
    assert.equal(store.getSnapshot().providers.length, 1)
    assert.equal(chatReadiness(store.getSnapshot()).status, 'unbound')
  })

  test('binding one role leaves the others unbound', async () => {
    const { store } = await loaded({ credentialConfigured: true, bindings: BOUND })
    const rows = store.getSnapshot().roles
    const chat = rows.find(row => row.role === 'agent_model')
    assert.equal(chat.model, 'openai/gpt-4o-mini')
    for (const row of rows.filter(entry => entry.role !== 'agent_model')) {
      assert.equal(row.model, null, `${row.role} inherited a binding`)
    }
  })
})

describe('binding Chat is what makes Chat runnable', () => {
  test('a bound, credentialled, served route is executable', async () => {
    const { store } = await loaded({ credentialConfigured: true, bindings: BOUND })
    assert.equal(isExecutable(chatReadiness(store.getSnapshot())), true)
    assert.ok(screen(store).includes('Chat can run.'))
  })

  test('the same binding without a credential is blocked, not ready', async () => {
    const { store } = await loaded({ credentialConfigured: false, bindings: BOUND })
    const chat = chatReadiness(store.getSnapshot())
    assert.equal(isExecutable(chat), false)
    assert.equal(chat.primaryBlocker, 'credential_absent')
  })

  test('the same binding on a route no adapter serves is blocked', async () => {
    const { store } = await loaded({ credentialConfigured: true, bindings: BOUND, active: false })
    const chat = chatReadiness(store.getSnapshot())
    assert.equal(isExecutable(chat), false)
    assert.equal(chat.primaryBlocker, 'provider_unknown')
  })

  test('a model the provider stopped offering is unavailable, not ready', async () => {
    const { store } = await loaded({
      credentialConfigured: true,
      bindings: BOUND,
      models: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
    })
    const chat = chatReadiness(store.getSnapshot())
    assert.equal(isExecutable(chat), false)
    assert.equal(chat.primaryBlocker, 'model_unavailable')
  })

  test('an unreadable credential store is a fault to report, not an empty slot', async () => {
    // Telling somebody to add a credential they already added is how a person
    // ends up entering a key three times.
    const { store } = await loaded({
      credentialConfigured: true, credentialReadable: false, bindings: BOUND,
    })
    assert.equal(store.getSnapshot().providers[0].credential, 'inaccessible')
    assert.equal(chatReadiness(store.getSnapshot()).primaryBlocker, 'credential_inaccessible')
  })
})

describe('the decision is persisted, and persisted as a reference', () => {
  test('binding writes the whole document to the Watch namespace', async () => {
    const { store, stub } = await loaded({ credentialConfigured: true })
    await store.bind('agent_model', 'openrouter', 'openai/gpt-4o-mini')
    assert.equal(stub.calls.replace.length, 1)
    const written = stub.calls.replace[0]
    assert.equal(written.ns, 'watch-bindings')
    assert.equal(written.section.roles.agent_model.provider, 'openrouter')
    assert.equal(written.section.roles.agent_model.model, 'openai/gpt-4o-mini')
  })

  test('what is written is a reference the Host resolves, never a value', async () => {
    const { store, stub } = await loaded({ credentialConfigured: true })
    await store.bind('agent_model', 'openrouter', 'openai/gpt-4o-mini')
    const record = stub.calls.replace[0].section.roles.agent_model
    assert.equal(record.credentialRef, 'OPENROUTER_API_KEY')
    assert.deepEqual(
      Object.keys(record).sort(), ['boundAt', 'credentialRef', 'model', 'provider'])
  })

  test('the write carries the revision it was read at', async () => {
    // A stale editor is refused rather than silently overwriting somebody
    // else's change.
    const { store, stub } = await loaded({ credentialConfigured: true, bindings: BOUND })
    await store.bind('visual_perception', 'openrouter', 'openai/gpt-4o-mini')
    assert.equal(stub.calls.replace[0].expectedRevision, 7)
  })

  test('unbinding removes the role rather than emptying its fields', async () => {
    const { store, stub } = await loaded({ credentialConfigured: true, bindings: BOUND })
    await store.unbind('agent_model')
    assert.deepEqual(stub.calls.replace[0].section.roles, {})
  })

  test('a refused write leaves the previous binding standing', async () => {
    const { store } = await loaded({
      credentialConfigured: true,
      bindings: BOUND,
      onReplace: () => failed('the settings document changed under you'),
    })
    await store.bind('agent_model', 'openrouter', 'openai/gpt-4o-mini')
    const snapshot = store.getSnapshot()
    assert.equal(snapshot.error, 'the settings document changed under you')
    assert.equal(snapshot.roles.find(row => row.role === 'agent_model').model, 'openai/gpt-4o-mini')
  })
})

describe('status is words, and colour is decoration on top of them', () => {
  test('every role state names itself in text', async () => {
    const { store } = await loaded({ credentialConfigured: true })
    const markup = screen(store)
    // "Not configured" is the accessible label for `unbound`. A chip with no
    // text beside it is a status a screen reader does not have.
    assert.ok(markup.includes('Not configured'))
    assert.ok(markup.includes('Nothing assigned'))
  })

  test('a blocked role says what to do, not that it is blocked', async () => {
    const { store } = await loaded({ credentialConfigured: false, bindings: BOUND })
    const markup = screen(store)
    assert.ok(markup.includes('Add a credential for this provider.'),
      'the blocked state does not name the next step')
  })

  test('the controls are labelled and reachable', async () => {
    const { store } = await loaded({ credentialConfigured: true })
    const markup = screen(store)
    assert.ok(markup.includes('<button'), 'there is no control on the screen at all')
    assert.ok(/aria-live="polite"/.test(markup), 'a save changes nothing a reader is told about')
  })

  test('nothing on the screen is only a coloured dot', async () => {
    const { store } = await loaded({ credentialConfigured: true, bindings: BOUND })
    const markup = screen(store)
    // Every chip in this panel renders its own text. An empty one would be a
    // status carried by border colour alone.
    assert.equal(/<span[^>]*border[^>]*><\/span>/.test(markup), false)
  })
})

describe('the screen never shows what a person did not configure', () => {
  test('no DeepSeek route appears when none is configured', async () => {
    const { store } = await loaded({ credentialConfigured: true })
    const markup = screen(store)
    assert.equal(markup.includes('deepseek-official'), false)
    assert.equal(markup.includes('DeepSeek-V4-Flash'), false)
  })

  test('no credential reference is rendered as a value', async () => {
    const { store } = await loaded({ credentialConfigured: true, bindings: BOUND })
    const markup = screen(store)
    for (const shape of [/\bsk-[A-Za-z0-9]{8,}/, /\bBearer\s+\S{8,}/]) {
      assert.equal(shape.test(markup), false, `the screen renders ${String(shape)}`)
    }
  })

  test('no absolute host path reaches the screen', async () => {
    const { store } = await loaded({ credentialConfigured: true, bindings: BOUND })
    const markup = screen(store)
    assert.doesNotMatch(markup, /[A-Za-z]:\\\\/)
    assert.doesNotMatch(markup, /\/(?:home|Users|var|tmp)\//)
  })
})

describe('the pieces the store is assembled from', () => {
  test('a credential reference is read out of the provider’s own section', () => {
    const view = { ns: 'llm-pi-ai', value: { profiles: { openrouter: { apiKeyEnv: 'X_KEY' } } }, revision: 1 }
    assert.equal(credentialRefOf(view, ['profiles', 'openrouter']), 'X_KEY')
    assert.equal(credentialRefOf(view, ['profiles', 'absent']), null)
    assert.equal(credentialRefOf(undefined, []), null)
  })

  test('a stored credential is configured_unverified and nothing more', () => {
    assert.equal(credentialStatusOf('X_KEY', { X_KEY: { configured: true, writable: true } }, true),
      'configured_unverified')
    assert.equal(credentialStatusOf('X_KEY', {}, true), 'absent')
    assert.equal(credentialStatusOf(null, {}, true), 'absent')
    assert.equal(credentialStatusOf('X_KEY', {}, false), 'inaccessible')
  })

  test('readiness is derived through the one gate, never assembled', () => {
    // A row built by hand still has to come back through `roleReadiness`, so a
    // surface cannot construct "ready" from parts it liked the look of.
    const providers = [{
      provider: 'openrouter',
      displayName: 'OpenRouter',
      active: true,
      credentialRef: 'OPENROUTER_API_KEY',
      credential: 'configured_unverified',
      models: [{ id: 'm', name: 'M' }],
      catalogError: null,
    }]
    const unbound = roleRowOf('agent_model', EMPTY_BINDINGS, providers)
    assert.equal(unbound.readiness.status, 'unbound')

    const bound = roleRowOf('agent_model', withBinding(EMPTY_BINDINGS, 'agent_model', {
      provider: 'openrouter', model: 'm', credentialRef: 'OPENROUTER_API_KEY', boundAt: '',
    }), providers)
    assert.equal(bound.readiness.status, 'executable')
  })
})
