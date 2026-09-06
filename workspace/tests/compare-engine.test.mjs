/**
 * The comparison engine.
 *
 * Two properties matter more than the rest, and both are about what a reader is
 * entitled to conclude from a diff.
 *
 * **It is deterministic.** The same two records produce the same comparison
 * every time, on any machine, with no model involved. A diff that changes
 * between runs is a lie about what happened, and nobody can quote it.
 *
 * **It separates two kinds of difference.** An agent producing different text
 * is ordinary. The same claim going from VERIFIED to FAILED is not. Merging
 * them into one list invites a reader to treat a changed answer as a changed
 * truth, which is the confusion this whole product exists to prevent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareRecords, describeIncompatibility, diffOutput, isComparable,
} from '@deepwatch/dsh-client-evidence'

const claim = (over = {}) => ({
  claimId: 'c1',
  text: 'the row was written',
  verdict: 'VERIFIED',
  provenance: 'deterministic check: row-present',
  evidenceIds: ['ev-1'],
  ...over,
})

const record = (over = {}) => ({
  recordId: 'run-a',
  kind: 'run',
  label: 'Run A',
  at: '2026-08-01T10:00:00.000Z',
  output: 'line one\nline two\nline three',
  claims: [claim()],
  ...over,
})

test('compatibility', async t => {
  await t.test('two records of the same kind are comparable', () => {
    assert.equal(isComparable(record(), record({ recordId: 'run-b' })), true)
  })

  await t.test('different kinds are refused with a reason', () => {
    const result = compareRecords(record(), record({ recordId: 'v1', kind: 'verification' }))
    assert.equal(result.comparable, false)
    assert.equal(result.reason, 'different_kinds')
    assert.match(describeIncompatibility('different_kinds'), /do not line up/)
  })

  await t.test('a record compared with itself is not a comparison', () => {
    // Not an error, but a page of matches would be a worse answer than saying
    // so plainly.
    const result = compareRecords(record(), record())
    assert.equal(result.comparable, false)
    assert.equal(result.reason, 'same_record')
  })

  await t.test('a missing side is named, not crashed on', () => {
    assert.equal(compareRecords(null, record()).reason, 'left_missing')
    assert.equal(compareRecords(record(), null).reason, 'right_missing')
  })

  await t.test('a deleted record behaves exactly like a missing one', () => {
    // The UI passes `null` when a chosen record is gone. Nothing throws.
    const result = compareRecords(record(), null)
    assert.equal(result.comparable, false)
    assert.deepEqual(result.claims, [])
    assert.equal(result.output, null)
  })
})

test('claim dispositions', async t => {
  const left = record()

  await t.test('identical checked claims are matching', () => {
    const result = compareRecords(left, record({ recordId: 'run-b' }))
    assert.equal(result.claims[0].disposition, 'matching')
    assert.equal(result.summary.matching, 1)
  })

  await t.test('identical unchecked claims are unverifiable, not matching', () => {
    // "We both said the same thing and neither of us looked" is a different
    // finding from "we both checked and agreed", and reporting it as agreement
    // is how an unverified claim acquires false weight.
    const unchecked = claim({ verdict: 'UNVERIFIED' })
    const result = compareRecords(
      record({ claims: [unchecked] }),
      record({ recordId: 'run-b', claims: [unchecked] }),
    )
    assert.equal(result.claims[0].disposition, 'unverifiable')
    assert.match(result.claims[0].because, /neither side was checked/)
  })

  await t.test('changed text is a changed claim', () => {
    const result = compareRecords(left, record({
      recordId: 'run-b',
      claims: [claim({ text: 'the row was not written' })],
    }))
    assert.equal(result.claims[0].disposition, 'changed')
  })

  await t.test('the same claim with a different verdict is called out separately', () => {
    const result = compareRecords(left, record({
      recordId: 'run-b',
      claims: [claim({ verdict: 'INCONCLUSIVE' })],
    }))
    assert.equal(result.claims[0].disposition, 'verdict_changed')
    assert.match(result.claims[0].because, /VERIFIED to INCONCLUSIVE/)
  })

  await t.test('VERIFIED against FAILED is contradictory', () => {
    // The one disposition that says something can not be reconciled.
    const result = compareRecords(left, record({
      recordId: 'run-b',
      claims: [claim({ verdict: 'FAILED' })],
    }))
    assert.equal(result.claims[0].disposition, 'contradictory')
    assert.equal(result.summary.contradictory, 1)
    assert.match(result.claims[0].because, /Both cannot hold/)
  })

  await t.test('a claim on one side only is reported from that side', () => {
    const result = compareRecords(
      record({ claims: [claim({ claimId: 'only-left' })] }),
      record({ recordId: 'run-b', claims: [claim({ claimId: 'only-right' })] }),
    )
    const byId = Object.fromEntries(result.claims.map(d => [d.claimId, d.disposition]))
    assert.equal(byId['only-left'], 'missing_right')
    assert.equal(byId['only-right'], 'missing_left')
    assert.equal(result.summary.missing, 2)
  })

  await t.test('every difference keeps both sides and their provenance', () => {
    const result = compareRecords(left, record({
      recordId: 'run-b',
      claims: [claim({ text: 'something else', provenance: 'model judgement' })],
    }))
    const difference = result.claims[0]
    assert.equal(difference.left?.provenance, 'deterministic check: row-present')
    assert.equal(difference.right?.provenance, 'model judgement')
    assert.deepEqual(difference.left?.evidenceIds, ['ev-1'])
  })

  await t.test('every difference explains itself', () => {
    const result = compareRecords(left, record({ recordId: 'run-b' }))
    for (const difference of result.claims) {
      assert.ok(difference.because.length > 0, `${difference.claimId} gives no reason`)
    }
  })
})

test('output differences stay separate from verification', async t => {
  await t.test('identical output is reported as identical', () => {
    const result = compareRecords(record(), record({ recordId: 'run-b' }))
    assert.equal(result.output?.identical, true)
    assert.equal(result.output?.firstDivergenceLine, null)
  })

  await t.test('the first divergent line is found', () => {
    const result = compareRecords(record(), record({
      recordId: 'run-b',
      output: 'line one\nline TWO\nline three',
    }))
    assert.equal(result.output?.identical, false)
    assert.equal(result.output?.firstDivergenceLine, 2)
  })

  await t.test('output length is reported for both sides', () => {
    const difference = diffOutput('a\nb', 'a\nb\nc')
    assert.equal(difference.leftLines, 2)
    assert.equal(difference.rightLines, 3)
    assert.equal(difference.firstDivergenceLine, 3)
  })

  await t.test('empty output on both sides is identical', () => {
    const difference = diffOutput('', '')
    assert.equal(difference.identical, true)
    assert.equal(difference.leftLines, 0)
  })

  await t.test('changed output does not change a verdict', () => {
    // The structural point: text changed, verification did not.
    const result = compareRecords(record(), record({
      recordId: 'run-b',
      output: 'completely different text',
    }))
    assert.equal(result.output?.identical, false)
    assert.equal(result.summary.matching, 1)
    assert.equal(result.summary.verdictChanged, 0)
    assert.equal(result.summary.contradictory, 0)
  })
})

test('determinism', async t => {
  const many = count => Array.from({ length: count }, (_, index) => claim({
    claimId: `c${String(index)}`,
    text: `claim ${String(index)}`,
    verdict: index % 2 === 0 ? 'VERIFIED' : 'UNVERIFIED',
  }))

  await t.test('the same inputs always produce the same output', () => {
    const left = record({ claims: many(30) })
    const right = record({ recordId: 'run-b', claims: many(30) })
    const first = JSON.stringify(compareRecords(left, right))
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(JSON.stringify(compareRecords(left, right)), first)
    }
  })

  await t.test('claim order in the input does not change the output', () => {
    // A comparison that depended on insertion order could not be quoted.
    const claims = many(20)
    const forwards = compareRecords(
      record({ claims }),
      record({ recordId: 'run-b', claims }),
    )
    const backwards = compareRecords(
      record({ claims: [...claims].reverse() }),
      record({ recordId: 'run-b', claims: [...claims].reverse() }),
    )
    assert.deepEqual(
      forwards.claims.map(d => d.claimId),
      backwards.claims.map(d => d.claimId),
    )
    assert.deepEqual(forwards.summary, backwards.summary)
  })

  await t.test('nothing about it needs a clock or a model', () => {
    // Pure by construction: no Date, no random, no I/O, no network.
    const source = compareRecords.toString()
    assert.doesNotMatch(source, /Date\.now|Math\.random|fetch\(/)
  })

  await t.test('a large comparison stays stable and complete', () => {
    const left = record({ claims: many(500) })
    const right = record({ recordId: 'run-b', claims: many(500) })
    const result = compareRecords(left, right)
    assert.equal(result.claims.length, 500)
    const total = result.summary.matching + result.summary.unverifiable
      + result.summary.changed + result.summary.verdictChanged
      + result.summary.missing + result.summary.contradictory
    assert.equal(total, 500, 'every claim must land in exactly one bucket')
  })
})
