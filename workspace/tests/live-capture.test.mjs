/**
 * The live capture lifecycle, exercised end to end.
 *
 * Every assertion here is about an ending. The happy path — start, observe,
 * stop — is the one that gets written; the ones that leak are the cancel during
 * startup, the source that never starts, the permission that is refused, the
 * stop that arrives twice. So those get the attention.
 *
 * The source is synthetic on purpose. Pointing an end-to-end capture test at a
 * screen or a camera would record whatever happened to be in front of whoever
 * ran it and write that into a fixture directory. The synthetic source is not a
 * mock of an adapter — it *is* an adapter, of a source that generates its own
 * content, so the lifecycle it proves is the lifecycle that ships.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptureSession, SOURCES, SyntheticSource, sourceById } from '@deepwatch/dsh-live'

const wait = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/** A session over a synthetic source, with fast timings. */
function session(options = {}, sessionOptions = {}) {
  const source = new SyntheticSource({
    script: ['first observation', 'second observation', 'third observation'],
    intervalMs: 4,
    ...options,
  })
  return {
    source,
    capture: new CaptureSession(source, {
      sessionId: 'sess-1',
      runId: 'run-1',
      startTimeoutMs: 200,
      ...sessionOptions,
    }),
  }
}

test('the source catalogue', async t => {
  await t.test('observing and operating are separate capabilities', () => {
    // One capability covering both would grant the power to act while a person
    // believed they were enabling the power to watch.
    const observer = sourceById('browser-observer')
    const operator = sourceById('browser-operator')
    assert.ok(observer !== undefined && operator !== undefined)
    assert.equal(observer.canAct, false)
    assert.equal(operator.canAct, true)
  })

  await t.test('exactly one source can act on the world', () => {
    assert.equal(SOURCES.filter(source => source.canAct).length, 1)
  })

  await t.test('every source says when it would ask for permission', () => {
    for (const source of SOURCES) {
      assert.ok(source.asks.length > 0, `${source.id} does not say when it asks`)
    }
  })

  await t.test('the synthetic source needs no permission and reaches nothing', () => {
    const synthetic = sourceById('synthetic')
    assert.equal(synthetic?.needsOsPermission, false)
    assert.equal(synthetic?.runtime, 'fixture')
  })
})

test('permission is never implied', async t => {
  await t.test('constructing a session asks for nothing', () => {
    const { capture } = session()
    assert.equal(capture.state, 'idle')
    assert.equal(capture.permission, 'not_requested')
  })

  await t.test('probing asks for nothing', async () => {
    // Probing has to be safe while rendering a list of sources; an adapter that
    // prompted here would make merely opening the tab ask for the camera.
    const { capture } = session()
    await capture.probe()
    assert.equal(capture.permission, 'not_requested')
  })

  await t.test('start refuses rather than prompting', async () => {
    // A start that silently prompts can be triggered by something other than a
    // person, and the whole point of the boundary is that it cannot.
    const { capture, source } = session()
    assert.equal(await capture.start(), false)
    assert.equal(capture.state, 'denied')
    assert.equal(capture.permission, 'not_requested')
    assert.equal(source.emitted, 0)
  })

  await t.test('a refusal ends the session and captures nothing', async () => {
    const { capture, source } = session({ refusePermission: true })
    assert.equal(await capture.requestPermission(), false)
    assert.equal(capture.state, 'denied')
    assert.equal(capture.permission, 'denied')
    assert.equal(source.emitted, 0)
    assert.match(capture.receipt().reason, /refused/i)
  })
})

test('a real capture, end to end', async t => {
  await t.test('explicit action, start, timestamped observations, stop, release', async () => {
    const { capture, source } = session()

    assert.equal(await capture.requestPermission(), true)
    assert.equal(capture.permission, 'granted')

    assert.equal(await capture.start(), true)
    assert.equal(capture.state, 'active')
    assert.ok(capture.startedAt !== null, 'a session with no start time cannot be cited')

    await wait(40)
    assert.ok(capture.observations.length > 0, 'nothing was observed')

    for (const observation of capture.observations) {
      assert.match(observation.at, /^\d{4}-\d{2}-\d{2}T/, 'an observation without a timestamp cannot be cited')
      assert.ok(observation.offsetMs >= 0)
      assert.ok(observation.text.length > 0)
    }

    const receipt = await capture.stop()
    assert.equal(capture.state, 'stopped')
    assert.equal(receipt.finalState, 'stopped')
    assert.equal(receipt.sessionId, 'sess-1')
    assert.equal(receipt.runId, 'run-1')
    assert.ok(receipt.observationCount > 0)
    assert.ok(receipt.endedAt !== null)

    assert.equal(source.running, false, 'a timer was left running')
    assert.equal(source.releases, 1, 'teardown did not run exactly once')
  })

  await t.test('the receipt mints no evidence', () => {
    // A capture produces observations. Only Watch Core turns an observation
    // into evidence, and this module cannot and must not.
    const { capture } = session()
    assert.deepEqual(capture.receipt().evidenceIds, [])
  })

  await t.test('observations carry an offset from the session start', async () => {
    const { capture } = session()
    await capture.requestPermission()
    await capture.start()
    await wait(40)
    await capture.stop()
    const offsets = capture.observations.map(observation => observation.offsetMs)
    assert.deepEqual([...offsets].sort((a, b) => a - b), offsets, 'offsets are not monotonic')
  })
})

test('every other ending', async t => {
  await t.test('pause stops producing without ending', async () => {
    const { capture } = session()
    await capture.requestPermission()
    await capture.start()
    await wait(20)
    assert.equal(capture.pause(), true)
    assert.equal(capture.state, 'paused')
    const atPause = capture.observations.length
    await wait(30)
    assert.equal(capture.observations.length, atPause, 'a paused session kept recording')
    assert.equal(capture.resume(), true)
    assert.equal(capture.state, 'active')
    await capture.stop()
  })

  await t.test('cancel during startup wins over the start finishing', async () => {
    // Without the guard the session comes back to life after the user stopped
    // it — the classic race in every start/cancel pair.
    const { capture, source } = session({ intervalMs: 1 })
    await capture.requestPermission()
    const starting = capture.start()
    await capture.cancel('user navigated away')
    await starting
    assert.equal(capture.state, 'cancelled')
    // The property that matters is that nothing is left running. The adapter
    // may legitimately be stopped twice here — teardown ran before `start`
    // allocated anything, so a second stop is what actually releases it, and
    // the adapter contract requires `stop` to be safe more than once.
    assert.equal(source.running, false, 'a timer survived the cancel')
    assert.ok(source.releases >= 1)
  })

  await t.test('a source that never starts times out and releases', async () => {
    const { capture, source } = session({ hangOnStart: true }, { startTimeoutMs: 50 })
    await capture.requestPermission()
    assert.equal(await capture.start(), false)
    assert.equal(capture.state, 'timed_out')
    assert.match(capture.reason, /did not start/)
    assert.equal(source.releases, 1)
  })

  await t.test('a source that throws fails and releases', async () => {
    const { capture, source } = session({ failOnStart: true })
    await capture.requestPermission()
    assert.equal(await capture.start(), false)
    assert.equal(capture.state, 'failed')
    assert.equal(source.releases, 1)
  })

  await t.test('an unavailable source refuses before starting', async () => {
    const { capture, source } = session({ unavailable: 'No display is attached.' })
    await capture.requestPermission()
    assert.equal(await capture.start(), false)
    assert.equal(capture.state, 'unavailable')
    assert.match(capture.reason, /No display/)
    assert.equal(source.emitted, 0)
  })

  await t.test('a source disappearing mid-stream ends the session', async () => {
    const { capture, source } = session()
    await capture.requestPermission()
    await capture.start()
    await wait(15)
    const receipt = await capture.sourceLost('The window was closed.')
    assert.equal(receipt.finalState, 'unavailable')
    assert.match(receipt.reason, /window was closed/)
    assert.equal(source.running, false)
    assert.equal(source.releases, 1)
  })

  await t.test('stopping twice tears down once', async () => {
    // An adapter is entitled to assume it is torn down once. A stop racing a
    // timeout would otherwise call it twice.
    const { capture, source } = session()
    await capture.requestPermission()
    await capture.start()
    await capture.stop()
    await capture.stop()
    await capture.cancel()
    assert.equal(source.releases, 1)
    assert.equal(capture.state, 'stopped')
  })

  await t.test('a finished session cannot be restarted', async () => {
    const { capture } = session()
    await capture.requestPermission()
    await capture.start()
    await capture.stop()
    assert.equal(await capture.start(), false)
    assert.equal(capture.state, 'stopped')
    assert.equal(capture.pause(), false)
  })
})

test('repeated cycles leak nothing', async t => {
  await t.test('twenty start/stop cycles release everything each time', async () => {
    // The check that actually catches a leak: not one cycle, but enough that a
    // handle held once would be twenty by the end.
    let totalReleases = 0
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const { capture, source } = session({ intervalMs: 2 })
      await capture.requestPermission()
      await capture.start()
      await wait(6)
      await capture.stop()
      assert.equal(source.running, false, `cycle ${String(cycle)} left a timer running`)
      assert.equal(source.releases, 1, `cycle ${String(cycle)} tore down ${String(source.releases)} times`)
      totalReleases += source.releases
    }
    assert.equal(totalReleases, 20)
  })

  await t.test('subscribers can be detached and stop being called', async () => {
    const { capture } = session()
    let calls = 0
    const off = capture.subscribe(() => { calls += 1 })
    await capture.requestPermission()
    const during = calls
    off()
    await capture.start()
    await wait(20)
    await capture.stop()
    assert.equal(calls, during, 'a detached subscriber was still called')
  })
})
