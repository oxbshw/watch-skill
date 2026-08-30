/**
 * Contract drift between the Workspace and Watch Core.
 *
 * ADR-004 makes the engine's Pydantic models the source of truth and these
 * TypeScript types a face over them. The failure that arrangement invites is
 * quiet: the engine renames a field, the Workspace keeps compiling, and the
 * mismatch first appears as an `undefined` in production.
 *
 * The digests exist to make that loud at connect time. These tests guard the
 * three ways the check could stop meaning anything: treating silence as
 * agreement, taking a whole engine offline for one changed family, or
 * refusing to talk to an engine that predates the check.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'
import {
  EXPECTED_SCHEMA_DIGESTS,
  FAMILY_CAPABILITIES,
  detectSchemaDrift,
  isContractUnverified,
} from '@deepwatch/dsh-contracts'

describe('drift detection', () => {
  test('a matching contract produces no drift', () => {
    assert.deepEqual(detectSchemaDrift({ ...EXPECTED_SCHEMA_DIGESTS }), [])
  })

  test('a changed family is reported with both sides named', () => {
    const drift = detectSchemaDrift({
      ...EXPECTED_SCHEMA_DIGESTS,
      verification: 'sha256:something-else',
    })
    assert.equal(drift.length, 1)
    assert.equal(drift[0].family, 'verification')
    assert.equal(drift[0].expected, EXPECTED_SCHEMA_DIGESTS.verification)
    assert.equal(drift[0].actual, 'sha256:something-else')
    assert.ok(drift[0].affects.includes('watch.verification.run'))
  })

  test('a family the engine stopped publishing counts as drift', () => {
    // Treating silence as agreement is how this check would come to mean
    // nothing: an engine that publishes no digest is exactly as unverifiable
    // as one publishing a different value.
    const partial = { ...EXPECTED_SCHEMA_DIGESTS }
    delete partial.evidence
    const drift = detectSchemaDrift(partial)
    assert.equal(drift.length, 1)
    assert.equal(drift[0].family, 'evidence')
    assert.equal(drift[0].actual, null)
  })

  test('drift is scoped: one changed family does not implicate the rest', () => {
    const drift = detectSchemaDrift({ ...EXPECTED_SCHEMA_DIGESTS, library: 'sha256:changed' })
    const affected = new Set(drift.flatMap(entry => entry.affects))
    assert.ok(affected.has('watch.library.search'))
    assert.ok(
      !affected.has('watch.verification.run'),
      'a changed library schema must not take verification offline',
    )
  })

  test('every family maps to the capabilities it is load-bearing for', () => {
    for (const family of Object.keys(EXPECTED_SCHEMA_DIGESTS)) {
      assert.ok(
        Array.isArray(FAMILY_CAPABILITIES[family]),
        `${family} needs a capability mapping or drift cannot be scoped`,
      )
    }
  })
})

describe('an engine older than the check', () => {
  test('publishing nothing is unverified, not mismatched', () => {
    assert.equal(isContractUnverified({}), true)
    assert.equal(isContractUnverified({ ...EXPECTED_SCHEMA_DIGESTS }), false)
  })

  test('an empty map still produces drift entries, which the Bridge reads as unverified', () => {
    // detectSchemaDrift alone cannot tell "old engine" from "wrong engine";
    // that judgement belongs to the Bridge, which asks isContractUnverified
    // first. This asserts the split rather than papering over it.
    assert.equal(detectSchemaDrift({}).length, Object.keys(EXPECTED_SCHEMA_DIGESTS).length)
  })
})

describe('the Bridge acting on drift', () => {
  /** A transport that answers the handshake with the digests under test. */
  function driftingTransport(schemaDigests) {
    return {
      kind: 'mock',
      connect: () => Promise.resolve({ ok: true, value: undefined }),
      send: () => Promise.resolve({
        ok: true,
        value: {
          coreVersion: '1.3.0rc2',
          coreBuild: null,
          protocolVersion: 1,
          capabilities: [{
            capabilityId: 'watch.verification.run',
            provider: 'watch-core',
            providerVersion: '1.3.0rc2',
            status: 'implemented',
            requirements: [],
            detected: {},
            missing: [],
            fixes: [],
            lastCheckedAt: new Date(0).toISOString(),
          }],
          schemaDigests,
          policy: {
            offlineOnly: true,
            cloudPerceptionOptIn: false,
            memoryMode: 'off',
            defaultRetentionClass: 'workspace',
          },
          limits: { maxRequestBytes: 1024, maxInFlight: 1, defaultDeadlineMs: 1000 },
        },
      }),
      subscribe: () => () => {},
      onFailure: () => () => {},
      dispose: () => Promise.resolve(),
    }
  }

  /** Mount the Bridge with its transport factory replaced. */
  async function mountWith(schemaDigests) {
    const ctx = new Context()
    const fiber = await ctx.plugin(WatchCoreService, { transport: 'mock', autoConnect: false })
    // Reaching past the config is deliberate: the drift path is what is under
    // test, and standing up a whole second engine to reach it would test the
    // engine instead.
    ctx.watchCore.createTransport = () => driftingTransport(schemaDigests)
    return { ctx, fiber }
  }

  test('a drifted capability is refused even though the engine offers it', async () => {
    const { ctx, fiber } = await mountWith({
      ...EXPECTED_SCHEMA_DIGESTS,
      verification: 'sha256:changed',
    })
    try {
      await ctx.watchCore.connect()
      assert.equal(ctx.watchCore.health().phase, 'degraded')
      assert.equal(ctx.watchCore.health().error.error, 'bridge.schema_drift')
      assert.equal(
        ctx.watchCore.isCapable('watch.verification.run'),
        false,
        'a capability whose contract drifted must not be offered',
      )
    } finally {
      await fiber.dispose()
    }
  })

  test('a matching contract stays ready with no error', async () => {
    const { ctx, fiber } = await mountWith({ ...EXPECTED_SCHEMA_DIGESTS })
    try {
      await ctx.watchCore.connect()
      assert.equal(ctx.watchCore.health().phase, 'ready')
      assert.equal(ctx.watchCore.health().error, null)
      assert.equal(ctx.watchCore.isCapable('watch.verification.run'), true)
    } finally {
      await fiber.dispose()
    }
  })

  test('an engine that predates the check still works, and says it is unchecked', async () => {
    const { ctx, fiber } = await mountWith({})
    try {
      await ctx.watchCore.connect()
      // Ready, not degraded: refusing to talk to it would break a working
      // setup to enforce a check that version predates.
      assert.equal(ctx.watchCore.health().phase, 'ready')
      assert.equal(ctx.watchCore.health().error.error, 'bridge.contract_unverified')
      assert.equal(ctx.watchCore.isCapable('watch.verification.run'), true)
    } finally {
      await fiber.dispose()
    }
  })
})
