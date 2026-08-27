/**
 * The Bridge against the real Watch Core, not a fixture.
 *
 * Everything else in this suite proves the Node half is well-behaved. This
 * file proves the two halves actually meet: that a Harness plugin, speaking
 * the protocol as written, gets a usable handshake out of the Python engine
 * and is told the truth about what that engine can do here.
 *
 * It skips rather than fails when Watch Core is absent. The engine is an
 * optional dependency of the Workspace by design — that is the whole point of
 * the mock backend — so its absence is a fact about the machine, not a
 * regression. Point WATCH_CORE_COMMAND at an interpreter or the `watch-skill`
 * executable to run it.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@watchskill/dsh-core-bridge'
import { detectSchemaDrift } from '@watchskill/dsh-contracts'

/**
 * Resolve how to start Watch Core, or report that it is not installed.
 *
 * Checked by actually running it: a `watch-skill` on PATH that cannot import
 * its own package would otherwise turn a skip into a confusing failure later.
 */
function resolveCore() {
  const explicit = process.env['WATCH_CORE_COMMAND']
  if (explicit !== undefined && explicit !== '') {
    const args = (process.env['WATCH_CORE_ARGS'] ?? 'bridge').split(' ').filter(Boolean)
    return { command: explicit, args }
  }
  for (const candidate of [
    { command: 'watch-skill', args: ['bridge'] },
    { command: 'python', args: ['-m', 'watch_skill.surfaces.cli.main', 'bridge'] },
  ]) {
    try {
      // Short: this runs on every `npm test`, and the answer to "is the
      // engine here" should not cost a minute when the answer is no.
      execFileSync(candidate.command, [...candidate.args.slice(0, -1), '--help'], {
        stdio: 'ignore',
        timeout: 20_000,
        shell: process.platform === 'win32',
      })
      return candidate
    } catch {
      continue
    }
  }
  return null
}

const CORE = resolveCore()
const skip = CORE === null
  ? 'Watch Core is not installed; set WATCH_CORE_COMMAND to run this suite'
  : false

describe('the Bridge against a real Watch Core', { skip }, () => {
  let ctx
  let fiber
  let handshake

  before(async () => {
    ctx = new Context()
    fiber = await ctx.plugin(WatchCoreService, {
      transport: 'stdio',
      command: CORE.command,
      args: CORE.args,
      autoConnect: false,
      // The engine imports a large dependency tree on first start.
      startupTimeoutMs: 120_000,
      requestTimeoutMs: 120_000,
    })
    handshake = await ctx.watchCore.connect()
  })

  test('connects and negotiates a protocol both sides speak', () => {
    assert.equal(handshake.ok, true, JSON.stringify(handshake.error ?? {}, null, 2))
    assert.equal(ctx.watchCore.health().phase, 'ready')
    assert.equal(ctx.watchCore.health().transport, 'stdio')
    assert.equal(handshake.value.protocolVersion, 1)
    assert.match(handshake.value.coreVersion, /^\d+\.\d+/)
  })

  test('the installed engine publishes the contract this build was written against', () => {
    // The check that keeps ADR-004 honest. The engine's Pydantic models are
    // the source of truth and these types are a face over them; if that face
    // ever stops matching, this fails here rather than as an undefined field
    // in someone's session.
    const drift = detectSchemaDrift(handshake.value.schemaDigests)
    assert.deepEqual(
      drift,
      [],
      'contract drift: regenerate schemas/bridge/manifest.json in watch-skill '
      + 'and update EXPECTED_SCHEMA_DIGESTS',
    )
    assert.equal(
      ctx.watchCore.health().error,
      null,
      'a matching contract must leave no warning behind',
    )
  })

  test('reports how it knows each capability, not just whether it has one', () => {
    const statuses = new Set(['machine_tested', 'probed', 'implemented', 'unavailable', 'not_tested'])
    assert.ok(handshake.value.capabilities.length > 0)
    for (const capability of handshake.value.capabilities) {
      assert.ok(statuses.has(capability.status), `${capability.capabilityId}: ${capability.status}`)
      if (capability.status === 'unavailable') {
        assert.ok(capability.missing.length > 0, `${capability.capabilityId} must say what is missing`)
        assert.ok(capability.fixes.length > 0, `${capability.capabilityId} must state a fix`)
      }
      assert.ok(capability.lastCheckedAt, 'a status with no timestamp is not truth, it is a guess')
    }
  })

  test('only a capability the engine actually exercised is offered as usable', () => {
    for (const capability of handshake.value.capabilities) {
      const usable = ctx.watchCore.isCapable(capability.capabilityId)
      if (capability.status === 'probed' || capability.status === 'unavailable') {
        assert.equal(
          usable,
          false,
          `${capability.capabilityId} is ${capability.status} and must not be offered`,
        )
      }
    }
  })

  test('reports the egress policy actually in force', () => {
    const policy = handshake.value.policy
    assert.equal(typeof policy.offlineOnly, 'boolean')
    assert.equal(typeof policy.cloudPerceptionOptIn, 'boolean')
    if (policy.offlineOnly) {
      assert.equal(
        policy.cloudPerceptionOptIn,
        false,
        'offline mode must not report cloud perception as available',
      )
    }
  })

  test('the library answers on an empty index instead of erroring', async () => {
    const result = await ctx.watchCore.request('watch.library.list', { limit: 5 })
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}))
    assert.ok(Array.isArray(result.value.sources))
    assert.equal(typeof result.value.total, 'number')
  })

  test('a prose expectation is UNVERIFIED, not a pass and not a failure', async () => {
    const result = await ctx.watchCore.request('watch.verification.run', {
      expectation: 'the deploy worked',
      verificationId: 'ver_integration',
    })
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}))
    assert.equal(result.value.verdict, 'UNVERIFIED')
    assert.ok(result.value.reason.length > 0)
  })

  test('a real deterministic contract returns a verdict and a frozen digest', async () => {
    // The contract checks a file this repository certainly has, so the
    // assertion is about the verdict path rather than about the filesystem.
    const result = await ctx.watchCore.request('watch.verification.run', {
      expectation: 'the workspace manifest exists',
      workingDir: process.cwd(),
      checks: [{
        id: 'manifest',
        type: 'file_exists',
        required: true,
        params: { path: 'package.json' },
      }],
    })
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}))
    assert.equal(result.value.verdict, 'VERIFIED')
    assert.ok(
      result.value.contractDigest.length > 0,
      'a verdict without a frozen contract digest cannot be audited',
    )
    assert.equal(result.value.checks[0].passed, true)
  })

  test('a missing required check is FAILED, and names what failed', async () => {
    const result = await ctx.watchCore.request('watch.verification.run', {
      expectation: 'a file that is not there exists',
      workingDir: process.cwd(),
      checks: [{
        id: 'absent',
        type: 'file_exists',
        required: true,
        params: { path: 'this-file-does-not-exist-4182.txt' },
      }],
    })
    assert.equal(result.ok, true, JSON.stringify(result.error ?? {}))
    assert.equal(result.value.verdict, 'FAILED')
    assert.match(result.value.reason, /absent/)
  })

  test('an unknown method is refused with the fix, not a crash', async () => {
    const result = await ctx.watchCore.request('watch.does.not.exist', {})
    assert.equal(result.ok, false)
    assert.equal(result.error.error, 'bridge.method_not_found')
    assert.ok(result.error.fix.length > 0)
    // The engine must still be usable afterwards.
    assert.equal(ctx.watchCore.health().phase, 'ready')
  })

  test('a query for a source that is not indexed refuses with a fix', async () => {
    const result = await ctx.watchCore.request('watch.source.ask', {
      question: 'what is on screen',
    })
    assert.equal(result.ok, false)
    assert.equal(result.error.error, 'bridge.invalid_params')
    assert.ok(result.error.fix.length > 0)
  })

  test('shutting down leaves no Watch Core process behind', async () => {
    await fiber.dispose()
    assert.equal(ctx.watchCore, undefined)
  })
})

// Surfaced deliberately: a silent skip in CI reads as a pass.
if (skip !== false && existsSync(new URL('../package.json', import.meta.url))) {
  process.stdout.write(`\n# core-integration skipped: ${skip}\n`)
}
