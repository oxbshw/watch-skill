/**
 * Technology descriptors, role bindings and OCR routing.
 *
 * Three things are being defended here, and each is a place where the
 * convenient behavior is the wrong one:
 *
 * - **Presence is not readiness.** A binary on disk must not be offered as a
 *   working capability.
 * - **A credential is not consent.** Holding an API key must not authorize
 *   sending someone's frames to the service it opens.
 * - **Unmeasured is not qualified.** An engine nobody tested on a workload
 *   must not become the default for it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEEPSEEK_OCR,
  DEEPSEEK_OCR2,
  OCR_ENGINES,
  OCR_WORKLOADS,
  RAPID_OCR,
  ROLES,
  SCRIPTS,
  TESSERACT,
  canBind,
  canDefault,
  canFallBack,
  isUsable,
  mayDistributeWeights,
  notTested,
  routeOcr,
  unchecked,
} from '@watchskill/dsh-technology'

/** Health for a technology that is genuinely working. */
function ready(id) {
  return {
    technologyId: id,
    state: 'ready',
    detected: {},
    missing: [],
    fixes: [],
    lastCheckedAt: '2026-08-27T00:00:00.000Z',
    reason: null,
  }
}

/** A binding with the safe defaults. */
function binding(overrides = {}) {
  return {
    role: 'ocr_layout',
    technologyId: RAPID_OCR.id,
    model: null,
    scope: 'workspace',
    scopeId: 'ws_1',
    fallbackTechnologyId: null,
    allowEgressFallback: false,
    ...overrides,
  }
}

describe('presence is not readiness', () => {
  test('installed and probed are not usable', () => {
    // The states that exist precisely so they cannot be collapsed into
    // "installed, therefore fine".
    for (const state of ['discovered', 'not_installed', 'installing', 'installed', 'probed']) {
      assert.equal(isUsable(state), false, `${state} must not be offered`)
    }
  })

  test('only ready and degraded are usable', () => {
    assert.equal(isUsable('ready'), true)
    // Degraded is usable and says so; the alternative is hiding a working
    // capability because part of it is not.
    assert.equal(isUsable('degraded'), true)
    for (const state of ['unavailable', 'incompatible', 'disabled', 'machine_tested']) {
      assert.equal(isUsable(state), false, `${state} must not be offered`)
    }
  })

  test('a technology nobody checked is discovered, not absent', () => {
    // Reporting absence we never established is the same error as reporting
    // readiness we never established.
    const health = unchecked('ocr.rapidocr')
    assert.equal(health.state, 'discovered')
    assert.equal(health.lastCheckedAt, null)
    assert.equal(isUsable(health.state), false)
  })
})

describe('role bindings', () => {
  test('a technology can only be bound to a role it serves', () => {
    const decision = canBind('asr', RAPID_OCR, ready(RAPID_OCR.id), {
      offlineOnly: false, egressConsent: true,
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'role_not_supported')
  })

  test('an unusable technology cannot be bound, and the refusal names the state', () => {
    const decision = canBind('ocr_layout', RAPID_OCR, {
      ...unchecked(RAPID_OCR.id),
      state: 'unavailable',
      fixes: ['Install rapidocr-onnxruntime.'],
    }, { offlineOnly: false, egressConsent: true })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'technology_not_usable')
    assert.match(decision.explanation, /unavailable/)
    assert.match(decision.explanation, /Install rapidocr/)
  })

  test('offline-only refuses anything that leaves the machine', () => {
    const cloud = {
      ...RAPID_OCR,
      id: 'ocr.cloud',
      displayName: 'A cloud OCR service',
      privacy: { egress: 'content', worksOffline: false, requiresEgressConsent: true },
    }
    const decision = canBind('ocr_layout', cloud, ready(cloud.id), {
      offlineOnly: true, egressConsent: true,
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'offline_policy')
  })

  test('a credential is not consent to send content', () => {
    // The rule the whole privacy model rests on: having configured a provider
    // is not the same as agreeing that frames may be uploaded to it.
    const cloud = {
      ...RAPID_OCR,
      id: 'ocr.cloud',
      displayName: 'A cloud OCR service',
      credentialReference: 'cred_abc',
      privacy: { egress: 'content', worksOffline: false, requiresEgressConsent: true },
    }
    const decision = canBind('ocr_layout', cloud, ready(cloud.id), {
      offlineOnly: false, egressConsent: false,
    })
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'egress_consent_missing')
    assert.match(decision.explanation, /not the same as agreeing/)
  })

  test('a local engine binds under every policy', () => {
    const decision = canBind('ocr_layout', RAPID_OCR, ready(RAPID_OCR.id), {
      offlineOnly: true, egressConsent: false,
    })
    assert.equal(decision.allowed, true)
  })

  test('every role is enumerable for settings', () => {
    assert.ok(ROLES.includes('agent_model'))
    assert.ok(ROLES.includes('ocr_layout'))
    assert.equal(new Set(ROLES).size, ROLES.length)
  })
})

describe('fallback across a privacy boundary', () => {
  test('falling back from local to cloud is refused by default', () => {
    // The quiet failure this prevents: a local engine is busy, the request
    // goes to a cloud one, nothing errored, nobody was asked, and content left
    // the machine.
    const cloud = {
      ...RAPID_OCR,
      id: 'ocr.cloud',
      privacy: { egress: 'content', worksOffline: false, requiresEgressConsent: true },
    }
    const decision = canFallBack(RAPID_OCR, cloud, binding())
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'egress_consent_missing')
  })

  test('it is allowed when the binding said so explicitly', () => {
    const cloud = {
      ...RAPID_OCR,
      id: 'ocr.cloud',
      privacy: { egress: 'content', worksOffline: false, requiresEgressConsent: true },
    }
    assert.equal(canFallBack(RAPID_OCR, cloud, binding({ allowEgressFallback: true })).allowed, true)
  })

  test('falling back between two local engines is fine', () => {
    assert.equal(canFallBack(RAPID_OCR, TESSERACT, binding()).allowed, true)
  })
})

describe('OCR qualification', () => {
  test('not tested and not qualified are different answers', () => {
    // Collapsing them would let an engine nobody ran look evaluated.
    const untested = notTested(DEEPSEEK_OCR2.id, 'document', 'Latin')
    assert.equal(untested.state, 'NOT_TESTED')
    assert.equal(untested.measuredAt, null)
    assert.deepEqual(untested.metrics, {}, 'an untested cell carries no numbers')
    assert.equal(canDefault(untested), false)

    assert.equal(canDefault({ ...untested, state: 'NOT_YET_QUALIFIED' }), false)
    assert.equal(canDefault({ ...untested, state: 'QUALIFIED' }), true)
    assert.equal(canDefault({ ...untested, state: 'QUALIFIED_WITH_LIMITATIONS' }), true)
  })

  test('the matrix is per workload and script, never one score', () => {
    assert.ok(OCR_WORKLOADS.length >= 10)
    assert.ok(SCRIPTS.includes('Arabic'))
    assert.ok(SCRIPTS.includes('Han_Simplified'))
    assert.ok(SCRIPTS.includes('Thai'))
    assert.ok(SCRIPTS.includes('Mixed'))
  })
})

describe('OCR routing', () => {
  const health = new Map(OCR_ENGINES.map(engine => [
    engine.id,
    // No GPU on this machine, so the DeepSeek engines are not usable.
    engine.hardware.gpu === 'required'
      ? { usable: false, state: 'unavailable' }
      : { usable: true, state: 'ready' },
  ]))

  test('a GPU engine is excluded on a machine without one, with a reason', () => {
    const decision = routeOcr(
      { workload: 'document', scripts: ['Latin'], quality: 'best', hasGpu: false, offlineOnly: false, egressConsent: true },
      OCR_ENGINES,
      [],
      health,
    )
    assert.notEqual(decision.engineId, DEEPSEEK_OCR2.id)
    assert.ok(decision.excluded.some(entry => entry.engineId === DEEPSEEK_OCR2.id))
    assert.ok(decision.reason.length > 0, 'a routing choice must be auditable')
  })

  test('an unqualified choice says so rather than implying it was qualified', () => {
    const decision = routeOcr(
      { workload: 'subtitles', scripts: ['Arabic'], quality: 'balanced', hasGpu: false, offlineOnly: false, egressConsent: false },
      OCR_ENGINES,
      [],
      health,
    )
    assert.ok(decision.engineId !== null)
    assert.match(decision.reason, /no engine is qualified/)
    assert.match(decision.reason, /unqualified/)
  })

  test('a qualified engine is preferred over an unqualified one', () => {
    const qualification = [{
      engineId: TESSERACT.id,
      workload: 'mixed_script',
      script: 'Thai',
      state: 'QUALIFIED',
      metrics: { cer: 0.04 },
      limitations: [],
      measuredAt: '2026-08-27T00:00:00.000Z',
      measuredOn: 'reference-laptop',
    }]
    const decision = routeOcr(
      { workload: 'mixed_script', scripts: ['Thai'], quality: 'balanced', hasGpu: false, offlineOnly: false, egressConsent: false },
      OCR_ENGINES,
      qualification,
      health,
    )
    assert.equal(decision.engineId, TESSERACT.id)
    assert.match(decision.reason, /qualified for mixed_script/)
  })

  test('offline-only excludes anything that would leave the machine', () => {
    const cloud = {
      ...RAPID_OCR,
      id: 'ocr.cloud',
      privacy: { egress: 'content', worksOffline: false, requiresEgressConsent: true },
    }
    const withCloud = new Map(health)
    withCloud.set(cloud.id, { usable: true, state: 'ready' })
    const decision = routeOcr(
      { workload: 'document', scripts: ['Latin'], quality: 'best', hasGpu: false, offlineOnly: true, egressConsent: true },
      [...OCR_ENGINES, cloud],
      [],
      withCloud,
    )
    assert.notEqual(decision.engineId, cloud.id)
    assert.ok(decision.excluded.some(e => e.engineId === cloud.id && e.reason.includes('offline')))
  })

  test('no available engine is null with a reason, never a silent default', () => {
    const nothing = new Map(OCR_ENGINES.map(e => [e.id, { usable: false, state: 'unavailable' }]))
    const decision = routeOcr(
      { workload: 'document', scripts: ['Latin'], quality: 'fast', hasGpu: false, offlineOnly: false, egressConsent: false },
      OCR_ENGINES,
      [],
      nothing,
    )
    assert.equal(decision.engineId, null)
    assert.match(decision.reason, /No OCR engine is available/)
  })
})

describe('model weight provenance', () => {
  test('a repository licence does not stand in for a weight licence', () => {
    // DeepSeek-OCR's code is MIT and OCR2's is Apache-2.0. Neither says
    // anything about the published weights, and treating one as the other is
    // how a distribution ships something it had no right to.
    assert.equal(DEEPSEEK_OCR.provenance.codeLicense, 'MIT')
    assert.equal(DEEPSEEK_OCR.provenance.weightsLicense, null)
    assert.equal(DEEPSEEK_OCR2.provenance.codeLicense, 'Apache-2.0')
    assert.equal(DEEPSEEK_OCR2.provenance.weightsLicense, null)

    assert.equal(mayDistributeWeights(DEEPSEEK_OCR), false)
    assert.equal(mayDistributeWeights(DEEPSEEK_OCR2), false)
  })

  test('a reviewed licence permits distribution', () => {
    assert.equal(mayDistributeWeights(RAPID_OCR), true)
  })

  test('every engine pins a revision or explains why it does not need one', () => {
    for (const engine of [DEEPSEEK_OCR, DEEPSEEK_OCR2]) {
      assert.match(
        engine.provenance.revision ?? '',
        /^[0-9a-f]{40}$/,
        `${engine.id} must pin an exact revision`,
      )
    }
  })

  test('nothing installs automatically', () => {
    // A large model download that starts on its own is a bandwidth bill and a
    // disk full, on someone else's machine.
    for (const engine of OCR_ENGINES) {
      assert.equal(engine.install.automatic, false, `${engine.id} must not auto-install`)
    }
  })

  test('model code that trusts remote code runs isolated', () => {
    // DeepSeek's published inference path uses trust_remote_code. A surprise in
    // a model repository should cost a worker, not the workspace.
    assert.equal(DEEPSEEK_OCR.trust, 'isolated')
    assert.equal(DEEPSEEK_OCR2.trust, 'isolated')
    assert.equal(DEEPSEEK_OCR.runtime, 'local_process')
    assert.equal(DEEPSEEK_OCR2.runtime, 'local_process')
  })
})
