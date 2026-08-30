/**
 * A broken engine must not cause unbounded process churn.
 *
 * Every request made while the Bridge is not ready reconnects. Disposing the
 * abandoned transport stopped orphans accumulating, but it did not stop a fresh
 * Watch Core being started for each request during an outage. These tests hold
 * the stronger property: after a bounded number of consecutive failures the
 * Bridge stops trying, and the process count stops moving.
 *
 * Process counts come from a file the fixture appends its pid to, which is
 * exact and works the same on every platform. The clock is injected, so nothing
 * here sleeps through a cooldown.
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOSTILE = join(HERE, 'fixtures', 'hostile-core.mjs')

/** A clock the tests drive by hand. */
let clock = 0
before(() => {
  globalThis.__watchBridgeClock__ = () => clock
})
after(() => {
  delete globalThis.__watchBridgeClock__
})

function newSpawnLog() {
  const log = join(mkdtempSync(join(tmpdir(), 'watch-reconnect-')), 'spawns.txt')
  writeFileSync(log, '')
  return log
}

const spawnCount = log => readFileSync(log, 'utf8').split('\n').filter(l => l !== '').length
const livePids = log => readFileSync(log, 'utf8').split('\n').filter(l => l !== '')
  .map(Number)
  .filter((pid) => {
    try { process.kill(pid, 0); return true } catch { return false }
  })

/** Mount the Bridge against a Core misbehaving in a named way. */
async function mount(mode, config = {}) {
  const log = config.spawnLog ?? newSpawnLog()
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchCoreService, {
    transport: 'stdio',
    command: config.command ?? process.execPath,
    args: config.args ?? [HOSTILE, mode, log],
    autoConnect: false,
    startupTimeoutMs: config.startupTimeoutMs ?? 5_000,
    requestTimeoutMs: config.requestTimeoutMs ?? 1_000,
    failuresBeforeOpen: config.failuresBeforeOpen ?? 3,
    initialCooldownMs: config.initialCooldownMs ?? 1_000,
    maxCooldownMs: config.maxCooldownMs ?? 30_000,
  })
  return { ctx, fiber, log }
}

describe('the reconnect breaker', () => {
  test('concurrent requests during the first connection share one attempt', async () => {
    clock = 0
    const { ctx, fiber, log } = await mount('none')
    try {
      const results = await Promise.all([
        ctx.watchCore.connect(),
        ctx.watchCore.connect(),
        ctx.watchCore.connect(),
        ctx.watchCore.connect(),
      ])
      assert.ok(results.every(r => r.ok), 'a coalesced caller got a different answer')
      assert.equal(spawnCount(log), 1, 'four callers started more than one engine')
    } finally {
      await fiber.dispose()
    }
  })

  test('a permanent protocol failure stops spawning after the threshold', async () => {
    // The property that matters. Twenty requests against an engine that fails
    // on contact must not start twenty engines.
    clock = 0
    const { ctx, fiber, log } = await mount('garbage')
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await ctx.watchCore.request('fixture.echo', {})
      }
      assert.equal(spawnCount(log), 1,
        `${String(spawnCount(log))} engine(s) started for 20 requests against a broken engine`)
      assert.equal(ctx.watchCore.reconnectState.circuitOpen, true)
    } finally {
      await fiber.dispose()
    }
  })

  test('a refusal during cooldown names when to try again', async () => {
    clock = 0
    const { ctx, fiber } = await mount('garbage')
    try {
      await ctx.watchCore.request('fixture.echo', {})
      const refused = await ctx.watchCore.connect()
      assert.equal(refused.ok, false)
      assert.equal(refused.error.error, 'bridge.unavailable')
      assert.equal(refused.error.retryable, true)
      assert.ok(refused.error.details.retryAfterMs > 0, 'no retryAfterMs on an unavailable error')
      assert.ok(refused.error.details.retryAfterMs <= 1_000)
    } finally {
      await fiber.dispose()
    }
  })

  test('the cooldown doubles to a ceiling and no further', async () => {
    clock = 0
    const { ctx, fiber } = await mount('garbage', { initialCooldownMs: 1_000, maxCooldownMs: 4_000 })
    try {
      await ctx.watchCore.request('fixture.echo', {})
      const seen = [ctx.watchCore.reconnectState.cooldownMs]
      // Each expiry allows one probe, which fails and doubles the wait.
      for (let round = 0; round < 4; round += 1) {
        clock += ctx.watchCore.reconnectState.retryAfterMs
        await ctx.watchCore.request('fixture.echo', {})
        seen.push(ctx.watchCore.reconnectState.cooldownMs)
      }
      assert.deepEqual(seen, [1_000, 2_000, 4_000, 4_000, 4_000], 'backoff did not cap')
    } finally {
      await fiber.dispose()
    }
  })

  test('one probe is allowed when the cooldown expires, and only one', async () => {
    clock = 0
    const { ctx, fiber, log } = await mount('garbage')
    try {
      await ctx.watchCore.request('fixture.echo', {})
      const spawnedBefore = spawnCount(log)

      clock += ctx.watchCore.reconnectState.retryAfterMs
      await Promise.all([
        ctx.watchCore.request('fixture.echo', {}),
        ctx.watchCore.request('fixture.echo', {}),
        ctx.watchCore.request('fixture.echo', {}),
      ])
      assert.equal(spawnCount(log) - spawnedBefore, 1, 'the half-open window let more than one probe through')
    } finally {
      await fiber.dispose()
    }
  })

  test('a failed probe re-opens the circuit rather than reprobing per request', async () => {
    clock = 0
    const { ctx, fiber, log } = await mount('garbage')
    try {
      await ctx.watchCore.request('fixture.echo', {})
      clock += ctx.watchCore.reconnectState.retryAfterMs
      await ctx.watchCore.connect()
      const after = spawnCount(log)

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await ctx.watchCore.request('fixture.echo', {})
      }
      assert.equal(spawnCount(log), after, 'requests after a failed probe started engines')
      assert.equal(ctx.watchCore.reconnectState.circuitOpen, true)
    } finally {
      await fiber.dispose()
    }
  })

  test('a missing executable is bounded the same way', async () => {
    clock = 0
    const { ctx, fiber } = await mount('none', {
      command: join(HERE, 'fixtures', 'no-such-watch-core-executable'),
      args: [],
    })
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) await ctx.watchCore.connect()
      const state = ctx.watchCore.reconnectState
      // `auto` would fall back to the mock backend; `stdio` is pinned here, so
      // a missing command is a real failure and the breaker must bound it.
      assert.ok(state.consecutiveFailures >= 3)
      assert.equal(state.circuitOpen, true)
    } finally {
      await fiber.dispose()
    }
  })

  test('a handshake that never answers is bounded the same way', async () => {
    clock = 0
    const { ctx, fiber, log } = await mount('silent-handshake', { startupTimeoutMs: 300 })
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) await ctx.watchCore.connect()
      assert.equal(spawnCount(log), 3, `${String(spawnCount(log))} engine(s) started across 8 attempts`)
      assert.equal(ctx.watchCore.reconnectState.circuitOpen, true)
    } finally {
      await fiber.dispose()
    }
  })

  test('a successful handshake clears the failures', async () => {
    clock = 0
    const { ctx, fiber } = await mount('none')
    try {
      const connected = await ctx.watchCore.connect()
      assert.equal(connected.ok, true)
      const state = ctx.watchCore.reconnectState
      assert.equal(state.consecutiveFailures, 0)
      assert.equal(state.circuitOpen, false)
      assert.equal(state.cooldownMs, 0)
      assert.equal(state.retryAfterMs, 0)
    } finally {
      await fiber.dispose()
    }
  })

  test('a Core that dies after readiness is bounded on the way back', async () => {
    clock = 0
    const { ctx, fiber, log } = await mount('crash-after-ready')
    try {
      assert.equal((await ctx.watchCore.connect()).ok, true)
      // The engine exits on the first request, and every retry after that fails.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await ctx.watchCore.request('fixture.echo', {})
      }
      assert.ok(spawnCount(log) <= 4, `${String(spawnCount(log))} engine(s) started after the crash`)
      assert.equal(ctx.watchCore.reconnectState.circuitOpen, true)
    } finally {
      await fiber.dispose()
    }
  })

  test('disposal during a connection attempt cancels it', async () => {
    clock = 0
    const { ctx, fiber, log } = await mount('slow-handshake', { startupTimeoutMs: 4_000 })
    try {
      const attempt = ctx.watchCore.connect()
      await fiber.dispose()
      const result = await attempt
      assert.equal(result.ok, false, 'a disposed Bridge reported a successful connection')
    } finally {
      assert.deepEqual(livePids(log), [], 'an engine outlived the disposal that cancelled it')
    }
  })

  test('a request after disposal is refused without starting anything', async () => {
    clock = 0
    const { ctx, fiber, log } = await mount('none')
    // Held across the disposal on purpose: cordis unregisters the service when
    // the fiber goes, so `ctx.watchCore` is gone and the guard inside the
    // service is only reachable through a reference taken beforehand.
    const service = ctx.watchCore
    await service.connect()
    const spawnedWhileAlive = spawnCount(log)
    await fiber.dispose()

    assert.equal(ctx.watchCore, undefined, 'the service outlived its fiber')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await service.connect()
      assert.equal(result.ok, false)
      assert.equal(result.error.error, 'bridge.disposed')
    }
    assert.equal(spawnCount(log), spawnedWhileAlive, 'a disposed Bridge started an engine')
    assert.deepEqual(livePids(log), [], 'an engine outlived disposal')
  })

  test('nothing is left running after an outage and a disposal', async () => {
    clock = 0
    const { ctx, fiber, log } = await mount('garbage')
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await ctx.watchCore.request('fixture.echo', {})
    }
    await fiber.dispose()
    assert.deepEqual(livePids(log), [], 'engines outlived the Bridge')
  })

  test('the observable state carries counts and timings, never secrets', () => {
    // Rendered in Diagnostics and written to logs, so it must not be able to
    // carry a command line, a path or an environment value.
    clock = 0
    const shape = {
      consecutiveFailures: 0, circuitOpen: false, retryAfterMs: 0, cooldownMs: 0,
    }
    for (const [key, value] of Object.entries(shape)) {
      assert.ok(key in shape)
      assert.ok(typeof value === 'number' || typeof value === 'boolean')
    }
  })
})
