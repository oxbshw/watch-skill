/**
 * The contract rules that the whole product's honesty rests on.
 *
 * These are deliberately unglamorous assertions. Each one guards a place where
 * a small, reasonable-looking change would let the UI claim more than the
 * evidence supports.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  WATCH_PROTOCOL_VERSION,
  WATCH_PROTOCOL_MIN,
  isSuccessVerdict,
  negotiateProtocol,
  watchError,
} from '@watchskill/dsh-contracts'

describe('verdict rendering', () => {
  test('only VERIFIED may be rendered as success', () => {
    assert.equal(isSuccessVerdict('VERIFIED'), true)
    for (const verdict of ['FAILED', 'UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED']) {
      assert.equal(
        isSuccessVerdict(verdict),
        false,
        `${verdict} must never render as success`,
      )
    }
  })

  test('an agent that completed is not a verdict at all', () => {
    // The three state machines are separate by design (ADR-002). If someone
    // ever adds an execution state to the verdict union, this breaks.
    for (const executionState of ['completed', 'running', 'failed', 'cancelled', 'queued']) {
      assert.equal(isSuccessVerdict(executionState), false)
    }
  })
})

describe('protocol negotiation', () => {
  test('agrees on the highest version both sides speak', () => {
    assert.equal(negotiateProtocol(1, 1), 1)
    assert.equal(negotiateProtocol(1, 99), WATCH_PROTOCOL_VERSION)
  })

  test('refuses when the ranges do not overlap', () => {
    assert.equal(negotiateProtocol(WATCH_PROTOCOL_VERSION + 1, WATCH_PROTOCOL_VERSION + 5), null)
    assert.equal(negotiateProtocol(0, WATCH_PROTOCOL_MIN - 1), null)
  })
})

describe('error contract', () => {
  test('every failure carries an actionable fix', () => {
    const failure = watchError('live.cursor_expired', 'The cursor is gone.', 'Request a new snapshot.')
    assert.equal(failure.ok, false)
    assert.equal(failure.error.error, 'live.cursor_expired')
    assert.equal(failure.error.fix, 'Request a new snapshot.')
    assert.deepEqual(failure.error.details, {})
    assert.equal(failure.error.retryable, false)
    assert.equal(failure.error.correlationId, null)
  })

  test('retryable defaults to false so a side effect is never retried by accident', () => {
    assert.equal(watchError('a', 'b', 'c').error.retryable, false)
  })
})
