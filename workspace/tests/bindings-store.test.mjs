/**
 * The decisions a person made, kept where reopening the product finds them.
 *
 * `readiness` decides whether a role can run; this is where three of the facts
 * it decides from are *stored*. The failure it exists to prevent is the one
 * that shipped: a saved OpenRouter credential, no way to say which model it was
 * for, and a composer still pointed at a DeepSeek default nobody chose.
 *
 * Two properties carry most of the weight here and both are tested as rules
 * rather than as examples.
 *
 * **Nothing is bound implicitly.** No role inherits another's model, a
 * credential does not become a binding, and an unreadable entry becomes
 * *unbound* rather than a guess. Every one of those is a route somebody's
 * prompt could take without them choosing it.
 *
 * **A binding is a reference, never a credential.** The document is written to
 * the Harness's settings file, rides the settings RPC and appears in exports,
 * so `assertNoSecretMaterial` is a real boundary rather than a comment.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CONTRACTS = join(ROOT, 'packages', 'watch', 'contracts')

const {
  BINDABLE_ROLES, BINDINGS_NAMESPACE, BINDINGS_VERSION, EMPTY_BINDINGS, PRIMARY_ROLE,
  ROLE_LABEL, ROLE_MODALITIES, ROLE_PURPOSE, assertNoSecretMaterial, bindingFor,
  boundProviders, isBindableRole, isBound, isStorableId, readBindings, withBinding,
  withoutBinding,
} = await import(pathToFileURL(join(CONTRACTS, 'lib', 'bindings.js')).href)

const { ROLES } = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'technology', 'lib', 'descriptors.js')).href)

const { roleReadiness } = await import(
  pathToFileURL(join(CONTRACTS, 'lib', 'readiness.js')).href)

/** One stored decision, so a case only varies what it means to. */
const CHAT = {
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  credentialRef: 'openrouter',
  boundAt: '2026-08-31T05:03:08.000Z',
}

describe('a fresh profile has bound nothing', () => {
  test('the empty document binds no role at all', () => {
    assert.deepEqual(EMPTY_BINDINGS.roles, {})
    for (const role of BINDABLE_ROLES) {
      assert.equal(isBound(EMPTY_BINDINGS, role), false)
      assert.equal(bindingFor(EMPTY_BINDINGS, role), null)
    }
  })

  test('an unbound Chat is unbound, not executable', () => {
    // The join this whole subsystem exists to make: storage says "no record",
    // the gate says "no_binding", and nothing in between invents a default.
    const readiness = roleReadiness(PRIMARY_ROLE, {
      binding: bindingFor(EMPTY_BINDINGS, PRIMARY_ROLE),
      credential: 'configured_unverified',
      reachability: 'unknown',
      model: 'none',
      route: null,
      consentGranted: true,
      policyPermits: true,
      contractMatches: true,
    })
    assert.equal(readiness.status, 'unbound')
    assert.equal(readiness.primaryBlocker, 'no_binding')
  })

  test('Chat is the role the first conversation needs', () => {
    assert.equal(PRIMARY_ROLE, 'agent_model')
    assert.equal(ROLE_LABEL[PRIMARY_ROLE], 'Chat')
    assert.ok(isBindableRole(PRIMARY_ROLE))
  })

  test('the bindable roles are the technology package’s roles, not a second set', () => {
    // Two role vocabularies in one product is how a binding made on one screen
    // stops being visible on another. `contracts` cannot import `technology` —
    // it is the package everything depends on — so the ids are spelled twice
    // and this is the gate that keeps the spellings the same.
    for (const role of BINDABLE_ROLES) {
      assert.ok(ROLES.includes(role), `"${role}" is not a RoleId the product knows`)
    }
  })

  test('roles served by a local engine are not offered as provider bindings', () => {
    // Offering them would offer a choice that is not there: nobody picks a
    // cloud provider for the deterministic verifier.
    for (const local of ['verifier', 'ocr_layout', 'reranking', 'speaker_diarization']) {
      assert.equal(isBindableRole(local), false, `${local} is offered as a provider binding`)
    }
  })

  test('every bindable role says what it is for and what it needs', () => {
    for (const role of BINDABLE_ROLES) {
      assert.equal(typeof ROLE_PURPOSE[role], 'string')
      assert.notEqual(ROLE_PURPOSE[role], '')
      assert.equal(typeof ROLE_LABEL[role], 'string')
      assert.notEqual(ROLE_LABEL[role], '')
      assert.ok(Array.isArray(ROLE_MODALITIES[role]))
      assert.ok(ROLE_MODALITIES[role].length > 0)
    }
  })
})

describe('binding one role binds exactly that role', () => {
  test('a bound Chat is readable back', () => {
    const doc = withBinding(EMPTY_BINDINGS, 'agent_model', CHAT)
    assert.equal(isBound(doc, 'agent_model'), true)
    const binding = bindingFor(doc, 'agent_model')
    assert.equal(binding.provider, 'openrouter')
    assert.equal(binding.model, 'openai/gpt-4o-mini')
    assert.deepEqual(binding.modalities, ROLE_MODALITIES.agent_model)
  })

  test('no other role is bound by it', () => {
    // The silent-fallback regression, as a rule. Binding Chat must not make
    // vision "configured" — a product that describes an image it never looked
    // at is the failure that argument protects against.
    const doc = withBinding(EMPTY_BINDINGS, 'agent_model', CHAT)
    for (const role of BINDABLE_ROLES.filter(other => other !== 'agent_model')) {
      assert.equal(isBound(doc, role), false, `${role} became bound`)
      assert.equal(bindingFor(doc, role), null)
    }
  })

  test('binding never mutates the document it was given', () => {
    const before = withBinding(EMPTY_BINDINGS, 'agent_model', CHAT)
    const snapshot = JSON.stringify(before)
    withBinding(before, 'visual_perception', { ...CHAT, model: 'openai/gpt-4o' })
    assert.equal(JSON.stringify(before), snapshot)
  })

  test('unbinding removes the role and leaves the rest', () => {
    const doc = withBinding(withBinding(EMPTY_BINDINGS, 'agent_model', CHAT), 'visual_perception', CHAT)
    const after = withoutBinding(doc, 'agent_model')
    assert.equal(isBound(after, 'agent_model'), false)
    assert.equal(isBound(after, 'visual_perception'), true)
  })

  test('the providers a person actually pointed something at', () => {
    const doc = withBinding(
      withBinding(EMPTY_BINDINGS, 'agent_model', CHAT),
      'visual_perception', { ...CHAT, provider: 'anthropic' })
    assert.deepEqual(boundProviders(doc), ['anthropic', 'openrouter'])
  })
})

describe('a hand-edited settings file cannot route a prompt somewhere nobody chose', () => {
  test('a document that is not a document reads as empty', () => {
    for (const raw of [null, undefined, 'chat', 42, []]) {
      assert.deepEqual(readBindings(raw), EMPTY_BINDINGS)
    }
  })

  test('an unknown role is dropped rather than kept', () => {
    const doc = readBindings({ version: 1, roles: { agent_model: CHAT, telepathy: CHAT } })
    assert.equal(isBound(doc, 'agent_model'), true)
    assert.equal(Object.keys(doc.roles).length, 1)
  })

  test('a malformed entry becomes unbound, and its neighbours survive', () => {
    // Dropping is the safe direction: an unbound role refuses at the composer
    // where a person is told what to fix. A half-read one routes.
    const doc = readBindings({
      version: 1,
      roles: { agent_model: CHAT, visual_perception: { provider: 'openrouter' } },
    })
    assert.equal(isBound(doc, 'agent_model'), true)
    assert.equal(isBound(doc, 'visual_perception'), false)
  })

  test('a document from a newer build is not half-understood', () => {
    const doc = readBindings({ version: BINDINGS_VERSION + 1, roles: { agent_model: CHAT } })
    assert.deepEqual(doc, EMPTY_BINDINGS)
  })

  test('a reference that is not a string reads as no reference, not as a value', () => {
    const doc = readBindings({ version: 1, roles: { agent_model: { ...CHAT, credentialRef: { v: 1 } } } })
    assert.equal(doc.roles.agent_model.credentialRef, null)
  })

  test('an id carrying control characters is refused', () => {
    assert.equal(isStorableId('openai/gpt-4o-mini'), true)
    assert.equal(isStorableId(''), false)
    assert.equal(isStorableId('a b'), false)
    assert.equal(isStorableId('a\nb'), false)
    assert.equal(isStorableId('x'.repeat(201)), false)
  })

  test('a read document always carries the version this build writes', () => {
    assert.equal(readBindings({ version: 1, roles: {} }).version, BINDINGS_VERSION)
  })
})

describe('a binding is a reference, never a credential', () => {
  test('the namespace is DeepWatch’s own section of the Harness document', () => {
    assert.equal(BINDINGS_NAMESPACE, 'watch-bindings')
  })

  test('a well-formed document passes the boundary', () => {
    assert.doesNotThrow(() => {
      assertNoSecretMaterial('test', withBinding(EMPTY_BINDINGS, 'agent_model', CHAT))
    })
  })

  test('a pasted key is refused at the write, not discovered in a screenshot', () => {
    for (const leaked of ['sk-abcdef0123456789', 'Bearer abcdef0123456789', 'sk_live_abcdef0123']) {
      const doc = withBinding(EMPTY_BINDINGS, 'agent_model', { ...CHAT, credentialRef: leaked })
      assert.throws(
        () => { assertNoSecretMaterial('settings write', doc) },
        /credential material/,
        `${leaked} was allowed through`)
    }
  })

  test('a reference is a name, and a name is allowed to look like one', () => {
    // The Host resolves `OPENROUTER_API_KEY` against its own store. Refusing
    // it would refuse every real binding, and a guard that fires on the normal
    // case is a guard somebody removes.
    for (const ref of ['OPENROUTER_API_KEY', 'openrouter', 'ANTHROPIC_API_KEY', null]) {
      const doc = withBinding(EMPTY_BINDINGS, 'agent_model', { ...CHAT, credentialRef: ref })
      assert.doesNotThrow(
        () => { assertNoSecretMaterial('settings write', doc) },
        `${String(ref)} was refused as a reference`)
    }
  })

  test('a long opaque token pasted into the reference field is refused', () => {
    const doc = withBinding(EMPTY_BINDINGS, 'agent_model', {
      ...CHAT, credentialRef: 'v1AbCdEf0123456789GhIjKlMnOpQrStUvWx',
    })
    assert.throws(() => { assertNoSecretMaterial('settings write', doc) }, /credential material/)
  })

  test('no stored field records anything measured from a secret', () => {
    // Not a value, and not the things people reach for instead of one: a
    // length, a prefix, a fingerprint. A reader gains nothing from "51
    // characters"; somebody reading a shared screenshot does.
    const doc = withBinding(EMPTY_BINDINGS, 'agent_model', CHAT)
    const fields = Object.keys(doc.roles.agent_model)
    assert.deepEqual(fields.sort(), ['boundAt', 'credentialRef', 'model', 'provider'])
    for (const forbidden of ['length', 'hash', 'digest', 'fingerprint', 'prefix', 'suffix', 'key']) {
      assert.equal(fields.includes(forbidden), false, `the record carries ${forbidden}`)
    }
  })
})

describe('a binding says what kind of actor wrote it', () => {
  const bound = (record) => readBindings({
    version: 1, roles: { agent_model: { provider: 'p', model: 'm', ...record } },
  }).roles.agent_model

  test('a document written before this field existed is unattributed', () => {
    // Honest, and deliberately not `person`: presenting an unattributed
    // binding as a deliberate choice is the substitution the field exists to
    // prevent, and every binding stored by an earlier build is in this state.
    assert.equal(bound({ boundAt: '2026-01-01T00:00:00.000Z' }).boundBy, 'unknown')
  })

  test('an actor this build understands is kept', () => {
    for (const actor of ['person', 'setup', 'unknown']) {
      assert.equal(bound({ boundBy: actor }).boundBy, actor)
    }
  })

  test('anything else reads as unattributed rather than being believed', () => {
    for (const value of ['administrator', '', 42, null, {}, ['person']]) {
      assert.equal(bound({ boundBy: value }).boundBy, 'unknown',
        `${JSON.stringify(value)} was accepted as an actor`)
    }
  })

  test('a name is never stored as an actor', () => {
    // The field answers "did a person choose this", never "which person". This
    // document is exported, rides the settings RPC and appears in Diagnostics.
    assert.equal(bound({ boundBy: 'sayed' }).boundBy, 'unknown')
  })

  test('the actor is not a place a credential could hide', () => {
    assert.equal(bound({ boundBy: 'sk-not-a-real-key-0000' }).boundBy, 'unknown')
  })
})
