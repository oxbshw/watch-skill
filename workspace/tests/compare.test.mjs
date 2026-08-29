/**
 * Compare: where two observations first stopped agreeing.
 *
 * The question is narrower than "what changed", and much more useful. A diff of
 * two long runs produces hundreds of differences, most of them consequences of
 * the first, and a person reading it has to work backwards. So the first
 * divergence is a result rather than something to scroll for.
 *
 * The rule under test alongside it: a difference is not a failure. Compare
 * surfaces divergences and never issues a verdict — deciding whether a change
 * was the one somebody asked for is a verification contract.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  compareProjections,
  comparisonDigest,
  hasVerdictDivergence,
  project,
} from '@watchskill/dsh-trajectory'

function toolCall(seq, callId, name) {
  return {
    type: 'tool/call',
    seq,
    time: 1000 + seq,
    data: { callId, name, arguments: {}, turn: 1, step: 1 },
  }
}

function toolResult(seq, callId, value) {
  return {
    type: 'tool/result',
    seq,
    time: 1000 + seq,
    data: {
      turn: 1,
      message: {
        source: { callId },
        content: [{ content: [{ type: 'text', text: JSON.stringify(value) }] }],
      },
    },
  }
}

function answer(evidenceId, atMs, revision = 'src@rev1') {
  return {
    ok: true,
    answer: 'observed',
    groundedness: 'sufficient',
    evidence: [{
      evidenceId,
      sourceRevisionId: revision,
      temporalRange: { startMs: atMs, endMs: atMs },
      modality: 'visual',
      provenance: 'observation',
      freshness: 'current',
      text: 'some observed text',
    }],
  }
}

function verdict(value) {
  return {
    verificationId: `ver_${value}`,
    verdict: value,
    reason: 'because',
    contractDigest: 'sha256:abc',
    evaluatedAt: '2026-08-27T00:00:00.000Z',
  }
}

/** A run: an observation at 1s, one at 5s, then a verdict. */
function run(options = {}) {
  return project([
    toolCall(1, 'c1', 'watch_ask_source'),
    toolResult(2, 'c1', answer('ev_a', 1000, options.revision)),
    toolCall(3, 'c2', 'watch_ask_source'),
    toolResult(4, 'c2', answer(options.secondEvidence ?? 'ev_b', 5000, options.revision)),
    toolCall(5, 'c3', 'watch_verify'),
    toolResult(6, 'c3', verdict(options.verdict ?? 'VERIFIED')),
  ], options.session ?? 'sess_a')
}

describe('two identical runs agree', () => {
  test('no divergence, and nothing to look at', () => {
    const comparison = compareProjections(run(), run(), 'run', { leftId: 'a', rightId: 'b' })
    assert.deepEqual(comparison.divergences, [])
    assert.equal(comparison.firstDivergence, null)
    assert.ok(comparison.agreements > 0)
  })

  test('the digest is stable across identical inputs', () => {
    const first = comparisonDigest(compareProjections(run(), run(), 'run', { leftId: 'a', rightId: 'b' }))
    const second = comparisonDigest(compareProjections(run(), run(), 'run', { leftId: 'a', rightId: 'b' }))
    assert.equal(first, second)
    assert.match(first, /^fnv1a64:[0-9a-f]{16}$/)
  })
})

describe('the first divergence', () => {
  test('is the earliest by source time, not by map order', () => {
    // Everything after the first divergence is usually a consequence of it,
    // so which one is reported first is the whole value of the feature.
    const comparison = compareProjections(
      run(),
      run({ secondEvidence: 'ev_different', verdict: 'FAILED' }),
      'run',
      { leftId: 'a', rightId: 'b' },
    )
    assert.ok(comparison.firstDivergence !== null)
    assert.equal(comparison.firstDivergence.atMs, 5000)
    assert.equal(
      comparison.divergences[0],
      comparison.firstDivergence,
      'the first divergence must be first in the list',
    )
  })

  test('untimed divergences sort last so they cannot hide an early one', () => {
    const comparison = compareProjections(
      run(),
      run({ secondEvidence: 'ev_different', verdict: 'FAILED' }),
      'run',
      { leftId: 'a', rightId: 'b' },
    )
    const timings = comparison.divergences.map(divergence => divergence.atMs)
    const firstUntimed = timings.indexOf(null)
    if (firstUntimed >= 0) {
      assert.ok(
        timings.slice(firstUntimed).every(at => at === null),
        'a timed divergence must never appear after an untimed one',
      )
    }
  })
})

describe('what a divergence reports', () => {
  test('a changed verdict is named as a verdict change', () => {
    // The most important difference there is: the same step reached a
    // different conclusion.
    const comparison = compareProjections(
      run(), run({ verdict: 'FAILED' }), 'run', { leftId: 'a', rightId: 'b' },
    )
    const verdictChange = comparison.divergences.find(entry => entry.channel === 'verification')
    assert.ok(verdictChange !== undefined)
    assert.match(verdictChange.summary, /verdict VERIFIED → FAILED/)
    assert.equal(hasVerdictDivergence(comparison), true)
  })

  test('a source revision change is reported as one', () => {
    const comparison = compareProjections(
      run(), run({ revision: 'src@rev2' }), 'source_revision', { leftId: 'r1', rightId: 'r2' },
    )
    assert.ok(comparison.divergences.some(entry => /different source revision/.test(entry.summary)))
  })

  test('a divergence carries identifiers, never evidence content', () => {
    // Compare holds no payloads, so it cannot become a second place evidence
    // lives.
    const comparison = compareProjections(
      run(), run({ secondEvidence: 'ev_different' }), 'run', { leftId: 'a', rightId: 'b' },
    )
    const serialized = JSON.stringify(comparison)
    assert.ok(!serialized.includes('some observed text'))
    assert.ok(serialized.includes('ev_different'))
  })

  test('a step present on only one side is added or removed, not changed', () => {
    const right = project([
      toolCall(1, 'c1', 'watch_ask_source'),
      toolResult(2, 'c1', answer('ev_a', 1000)),
    ], 'sess_b')
    const comparison = compareProjections(run(), right, 'run', { leftId: 'a', rightId: 'b' })
    const removed = comparison.divergences.filter(entry => entry.kind === 'removed')
    assert.ok(removed.length > 0)
    for (const divergence of removed) {
      assert.equal(divergence.rightRecordId, null)
      assert.ok(divergence.leftRecordId !== null)
    }
  })
})

describe('Compare issues no verdict of its own', () => {
  test('a difference is not a failure', () => {
    // Most changes between two runs are the change somebody asked for.
    // Deciding whether one was expected is a verification contract.
    const comparison = compareProjections(
      run(), run({ secondEvidence: 'ev_different' }), 'run', { leftId: 'a', rightId: 'b' },
    )
    assert.ok(comparison.divergences.length > 0)
    assert.ok(!('verdict' in comparison), 'a comparison must not carry a verdict')
    assert.equal(
      hasVerdictDivergence(comparison),
      false,
      'evidence differing is not a verdict change',
    )
  })
})

describe('deep-linkable and replayable', () => {
  test('a different comparison has a different digest', () => {
    const same = comparisonDigest(
      compareProjections(run(), run(), 'run', { leftId: 'a', rightId: 'b' }),
    )
    const different = comparisonDigest(
      compareProjections(run(), run({ verdict: 'FAILED' }), 'run', { leftId: 'a', rightId: 'b' }),
    )
    assert.notEqual(same, different)
  })

  test('the digest ignores summary wording', () => {
    const comparison = compareProjections(
      run(), run({ verdict: 'FAILED' }), 'run', { leftId: 'a', rightId: 'b' },
    )
    const reworded = {
      ...comparison,
      divergences: comparison.divergences.map(entry => ({ ...entry, summary: 'rewritten' })),
    }
    assert.equal(comparisonDigest(comparison), comparisonDigest(reworded))
  })
})
