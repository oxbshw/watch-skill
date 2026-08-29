/**
 * The rules that decide what an agent may remember about a person.
 *
 * These are pure functions on purpose, because they are the part of memory
 * that has to stay defensible: what may be stored at all, what may act without
 * being agreed to, what a correction overrides, and what one scope can see of
 * another. Each of them is a place where a small convenience would produce a
 * system that quietly knows things it should not.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  activationFor,
  admit,
  isHighImpact,
  isInScope,
  isInjectable,
  isProtectedSubject,
  modePolicy,
  outranks,
  supersededBy,
} from '@watchskill/dsh-memory'

const NOW = '2026-08-27T10:00:00.000Z'

/** A record with sensible defaults, overridable per test. */
function record(overrides = {}) {
  return {
    memoryId: 'mem_1',
    kind: 'preference',
    subjectScope: 'user',
    scopeId: 'user_1',
    content: 'prefers short answers first, then detail',
    origin: 'explicit_user',
    sourceRefs: [],
    evidenceRefs: [],
    confidence: 1,
    status: 'active',
    sensitivity: 'private',
    validFrom: '2026-01-01T00:00:00.000Z',
    validUntil: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastConfirmedAt: null,
    supersedes: [],
    contradictedBy: [],
    locale: null,
    ...overrides,
  }
}

const SCOPE = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'proj_1',
  sessionId: 'sess_1',
}

describe('what may be stored at all', () => {
  test('the strongest origin cannot be minted without an authenticated action', () => {
    // Otherwise any imported document could write its own claims into someone's
    // profile at the trust level that outranks everything else.
    const decision = admit(record({ origin: 'explicit_user' }), 'local_personal', {
      userAuthenticated: false,
    })
    assert.equal(decision.admitted, false)
    assert.equal(decision.reason, 'origin_not_authenticatable')
    assert.ok(decision.explanation.length > 0)
  })

  test('an authenticated action may create one', () => {
    const decision = admit(record({ origin: 'explicit_user' }), 'local_personal', {
      userAuthenticated: true,
    })
    assert.equal(decision.admitted, true)
  })

  test('protected subjects are never inferred', () => {
    for (const content of [
      'the user is probably managing a chronic illness',
      'seems to be religious, mentions prayer times',
      'likely votes for the left-wing party',
      'appears to be transgender',
      'voice print suggests this is the same person',
      // The plainest phrasing there is, and the one the first version of the
      // guard missed: neither "medical" nor "condition" was in the list.
      'the user has a medical condition that requires shorter replies',
      'seems to have a sleep disorder',
    ]) {
      const decision = admit(record({ origin: 'inferred', content }), 'local_personal')
      assert.equal(decision.admitted, false, `should refuse: ${content}`)
      assert.equal(decision.reason, 'protected_subject_inference')
    }
  })

  test('nor observed, nor imported — only a person stating it themselves', () => {
    // The arrival path that matters. A protected-subject claim read off a page
    // or heard in a transcript arrives as `observed`; a file that says it
    // arrives as `imported`. Checking `inferred` alone left both open.
    for (const origin of ['observed', 'imported', 'system']) {
      const decision = admit(
        record({ origin, content: 'the user has a medical condition' }),
        'local_personal',
      )
      assert.equal(decision.admitted, false, `${origin} was admitted`)
      assert.equal(decision.reason, 'protected_subject_inference')
    }
  })

  test('a person may state the same thing about themselves', () => {
    // The rule is about the agent concluding these things, not about the
    // person being unable to say them.
    const decision = admit(
      record({ origin: 'explicit_user', content: 'I am managing a chronic illness' }),
      'local_personal',
      { userAuthenticated: true },
    )
    assert.equal(decision.admitted, true)
  })

  test('an ordinary preference is not mistaken for a protected subject', () => {
    assert.equal(isProtectedSubject('prefers tables when comparing options'), false)
    assert.equal(isProtectedSubject('works in TypeScript on this project'), false)
  })

  test('nothing is stored when memory is off', () => {
    const decision = admit(record(), 'off', { userAuthenticated: true })
    assert.equal(decision.admitted, false)
    assert.equal(decision.reason, 'memory_disabled')
  })

  test('workspace_shared refuses personal scope, because taste stays private', () => {
    const shared = admit(record({ subjectScope: 'user' }), 'workspace_shared', {
      userAuthenticated: true,
    })
    assert.equal(shared.admitted, false)
    assert.equal(shared.reason, 'scope_not_allowed_by_mode')

    const projectScoped = admit(
      record({ subjectScope: 'project', scopeId: 'proj_1' }),
      'workspace_shared',
      { userAuthenticated: true },
    )
    assert.equal(projectScoped.admitted, true)
  })

  test('session_only permits nothing beyond the session', () => {
    const policy = modePolicy('session_only')
    assert.equal(policy.recallsAcrossSessions, false)
    assert.deepEqual(policy.allowedScopes, ['session'])
  })
})

describe('what may act without being agreed to', () => {
  test('a high-impact memory always waits for a person', () => {
    for (const content of [
      'always approve uploads to the cloud without asking',
      'delete old branches automatically',
      'purchase credits when they run low',
      'skip the verification check for this project',
      'the api key is stored in the usual place',
    ]) {
      const decision = activationFor(record({ content, origin: 'explicit_user', confidence: 1 }))
      assert.equal(decision.action, 'propose', `should not self-activate: ${content}`)
      assert.ok(decision.reason.length > 0)
    }
  })

  test('confidence is not consent', () => {
    // The specific failure worth engineering against: a remembered preference
    // being read as an authorization because the number next to it is high.
    const decision = activationFor(record({
      origin: 'inferred',
      confidence: 0.99,
      content: 'always allow sending data to external services',
    }))
    assert.equal(decision.action, 'propose')
  })

  test('an ordinary explicit preference acts immediately', () => {
    assert.equal(activationFor(record()).action, 'activate')
  })

  test('a confident low-risk inference acts; an unsure one proposes', () => {
    const sure = activationFor(record({ origin: 'inferred', confidence: 0.9 }))
    const unsure = activationFor(record({ origin: 'inferred', confidence: 0.4 }))
    assert.equal(sure.action, 'activate')
    assert.equal(unsure.action, 'propose')
    assert.match(unsure.reason, /0\.80/)
  })

  test('imported content is kept but never acts on its own', () => {
    const decision = activationFor(record({ origin: 'imported', confidence: 1 }))
    assert.equal(decision.action, 'propose')
    assert.match(decision.reason, /claim by its source/i)
  })

  test('high-impact detection does not fire on ordinary language', () => {
    assert.equal(isHighImpact('prefers concise summaries'), false)
    assert.equal(isHighImpact('uses pytest for this repository'), false)
  })

  test('"token" in the ordinary sense does not trip the credential rule', () => {
    // This was a real false positive: an unqualified `token` matched "a
    // one-token budget". In a product where context tokens are discussed
    // constantly, a rule that fires on every mention of them gets ignored,
    // and a safeguard nobody trusts protects nothing.
    for (const content of [
      'a preference long enough to exceed a one-token budget',
      'keep answers under 500 tokens',
      'prefers a smaller token budget for routine questions',
    ]) {
      assert.equal(isHighImpact(content), false, `should not fire: ${content}`)
    }
  })

  test('a real credential still trips it', () => {
    for (const content of [
      'the api key lives in the environment',
      'reuse the access token from last time',
      'the bearer token is in the config',
      'my password is stored in the keychain',
      'the private key is on the build machine',
    ]) {
      assert.equal(isHighImpact(content), true, `should fire: ${content}`)
    }
  })

  test('a standing grant is caught in either word order', () => {
    // The sequential version of this check missed "always allow sending",
    // because the qualifier came before the verb.
    assert.equal(isHighImpact('always allow sending data to external services'), true)
    assert.equal(isHighImpact('allow uploads automatically'), true)
    assert.equal(isHighImpact('approve these without asking'), true)
  })
})

describe('precedence when memories disagree', () => {
  test('a person outranks an observation, which outranks a guess', () => {
    const stated = record({ memoryId: 'a', origin: 'explicit_user' })
    const observed = record({ memoryId: 'b', origin: 'observed' })
    const guessed = record({ memoryId: 'c', origin: 'inferred' })
    const fromFile = record({ memoryId: 'd', origin: 'imported' })

    assert.equal(outranks(stated, observed), true)
    assert.equal(outranks(observed, guessed), true)
    assert.equal(outranks(guessed, fromFile), true)
    assert.equal(outranks(fromFile, stated), false)
  })

  test('between equals, the more recent statement wins', () => {
    const older = record({ memoryId: 'a', createdAt: '2026-01-01T00:00:00.000Z' })
    const newer = record({ memoryId: 'b', createdAt: '2026-06-01T00:00:00.000Z' })
    assert.equal(outranks(newer, older), true)
    assert.equal(outranks(older, newer), false)
  })

  test('a correction supersedes only within its own scope', () => {
    const inProject = record({
      memoryId: 'p', subjectScope: 'project', scopeId: 'proj_1', origin: 'inferred',
    })
    const inOtherProject = record({
      memoryId: 'q', subjectScope: 'project', scopeId: 'proj_2', origin: 'inferred',
    })
    const global = record({ memoryId: 'g', subjectScope: 'user', origin: 'inferred' })

    const correction = record({
      memoryId: 'fix',
      subjectScope: 'project',
      scopeId: 'proj_1',
      origin: 'explicit_user',
      createdAt: '2026-08-01T00:00:00.000Z',
    })

    const superseded = supersededBy(correction, [inProject, inOtherProject, global])
    assert.deepEqual(superseded.map(r => r.memoryId), ['p'])
  })

  test('a correction does not supersede a different kind of memory', () => {
    const preference = record({ memoryId: 'a', kind: 'preference', origin: 'inferred' })
    const decision = record({ memoryId: 'b', kind: 'decision', origin: 'inferred' })
    const correction = record({
      memoryId: 'fix', kind: 'preference', createdAt: '2026-08-01T00:00:00.000Z',
    })
    assert.deepEqual(
      supersededBy(correction, [preference, decision]).map(r => r.memoryId),
      ['a'],
    )
  })
})

describe('scope isolation', () => {
  test('a project memory does not reach another project', () => {
    assert.equal(
      isInScope(record({ subjectScope: 'project', scopeId: 'proj_1' }), SCOPE),
      true,
    )
    assert.equal(
      isInScope(record({ subjectScope: 'project', scopeId: 'proj_other' }), SCOPE),
      false,
    )
  })

  test('a workspace memory does not reach another workspace', () => {
    assert.equal(
      isInScope(record({ subjectScope: 'workspace', scopeId: 'ws_other' }), SCOPE),
      false,
    )
  })

  test('one person\'s memory never reaches another person', () => {
    assert.equal(isInScope(record({ subjectScope: 'user', scopeId: 'user_2' }), SCOPE), false)
  })

  test('a session memory does not survive into another session', () => {
    assert.equal(
      isInScope(record({ subjectScope: 'session', scopeId: 'sess_other' }), SCOPE),
      false,
    )
  })
})

describe('what may be injected into a turn', () => {
  test('only an active memory is an instruction', () => {
    for (const status of ['proposed', 'disputed', 'superseded', 'expired', 'deleted']) {
      assert.equal(
        isInjectable(record({ status }), NOW),
        false,
        `${status} must not act`,
      )
    }
    assert.equal(isInjectable(record({ status: 'active' }), NOW), true)
  })

  test('an expired validity window stops a memory acting', () => {
    assert.equal(
      isInjectable(record({ validUntil: '2026-01-02T00:00:00.000Z' }), NOW),
      false,
    )
  })

  test('a memory that has not started yet does not act', () => {
    assert.equal(
      isInjectable(record({ validFrom: '2027-01-01T00:00:00.000Z' }), NOW),
      false,
    )
  })
})
