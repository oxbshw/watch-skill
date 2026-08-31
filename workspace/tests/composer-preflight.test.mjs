/**
 * The composer, closed before the prompt rather than after it.
 *
 * Sayed typed into a composer that looked ready. The model chip named a
 * DeepSeek model he had not chosen, the send button was live, and the first
 * thing that disagreed with any of it was a failed turn carrying a missing
 * environment variable. Everything he needed to know was knowable before he
 * typed a character.
 *
 * So these hold the client half of preflight to three properties, and the
 * third is the one that makes the other two honest:
 *
 *   - an unconfigured Chat raises the block upstream provides, so the textarea
 *     goes inert and the placeholder says why;
 *   - a configured Chat raises none, so a working product is not permanently
 *     told to configure itself;
 *   - the block is *lifted* when the binding lands, and cleared on unmount —
 *     a block nothing is left to lift is a composer nobody can reopen.
 *
 * The card is rendered rather than inspected as source, because a card that
 * exists in a branch nobody reaches is the same as no card.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SETTINGS = join(ROOT, 'packages', 'watch', 'client-settings')

const { BindingStore } = await import(
  pathToFileURL(join(SETTINGS, 'lib', 'client', 'binding-state.js')).href)
const { ChatGate, blockFor, blockReason } = await import(
  pathToFileURL(join(SETTINGS, 'lib', 'client', 'chat-gate.js')).href)
const { isDisclosureSafe } = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'contracts', 'lib', 'failures.js')).href)

const ok = value => ({ result: { ok: true, value } })

/** A Host answering one shape of the world. */
function api({ credentialConfigured = true, bindings = null, models = [{ id: 'm1', name: 'M1' }] } = {}) {
  const namespaces = [{
    ns: 'llm-pi-ai',
    value: { profiles: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY' } } },
    revision: 1,
  }]
  if (bindings !== null) namespaces.push({ ns: 'watch-bindings', value: bindings, revision: 3 })
  return {
    settings: {
      describe: async () => ok({ writable: true, namespaces }),
      replace: async payload => ok({ ns: payload.ns, value: payload.section, revision: 4 }),
    },
    llm: {
      providers: async () => ok({
        providers: [{
          provider: 'openrouter',
          displayName: 'OpenRouter',
          settingsNs: 'llm-pi-ai',
          settingsPath: ['profiles', 'openrouter'],
          active: true,
        }],
      }),
      models: async () => ok({ groups: [{ id: 'openrouter', name: 'OpenRouter', models }], failures: [] }),
    },
    credentials: {
      describe: async payload => ok({
        credentials: Object.fromEntries(
          payload.refs.map(ref => [ref, { configured: credentialConfigured, writable: true }])),
      }),
    },
  }
}

/** A block registry that records every call, because the sequence is the point. */
function recorder() {
  const calls = []
  return {
    calls,
    set(sessionId, block) { calls.push({ sessionId, block }) },
    /** The block standing for one session after every call so far. */
    standing(sessionId) {
      const seen = calls.filter(call => call.sessionId === sessionId)
      return seen.length === 0 ? undefined : seen[seen.length - 1].block
    },
  }
}

/** A loaded store over one shape of the world. */
async function loaded(options) {
  const store = new BindingStore(api(options))
  await store.load()
  return store
}

const BOUND = {
  version: 1,
  roles: {
    agent_model: {
      provider: 'openrouter', model: 'm1',
      credentialRef: 'OPENROUTER_API_KEY', boundAt: '2026-08-31T05:03:08.000Z',
    },
  },
}

/**
 * Render the gate, and apply the block its own decision function calls for.
 *
 * `renderToStaticMarkup` runs no effects, so the block has to be applied here
 * — but through `blockFor`, which is the same function the effect calls. A
 * test that re-derived the condition beside the component would agree with
 * itself and prove nothing about what a person gets.
 */
function mount(store, blocks, sessionId = 'session-1') {
  const markup = renderToStaticMarkup(createElement(ChatGate, { sessionId, store, blocks }))
  blocks.set(sessionId, blockFor(store.getSnapshot()))
  return markup
}

describe('an unconfigured Chat closes the composer', () => {
  test('a fresh profile with a credential and no binding still blocks', async () => {
    const store = await loaded({ credentialConfigured: true })
    const markup = mount(store, recorder())
    assert.ok(markup.includes('Chat model is not configured'),
      'the composer says nothing about why it is closed')
    assert.ok(markup.includes('Choose models and roles'))
  })

  test('the reason names the capability and the next step', () => {
    const reason = blockReason('Choose a provider and a model, then assign one to Chat.')
    assert.ok(reason.startsWith('Chat is not configured'))
    assert.ok(reason.includes('assign one to Chat'))
  })

  test('the reason a person reads carries no internal identity', () => {
    // The placeholder is the most-read string in this whole subsystem. A route
    // id or an environment variable reaching it would put the original defect
    // back on screen in the one place nobody would think to look.
    for (const detail of [
      'Choose a provider and a model, then assign one to Chat. Nothing is sent until you do.',
      'A credential is assigned to this provider, and it could not be read on this machine.',
      'The provider no longer offers the model assigned to this capability.',
    ]) {
      assert.equal(isDisclosureSafe(blockReason(detail)), true, `${detail} leaked something`)
    }
  })

  test('the card offers the picker in place rather than naming a screen it cannot open', async () => {
    // The settings panel's open state is local to its own component, so no
    // plugin can navigate to a section. A button that fails when pressed
    // teaches people the product is broken.
    const store = await loaded({ credentialConfigured: true })
    const markup = mount(store, recorder())
    assert.ok(markup.includes('<button'), 'the card offers no action at all')
    assert.ok(markup.includes('Settings → Role Bindings has the full view.'))
  })
})

describe('a configured Chat is left alone', () => {
  test('a bound, credentialled, served route renders no card', async () => {
    const store = await loaded({ credentialConfigured: true, bindings: BOUND })
    assert.equal(mount(store, recorder()), '')
  })

  test('the block is lifted once the binding lands', async () => {
    // The property that matters more than raising one: a product that blocks
    // and never unblocks is a product nobody can use after fixing it.
    const blocks = recorder()
    const store = await loaded({ credentialConfigured: true })
    mount(store, blocks)
    assert.notEqual(blocks.standing('session-1'), undefined, 'nothing was blocked to begin with')

    await store.bind('agent_model', 'openrouter', 'm1')
    const chat = store.getSnapshot().roles.find(row => row.role === 'agent_model')
    assert.equal(chat.readiness.status, 'executable')
    mount(store, blocks)
    assert.equal(blocks.standing('session-1'), undefined, 'the composer stayed closed')
  })
})

describe('what the gate must never do', () => {
  test('it blocks nothing before the Host has answered', async () => {
    // An unloaded store is `idle`. Blocking there would make every reload look
    // like a misconfiguration, and the Host refuses an unbound route anyway.
    const store = new BindingStore(api())
    assert.equal(store.getSnapshot().status, 'idle')
    const blocks = recorder()
    assert.equal(mount(store, blocks), '')
    assert.equal(blocks.standing('session-1'), undefined)
  })

  test('the block it raises is the one its own decision function returns', async () => {
    const blocks = recorder()
    const store = await loaded({ credentialConfigured: true })
    mount(store, blocks)
    assert.deepEqual(blocks.standing('session-1'), blockFor(store.getSnapshot()))
    assert.match(blocks.standing('session-1').reason, /^Chat is not configured/)
  })

  test('it renders no absolute path and no route id', async () => {
    const store = await loaded({ credentialConfigured: true })
    const markup = mount(store, recorder())
    assert.doesNotMatch(markup, /[A-Za-z]:\\\\/)
    assert.doesNotMatch(markup, /\/(?:home|Users|var|tmp)\//)
    assert.equal(markup.includes('deepseek-official'), false)
    assert.equal(markup.includes('llm-deepseek'), false)
    assert.equal(markup.includes('DEEPSEEK_API_KEY'), false)
  })

  test('it names itself for a reader who cannot see it', async () => {
    const store = await loaded({ credentialConfigured: true })
    const markup = mount(store, recorder())
    assert.ok(markup.includes('aria-label="Chat setup"'),
      'the setup card has no accessible name')
  })

  test('sending is refused by the Host too, not only by this card', () => {
    // Stated as a source fact rather than a behaviour, because the behaviour
    // is the Host's and is tested in `routing-preflight.test.mjs`. What this
    // asserts is that the client half has not been written as though it were
    // the enforcement.
    const source = join(
      ROOT, 'packages', 'watch', 'client-settings', 'src', 'client', 'chat-gate.tsx')
    const text = readFileSync(source, 'utf8')
    assert.match(text, /affordance, and it is not the enforcement/)
  })
})
