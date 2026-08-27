/**
 * Live: being honest about time you did not see.
 *
 * The tests that matter here are not about rendering events. They are about the
 * three moments where a live client is tempted to invent continuity:
 *
 * - a delta arrives that does not continue from the cursor being held;
 * - the connection drops and comes back;
 * - the buffer fills up during a long session.
 *
 * In every one of them the honest answer costs something — a visible gap, a
 * banner, a "1,204 events dropped" line — and the dishonest answer looks
 * better. So each is asserted directly rather than left to review.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  DEFAULT_LIMITS,
  applyDelta,
  connectionLost,
  describeContinuity,
  finish,
  pinMoment,
  reconnecting,
  replayDigest,
  startSession,
  toReplay,
} from '@watchskill/dsh-live'

import { LiveHeader, LiveSurface } from '@watchskill/dsh-live/components'

import {
  BROKEN_DELTA,
  CONTINUED_DELTA,
  FIRST_DELTA,
  NOW,
  PINNED,
  RECOVERY_SNAPSHOT,
  SESSION_START,
  longRun,
} from './fixtures/live-session.mjs'

/** The fixture journey up to the point named. */
function journey(upTo) {
  let state = startSession(SESSION_START)
  if (upTo === 'start') return state

  state = applyDelta(state, FIRST_DELTA, NOW.afterFirst)
  if (upTo === 'observing') return state

  state = applyDelta(state, BROKEN_DELTA, NOW.afterBreak)
  if (upTo === 'broken') return state

  state = applyDelta(state, RECOVERY_SNAPSHOT, NOW.afterSnapshot)
  if (upTo === 'recovered') return state

  state = applyDelta(state, CONTINUED_DELTA, NOW.afterContinued)
  if (upTo === 'continued') return state

  return finish(state, true)
}

describe('starting and observing', () => {
  test('a fresh session claims nothing it has not seen', () => {
    const state = journey('start')
    assert.equal(state.status, 'starting')
    assert.equal(state.connection, 'connecting')
    assert.equal(state.cursor, '')
    assert.deepEqual([...state.events], [])
    assert.equal(state.clocks.wallMs, null)
    assert.equal(state.clocks.mediaMs, null)
    assert.equal(state.clocks.latencyMs, null)
  })

  test('the first delta advances the cursor and all three clocks', () => {
    const state = journey('observing')
    assert.equal(state.cursor, 'c3')
    assert.equal(state.connection, 'live')
    assert.equal(state.events.length, 3)
    assert.equal(state.clocks.mediaMs, 4_000)
    assert.equal(state.clocks.sessionMs, 4_500)
    assert.equal(state.clocks.latencyMs, 500)
  })

  test('re-applying the same delta changes nothing', () => {
    const once = journey('observing')
    const twice = applyDelta(once, FIRST_DELTA, NOW.afterFirst)
    assert.equal(twice, once, 'a retry produced a new state')
    assert.equal(twice.events.length, 3)
  })

  test('latency is never negative, whatever the clocks say', () => {
    const state = applyDelta(startSession(SESSION_START), FIRST_DELTA, 0)
    assert.equal(state.clocks.latencyMs, 0)
  })
})

describe('a stream that does not continue', () => {
  test('a cursor break is recorded as a gap, not spliced over', () => {
    const state = journey('broken')
    assert.equal(state.needsSnapshot, true)
    assert.equal(state.connection, 'reconnecting')
    const gapEvents = state.events.filter(event => event.kind === 'gap')
    assert.equal(gapEvents.length, 1)
    assert.deepEqual(gapEvents[0].range, { startMs: 4_000, endMs: 30_000 })
  })

  test('the broken delta’s events are not appended', () => {
    const state = journey('broken')
    assert.equal(state.events.some(event => event.text.includes('went through')), false,
      'events from a discontinuous delta were spliced in')
    assert.equal(state.cursor, 'c3', 'the cursor advanced across a break')
  })

  test('the client says why, in terms of the cursors', () => {
    const state = journey('broken')
    assert.match(state.lastError, /c8/)
    assert.match(state.lastError, /c3/)
  })

  test('only a snapshot restores continuity', () => {
    let state = journey('broken')
    // Another delta, even a well-formed one, must not clear the flag.
    state = applyDelta(state, CONTINUED_DELTA, NOW.afterBreak)
    assert.equal(state.needsSnapshot, true)

    state = applyDelta(journey('broken'), RECOVERY_SNAPSHOT, NOW.afterSnapshot)
    assert.equal(state.needsSnapshot, false)
    assert.equal(state.cursor, 'c10')
  })

  test('the recovered snapshot keeps the gap the engine reported', () => {
    const state = journey('recovered')
    assert.deepEqual([...state.gaps], [{ startMs: 4_000, endMs: 30_000 }])
    assert.ok(state.events.some(event => event.kind === 'gap'))
  })

  test('a snapshot replaces the view rather than extending it', () => {
    const state = journey('recovered')
    const seqs = state.events.map(event => event.seq)
    assert.deepEqual(seqs, [...new Set(seqs)], 'the snapshot was appended, duplicating events')
  })

  test('observation continues normally after recovery', () => {
    const state = journey('continued')
    assert.equal(state.cursor, 'c12')
    assert.equal(state.needsSnapshot, false)
    assert.ok(state.events.some(event => event.text.includes('health check is green')))
  })

  test('a lost connection always needs a snapshot, even if nothing was missed', () => {
    const state = connectionLost(journey('observing'), 'socket closed')
    assert.equal(state.connection, 'lost')
    assert.equal(state.needsSnapshot, true)
    assert.equal(state.lastError, 'socket closed')
    assert.equal(reconnecting(state).connection, 'reconnecting')
  })
})

describe('a long session stays bounded', () => {
  test('the buffer does not grow past its limit', () => {
    const state = applyDelta(journey('continued'), longRun(5_000), NOW.afterContinued, { maxEvents: 100 })
    assert.ok(state.events.length <= 100, `buffer held ${String(state.events.length)}`)
    assert.ok(state.trimmed > 0)
  })

  test('a trim never drops a gap', () => {
    const state = applyDelta(journey('continued'), longRun(5_000), NOW.afterContinued, { maxEvents: 10 })
    assert.ok(state.events.some(event => event.kind === 'gap'), 'trimming dropped a gap')
    assert.deepEqual([...state.gaps], [{ startMs: 4_000, endMs: 30_000 }])
  })

  test('a trim never drops a pinned moment’s evidence', () => {
    const pinned = pinMoment(journey('continued'), PINNED)
    const state = applyDelta(pinned, longRun(5_000), NOW.afterContinued, { maxEvents: 10 })
    assert.ok(
      state.events.some(event => event.evidenceIds.includes('ev_ocr_1')),
      'trimming dropped the event a pin pointed at',
    )
  })

  test('the surface says how much it dropped rather than looking complete', () => {
    const state = applyDelta(journey('continued'), longRun(5_000), NOW.afterContinued, { maxEvents: 100 })
    assert.match(describeContinuity(state), /dropped/)
  })

  test('the default bound is a real number, not unlimited', () => {
    assert.ok(Number.isFinite(DEFAULT_LIMITS.maxEvents))
    assert.ok(DEFAULT_LIMITS.maxEvents > 0)
  })

  test('pinning the same moment twice is a no-op', () => {
    const once = pinMoment(journey('continued'), PINNED)
    assert.equal(pinMoment(once, PINNED), once)
  })
})

describe('finalize and replay', () => {
  test('a finalized session freezes into a replay that reopens identically', () => {
    const finished = journey('finalized')
    assert.equal(finished.status, 'finalized')
    assert.equal(finished.connection, 'stopped')

    const first = toReplay(finished)
    const second = toReplay(journey('finalized'))
    assert.equal(replayDigest(first), replayDigest(second))
    assert.deepEqual(first.events, second.events)
  })

  test('the replay keeps the gap, so a finished session is not tidier than it was', () => {
    const replay = toReplay(journey('finalized'))
    assert.deepEqual([...replay.gaps], [{ startMs: 4_000, endMs: 30_000 }])
  })

  test('a discarded session says it was discarded', () => {
    const discarded = finish(journey('continued'), false)
    assert.equal(discarded.status, 'discarded')
    assert.equal(toReplay(discarded).status, 'discarded')
  })

  test('a replay of a trimmed session says how much it is missing', () => {
    const long = applyDelta(journey('continued'), longRun(5_000), NOW.afterContinued, { maxEvents: 100 })
    const replay = toReplay(finish(long, true))
    assert.ok(replay.trimmed > 0)
    assert.notEqual(replayDigest(replay), replayDigest(toReplay(finish(journey('continued'), true))))
  })

  test('the continuity line is present when everything is fine, too', () => {
    assert.match(describeContinuity(journey('observing')), /no gaps/)
    assert.match(describeContinuity(journey('observing')), /nothing dropped/)
  })
})

describe('what Live draws', () => {
  test('all three clocks and the latency are on screen at once', () => {
    const markup = renderToStaticMarkup(createElement(LiveHeader, { state: journey('continued') }))
    for (const field of ['session-clock', 'media-clock', 'wall-clock', 'latency', 'connection', 'continuity']) {
      assert.match(markup, new RegExp(`data-watch-field="${field}"`), `missing ${field}`)
    }
  })

  test('a discontinuous view says so as an alert, not a toast', () => {
    const markup = renderToStaticMarkup(createElement(LiveSurface, {
      state: journey('broken'),
      onStart: () => {}, onStop: () => {}, onAsk: () => {}, onSelect: () => {}, onPin: () => {},
    }))
    assert.match(markup, /role="alert"/)
    assert.match(markup, /not continuous/)
  })

  test('a gap draws as a gap', () => {
    const markup = renderToStaticMarkup(createElement(LiveSurface, {
      state: journey('recovered'),
      onStart: () => {}, onStop: () => {}, onAsk: () => {}, onSelect: () => {}, onPin: () => {},
    }))
    assert.match(markup, /data-watch-live-event="gap"/)
    assert.match(markup, /⌇/)
  })

  test('stopping offers keeping and discarding as separate choices', () => {
    const markup = renderToStaticMarkup(createElement(LiveSurface, {
      state: journey('continued'),
      onStart: () => {}, onStop: () => {}, onAsk: () => {}, onSelect: () => {}, onPin: () => {},
    }))
    assert.match(markup, /data-watch-action="finalize"/)
    assert.match(markup, /data-watch-action="discard"/)
  })

  test('a trimmed session says so on screen', () => {
    const long = applyDelta(journey('continued'), longRun(5_000), NOW.afterContinued, { maxEvents: 100 })
    const markup = renderToStaticMarkup(createElement(LiveSurface, {
      state: long,
      onStart: () => {}, onStop: () => {}, onAsk: () => {}, onSelect: () => {}, onPin: () => {},
    }))
    assert.match(markup, /data-watch-live-trimmed/)
    assert.match(markup, /no longer held in this view/)
  })
})
