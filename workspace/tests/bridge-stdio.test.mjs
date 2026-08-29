/**
 * The stdio transport against a real child process.
 *
 * The mock proves the plugin is well-behaved when nothing is attached. This
 * file proves the wire itself: framing, correlation, deadlines, cancellation
 * semantics, structured error passthrough, and what happens when the engine
 * dies with work in flight.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@watchskill/dsh-core-bridge'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-core.mjs')

/** Mount the Bridge against the protocol fixture. */
async function mountFixture(config = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchCoreService, {
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    autoConnect: false,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 3_000,
    ...config,
  })
  return { ctx, fiber }
}

/** Run one test body against a mounted fixture, always disposing afterwards. */
async function withFixture(config, body) {
  const { ctx, fiber } = await mountFixture(config)
  try {
    return await body(ctx)
  } finally {
    await fiber.dispose()
  }
}

describe('handshake over stdio', () => {
  test('negotiates and reports the real transport', async () => {
    await withFixture({}, async (ctx) => {
      const result = await ctx.watchCore.connect()
      assert.equal(result.ok, true)
      assert.equal(result.value.coreVersion, '1.3.0rc2-fixture')
      assert.equal(result.value.protocolVersion, 1)

      const health = ctx.watchCore.health()
      assert.equal(health.phase, 'ready')
      assert.equal(health.transport, 'stdio')
    })
  })

  test('a machine-tested capability is reported as usable', async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      assert.equal(ctx.watchCore.isCapable('watch.video.query'), true)
      assert.equal(ctx.watchCore.isCapable('watch.live.session'), false)
    })
  })
})

describe('request framing', () => {
  test('round-trips params and carries the correlation id to the engine', async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request(
        'fixture.echo',
        { question: 'what is on screen' },
        { correlationId: 'cor_test_1' },
      )
      assert.equal(result.ok, true)
      assert.deepEqual(result.value.params, { question: 'what is on screen' })
      assert.equal(
        result.value.correlationId,
        'cor_test_1',
        'the engine must receive the same correlation id the caller used',
      )
    })
  })

  test('a frame split inside its header still decodes', async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('fixture.split', {})
      assert.equal(result.ok, true)
      assert.deepEqual(result.value, { split: true })
    })
  })

  test('concurrent requests are matched to their own replies', async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      const results = await Promise.all([
        ctx.watchCore.request('fixture.echo', { n: 1 }),
        ctx.watchCore.request('fixture.echo', { n: 2 }),
        ctx.watchCore.request('fixture.echo', { n: 3 }),
      ])
      assert.deepEqual(results.map(r => r.value.params.n), [1, 2, 3])
    })
  })
})

describe('errors from the engine', () => {
  test("the engine's own error contract is preserved verbatim", async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('fixture.fail', {})
      assert.equal(result.ok, false)
      assert.equal(result.error.error, 'fixture.refused')
      assert.equal(
        result.error.fix,
        'Do the thing the engine asked for.',
        'the transport must not reword a fix the engine is better placed to give',
      )
      assert.deepEqual(result.error.details, { from: 'fixture' })
    })
  })

  test('a bare JSON-RPC error is still given a fix', async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('fixture.rawFail', {})
      assert.equal(result.ok, false)
      assert.equal(result.error.error, 'bridge.method_not_found')
      assert.ok(result.error.fix.length > 0, 'no failure may reach the user without a fix')
    })
  })
})

describe('deadlines and cancellation', () => {
  test('a deadline does not claim the work did not happen', async () => {
    await withFixture({ requestTimeoutMs: 300 }, async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('fixture.silent', {})
      assert.equal(result.ok, false)
      assert.equal(result.error.error, 'bridge.deadline_exceeded')
      assert.equal(
        result.error.retryable,
        false,
        'a timed-out call must not be marked safe to retry',
      )
      assert.match(result.error.fix, /receipt/i)
    })
  })

  test('cancelling a dispatched request reports "requested", not "cancelled"', async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      const controller = new AbortController()
      const pending = ctx.watchCore.request('fixture.slow', {}, { signal: controller.signal })
      // Give the frame time to reach the engine before asking it to stop.
      await new Promise(resolve => setTimeout(resolve, 100))
      controller.abort()
      const result = await pending
      assert.equal(result.ok, false)
      assert.equal(
        result.error.error,
        'bridge.cancel_requested',
        'a dispatched side effect can only ever be "cancel requested"',
      )
      assert.match(result.error.fix, /receipt/i)
    })
  })
})

describe('engine loss', () => {
  test('an engine that exits fails in-flight work and reports why', async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      const pending = ctx.watchCore.request('fixture.silent', {})
      await ctx.watchCore.request('fixture.crash', {}).catch(() => undefined)
      const result = await pending
      assert.equal(result.ok, false)
      assert.equal(result.error.error, 'bridge.core_exited')
      assert.equal(result.error.retryable, true, 'a lost connection is safe to reconnect')
      assert.equal(ctx.watchCore.health().phase, 'failed')
    })
  })
})

describe('side-effect envelope', () => {
  test('a command carries idempotency and digest fields to the engine', async () => {
    await withFixture({}, async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.command('fixture.echo', { target: '#submit' }, {
        operationId: 'op_1',
        idempotencyKey: 'idem_1',
        inputDigest: 'sha256:abc',
      })
      assert.equal(result.ok, true)
      // Reconnect recovery depends on these reaching the engine; without them a
      // resumed session could only recover by reissuing the side effect.
      assert.equal(result.value.params.operationId, 'op_1')
      assert.equal(result.value.params.idempotencyKey, 'idem_1')
      assert.equal(result.value.params.inputDigest, 'sha256:abc')
      assert.equal(result.value.params.target, '#submit')
    })
  })
})
