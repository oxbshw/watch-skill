/**
 * The Bridge running inside a real Cordis context with the mock backend.
 *
 * This is Phase 1's honesty gate: the plugin must be installable and alive
 * before Watch Core exists, without any surface being able to read that state
 * as "a capability is available".
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'

/** Mount the Bridge on a fresh context and wait for the fiber to settle. */
async function mountBridge(config = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchCoreService, {
    transport: 'mock',
    autoConnect: false,
    ...config,
  })
  return { ctx, fiber }
}

describe('the Bridge before Watch Core exists', () => {
  let mounted

  before(async () => { mounted = await mountBridge() })
  after(async () => { await mounted?.fiber.dispose() })

  test('registers itself as a Cordis service', () => {
    assert.ok(mounted.ctx.watchCore, 'ctx.watchCore should be provided')
  })

  test('health is readable before connecting, and says so', () => {
    const health = mounted.ctx.watchCore.health()
    assert.equal(health.phase, 'disconnected')
    assert.equal(health.transport, null)
    assert.equal(health.handshake, null)
  })

  test('connecting reports the mock transport, never a real one', async () => {
    const result = await mounted.ctx.watchCore.connect()
    assert.equal(result.ok, true)
    const health = mounted.ctx.watchCore.health()
    assert.equal(health.phase, 'ready')
    assert.equal(
      health.transport,
      'mock',
      'the UI must be able to see that no real engine is attached',
    )
  })

  test('every capability reports not_tested, never machine_tested', async () => {
    await mounted.ctx.watchCore.connect()
    const capabilities = mounted.ctx.watchCore.capabilities()
    assert.ok(capabilities.length > 0, 'the mock should still declare the capability surface')
    for (const capability of capabilities) {
      assert.equal(
        capability.status,
        'not_tested',
        `${capability.capabilityId} must not claim to have been tested`,
      )
      assert.ok(capability.fixes.length > 0, `${capability.capabilityId} must state a fix`)
    }
  })

  test('isCapable is false for every declared capability', async () => {
    await mounted.ctx.watchCore.connect()
    for (const capability of mounted.ctx.watchCore.capabilities()) {
      assert.equal(
        mounted.ctx.watchCore.isCapable(capability.capabilityId),
        false,
        `${capability.capabilityId} must not be offered as usable`,
      )
    }
  })

  test('any real request is a structured refusal, not an invented answer', async () => {
    await mounted.ctx.watchCore.connect()
    const result = await mounted.ctx.watchCore.request('watch.video.query', { question: 'anything' })
    assert.equal(result.ok, false)
    assert.equal(result.error.error, 'bridge.core_unavailable')
    assert.ok(result.error.fix.length > 0)
  })

  test('the mock reports the strictest policy, because it is the accurate one', async () => {
    const result = await mounted.ctx.watchCore.connect()
    assert.equal(result.ok, true)
    assert.equal(result.value.policy.offlineOnly, true)
    assert.equal(result.value.policy.cloudPerceptionOptIn, false)
    assert.equal(result.value.policy.memoryMode, 'off')
  })
})

describe('connection lifecycle', () => {
  test('concurrent connects share one attempt', async () => {
    const { ctx, fiber } = await mountBridge()
    try {
      const results = await Promise.all([
        ctx.watchCore.connect(),
        ctx.watchCore.connect(),
        ctx.watchCore.connect(),
      ])
      for (const result of results) assert.equal(result.ok, true)
    } finally {
      await fiber.dispose()
    }
  })

  test('health subscribers see each phase change in order', async () => {
    const { ctx, fiber } = await mountBridge()
    const phases = []
    const unsubscribe = ctx.watchCore.onHealthChange(health => phases.push(health.phase))
    try {
      await ctx.watchCore.connect()
      assert.deepEqual(phases, ['connecting', 'ready'])
    } finally {
      unsubscribe()
      await fiber.dispose()
    }
  })

  test('disposing the fiber unregisters the service', async () => {
    const { ctx, fiber } = await mountBridge()
    await ctx.watchCore.connect()
    await fiber.dispose()
    assert.equal(ctx.watchCore, undefined, 'the service must not outlive its fiber')
  })
})

describe('cancellation', () => {
  test('a request cancelled before dispatch reports cancellation, not failure', async () => {
    const { ctx, fiber } = await mountBridge()
    try {
      await ctx.watchCore.connect()
      const controller = new AbortController()
      controller.abort()
      const result = await ctx.watchCore.request(
        'watch.video.query',
        {},
        { signal: controller.signal },
      )
      assert.equal(result.ok, false)
      assert.equal(result.error.error, 'bridge.cancelled')
    } finally {
      await fiber.dispose()
    }
  })
})

describe('boot resilience', () => {
  test('a Bridge that cannot reach Core never blocks the context from starting', async () => {
    // autoConnect against a command that does not exist. The plan requires the
    // Workspace to open with Watch disabled and a stated fix, not to fail boot.
    const { ctx, fiber } = await mountBridge({
      transport: 'stdio',
      command: 'watch-core-that-does-not-exist',
      args: [],
      autoConnect: true,
      startupTimeoutMs: 2_000,
    })
    try {
      assert.ok(ctx.watchCore, 'the service must still be registered')
      const result = await ctx.watchCore.connect()
      assert.equal(result.ok, false)
      const health = ctx.watchCore.health()
      assert.equal(health.phase, 'failed')
      assert.ok(
        health.error.fix.includes('watch-core-that-does-not-exist'),
        'the fix must name the command that could not be started',
      )
    } finally {
      await fiber.dispose()
    }
  })
})
