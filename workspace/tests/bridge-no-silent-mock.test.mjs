/**
 * The Bridge must never turn a broken engine into a working-looking product.
 *
 * This file exists because the opposite behaviour shipped. `transport: 'auto'`
 * used to fall back to the in-process mock whenever the `watch-skill` command
 * was not on the machine, and publish `phase: 'ready'`. The reasoning was
 * reasonable and the result was not: DeepWatch reported itself connected,
 * listed capabilities, and answered every real request with a refusal the
 * surfaces rendered as an empty result. From the outside that is
 * indistinguishable from "nothing is indexed yet", so the single fact the
 * product exists to make legible — is there a real engine behind this — became
 * the single fact it concealed.
 *
 * Every test below is a counterfactual: it breaks Watch Core in one specific
 * way and asserts the product goes *unavailable with a named blocker*, not
 * ready. A regression that reintroduces the fallback fails here rather than in
 * front of a user.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Mount the Bridge and always dispose it, whatever the body does. */
async function withBridge(config, body) {
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchCoreService, {
    autoConnect: false,
    startupTimeoutMs: 4_000,
    requestTimeoutMs: 2_000,
    ...config,
  })
  try {
    return await body(ctx)
  } finally {
    await fiber.dispose()
  }
}

/** A command name no machine has, so the spawn fails with ENOENT. */
const ABSENT = 'watch-skill-this-command-does-not-exist'

describe('a missing Watch Core is missing, not mocked', () => {
  test('transport auto reports core_missing rather than falling back', async () => {
    await withBridge({ transport: 'auto', command: ABSENT }, async (ctx) => {
      const result = await ctx.watchCore.connect()

      assert.equal(result.ok, false, 'connecting to an absent engine must fail')

      const health = ctx.watchCore.health()
      assert.equal(health.phase, 'failed')
      assert.equal(health.blocker, 'core_missing')
      assert.equal(health.transport, 'stdio', 'the attempted transport is reported honestly')
      assert.notEqual(health.transport, 'mock', 'auto must never reach the mock')
      assert.equal(health.isTestOnlyMock, false)
      assert.equal(health.handshake, null, 'no handshake means no version to claim')
      assert.equal(health.lastHandshakeAt, null)
    })
  })

  test('no capability is usable when the engine never answered', async () => {
    await withBridge({ transport: 'auto', command: ABSENT }, async (ctx) => {
      await ctx.watchCore.connect()

      assert.deepEqual([...ctx.watchCore.capabilities()], [])
      for (const id of ['watch.video.query', 'watch.library.search', 'watch.verification.run']) {
        assert.equal(ctx.watchCore.isCapable(id), false, `${id} must not be usable`)
      }
    })
  })

  test('a request against an absent engine fails instead of returning data', async () => {
    await withBridge({ transport: 'auto', command: ABSENT }, async (ctx) => {
      const result = await ctx.watchCore.request('watch.library.search', { query: 'anything' })

      assert.equal(result.ok, false)
      // Whatever the code, it must not be a success carrying rows. A mock
      // answering here is the exact defect: a Library that looks empty rather
      // than a Library that is unavailable.
      assert.ok(typeof result.error.fix === 'string' && result.error.fix.length > 0)
    })
  })
})

describe('an engine present but without the Bridge surface', () => {
  test('an older Core that rejects `bridge` reports bridge_surface_missing', async () => {
    await withBridge({
      transport: 'auto',
      command: process.execPath,
      args: [join(FIXTURES, 'core-without-bridge.mjs')],
    }, async (ctx) => {
      const result = await ctx.watchCore.connect()

      assert.equal(result.ok, false)
      const health = ctx.watchCore.health()
      assert.equal(health.blocker, 'bridge_surface_missing')
      assert.equal(health.isTestOnlyMock, false)
      assert.notEqual(health.phase, 'ready')
    })
  })
})

describe('an engine that starts and cannot handshake', () => {
  test('a Core that exits mid-handshake is failed, not ready', async () => {
    await withBridge({
      transport: 'auto',
      command: process.execPath,
      args: [join(FIXTURES, 'core-handshake-broken.mjs')],
    }, async (ctx) => {
      const result = await ctx.watchCore.connect()

      assert.equal(result.ok, false)
      const health = ctx.watchCore.health()
      assert.notEqual(health.phase, 'ready')
      assert.equal(health.isTestOnlyMock, false)
      assert.ok(
        ['handshake_failed', 'core_crashed', 'core_timeout'].includes(health.blocker),
        `blocker was ${health.blocker}`,
      )
    })
  })
})

describe('the mock is reachable only by name', () => {
  test('selecting mock explicitly is allowed, and flags itself', async () => {
    await withBridge({ transport: 'mock' }, async (ctx) => {
      const result = await ctx.watchCore.connect()

      assert.equal(result.ok, true, 'an explicit fixture backend still works')
      const health = ctx.watchCore.health()
      assert.equal(health.transport, 'mock')
      assert.equal(health.isTestOnlyMock, true, 'the flag is what stops a screen calling this real')
      assert.equal(health.blocker, 'test_only_mock')
    })
  })

  test('the mock still refuses to invent an answer', async () => {
    await withBridge({ transport: 'mock' }, async (ctx) => {
      await ctx.watchCore.connect()
      const result = await ctx.watchCore.request('watch.library.search', { query: 'x' })

      assert.equal(result.ok, false, 'a fixture backend answers nothing but the handshake')
    })
  })

  test('no capability is usable on the mock, however healthy it looks', async () => {
    await withBridge({ transport: 'mock' }, async (ctx) => {
      await ctx.watchCore.connect()

      const truths = [...ctx.watchCore.capabilities()]
      assert.ok(truths.length > 0, 'the mock does declare capabilities')
      for (const truth of truths) {
        assert.equal(truth.status, 'not_tested', `${truth.capabilityId} must stay unproven`)
        assert.equal(ctx.watchCore.isCapable(truth.capabilityId), false)
      }
    })
  })
})
