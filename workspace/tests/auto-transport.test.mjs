/**
 * The `auto` transport: which real engine to try, never whether to use one.
 *
 * `auto` used to fall back to the in-process mock when the command was not
 * installed, on the reasoning that a machine without Watch Core should still
 * get a working Workspace. The distinction it rested on — "not installed" is
 * normal, "installed and broken" is a fault — was real and correctly
 * implemented, and it still produced the wrong product: a Workspace that
 * reported itself ready, listed capabilities, and answered every request with
 * a refusal the surfaces drew as an empty result.
 *
 * The Workspace is still fully usable without an engine. What changed is that
 * it now says so. `core_missing` is a state with a name, a fix and a disabled
 * Watch surface — not a green screen with nothing behind it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-core.mjs')

/** Mount the Bridge and wait for its first connect attempt to settle. */
async function mount(config) {
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchCoreService, {
    autoConnect: false,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    ...config,
  })
  const result = await ctx.watchCore.connect()
  return { ctx, fiber, result }
}

describe('a machine without Watch Core', () => {
  test('is reported as missing, and the Workspace stays usable', async () => {
    const { ctx, fiber, result } = await mount({
      transport: 'auto',
      command: 'watch-core-definitely-not-installed-4182',
      args: ['bridge'],
    })
    try {
      assert.equal(result.ok, false, 'an absent engine is not a successful connection')

      const health = ctx.watchCore.health()
      assert.equal(health.phase, 'failed')
      assert.equal(health.blocker, 'core_missing', 'the UI branches on this, not on prose')
      assert.notEqual(health.transport, 'mock', 'auto must never reach the mock')
      assert.equal(health.isTestOnlyMock, false)
      assert.equal(
        health.error.error,
        'bridge.core_not_installed',
        'the reason must survive, or the UI cannot say what to install',
      )
      assert.match(health.error.fix, /pip install watch-skill/)
    } finally {
      await fiber.dispose()
    }
  })

  test('claims no capability at all, having spoken to nothing', async () => {
    // Stronger than the old assertion, which accepted a list of capabilities
    // all reporting `not_tested`. A list is something a screen can render, and
    // a screen rendering nine greyed-out rows for an engine that was never
    // contacted is still a screen describing an engine.
    const { ctx, fiber } = await mount({
      transport: 'auto',
      command: 'watch-core-definitely-not-installed-4182',
      args: ['bridge'],
    })
    try {
      assert.deepEqual([...ctx.watchCore.capabilities()], [])
      assert.equal(ctx.watchCore.health().handshake, null, 'no handshake, no version to show')
      assert.equal(ctx.watchCore.health().lastHandshakeAt, null)
    } finally {
      await fiber.dispose()
    }
  })
})

describe('a Watch Core that is present but broken', () => {
  /** Write a script that starts, then dies without speaking the protocol. */
  function brokenCore() {
    const dir = mkdtempSync(join(tmpdir(), 'watch-broken-'))
    const script = join(dir, 'broken.mjs')
    writeFileSync(script, "process.stderr.write('boom\\n'); process.exit(2);\n")
    return script
  }

  test('is reported as a fault, never hidden behind the mock', async () => {
    // This is the case the whole distinction exists for. Falling back here
    // would leave someone with an installed engine, a green Workspace, and no
    // indication that nothing they ask will ever be answered.
    const { ctx, fiber, result } = await mount({
      transport: 'auto',
      command: process.execPath,
      args: [brokenCore()],
    })
    try {
      assert.equal(result.ok, false)
      const health = ctx.watchCore.health()
      assert.equal(health.phase, 'failed')
      assert.notEqual(
        health.transport,
        'mock',
        'a broken engine must not be replaced by a mock that answers nothing',
      )
      assert.notEqual(health.error.error, 'bridge.core_not_installed')
    } finally {
      await fiber.dispose()
    }
  })
})

describe('a machine with Watch Core', () => {
  test('auto reaches the real engine and says so', async () => {
    const { ctx, fiber, result } = await mount({
      transport: 'auto',
      command: process.execPath,
      args: [FIXTURE],
    })
    try {
      assert.equal(result.ok, true, JSON.stringify(result.error ?? {}))
      const health = ctx.watchCore.health()
      assert.equal(health.transport, 'stdio')
      assert.equal(health.phase, 'ready')
    } finally {
      await fiber.dispose()
    }
  })
})

describe('a pinned choice', () => {
  test('mock never attempts to start an engine', async () => {
    const { ctx, fiber } = await mount({
      transport: 'mock',
      command: 'watch-core-definitely-not-installed-4182',
    })
    try {
      assert.equal(ctx.watchCore.health().transport, 'mock')
      assert.equal(ctx.watchCore.health().error, null, 'a pinned mock is a choice, not a problem')
    } finally {
      await fiber.dispose()
    }
  })

  test('stdio never falls back, so a deployment that requires the engine fails loudly', async () => {
    const { ctx, fiber, result } = await mount({
      transport: 'stdio',
      command: 'watch-core-definitely-not-installed-4182',
      args: ['bridge'],
    })
    try {
      assert.equal(result.ok, false)
      assert.equal(ctx.watchCore.health().phase, 'failed')
      assert.notEqual(ctx.watchCore.health().transport, 'mock')
    } finally {
      await fiber.dispose()
    }
  })
})
