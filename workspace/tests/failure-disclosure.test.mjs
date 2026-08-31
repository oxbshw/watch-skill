/**
 * What a conversation is allowed to say when it cannot run.
 *
 * A first prompt failed, and the Chat surface showed its reader:
 * `@deepseek-ai/dsh-system-prompt`, the route id `llm-deepseek`, the provider
 * key `deepseek-official`, the environment variable `DEEPSEEK_API_KEY`, and a
 * paragraph of sandbox-policy text. All true. None of it actionable. And two
 * of them named a provider the reader had never chosen, so the message did not
 * merely fail to help — it said *this is a broken DeepSeek product* to somebody
 * who had configured OpenRouter.
 *
 * The list at the bottom of this file is that screen, verbatim. It is the
 * regression corpus: every string a person actually saw, asserted to be absent
 * from every card this product can render.
 *
 * The detail is not destroyed. It goes to Diagnostics and the Session Log,
 * redacted. What it may not do is arrive in a conversation.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CONTRACTS = join(ROOT, 'packages', 'watch', 'contracts')

const {
  assertNoInternalDisclosure, cardForBlocker, classifyFailure, failureCard, isDisclosureSafe,
} = await import(pathToFileURL(join(CONTRACTS, 'lib', 'failures.js')).href)

/** Every kind a reader can be shown. */
const KINDS = [
  'not_configured', 'credential_unavailable', 'credential_rejected', 'model_unavailable',
  'provider_unreachable', 'rate_limited', 'policy_forbids', 'unavailable',
]

/**
 * The screen this module exists because of.
 *
 * Not a representative sample and not a guess at what a leak looks like —
 * these are the tokens that were on a real reader's screen, kept here so the
 * fix is pinned to the failure rather than to an idea of it.
 */
const WHAT_SAYED_SAW = [
  '@deepseek-ai/dsh-system-prompt',
  'llm-deepseek',
  'deepseek-official',
  'DEEPSEEK_API_KEY',
  'at Agent.step (/app/packages/core/agent-loop/src/index.ts:214:11)',
  'sandboxPolicy: workspace-write',
  'file:///D:/Em/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js',
]

describe('no card carries implementation identity', () => {
  test('every kind renders a card', () => {
    for (const kind of KINDS) {
      const card = failureCard(kind)
      assert.equal(card.kind, kind)
      assert.notEqual(card.title, '')
      assert.notEqual(card.detail, '')
      assert.notEqual(card.action, '')
    }
  })

  test('every card is free of package names, route ids and variables', () => {
    for (const kind of KINDS) {
      const card = failureCard(kind)
      for (const field of ['title', 'detail', 'action']) {
        assert.doesNotThrow(
          () => { assertNoInternalDisclosure(`${kind}.${field}`, card[field]) },
          `${kind}.${field} discloses an internal name`)
      }
    }
  })

  test('every card offers exactly one next action and a way to Diagnostics', () => {
    for (const kind of KINDS) {
      const card = failureCard(kind)
      assert.ok(typeof card.target === 'string' && card.target !== '')
      assert.equal(typeof card.hasDiagnostics, 'boolean')
    }
  })

  test('no card is a bare error code or a provider’s own words', () => {
    for (const kind of KINDS) {
      const card = failureCard(kind)
      // A title that is SCREAMING_SNAKE or ends in a colon-code is the shape a
      // raw taxonomy string takes when it reaches a reader by accident.
      assert.equal(/^[A-Z0-9_]+$/.test(card.title), false)
      assert.equal(/\b(?:ERR|E[A-Z]{3,})\b/.test(card.title), false)
    }
  })
})

describe('the screen that shipped, token by token', () => {
  for (const leaked of WHAT_SAYED_SAW) {
    test(`the guard catches ${leaked.slice(0, 44)}`, () => {
      assert.equal(isDisclosureSafe(leaked), false, `${leaked} was judged safe`)
      assert.throws(() => { assertNoInternalDisclosure('chat', leaked) })
    })
  }

  test('none of them appears in any card', () => {
    for (const kind of KINDS) {
      const rendered = Object.values(failureCard(kind)).join(' ')
      for (const leaked of WHAT_SAYED_SAW) {
        assert.equal(
          rendered.includes(leaked), false,
          `the ${kind} card carries ${leaked}`)
      }
    }
  })

  test('ordinary product copy is not caught by the guard', () => {
    // A guard that fires on honest sentences is a guard somebody switches off.
    // "Built on DeepSeek Harness" is a product fact and must stay sayable.
    for (const fine of [
      'Built on DeepSeek Harness · Powered by Watch Skill',
      'Choose a provider and a model, then assign one to Chat.',
      'DeepSeek is one provider among many. Nothing here requires it.',
      'See what happened. Remember why. Verify what worked.',
    ]) {
      assert.equal(isDisclosureSafe(fine), true, `${fine} was judged unsafe`)
    }
  })
})

describe('a raw failure is classified, never quoted', () => {
  test('the statuses a provider answers with', () => {
    assert.equal(classifyFailure({ status: 401 }), 'credential_rejected')
    assert.equal(classifyFailure({ status: 403 }), 'credential_rejected')
    assert.equal(classifyFailure({ status: 404 }), 'model_unavailable')
    assert.equal(classifyFailure({ status: 429 }), 'rate_limited')
    assert.equal(classifyFailure({ status: 503 }), 'provider_unreachable')
  })

  test('the taxonomy codes the Harness normalises to', () => {
    assert.equal(classifyFailure({ code: 'MISSING_CREDENTIAL' }), 'credential_unavailable')
    assert.equal(classifyFailure({ code: 'AUTH' }), 'credential_rejected')
    assert.equal(classifyFailure({ code: 'RATE_LIMIT' }), 'rate_limited')
    assert.equal(classifyFailure({ code: 'NO_ADAPTER' }), 'model_unavailable')
  })

  test('an unrecognised failure is vague to the reader, not verbose', () => {
    assert.equal(classifyFailure({}), 'unavailable')
    const card = failureCard('unavailable')
    assert.equal(card.target, 'diagnostics')
  })

  test('classification reads signals and returns a kind, never text', () => {
    // The property that makes the whole boundary hold: there is no argument
    // shape that gets a provider's message into the return value.
    const kind = classifyFailure({ status: 401, code: 'AUTH' })
    assert.equal(typeof kind, 'string')
    assert.ok(KINDS.includes(kind))
  })
})

describe('a readiness blocker becomes a card a person can act on', () => {
  test('the first-run blocker sends somebody to Role Bindings', () => {
    const card = cardForBlocker('no_binding')
    assert.equal(card.kind, 'not_configured')
    assert.equal(card.target, 'role-bindings')
  })

  test('a missing credential does not send somebody to the model picker', () => {
    // Naming a missing model to somebody who has no credential sends them to
    // the wrong screen; that ordering is the whole reason blockers are ranked.
    assert.equal(cardForBlocker('credential_absent').target, 'role-bindings')
    assert.equal(cardForBlocker('credential_inaccessible').kind, 'credential_unavailable')
    assert.equal(cardForBlocker('credential_rejected').kind, 'credential_rejected')
  })

  test('a stale model choice sends somebody to the model picker', () => {
    assert.equal(cardForBlocker('model_unavailable').target, 'model-selection')
    assert.equal(cardForBlocker('model_invalid').target, 'model-selection')
  })

  test('every blocker maps to a disclosure-safe card', () => {
    const blockers = [
      'no_binding', 'provider_unknown', 'credential_absent', 'credential_rejected',
      'credential_inaccessible', 'model_unset', 'model_unavailable', 'model_invalid',
      'route_lacks_role', 'modality_unsupported', 'consent_required', 'policy_forbids',
      'contract_mismatch',
    ]
    for (const blocker of blockers) {
      const card = cardForBlocker(blocker)
      assert.ok(KINDS.includes(card.kind), `${blocker} produced kind ${card.kind}`)
      assert.equal(isDisclosureSafe(`${card.title} ${card.detail} ${card.action}`), true)
    }
  })
})
