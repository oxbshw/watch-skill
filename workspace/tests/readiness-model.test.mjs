/**
 * The four facts a green dot used to stand for.
 *
 * A provider row turned green the moment a credential was saved. A person read
 * that as "ready", typed a prompt, and the runtime routed it to a provider
 * they had never configured — failing on a missing environment variable and
 * leaving a failed turn behind. Every part of that followed from one indicator
 * answering four different questions at once.
 *
 * So the whole of this file is one assertion said many ways: a stored
 * credential is the *first* of four requirements and implies none of the
 * others. `roleReadiness` is the only thing allowed to answer "executable",
 * and the tests below are what stop that answer from being widened later — in
 * particular `a saved credential alone is never ready`, which is the exact
 * regression that shipped.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CONTRACTS = join(ROOT, 'packages', 'watch', 'contracts')

const {
  roleReadiness, isExecutable, blockerMessage, isPositiveBindingStatus,
  BINDING_STATUS_LABEL, CREDENTIAL_STATUS_LABEL, REACHABILITY_LABEL,
} = await import(pathToFileURL(join(CONTRACTS, 'lib', 'readiness.js')).href)

/** A route that can do everything, so a case only varies what it means to. */
const FULL_ROUTE = {
  provider: 'openrouter',
  roles: ['agent_model', 'visual_perception'],
  modalities: ['text', 'vision'],
  models: ['openai/gpt-4o-mini'],
}

/** A binding that would run, so a case only varies what it means to. */
const GOOD_BINDING = {
  role: 'agent_model',
  provider: 'openrouter',
  model: 'openai/gpt-4o-mini',
  credentialRef: 'cred-1',
  modalities: ['text'],
}

/** Every input satisfied; each test breaks exactly one thing. */
function ready(overrides = {}) {
  return {
    binding: GOOD_BINDING,
    credential: 'verified',
    reachability: 'reachable',
    model: 'selected',
    route: FULL_ROUTE,
    consentGranted: true,
    policyPermits: true,
    contractMatches: true,
    ...overrides,
  }
}

describe('a role is executable only when every requirement holds', () => {
  test('the complete case is executable, and carries no blockers', () => {
    const readiness = roleReadiness('agent_model', ready())
    assert.equal(readiness.status, 'executable')
    assert.deepEqual(readiness.blockers, [])
    assert.equal(readiness.primaryBlocker, null)
    assert.ok(isExecutable(readiness))
    assert.equal(blockerMessage(readiness), null)
  })

  test('a saved credential alone is never ready', () => {
    // The regression, stated once and directly. Everything else in this file
    // is a variation on it.
    const readiness = roleReadiness('agent_model', {
      binding: null,
      credential: 'configured_unverified',
      reachability: 'unknown',
      model: 'none',
      route: FULL_ROUTE,
      consentGranted: true,
      policyPermits: true,
      contractMatches: true,
    })

    assert.notEqual(readiness.status, 'executable',
      'a stored credential is one of four requirements, not the answer')
    assert.equal(readiness.status, 'unbound')
    assert.equal(readiness.primaryBlocker, 'no_binding')
    assert.ok(!isPositiveBindingStatus(readiness.status))
  })

  test('a provider with a credential and no model chosen is not ready', () => {
    const readiness = roleReadiness('agent_model', ready({
      credential: 'configured_unverified',
      reachability: 'unknown',
      model: 'none',
      binding: { ...GOOD_BINDING, model: '' },
    }))
    assert.equal(readiness.status, 'blocked')
    assert.ok(readiness.blockers.includes('model_unset'))
    assert.match(blockerMessage(readiness), /Choose a model/)
  })

  test('a complete binding with a saved but untested credential is not ready', () => {
    const readiness = roleReadiness('agent_model', ready({
      credential: 'configured_unverified',
      reachability: 'unknown',
    }))
    assert.equal(readiness.status, 'bound_unverified')
    assert.deepEqual(readiness.blockers, ['provider_untested'])
    assert.equal(BINDING_STATUS_LABEL[readiness.status], 'Configured · not tested')
    assert.ok(!isExecutable(readiness))
  })

  for (const [label, overrides, blocker] of [
    ['no binding at all', { binding: null }, 'no_binding'],
    ['an unknown provider', { route: null }, 'provider_unknown'],
    ['no credential', { credential: 'absent' }, 'credential_absent'],
    ['an unreadable credential store', { credential: 'inaccessible' }, 'credential_inaccessible'],
    ['a rejected credential', { credential: 'rejected' }, 'credential_rejected'],
    ['an unauthorized probe', { reachability: 'unauthorized' }, 'credential_rejected'],
    ['a provider that did not answer', { reachability: 'unreachable' }, 'provider_unreachable'],
    ['a provider that rate limited the test', { reachability: 'rate_limited' }, 'provider_rate_limited'],
    ['a model the provider dropped', { model: 'unavailable' }, 'model_unavailable'],
    ['a malformed model id', { model: 'invalid' }, 'model_invalid'],
    ['a contract this build cannot speak', { contractMatches: false }, 'contract_mismatch'],
    ['a consent that was never granted', { consentGranted: false }, 'consent_required'],
    ['policy that forbids the request', { policyPermits: false }, 'policy_forbids'],
  ]) {
    test(`${label} blocks the role`, () => {
      const readiness = roleReadiness('agent_model', ready(overrides))
      assert.ok(!isExecutable(readiness), `${label} was treated as ready`)
      assert.ok(readiness.blockers.includes(blocker),
        `expected ${blocker}, got ${readiness.blockers.join(', ')}`)
      assert.equal(typeof blockerMessage(readiness), 'string')
    })
  }

  test('a route that cannot serve the role blocks it', () => {
    const readiness = roleReadiness('embeddings', ready({
      binding: { ...GOOD_BINDING, role: 'embeddings' },
    }))
    assert.ok(readiness.blockers.includes('route_lacks_role'))
  })

  test('a role needing a modality the route lacks is blocked', () => {
    const readiness = roleReadiness('agent_model', ready({
      binding: { ...GOOD_BINDING, modalities: ['text', 'audio'] },
    }))
    assert.ok(readiness.blockers.includes('modality_unsupported'))
  })
})

describe('the blockers are reported in the order they must be fixed', () => {
  test('a completely unconfigured provider names the first step, not the last', () => {
    const readiness = roleReadiness('agent_model', ready({
      credential: 'absent',
      model: 'none',
      binding: { ...GOOD_BINDING, model: '' },
    }))
    // Telling somebody to choose a model when they have no credential sends
    // them to the wrong screen.
    assert.equal(readiness.primaryBlocker, 'credential_absent')
    assert.ok(readiness.blockers.indexOf('credential_absent')
      < readiness.blockers.indexOf('model_unset'))
  })

  test('every blocker has a sentence a person can act on', () => {
    for (const overrides of [
      { binding: null }, { route: null }, { credential: 'absent' },
      { credential: 'inaccessible' }, { credential: 'rejected' },
      { model: 'none', binding: { ...GOOD_BINDING, model: '' } },
      { model: 'invalid' }, { model: 'unavailable' },
      { contractMatches: false }, { consentGranted: false }, { policyPermits: false },
    ]) {
      const message = blockerMessage(roleReadiness('agent_model', ready(overrides)))
      assert.equal(typeof message, 'string')
      assert.ok(message.length > 10)
      // A first error tells a person what to do, not what broke internally.
      // Internal identifier *shapes*, not the English words. A sentence may
      // say "provider"; it may not name `deepseek-official` or DEEPSEEK_API_KEY.
      assert.doesNotMatch(message, /@deepseek-ai|@deepwatch|[A-Z_]+_API_KEY|MISSING_[A-Z]|llm-[a-z]|-official/,
        `blocker copy leaked an internal identifier: ${message}`)
    }
  })
})

describe('status words carry the meaning, not the colour', () => {
  test('only an executable binding reads as good', () => {
    assert.ok(isPositiveBindingStatus('executable'))
    for (const status of ['unbound', 'bound_unverified', 'blocked']) {
      assert.ok(!isPositiveBindingStatus(status),
        `${status} must not be drawn as ready — that is what the green dot did`)
    }
  })

  test('every status has an accessible label', () => {
    for (const status of ['unbound', 'bound_unverified', 'executable', 'blocked']) {
      assert.equal(typeof BINDING_STATUS_LABEL[status], 'string')
      assert.ok(BINDING_STATUS_LABEL[status].length > 0)
    }
    for (const status of [
      'absent', 'configured_unverified', 'verified', 'rejected', 'inaccessible',
    ]) {
      assert.equal(typeof CREDENTIAL_STATUS_LABEL[status], 'string')
    }
    for (const status of [
      'unknown', 'reachable', 'unreachable', 'rate_limited', 'unauthorized',
    ]) {
      assert.equal(typeof REACHABILITY_LABEL[status], 'string')
    }
  })

  test('a saved credential says it is not yet assigned', () => {
    // The exact copy the Models page owes a person after a save: "Saved
    // openrouter." said something happened and nothing about what it meant.
    assert.match(CREDENTIAL_STATUS_LABEL.configured_unverified, /not yet assigned/i)
  })

  test('nothing untested is labelled as tested', () => {
    assert.match(REACHABILITY_LABEL.unknown, /not tested/i)
    assert.match(BINDING_STATUS_LABEL.bound_unverified, /not tested/i)
  })

  test('no status label leaks a secret-shaped hint', () => {
    for (const label of [
      ...Object.values(BINDING_STATUS_LABEL),
      ...Object.values(CREDENTIAL_STATUS_LABEL),
      ...Object.values(REACHABILITY_LABEL),
    ]) {
      assert.doesNotMatch(label, /prefix|suffix|length|hash|sk-|characters/i,
        `a status label described the credential itself: ${label}`)
    }
  })
})
