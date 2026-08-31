/**
 * Diagnostics reads the engine, and cannot be made to claim one that is absent.
 *
 * The panel this backs used to render "Watch Core — Connected over stdio" as a
 * green chip with a version beside it. Both were literals typed into a
 * component: the read plane carried Library reads and nothing else, so the one
 * screen whose entire job is to report the state of the engine had no channel
 * to it. The interim fix was to make the panel say "not read from here", which
 * was honest and is not a product.
 *
 * `watchQuery.coreHealth` is the channel. These tests are about the property
 * that makes it worth having: every field comes from the running Bridge, and a
 * field that cannot be read is `null` rather than a plausible default.
 *
 * The last describe block is the counterfactual the whole exercise is for.
 * Break the handshake and Diagnostics must stop saying connected.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { readCoreHealth } from '../packages/watch/tools/lib/read-plane.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** A well-formed request; the method takes no parameters of its own. */
function request(overrides = {}) {
  return { protocol: 1, requestId: 'req_health_1', deadlineMs: 5_000, ...overrides }
}

/** Read health against a context, with a signal that is not aborted. */
function read(ctx, overrides = {}) {
  return readCoreHealth(request(overrides), ctx, new AbortController().signal)
}

/**
 * A stand-in Bridge, so the reader can be driven into every state.
 *
 * The real Bridge is exercised end to end in `bridge-*.test.mjs`; what needs
 * proving here is that this function reports what it is given and invents
 * nothing, which is easiest to see when the input is fully controlled.
 */
function bridge(health, capabilities = [], capable = () => false) {
  return {
    watchCore: {
      health: () => health,
      capabilities: () => capabilities,
      isCapable: capable,
    },
  }
}

const READY = {
  phase: 'ready',
  transport: 'stdio',
  blocker: 'connected',
  isTestOnlyMock: false,
  lastHandshakeAt: '2026-09-01T00:00:00Z',
  restartCount: 1,
  handshake: {
    coreVersion: '1.3.0rc2',
    coreBuild: null,
    protocolVersion: 1,
    protocolMin: 1,
  },
  error: null,
}

describe('a connected engine is reported as itself', () => {
  test('the version comes from the handshake, not from this build', () => {
    const report = read(bridge(READY))
    assert.equal(report.outcome, 'core_health')
    assert.equal(report.coreVersion, '1.3.0rc2')
    assert.equal(report.protocolVersion, 1)
    assert.equal(report.protocolMin, 1)
    assert.equal(report.transport, 'stdio')
    assert.equal(report.blocker, 'connected')
    assert.equal(report.lastHandshakeAt, '2026-09-01T00:00:00Z')
    assert.equal(report.restartCount, 1)
  })

  test('capabilities are counted by what is usable, not by what was claimed', () => {
    // A capability whose contract family drifted is reported by the engine as
    // implemented and is nonetheless unusable, because the two sides disagree
    // about what its payload means. Counting the engine's word would put a
    // number on the screen that no button could honour.
    const capabilities = [
      { capabilityId: 'a', status: 'machine_tested' },
      { capabilityId: 'b', status: 'implemented' },
      { capabilityId: 'c', status: 'unavailable' },
      { capabilityId: 'd', status: 'probed' },
      { capabilityId: 'e', status: 'not_tested' },
    ]
    const usable = new Set(['a'])
    const report = read(bridge(READY, capabilities, id => usable.has(id)))

    assert.deepEqual(report.capabilities, {
      ready: 1, unavailable: 1, degraded: 1, unknown: 2,
    })
  })
})

describe('nothing is defaulted', () => {
  test('an engine that never handshook reports nulls, not placeholders', () => {
    const report = read(bridge({
      phase: 'failed',
      transport: 'stdio',
      blocker: 'core_missing',
      isTestOnlyMock: false,
      lastHandshakeAt: null,
      restartCount: 1,
      handshake: null,
      error: {
        error: 'bridge.core_not_installed',
        fix: 'Install Watch Core with `pip install watch-skill`.',
        details: {},
      },
    }))

    assert.equal(report.coreVersion, null, 'a version nobody reported must be null')
    assert.equal(report.coreBuild, null)
    assert.equal(report.protocolVersion, null)
    assert.equal(report.protocolMin, null)
    assert.equal(report.lastHandshakeAt, null)
    assert.equal(report.contractsMatch, false)
    assert.match(report.fix, /pip install watch-skill/)
  })

  test('a Workspace with no Bridge at all still gets an answer', () => {
    // A real state: DSH runs without Watch. Throwing here would reach the
    // Gateway as an internal error, which is the least useful thing a
    // diagnostics screen can be told.
    const report = read({})
    assert.equal(report.outcome, 'core_health')
    assert.equal(report.blocker, 'core_missing')
    assert.equal(report.coreVersion, null)
    assert.deepEqual(report.capabilities, { ready: 0, unavailable: 0, degraded: 0, unknown: 0 })
  })
})

describe('a fixture backend can never look real', () => {
  test('the mock is flagged, whatever its phase says', () => {
    const report = read(bridge({
      ...READY,
      transport: 'mock',
      blocker: 'test_only_mock',
      isTestOnlyMock: true,
      handshake: { ...READY.handshake, coreVersion: '0.0.0-mock' },
    }))

    assert.equal(report.isTestOnlyMock, true)
    assert.equal(report.blocker, 'test_only_mock')
    // The phase is still `ready`, and that is correct — the backend is
    // working. The flag is what stops a screen calling its answers data.
    assert.equal(report.phase, 'ready')
  })
})

describe('contract drift is named, not summarised', () => {
  test('a drifted family is listed and marks the contract as mismatched', () => {
    const report = read(bridge({
      ...READY,
      phase: 'degraded',
      blocker: 'contract_mismatch',
      error: {
        error: 'bridge.schema_drift',
        fix: 'Update Watch Core or the Workspace so their contract versions match.',
        details: { drift: [{ family: 'evidence' }, { family: 'library' }] },
      },
    }))

    assert.equal(report.contractsMatch, false)
    assert.deepEqual(report.contractDrift, ['evidence', 'library'])
  })
})

describe('the request envelope is still validated', () => {
  test('a wrong protocol is refused rather than answered', () => {
    const report = readCoreHealth(
      request({ protocol: 999 }), bridge(READY), new AbortController().signal)
    assert.notEqual(report.outcome, 'core_health')
  })

  test('an aborted read reports the deadline it was given', () => {
    const controller = new AbortController()
    controller.abort()
    const report = readCoreHealth(request(), bridge(READY), controller.signal)
    assert.equal(report.outcome, 'deadline_exceeded')
    assert.equal(report.deadlineMs, 5_000)
  })
})

describe('counterfactual: break the handshake, lose the claim', () => {
  test('Diagnostics stops showing connected when Core stops handshaking', async () => {
    // The end-to-end version of every assertion above. A real Bridge is
    // pointed at a real child process that starts and then refuses to
    // negotiate, and the report has to follow.
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: WatchCoreService } = await import('@deepwatch/dsh-core-bridge')

    const ctx = new Context()
    const fiber = await ctx.plugin(WatchCoreService, {
      transport: 'auto',
      command: process.execPath,
      args: [join(FIXTURES, 'core-handshake-broken.mjs')],
      autoConnect: false,
      startupTimeoutMs: 4_000,
      requestTimeoutMs: 2_000,
    })
    try {
      await ctx.watchCore.connect()
      const report = read(ctx)

      assert.notEqual(report.blocker, 'connected', 'a broken handshake is not a connection')
      assert.equal(report.coreVersion, null, 'and it has no version to show')
      assert.equal(report.isTestOnlyMock, false, 'nor was it quietly replaced by a mock')
      assert.equal(report.capabilities.ready, 0)
    } finally {
      await fiber.dispose()
    }
  })
})
