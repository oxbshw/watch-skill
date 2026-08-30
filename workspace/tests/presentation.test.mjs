/**
 * The rules that decide what a screen is allowed to imply.
 *
 * A verdict card is the smallest surface in the product and the one where a
 * small, reasonable-looking change does the most damage: rendering
 * `UNVERIFIED` in a way a tired person reads as "done" removes the only claim
 * Watch makes. These tests exist so that change fails here rather than
 * shipping.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  formatTimestamp,
  freshnessLabel,
  parseAnswer,
  parseVerdict,
  verdictTone,
} from '@deepwatch/dsh-contracts'

const ALL_VERDICTS = ['VERIFIED', 'FAILED', 'UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED']

describe('verdict tone', () => {
  test('the success tone belongs to VERIFIED alone', () => {
    assert.equal(verdictTone('VERIFIED'), 'success')
    for (const verdict of ALL_VERDICTS.filter(v => v !== 'VERIFIED')) {
      assert.notEqual(
        verdictTone(verdict),
        'success',
        `${verdict} must never render in the success tone`,
      )
    }
  })

  test('an unproven result is caution, not error', () => {
    // Styling an honest non-answer as a failure teaches people to dismiss it,
    // which is how "not proven" quietly becomes "proven".
    for (const verdict of ['UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED']) {
      assert.equal(verdictTone(verdict), 'caution', `${verdict} should be caution`)
    }
    assert.equal(verdictTone('FAILED'), 'error')
  })

  test('every verdict in the taxonomy has a tone', () => {
    for (const verdict of ALL_VERDICTS) {
      assert.ok(['success', 'error', 'caution'].includes(verdictTone(verdict)))
    }
  })
})

describe('parsing a verification result', () => {
  test('reads a complete result', () => {
    const parsed = parseVerdict({
      verdict: 'VERIFIED',
      reason: 'Every required check passed.',
      contractDigest: 'sha256:abcdef0123456789',
      assurance: 'deterministic',
      checks: [{ checkId: 'artifact', kind: 'file_exists', passed: true, description: 'the file exists', detail: null }],
    })
    assert.equal(parsed.verdict, 'VERIFIED')
    assert.equal(parsed.assurance, 'deterministic')
    assert.equal(parsed.checks.length, 1)
    assert.equal(parsed.checks[0].passed, true)
  })

  test('refuses a payload with no verdict rather than inventing one', () => {
    for (const value of [null, undefined, 42, 'VERIFIED', [], {}, { verdict: 'PROBABLY' }]) {
      assert.equal(parseVerdict(value), null, `${JSON.stringify(value)} must not parse`)
    }
  })

  test('a refusal never parses as a verdict', () => {
    // A tool refusal and a verdict travel through the same slot. If a refusal
    // parsed, the card would render whatever tone its default happened to be.
    assert.equal(
      parseVerdict({ ok: false, error: 'bridge.core_unavailable', fix: 'Connect Watch Core.' }),
      null,
    )
  })

  test('a check that could not run stays distinct from one that failed', () => {
    const parsed = parseVerdict({
      verdict: 'INCONCLUSIVE',
      checks: [
        { checkId: 'a', passed: true },
        { checkId: 'b', passed: false },
        { checkId: 'c' },
        { checkId: 'd', passed: 'maybe' },
      ],
    })
    assert.deepEqual(parsed.checks.map(c => c.passed), [true, false, null, null])
  })

  test('a verdict with no reason still gets one that says what happened', () => {
    for (const verdict of ALL_VERDICTS) {
      const parsed = parseVerdict({ verdict })
      assert.ok(parsed.reason.length > 0, `${verdict} needs a fallback reason`)
      assert.notEqual(parsed.reason, verdict, 'the reason must explain, not restate')
    }
  })

  test('the UNVERIFIED fallback says nothing was established', () => {
    assert.match(parseVerdict({ verdict: 'UNVERIFIED' }).reason, /nothing was established/i)
  })

  test('a malformed check is dropped rather than rendered half-read', () => {
    const parsed = parseVerdict({ verdict: 'FAILED', checks: [null, 'x', {}, { checkId: 'ok' }] })
    assert.deepEqual(parsed.checks.map(c => c.checkId), ['ok'])
  })
})

describe('parsing an evidence-linked answer', () => {
  test('reads the answer and its citations', () => {
    const parsed = parseAnswer({
      ok: true,
      answer: 'The build failed at 2:14.',
      groundedness: 'sufficient',
      evidence: [{
        evidenceId: 'vid_1#ocr@0',
        text: 'ERROR: exit code 1',
        temporalRange: { startMs: 134_000, endMs: 134_000 },
        modality: 'visual',
        provenance: 'observation',
        freshness: 'current',
      }],
    })
    assert.equal(parsed.answer, 'The build failed at 2:14.')
    assert.equal(parsed.citations.length, 1)
    assert.equal(parsed.citations[0].atMs, 134_000)
    assert.equal(parsed.citations[0].freshness, 'current')
  })

  test('a refusal never parses as an answer', () => {
    assert.equal(parseAnswer({ ok: false, error: 'bridge.core_unavailable' }), null)
    assert.equal(parseAnswer({ answer: 'looks like an answer' }), null)
  })

  test('an unknown freshness becomes unavailable, never current', () => {
    // Defaulting an unknown to the reassuring value is the one direction this
    // must never fail in: it would present an unchecked observation as
    // confirmed.
    for (const freshness of [undefined, null, 'fresh', 'probably', 42]) {
      const parsed = parseAnswer({
        ok: true,
        answer: 'x',
        evidence: [{ evidenceId: 'e1', freshness }],
      })
      assert.equal(
        parsed.citations[0].freshness,
        'unavailable',
        `${JSON.stringify(freshness)} must not become "current"`,
      )
    }
  })

  test('a citation with no timing has no timestamp rather than 0:00', () => {
    const parsed = parseAnswer({ ok: true, answer: 'x', evidence: [{ evidenceId: 'e1' }] })
    assert.equal(parsed.citations[0].atMs, null)
    assert.equal(formatTimestamp(parsed.citations[0].atMs), null)
  })

  test('provenance defaults to observation only when the field is absent', () => {
    const derived = parseAnswer({
      ok: true,
      answer: 'x',
      evidence: [{ evidenceId: 'e1', provenance: 'deterministic_derivation' }],
    })
    assert.equal(derived.citations[0].provenance, 'deterministic_derivation')
  })

  test('an unrecognized groundedness is null, not a claim either way', () => {
    const parsed = parseAnswer({ ok: true, answer: 'x', groundedness: 'pretty good' })
    assert.equal(parsed.groundedness, null)
  })
})

describe('freshness labelling', () => {
  test('only a current observation goes unlabelled', () => {
    assert.equal(freshnessLabel('current'), null)
    for (const freshness of ['stale', 'gap', 'expired', 'unavailable']) {
      assert.ok(
        freshnessLabel(freshness).length > 0,
        `${freshness} must be visible without relying on colour`,
      )
    }
  })
})

describe('timestamp formatting', () => {
  test('reads the way a person reads a media position', () => {
    assert.equal(formatTimestamp(0), '0:00')
    assert.equal(formatTimestamp(9_000), '0:09')
    assert.equal(formatTimestamp(134_000), '2:14')
    assert.equal(formatTimestamp(3_599_000), '59:59')
    assert.equal(formatTimestamp(3_600_000), '1:00:00')
    assert.equal(formatTimestamp(7_384_000), '2:03:04')
  })

  test('an absent or nonsense position renders as nothing at all', () => {
    for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(formatTimestamp(value), null)
    }
  })

  test('a negative position clamps rather than rendering a negative time', () => {
    assert.equal(formatTimestamp(-5_000), '0:00')
  })
})
