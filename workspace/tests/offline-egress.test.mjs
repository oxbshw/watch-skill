/**
 * Zero non-loopback egress, proven at the process boundary.
 *
 * A release blocker in the governing spec (§22.4): an offline run that records
 * non-loopback egress means there is no release. §39.5 asks the same thing of
 * Foundation Complete, and adds the half people forget — media cloud upload is
 * a *separate* consent from holding a provider key.
 *
 * The instrument is `fixtures/egress-sentinel.cjs`, installed with
 * `node --require` so it is in place before the first line of product code is
 * evaluated. It patches `net.Socket.connect`, `net.connect`, `tls.connect` and
 * every `dns` resolver, plus `http`/`https`/`fetch` above them. In Node every
 * outbound path ends at one of those, so there is nothing inside the process
 * left to route around it — which is the difference between this and stubbing
 * `fetch`, where a module reaching for `undici` or a raw socket sails past.
 *
 * The suite has two arms, and the second is what makes the first mean
 * anything:
 *
 * - the **offline arm** exercises every route the spec names — providers,
 *   perception, Core, telemetry, plugin and update checks, memory retrieval,
 *   OCR and cloud routes, adapters — and must record nothing;
 * - the **self-test arm** attempts one real external connection and must be
 *   caught. A silent sentinel is indistinguishable from an absent one.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SENTINEL = join(HERE, 'fixtures', 'egress-sentinel.cjs')
const EXERCISE = join(HERE, 'fixtures', 'offline-exercise.mjs')

/** Run one script under the sentinel and report everything it did. */
function underSentinel(script, extraEnv = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'watch-egress-'))
  const log = join(logDir, 'violations.jsonl')
  try {
    const result = spawnSync(process.execPath, ['--require', SENTINEL, script], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        ...process.env,
        WATCH_EGRESS_LOG: log,
        // The policy the whole run is conducted under.
        WATCH_OFFLINE_ONLY: '1',
        ...extraEnv,
      },
    })
    const violations = existsSync(log)
      ? readFileSync(log, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line))
      : []
    return { ...result, violations }
  } finally {
    rmSync(logDir, { recursive: true, force: true, maxRetries: 5 })
  }
}

describe('the sentinel is real', () => {
  test('an external connection attempt is caught and kills the process', () => {
    // If this ever passes silently, every other result in this file is worth
    // nothing. It is the control, and it runs first for that reason.
    const result = underSentinel(EXERCISE, { WATCH_EGRESS_SELFTEST: '1' })

    assert.equal(result.status, 97,
      'the self-test connected to example.com and the sentinel did not stop it')
    assert.ok(result.violations.length >= 1, 'the violation was not recorded')
    assert.equal(result.violations[0].kind, 'tcp')
    assert.match(result.violations[0].target, /example\.com/)
    // The stack is what makes a violation actionable rather than a mystery.
    assert.notEqual(result.violations[0].stack, '')
    assert.match(result.stderr, /WATCH_EGRESS_VIOLATION/)
  })

  test('it is installed before any product code loads', () => {
    // `--require` runs before the entry module. Asserted by reading the
    // command this suite actually issues, so a refactor to an in-test import
    // fails here rather than silently weakening the proof.
    const source = readFileSync(join(HERE, 'offline-egress.test.mjs'), 'utf8')
    assert.match(source, /'--require', SENTINEL/)
  })

  test('loopback stays permitted, or the product could not work at all', () => {
    const sentinel = readFileSync(SENTINEL, 'utf8')
    for (const host of ['127.0.0.1', '::1', 'localhost']) {
      assert.ok(sentinel.includes(host), `${host} is not treated as loopback`)
    }
    // The whole 127/8 block, not one address.
    assert.match(sentinel, /\^127\\\./)
  })
})

describe('offline_only means zero non-loopback egress', () => {
  const result = underSentinel(EXERCISE)

  test('every exercised route completed', () => {
    if (result.status !== 0) {
      assert.fail(
        `the offline exercise exited ${String(result.status)}\n`
        + `${result.stdout}\n${result.stderr}`,
      )
    }
    const line = result.stdout.split('\n').find(entry => entry.startsWith('WATCH_OFFLINE_STEPS '))
    assert.notEqual(line, undefined, 'the exercise produced no step report')
    const steps = JSON.parse(line.slice('WATCH_OFFLINE_STEPS '.length))
    const failed = steps.filter(entry => !entry.ok)
    assert.deepEqual(failed, [], 'a route failed to run, so it proved nothing')
    // A run that exercised two things and found no egress is not a proof.
    assert.ok(steps.length >= 10, `only ${String(steps.length)} routes were exercised`)
  })

  test('nothing left the machine', () => {
    assert.deepEqual(result.violations, [],
      `non-loopback egress was attempted:\n${JSON.stringify(result.violations, null, 2)}`)
  })

  test('the sentinel reported, rather than having failed to load', () => {
    assert.match(result.stderr, /WATCH_EGRESS_SUMMARY/)
    assert.match(result.stderr, /"violations":0/)
  })

  test('the spec’s named routes are all in the exercise', () => {
    const source = readFileSync(EXERCISE, 'utf8')
    for (const route of [
      'routeOcr',            // OCR and cloud routes
      'watchMemory.compile', // memory retrieval and reranking
      'searchPlan',          // library / embeddings path
      'checkUpdate',         // update checks
      'detectCapabilities',  // engine and provider discovery
      'toVault',             // hosted adapters
      'MockTransport',       // Watch Core transport
      'gen-sbom',            // release tooling
    ]) {
      assert.ok(source.includes(route), `the exercise never touches ${route}`)
    }
  })
})

describe('media egress is a separate consent from a provider key', () => {
  test('holding a key does not permit media to leave', async () => {
    // §39.5 point 7, and §26 decision 11: "configured API key لا تعني media
    // upload consent." Two independent flags, and the agent may flip neither.
    const { defaultComposer, proposeChange } = await import('@watchskill/dsh-workspace')
    const withNetwork = {
      ...defaultComposer(),
      privacy: { offlineOnly: false, localMediaOnly: true, egressRoutes: ['api.example.com'] },
    }
    // Network is permitted. Media is still local-only, and an agent cannot
    // change that.
    assert.equal(withNetwork.privacy.localMediaOnly, true)
    const decision = proposeChange(withNetwork, {
      privacy: { ...withNetwork.privacy, localMediaOnly: false },
    }, 'agent')
    assert.equal(decision.ok, false)
    assert.ok(decision.refusals.some(refusal => refusal.axis === 'cloud_media'))
  })

  test('a cloud engine needs its own consent even with the network open', async () => {
    const technology = await import('@watchskill/dsh-technology')
    const health = new Map(
      technology.OCR_ENGINES.map(engine => [engine.id, { usable: true, state: 'ready' }]))
    const decision = technology.routeOcr(
      { workload: 'document', scripts: ['Latin'], quality: 'best', hasGpu: false, offlineOnly: false, egressConsent: false },
      technology.OCR_ENGINES, [], health,
    )
    assert.notEqual(decision.engineId, 'ocr.cloud')
    assert.ok(decision.excluded.some(
      entry => entry.engineId === 'ocr.cloud' && /consent/.test(entry.reason)))
  })
})
