/**
 * One readiness model, and it is derived rather than written down.
 *
 * The first version of this screen shipped a table with a status *typed into
 * each row*: "Watch Core — Ready", "Memory — Ready", and a notice that said
 * "4 of 12 capabilities are ready" on every machine in the world, including
 * the ones where Core was not installed. It was a picture of the product, not
 * a reading of the installation, and it was wrong in the direction that costs
 * somebody an afternoon: it claimed more than was known.
 *
 * `deriveReadiness` replaced it. `tests/product-identity.test.mjs` asserts the
 * *source* property — that no row can be born ready — because that file reads
 * what a built profile composes. This file asserts the behaviour: given a set
 * of runtime facts, what does a surface say, and can it ever say something
 * more flattering than the facts support.
 *
 * The seven words are the whole vocabulary. Onboarding and Diagnostics fold
 * the same function over the same snapshot, so the two cannot disagree; the
 * rendering half of that is in `tests/binding-flow.test.mjs`.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SETTINGS = join(ROOT, 'packages', 'watch', 'client-settings')
const CONTRACTS = join(ROOT, 'packages', 'watch', 'contracts')

const { READINESS, READINESS_STATUS_LABEL, deriveReadiness } = await import(
  pathToFileURL(join(SETTINGS, 'lib', 'client', 'readiness.js')).href)
const { roleReadiness } = await import(
  pathToFileURL(join(CONTRACTS, 'lib', 'readiness.js')).href)

/** Every word a surface is allowed to say about a capability. */
const VOCABULARY = [
  'loading', 'ready', 'degraded', 'unconfigured', 'unavailable', 'not_tested', 'error',
]

/** A capability Core reported on, at the evidence level it claimed. */
function capability(capabilityId, status, usable = status === 'machine_tested') {
  return {
    capabilityId, status, usable, missing: [], fixes: [],
    lastCheckedAt: '2026-09-01T00:00:00Z',
  }
}

/** Every capability the table folds, at one evidence level. */
const ALL_CAPABILITIES = [
  'watch.memory.recall', 'watch.verification.run',
  'watch.browser.observe', 'watch.browser.operate', 'watch.evidence.resolve',
]

/** A Core reading. Only what a case is about is ever varied. */
function health(overrides = {}) {
  return {
    outcome: 'core_health',
    protocol: 1,
    requestId: 'req_test',
    phase: 'ready',
    blocker: 'connected',
    coreVersion: '1.4.0',
    coreBuild: 'test',
    protocolVersion: 1,
    protocolMin: 1,
    transport: 'stdio',
    isTestOnlyMock: false,
    contractsMatch: true,
    contractDrift: [],
    lastHandshakeAt: '2026-09-01T00:00:00Z',
    restartCount: 0,
    capabilities: { ready: 5, unavailable: 0, degraded: 0, unknown: 0 },
    capabilityDetails: ALL_CAPABILITIES.map(id => capability(id, 'machine_tested')),
    fix: '',
    ...overrides,
  }
}

/** A role binding at whatever stage a case is about. */
function role(name, stage) {
  const full = {
    binding: {
      role: name, provider: 'openrouter', model: 'openai/gpt-4o-mini',
      credentialRef: 'OPENROUTER_API_KEY', modalities: ['text'],
    },
    credential: 'verified',
    reachability: 'reachable',
    model: 'selected',
    route: {
      provider: 'openrouter',
      roles: ['agent_model', 'visual_perception', 'asr', 'audio_understanding', 'embeddings'],
      modalities: ['text', 'vision', 'audio'],
      models: ['openai/gpt-4o-mini'],
    },
    consentGranted: true,
    policyPermits: true,
    contractMatches: true,
  }
  const facts = stage === 'executable'
    ? full
    : stage === 'bound_unverified'
      ? { ...full, credential: 'configured_unverified', reachability: 'unknown' }
      : { ...full, binding: null, credential: 'absent', reachability: 'unknown', model: 'none' }
  return {
    role: name,
    provider: facts.binding === null ? null : facts.binding.provider,
    model: facts.binding === null ? null : facts.binding.model,
    readiness: roleReadiness(name, facts),
  }
}

const ROLES = ['agent_model', 'visual_perception', 'asr', 'audio_understanding', 'embeddings']

/** Every role at one stage, because a case varies the stage, not the list. */
const allRoles = stage => ROLES.map(name => role(name, stage))

const statusOf = (rows, name) => rows.find(row => row.name === name)?.status

describe('the vocabulary is closed, and every word is reachable', () => {
  test('a derived row never invents a status outside the shared list', () => {
    const cases = [
      deriveReadiness({ reading: true }),
      deriveReadiness({}),
      deriveReadiness({ health: health(), roles: allRoles('executable') }),
      deriveReadiness({ health: health({ isTestOnlyMock: true }) }),
      deriveReadiness({ health: health({ blocker: 'core_missing', phase: 'failed' }) }),
    ]
    for (const rows of cases) {
      for (const row of rows) {
        assert.ok(VOCABULARY.includes(row.status), `invented status ${row.status}`)
        assert.equal(typeof row.statusLabel, 'string')
        assert.ok(row.statusLabel.length > 0, `${row.name} has no accessible word`)
      }
    }
  })

  test('each of the seven words has a label, and none of them is a colour', () => {
    for (const status of VOCABULARY) {
      assert.equal(typeof READINESS_STATUS_LABEL[status], 'string')
      assert.ok(READINESS_STATUS_LABEL[status].length > 0)
    }
    assert.equal(READINESS_STATUS_LABEL.unconfigured, 'Not configured')
    assert.equal(READINESS_STATUS_LABEL.not_tested, 'Not tested')
  })

  test('every one of the seven is reachable from some set of real facts', () => {
    const seen = new Set()
    for (const rows of [
      deriveReadiness({ reading: true }),
      deriveReadiness({}),
      deriveReadiness({ health: health(), roles: allRoles('executable') }),
      deriveReadiness({ health: health({ isTestOnlyMock: true }) }),
      deriveReadiness({ health: health({ blocker: 'core_missing', phase: 'failed' }) }),
      deriveReadiness({
        health: health({
          capabilityDetails: [
            capability('watch.memory.recall', 'machine_tested', false),
          ],
        }),
        roles: allRoles('bound_unverified'),
      }),
    ]) for (const row of rows) seen.add(row.status)

    assert.deepEqual([...seen].sort(), [...VOCABULARY].sort(),
      'a state the model can express is not reachable from any reading')
  })
})

describe('nothing is ready before it has been read', () => {
  test('while the reading is in flight every row says loading', () => {
    const rows = deriveReadiness({ reading: true })
    assert.ok(rows.length >= 12)
    assert.equal(rows.filter(row => row.status === 'loading').length,
      rows.filter(row => row.coreCapabilities !== undefined).length + 1,
      'a Core-backed row answered before the handshake did')
    assert.equal(rows.filter(row => row.status === 'ready').length, 0)
  })

  test('with no reading at all, nothing claims to be ready', () => {
    const rows = deriveReadiness({})
    assert.equal(rows.filter(row => row.status === 'ready').length, 0)
    assert.equal(statusOf(rows, 'Watch Core'), 'error')
  })

  test('the count is derived, never a number somebody typed', () => {
    // "4 of 12 capabilities are ready" was true of no installation. Two
    // different sets of facts must not produce the same count.
    const cold = deriveReadiness({}).filter(row => row.status === 'ready').length
    const warm = deriveReadiness({ health: health(), roles: allRoles('executable') })
      .filter(row => row.status === 'ready').length
    assert.equal(cold, 0)
    assert.ok(warm > cold, 'the ready count did not move when the facts did')
    assert.ok(warm < READINESS.length,
      'every capability claims to be ready, which cannot be true here')
  })
})

describe('a Core that is not there is unavailable, never quietly fine', () => {
  test('a missing Core makes every capability that needs it unavailable', () => {
    const rows = deriveReadiness({
      health: health({
        blocker: 'core_missing', phase: 'failed', capabilityDetails: [],
        fix: 'Install Watch Core and set the Bridge command in Settings → Watch.',
      }),
    })
    for (const name of ['Watch Core', 'Memory', 'Verification', 'Browser']) {
      assert.equal(statusOf(rows, name), 'unavailable', `${name} did not say unavailable`)
    }
    assert.match(rows[0].detail, /Install Watch Core/,
      'the row did not carry the fix the reading supplied')
  })

  test('the in-process fixture backend is degraded, not ready', () => {
    // `auto` transport falling back to the mock and reporting a healthy
    // product is the failure this flag exists to make impossible.
    const rows = deriveReadiness({ health: health({ isTestOnlyMock: true, transport: 'auto' }) })
    assert.equal(statusOf(rows, 'Watch Core'), 'degraded')
    assert.equal(rows.filter(row => row.status === 'ready').length, 0,
      'a fixture backend was allowed to make capabilities read as ready')
  })

  test('a Core that answered but is not ready is degraded rather than ready', () => {
    const rows = deriveReadiness({ health: health({ phase: 'degraded' }) })
    assert.equal(statusOf(rows, 'Watch Core'), 'degraded')
  })
})

describe('a capability is as good as its evidence, and no better', () => {
  test('machine-tested is the only level that reads as ready', () => {
    const rows = deriveReadiness({ health: health() })
    for (const name of ['Memory', 'Verification', 'Browser']) {
      assert.equal(statusOf(rows, name), 'ready', `${name} did not read as ready`)
    }
  })

  test('a probed capability is not tested, and so is an unreported one', () => {
    // `probed` says the dependencies were found, not that anything ran. It is
    // ignorance, not damage: drawing it as Degraded put a caution chip beside
    // a browser and a memory index that were both perfectly healthy.
    const rows = deriveReadiness({
      health: health({
        capabilityDetails: [capability('watch.memory.recall', 'probed', true)],
      }),
    })
    assert.equal(statusOf(rows, 'Memory'), 'not_tested')
    assert.equal(statusOf(rows, 'Verification'), 'not_tested',
      'a capability Core never mentioned was assumed to work')
  })

  test('a probe is never enough to read as ready', () => {
    const rows = deriveReadiness({
      health: health({
        capabilityDetails: ALL_CAPABILITIES.map(id => capability(id, 'probed', true)),
      }),
    })
    for (const name of ['Memory', 'Verification', 'Browser']) {
      assert.equal(statusOf(rows, name), 'not_tested', `${name} read as ready from a probe`)
    }
  })

  test('a capability the contract could not make usable is not ready', () => {
    const rows = deriveReadiness({
      health: health({
        capabilityDetails: [
          capability('watch.memory.recall', 'machine_tested', false),
          ...ALL_CAPABILITIES.slice(1).map(id => capability(id, 'machine_tested')),
        ],
      }),
    })
    assert.equal(statusOf(rows, 'Memory'), 'degraded')
  })

  test('the worst of a group is what the group reports', () => {
    // Browser folds three capability ids. Two working and one missing is not
    // two-thirds of a browser; it is a browser that cannot finish the job.
    const rows = deriveReadiness({
      health: health({
        capabilityDetails: [
          capability('watch.browser.observe', 'machine_tested'),
          capability('watch.browser.operate', 'machine_tested'),
          capability('watch.evidence.resolve', 'unavailable', false),
          capability('watch.memory.recall', 'machine_tested'),
          capability('watch.verification.run', 'machine_tested'),
        ],
      }),
    })
    assert.equal(statusOf(rows, 'Browser'), 'unavailable')
    assert.equal(statusOf(rows, 'Memory'), 'ready')
  })
})

describe('a saved credential is not a tested one, on this surface too', () => {
  test('an unbound role is not configured', () => {
    const rows = deriveReadiness({ health: health(), roles: allRoles('unbound') })
    assert.equal(statusOf(rows, 'Agent Model'), 'unconfigured')
  })

  test('a bound role with an untested credential reads as not tested', () => {
    const rows = deriveReadiness({ health: health(), roles: allRoles('bound_unverified') })
    const agent = rows.find(row => row.name === 'Agent Model')
    assert.equal(agent.status, 'not_tested')
    assert.match(agent.statusLabel, /not tested/i)
    assert.equal(rows.filter(row => row.role !== undefined && row.status === 'ready').length, 0,
      'a saved credential was enough to make a role read as ready')
  })

  test('only a successful test makes a role read as ready', () => {
    const rows = deriveReadiness({ health: health(), roles: allRoles('executable') })
    assert.equal(statusOf(rows, 'Agent Model'), 'ready')
  })

  test('a role the store never reported is not configured, not ready', () => {
    const rows = deriveReadiness({ health: health(), roles: [] })
    for (const row of rows.filter(item => item.role !== undefined)) {
      assert.equal(row.status, 'unconfigured', `${row.name} answered without a store row`)
    }
  })
})
