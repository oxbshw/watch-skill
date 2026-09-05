/**
 * What the startup budget must actually do, not what it is set to.
 *
 * `core-startup-backstop.test.mjs` checks the number in every composed patch.
 * A number is not a behaviour: the same 45 seconds would be equally present if
 * a dead child were waited out for the full budget, or if a slow-but-healthy
 * engine were killed at ten anyway. This file drives the transport against a
 * fixture that can be slow, hung, or dead on arrival, and asserts what each
 * one produces.
 *
 * The defect behind it: a first `watch-skill bridge` against a virtualenv
 * `deepwatch setup` had created moments earlier exceeded a ten-second budget
 * on a clean Windows machine — a cold Python import of thousands of files a
 * security scanner had never seen. Diagnostics reported Watch Core `failed`,
 * blocker `core_timeout`, last handshake `Never`, and the reconnect breaker
 * opened. The same profile connected in under three seconds on its next
 * start, and the packed Bridge integration passed 24/24 against that binary.
 * The installation was healthy and the product called it dead.
 *
 * Two properties have to hold together, and only one of them is about
 * patience: a slow engine must be waited for, and a *dead* one must not be.
 * A budget raised without the second property is a product that takes 45
 * seconds to notice a crash.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-core.mjs')

/**
 * The budget the composed profiles actually ship.
 *
 * Read as a constant rather than hard-coded twice: the point of these tests is
 * that the shipped budget behaves, so they must exercise the shipped number.
 */
const SHIPPED_STARTUP_MS = 45_000

/**
 * Mount against the fixture, with the environment the case needs.
 *
 * The child inherits `process.env`, so the fixture's controls are set on this
 * process for the length of the mount rather than passed through the service
 * config — the config schema does not carry `env`, and widening a public
 * deployment surface to steer a test fixture would be the wrong trade.
 */
async function mount(config = {}, env = {}) {
  const restore = []
  for (const [key, value] of Object.entries(env)) {
    restore.push([key, process.env[key]])
    process.env[key] = value
  }
  const undo = () => {
    for (const [key, previous] of restore) {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  }

  try {
    const ctx = new Context()
    const fiber = await ctx.plugin(WatchCoreService, {
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      autoConnect: false,
      startupTimeoutMs: SHIPPED_STARTUP_MS,
      requestTimeoutMs: 3_000,
      ...config,
    })
    return { ctx, fiber, undo }
  } catch (error) {
    undo()
    throw error
  }
}

async function withMount(config, env, body) {
  const { ctx, fiber, undo } = await mount(config, env)
  try {
    return await body(ctx)
  } finally {
    await fiber.dispose()
    undo()
  }
}

describe('a slow engine is waited for', () => {
  test('a healthy handshake past ten seconds still connects', async () => {
    // The regression, at full scale. Eleven seconds is past the budget that
    // failed and well inside the one that shipped; anything less would prove
    // only that some budget exists.
    const started = Date.now()
    await withMount({}, { WATCH_FIXTURE_HANDSHAKE_DELAY_MS: '11000' }, async (ctx) => {
      const result = await ctx.watchCore.connect()
      const elapsed = Date.now() - started

      assert.equal(result.ok, true,
        `a healthy engine that took 11s was refused: ${JSON.stringify(result.error)}`)
      assert.ok(elapsed > 10_000,
        `the handshake resolved in ${String(elapsed)}ms, so the delay never applied`)
      assert.ok(elapsed < SHIPPED_STARTUP_MS,
        `the handshake took ${String(elapsed)}ms, at or past the budget`)
      assert.equal(ctx.watchCore.health().phase, 'ready')
    })
  })
})

describe('a dead engine is not waited for', () => {
  test('a child that exits before the handshake fails at once', async () => {
    // The other half of raising the budget. A crash must not cost 45 seconds
    // to notice, or the product spends its startup budget on an engine that
    // is already gone.
    const started = Date.now()
    await withMount({}, { WATCH_FIXTURE_EXIT_AT_START: '3' }, async (ctx) => {
      const result = await ctx.watchCore.connect()
      const elapsed = Date.now() - started

      assert.equal(result.ok, false, 'a dead child reported a successful handshake')
      assert.ok(elapsed < 10_000,
        `noticing a dead child took ${String(elapsed)}ms; it must not wait out the budget`)
      assert.match(result.error.error, /exit|process|start/i,
        `the failure is not typed as a process failure: ${result.error.error}`)
      assert.ok(result.error.fix.length > 0, 'no failure may reach a user without a fix')
    })
  })
})

describe('a hung engine is bounded', () => {
  test('a handshake that never lands ends at the configured budget', async () => {
    // Boundedness is the behaviour; the shipped value of that bound is
    // asserted in core-startup-backstop.test.mjs. Proving both here would
    // mean a forty-five-second test to learn what a three-second one already
    // shows: the wait ends when the budget says, and says why.
    const budget = 3_000
    const started = Date.now()
    await withMount({ startupTimeoutMs: budget },
      { WATCH_FIXTURE_HANDSHAKE_NEVER: '1' }, async (ctx) => {
        const result = await ctx.watchCore.connect()
        const elapsed = Date.now() - started

        assert.equal(result.ok, false, 'a hung engine reported a handshake')
        assert.ok(elapsed >= budget - 500,
          `gave up after ${String(elapsed)}ms, before its own budget`)
        assert.ok(elapsed < budget + 8_000,
          `took ${String(elapsed)}ms to honour a ${String(budget)}ms budget`)
        assert.ok(result.error.fix.length > 0)
      })
  })
})

describe('a failed start does not poison the session', () => {
  test('a later connect succeeds after a hung one gave up', async () => {
    // What the clean room could not do. Once the first handshake timed out,
    // Diagnostics stayed `failed` with `Last handshake: Never` and re-reading
    // health changed nothing; only restarting the Host recovered it.
    const { ctx, fiber, undo } = await mount({ startupTimeoutMs: 2_000 },
      { WATCH_FIXTURE_HANDSHAKE_NEVER: '1' })
    try {
      const first = await ctx.watchCore.connect()
      assert.equal(first.ok, false, 'the hung fixture connected')
      assert.notEqual(ctx.watchCore.health().phase, 'ready')
    } finally {
      await fiber.dispose()
      undo()
    }

    // A fresh mount is what a Host restart does, and it must work.
    await withMount({}, {}, async (healthy) => {
      const second = await healthy.watchCore.connect()
      assert.equal(second.ok, true,
        `a healthy engine was refused after an earlier failure: ${JSON.stringify(second.error)}`)
      assert.equal(healthy.watchCore.health().phase, 'ready')
    })
  })
})

describe('cancellation during startup releases the child', () => {
  test('disposing while the handshake is outstanding leaves nothing behind', async () => {
    const { ctx, fiber, undo } = await mount({}, { WATCH_FIXTURE_HANDSHAKE_NEVER: '1' })
    // Start the handshake and abandon it, without awaiting the result.
    const pending = ctx.watchCore.connect()
    await new Promise(resolve => setTimeout(resolve, 300))

    const started = Date.now()
    await fiber.dispose()
    undo()
    const elapsed = Date.now() - started

    assert.ok(elapsed < 10_000,
      `disposing a starting engine took ${String(elapsed)}ms`)
    // The abandoned promise must settle rather than hang the runtime.
    const result = await Promise.race([
      pending,
      new Promise(resolve => setTimeout(() => { resolve('never settled') }, 8_000)),
    ])
    assert.notEqual(result, 'never settled',
      'an in-flight handshake never settled after dispose')
  })
})

describe('the phase while starting is not a verdict', () => {
  test('health reads starting or connecting, never ready, before the handshake', async () => {
    // What a surface renders during the budget. `ready` here would be the
    // false Ready flash; a terminal error would be the premature failure the
    // raised budget exists to prevent.
    await withMount({}, { WATCH_FIXTURE_HANDSHAKE_DELAY_MS: '1500' }, async (ctx) => {
      const pending = ctx.watchCore.connect()
      await new Promise(resolve => setTimeout(resolve, 400))

      const phase = ctx.watchCore.health().phase
      assert.notEqual(phase, 'ready',
        'health claimed ready while the handshake was still outstanding')
      assert.notEqual(phase, 'failed',
        `health reported a terminal failure inside the budget: ${String(phase)}`)

      const result = await pending
      assert.equal(result.ok, true)
      assert.equal(ctx.watchCore.health().phase, 'ready')
    })
  })
})
