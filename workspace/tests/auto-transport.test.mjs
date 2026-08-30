/**
 * The `auto` transport, and the distinction it rests on.
 *
 * An automatic default is only acceptable if it can tell "Watch Core is not on
 * this machine" from "Watch Core is here and would not start". The first is a
 * normal state that deserves a working Workspace and an install prompt; the
 * second is a fault that must be reported. A fallback that cannot tell them
 * apart hides broken engines behind a mock that answers nothing — which is
 * strictly worse than not falling back at all.
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
  test('gets a working Workspace and is told what to install', async () => {
    const { ctx, fiber } = await mount({
      transport: 'auto',
      command: 'watch-core-definitely-not-installed-4182',
      args: ['bridge'],
    })
    try {
      const health = ctx.watchCore.health()
      assert.equal(health.phase, 'ready', 'the Workspace must remain usable')
      assert.equal(health.transport, 'mock')
      assert.equal(
        health.error.error,
        'bridge.core_not_installed',
        'the reason must survive the fallback, or the UI cannot say what to install',
      )
      assert.match(health.error.fix, /pip install watch-skill/)
    } finally {
      await fiber.dispose()
    }
  })

  test('still refuses every capability, because nothing was tested', async () => {
    const { ctx, fiber } = await mount({
      transport: 'auto',
      command: 'watch-core-definitely-not-installed-4182',
      args: ['bridge'],
    })
    try {
      const capabilities = ctx.watchCore.capabilities()
      assert.ok(capabilities.length > 0)
      for (const capability of capabilities) {
        assert.equal(capability.status, 'not_tested')
        assert.equal(ctx.watchCore.isCapable(capability.capabilityId), false)
      }
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
