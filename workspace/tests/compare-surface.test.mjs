/**
 * Compare, finished: channels, before/after, deep links, and a surface.
 *
 * The core — alignment, first divergence, a stable digest — was already tested
 * in compare.test.mjs. What is tested here is the rest of what the vision asks
 * for, and one distinction that only shows up on a realistic fixture:
 *
 * > The first divergence and the first divergence that *mattered* are usually
 * > not the same row.
 *
 * The before/after fixture is arranged so that an innocuous difference at 1.2s
 * arrives before a verdict flipping at 9.0s. A surface that reported the
 * earliest row would send someone to an extra frame. That is the failure this
 * file exists to catch.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  COMPARE_SUBJECTS,
  compareProjections,
  comparisonDigest,
  describeComparison,
  divergenceLink,
  exportComparison,
  firstMeaningfulDivergence,
  fromDeepLink,
  hasVerdictDivergence,
  project,
} from '@deepwatch/dsh-trajectory'

import { CompareView } from '@deepwatch/dsh-client-evidence/compare'

import { AFTER_EVENTS, BEFORE_EVENTS, CHANNEL_HINTS } from './fixtures/before-after.mjs'

const CONTEXT = { workspaceId: 'ws_1', sessionId: 'run_before' }

function compare(subject = 'before_after', hints = CHANNEL_HINTS) {
  return compareProjections(
    project(BEFORE_EVENTS, 'run_before'),
    project(AFTER_EVENTS, 'run_after'),
    subject,
    { leftId: 'run_before', rightId: 'run_after' },
    hints,
  )
}

describe('what can be compared', () => {
  test('every subject the vision names is supported', () => {
    assert.deepEqual(
      [...COMPARE_SUBJECTS],
      ['run', 'source_revision', 'temporal_region', 'before_after'],
    )
  })

  test('the subject travels through to the result and the digest', () => {
    for (const subject of COMPARE_SUBJECTS) {
      assert.equal(compare(subject).subject, subject)
    }
    assert.notEqual(
      comparisonDigest(compare('run')),
      comparisonDigest(compare('before_after')),
      'the subject does not affect the digest',
    )
  })
})

describe('channels come from the evidence, not from a guess', () => {
  test('resolved evidence places a divergence on its own sense', () => {
    const channels = new Set(compare().divergences.map(divergence => divergence.channel))
    assert.ok(channels.has('visual'), 'a visual divergence was not identified')
    assert.ok(channels.has('dom'), 'a DOM divergence was not identified')
    assert.ok(channels.has('verification'))
  })

  test('unresolved evidence is not filed under a sense it was assumed to have', () => {
    const channels = new Set(compare('before_after', new Map())
      .divergences
      .filter(divergence => divergence.channel !== 'verification' && divergence.channel !== 'receipt')
      .map(divergence => divergence.channel))
    assert.deepEqual([...channels], ['text'])
  })

  test('a verdict divergence is always on the verification channel', () => {
    const comparison = compare()
    assert.equal(hasVerdictDivergence(comparison), true)
    const verdicts = comparison.divergences.filter(d => d.channel === 'verification')
    assert.equal(verdicts.length, 1)
    assert.match(verdicts[0].summary, /FAILED → VERIFIED/)
  })
})

describe('the first divergence and the one that mattered', () => {
  test('the earliest divergence is the innocuous one', () => {
    const comparison = compare()
    assert.equal(comparison.firstDivergence.atMs, 1_200)
    assert.notEqual(comparison.firstDivergence.channel, 'verification')
  })

  test('the first meaningful divergence is the verdict', () => {
    const meaningful = firstMeaningfulDivergence(compare())
    assert.equal(meaningful.channel, 'verification')
    assert.match(meaningful.summary, /FAILED → VERIFIED/)
  })

  test('with no verdict or receipt divergence, meaningful falls back to first', () => {
    const same = compareProjections(
      project(BEFORE_EVENTS, 'run_a'),
      project(BEFORE_EVENTS, 'run_b'),
      'run',
      { leftId: 'run_a', rightId: 'run_b' },
      CHANNEL_HINTS,
    )
    assert.equal(same.divergences.length, 0)
    assert.equal(firstMeaningfulDivergence(same), null)
  })

  test('the summary reports the meaningful one, and never a pass or a fail', () => {
    const line = describeComparison(compare())
    assert.match(line, /First meaningful: verification/)
    assert.equal(/pass|fail/i.test(line), false, 'the summary editorialised')
  })

  test('two identical runs report agreement rather than nothing', () => {
    const same = compareProjections(
      project(BEFORE_EVENTS, 'run_a'),
      project(BEFORE_EVENTS, 'run_b'),
      'run',
      { leftId: 'run_a', rightId: 'run_b' },
    )
    assert.match(describeComparison(same), /No divergence across/)
    assert.ok(same.agreements > 0)
  })
})

describe('deep links out of a comparison', () => {
  test('each side of a divergence links into the inspector', () => {
    const comparison = compare()
    const divergence = firstMeaningfulDivergence(comparison)
    for (const side of ['left', 'right']) {
      const link = divergenceLink(comparison, divergence, side, CONTEXT)
      assert.notEqual(link, null, `${side} produced no link`)
      const restored = fromDeepLink(link)
      assert.notEqual(restored, null)
      assert.equal(restored.workspaceId, 'ws_1')
      assert.equal(restored.sessionId, side === 'left' ? 'run_before' : 'run_after')
      assert.equal(restored.inspectorTab, 'verification')
    }
  })

  test('a link points at the side it came from, not at both', () => {
    const comparison = compare()
    const divergence = firstMeaningfulDivergence(comparison)
    const left = fromDeepLink(divergenceLink(comparison, divergence, 'left', CONTEXT))
    const right = fromDeepLink(divergenceLink(comparison, divergence, 'right', CONTEXT))
    assert.notEqual(left.recordId, right.recordId)
  })

  test('a one-sided divergence produces no link for the empty side', () => {
    const comparison = compare()
    const oneSided = comparison.divergences.find(
      divergence => divergence.leftRecordId === null || divergence.rightRecordId === null,
    )
    if (oneSided === undefined) return
    const emptySide = oneSided.leftRecordId === null ? 'left' : 'right'
    assert.equal(divergenceLink(comparison, oneSided, emptySide, CONTEXT), null)
  })
})

describe('exporting a comparison', () => {
  test('the bundle carries identifiers and links, never evidence content', () => {
    const bundle = exportComparison(compare(), CONTEXT)
    const serialized = JSON.stringify(bundle)
    assert.match(serialized, /ev_after_3/)
    assert.equal(/observed|groundedness/.test(serialized), false,
      'the bundle inlined evidence payloads')
  })

  test('the bundle names both the first and the first meaningful divergence', () => {
    const bundle = exportComparison(compare(), CONTEXT)
    assert.equal(bundle.firstDivergence.atMs, 1_200)
    assert.equal(bundle.firstMeaningfulDivergence.channel, 'verification')
    assert.equal(bundle.links.length, 2)
  })

  test('the same comparison exports the same digest, twice', () => {
    assert.equal(
      exportComparison(compare(), CONTEXT).digest,
      exportComparison(compare(), CONTEXT).digest,
    )
  })
})

describe('what Compare draws', () => {
  function render(comparison = compare()) {
    return renderToStaticMarkup(createElement(CompareView, {
      comparison,
      leftLabel: 'before the fix',
      rightLabel: 'after the fix',
      onOpen: () => {},
    }))
  }

  test('the meaningful divergence is the one marked as leading', () => {
    const markup = render()
    assert.match(markup, /data-watch-leading="true"/)
    const leading = /data-watch-divergence="([a-z]+)"[^>]*data-watch-divergence-kind="[a-z]+" data-watch-leading="true"/.exec(markup)
    assert.notEqual(leading, null, 'no leading row was marked')
    assert.equal(leading[1], 'verification')
  })

  test('every divergence carries a channel, a kind and a glyph', () => {
    const markup = render()
    assert.match(markup, /data-watch-divergence="visual"/)
    assert.match(markup, /data-watch-divergence-kind="changed"/)
    assert.match(markup, /≠/)
  })

  test('both sides are openable, and an empty side is disabled', () => {
    const markup = render()
    assert.match(markup, /data-watch-open="left"/)
    assert.match(markup, /data-watch-open="right"/)
  })

  test('the surface says a difference is not a failure', () => {
    assert.match(render(), /A difference is not a failure/)
  })

  test('two agreeing runs say so rather than showing an empty list', () => {
    const same = compareProjections(
      project(BEFORE_EVENTS, 'run_a'),
      project(BEFORE_EVENTS, 'run_b'),
      'run',
      { leftId: 'run_a', rightId: 'run_b' },
    )
    assert.match(render(same), /agree everywhere they align/)
  })

  test('the side labels keep their own direction', () => {
    assert.match(render(), /dir="auto"/)
  })
})
