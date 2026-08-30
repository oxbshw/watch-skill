/**
 * The brand's one load-bearing rule.
 *
 * A brand package is mostly taste, and taste does not need a test. One thing
 * here is not taste: the mapping from status to tone is the visual half of
 * ADR-002, and it is the last place a false VERIFIED could enter the product
 * after every other guard has held.
 *
 * The attribution strings are also checked, because they are legal statements
 * rather than copy, and a legal statement that drifts is a problem nobody
 * notices until it matters.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  ATTRIBUTION,
  INDEPENDENCE,
  PRODUCT_NAME,
  STATUS_TONE,
  isSuccessTone,
  tokenFor,
  toneFor,
} from '@deepwatch/dsh-client-brand'

describe('the success tone', () => {
  test('exactly one status reaches it, and it is VERIFIED', () => {
    const successStatuses = Object.entries(STATUS_TONE)
      .filter(([, tone]) => tone === 'success')
      .map(([status]) => status)
    assert.deepEqual(successStatuses, ['VERIFIED'])
  })

  test('no other verdict is a success', () => {
    for (const verdict of ['FAILED', 'UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED']) {
      assert.equal(isSuccessTone(verdict), false, `${verdict} must not be a success`)
    }
  })

  test('a completed agent turn is not a success', () => {
    // The distinction the whole product exists to hold, at the last place it
    // could be lost. A finished turn is a statement about the agent.
    assert.equal(isSuccessTone('completed'), false)
    assert.equal(toneFor('completed'), 'info')
  })

  test('an unknown status is neutral, never a success', () => {
    // A status added elsewhere and not registered here should render as
    // unremarkable rather than accidentally as a win.
    for (const unknown of ['probably_fine', 'ok', 'done', 'pass', '']) {
      assert.equal(toneFor(unknown), 'neutral', `${unknown} should be neutral`)
      assert.equal(isSuccessTone(unknown), false)
    }
  })
})

describe('the caution tone', () => {
  test('an unproven result is caution, not error', () => {
    // Styling an honest non-answer as a failure teaches people to dismiss it,
    // which is how "not proven" quietly becomes "proven".
    for (const status of ['UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED']) {
      assert.equal(toneFor(status), 'caution')
    }
    assert.equal(toneFor('FAILED'), 'error')
  })

  test('a gap in capture is caution, not neutral', () => {
    // A missing observation is not the same as a fine one, and rendering it as
    // unremarkable is how a gap gets read as coverage.
    assert.equal(toneFor('gap'), 'caution')
    assert.equal(toneFor('expired'), 'caution')
    assert.equal(toneFor('current'), 'neutral')
  })
})

describe('tokens, not hex', () => {
  test('every tone resolves to a CSS variable', () => {
    for (const tone of ['success', 'error', 'caution', 'info', 'active', 'neutral']) {
      assert.match(
        tokenFor(tone),
        /^var\(--watch-tone-[a-z]+\)$/,
        'a feature package must receive a token, never a colour',
      )
    }
  })
})

describe('identity and attribution', () => {
  test('the product is named Watch, not DeepSeek anything', () => {
    assert.equal(PRODUCT_NAME, 'DeepWatch')
    assert.ok(!PRODUCT_NAME.toLowerCase().includes('deepseek'))
  })

  test('attribution names the upstream project', () => {
    assert.match(ATTRIBUTION, /DeepSeek Harness/)
    assert.match(ATTRIBUTION, /Watch Skill/)
  })

  test('the independence disclosure is present and unambiguous', () => {
    // Attribution without this could read as endorsement, and no such
    // endorsement exists.
    assert.match(INDEPENDENCE, /independent project/)
    assert.match(INDEPENDENCE, /not affiliated with or endorsed by DeepSeek/)
  })
})
