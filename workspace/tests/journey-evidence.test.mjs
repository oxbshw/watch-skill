/**
 * The evidence rules of the real-model journey, run against the evidence that
 * fooled them.
 *
 * Three of `qa-journey-live.mjs`'s assertions passed on runs that did not
 * support them. None of these is a hypothetical: each counterexample below is
 * the shape of a journal that produced a green claim.
 *
 *   LJ-09  "the broken claim fails" counted FAILED verdicts across the whole
 *          session, so the invented-sha256 failure from the *verification*
 *          phase satisfied a claim about the *mismatch* phase. The mismatch
 *          phase could have done nothing at all.
 *
 *   LJ-12  "the Library opens each one carrying the verdict Compare reads"
 *          counted opened rows and distinct revision ids, and never read a
 *          verdict — so a row opening with `verdict: null`, which is the exact
 *          defect this release exists to close, passed it.
 *
 *   LJ-13  "a perception request reached Core" accepted any `watch_*` tool
 *          other than `watch_verify` on a settled turn, so
 *          `watch_capabilities` — which reads nothing — proved a video had
 *          been read.
 *
 * Each test asserts the old input is rejected *and* that a genuine one is
 * still accepted, because a rule that fails everything is not a fix.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  delegationSucceeded,
  libraryAgreesWithCore,
  perceptionProved,
  phaseSlice,
  toolOf,
  verificationsIn,
} from '../scripts/lib/journey-evidence.mjs'

/** A journalled receipt, in the shape the Host writes. */
function receipt(tool, extra = {}) {
  const { tags = [], ...rest } = extra
  return {
    recordId: `rcpt_${Math.random().toString(16).slice(2, 10)}`,
    runId: 'session-1',
    ...rest,
    // Built last, and from the extras rather than replaced by them: spreading
    // `extra` over a `tags` key silently dropped `tool:` from every fixture
    // that set a state, and the tests then measured nothing.
    tags: ['execution-receipt', `tool:${tool}`, ...tags],
  }
}

describe('a phase is a slice of the journal, not the whole session', () => {
  test('receipts from an earlier phase are not evidence for a later one', () => {
    // The run that produced this: verification phase returns FAILED because
    // the model invented a digest; the mismatch phase then does nothing.
    const journal = [
      receipt('write'),
      receipt('watch_verify', { verdict: 'FAILED', evidenceIds: ['ver_a'] }),
    ]
    const markBeforeMismatch = journal.length
    // ...the mismatch turn ran and produced no verification at all.
    const mismatchPhase = phaseSlice(journal, markBeforeMismatch, 'session-1')
    assert.deepEqual(mismatchPhase, [])
    assert.equal(verificationsIn(mismatchPhase).some(e => e.verdict === 'FAILED'), false,
      'the earlier FAILED must not satisfy a claim about this phase')

    // The whole-session view is what used to be asked, and it says yes.
    assert.equal(verificationsIn(journal).some(e => e.verdict === 'FAILED'), true)
  })

  test('a real mismatch in its own phase is still accepted', () => {
    const journal = [
      receipt('write'),
      receipt('watch_verify', { verdict: 'FAILED', evidenceIds: ['ver_a'] }),
    ]
    const mark = journal.length
    journal.push(receipt('edit'))
    journal.push(receipt('watch_verify', { verdict: 'FAILED', evidenceIds: ['ver_b'] }))
    const phase = phaseSlice(journal, mark, 'session-1')
    assert.equal(verificationsIn(phase).some(e => e.verdict === 'FAILED'), true)
  })

  test('another session’s receipts are never this session’s evidence', () => {
    const journal = [receipt('watch_verify', { runId: 'session-other', verdict: 'FAILED' })]
    assert.deepEqual(phaseSlice(journal, 0, 'session-1'), [])
  })
})

describe('a Library row has to carry the verdict Core issued', () => {
  const journal = [
    { recordId: 'rcpt_1', verdict: 'FAILED', identities: ['ver_a'], text: '' },
    { recordId: 'rcpt_2', verdict: 'VERIFIED', identities: ['ver_b'], text: '' },
  ]

  test('a row that opens with no verdict is refused', () => {
    // The defect in the flesh: the row opens, it has a revision, and the
    // verdict Core returned never reached it.
    const opened = [
      { outcome: 'record', record: { verdict: null, revisionId: 'rcpt_1.aaa' } },
      { outcome: 'record', record: { verdict: 'VERIFIED', revisionId: 'rcpt_2.bbb' } },
    ]
    const verdict = libraryAgreesWithCore(opened, journal)
    assert.equal(verdict.ok, false)
    assert.match(verdict.problems.join(' '), /opened with no verdict/)

    // And the old rule -- opened rows, distinct revisions -- says yes.
    const oldRule = opened.filter(e => e.outcome === 'record').length === journal.length
      && new Set(opened.map(e => e.record.revisionId)).size === journal.length
    assert.equal(oldRule, true, 'the counterexample must pass the rule it replaced')
  })

  test('a row showing a different verdict than Core issued is refused', () => {
    const opened = [
      { outcome: 'record', record: { verdict: 'VERIFIED', revisionId: 'rcpt_1.aaa' } },
      { outcome: 'record', record: { verdict: 'VERIFIED', revisionId: 'rcpt_2.bbb' } },
    ]
    const verdict = libraryAgreesWithCore(opened, journal)
    assert.equal(verdict.ok, false)
    assert.match(verdict.problems.join(' '), /Library shows VERIFIED, journal recorded FAILED/)
  })

  test('two rows sharing a revision are one row rewritten', () => {
    const opened = [
      { outcome: 'record', record: { verdict: 'FAILED', revisionId: 'same' } },
      { outcome: 'record', record: { verdict: 'VERIFIED', revisionId: 'same' } },
    ]
    assert.equal(libraryAgreesWithCore(opened, journal).ok, false)
  })

  test('rows that agree with Core are accepted', () => {
    const opened = [
      { outcome: 'record', record: { verdict: 'FAILED', revisionId: 'rcpt_1.aaa' } },
      { outcome: 'record', record: { verdict: 'VERIFIED', revisionId: 'rcpt_2.bbb' } },
    ]
    assert.equal(libraryAgreesWithCore(opened, journal).ok, true)
  })
})

describe('a perception claim needs the fixture’s text and a timestamp', () => {
  const TOKEN = 'LIVEJOURNEY4482'

  test('a tool that reads nothing does not prove a video was read', () => {
    // `watch_capabilities` satisfied the old rule: a `watch_*` tool that is
    // not `watch_verify`, on a settled turn.
    const phase = [receipt('watch_capabilities', { text: 'watch_capabilities {} {"ok":true}' })]
    const read = perceptionProved(phase, TOKEN)
    assert.equal(read.ok, false)
    assert.match(read.reason, /no call returned LIVEJOURNEY4482|no Watch read tool/)

    const oldRule = phase.some((r) => {
      const tool = toolOf(r)
      return tool?.startsWith('watch_') && tool !== 'watch_verify'
    })
    assert.equal(oldRule, true, 'the counterexample must pass the rule it replaced')
  })

  test('the token without a timestamp is not a read', () => {
    const phase = [receipt('watch_search_sources',
      { text: `watch_search_sources {"query":"${TOKEN}"} {"sources":[]}` })]
    assert.equal(perceptionProved(phase, TOKEN).ok, false)
  })

  test('the token with a timestamp beside it is accepted, whichever tool found it', () => {
    for (const tool of ['watch_search_sources', 'watch_list_sources', 'watch_moment']) {
      const phase = [receipt(tool, {
        text: `${tool} {} {"hits":[{"timestampMs":477,"kind":"ocr","text":"${TOKEN}"}]}`,
      })]
      const read = perceptionProved(phase, TOKEN)
      assert.equal(read.ok, true, `${tool} should count`)
      assert.equal(read.timestampMs, 477)
    }
  })

  test('a different token is not this fixture', () => {
    const phase = [receipt('watch_moment',
      { text: 'watch_moment {} {"hits":[{"timestampMs":477,"text":"SOMETHINGELSE"}]}' })]
    assert.equal(perceptionProved(phase, TOKEN).ok, false)
  })
})

describe('delegation is proved by the child’s result, not its existence', () => {
  test('a subagent receipt that did not complete is not a delegation', () => {
    const phase = [receipt('subagent', { tags: ['state:failed'], text: 'subagent {} {}' })]
    const child = delegationSucceeded(phase, ['totals.json'])
    assert.equal(child.ok, false)
    assert.match(child.reason, /none completed/)

    // The old rule counted the receipt and stopped there.
    const oldRule = phase.filter(r => toolOf(r) === 'subagent').length >= 1
    assert.equal(oldRule, true, 'the counterexample must pass the rule it replaced')
  })

  test('a completed child that reports nothing useful is not enough', () => {
    const phase = [receipt('subagent',
      { tags: ['state:completed'], text: 'subagent {} {"result":"done"}' })]
    assert.equal(delegationSucceeded(phase, ['totals.json']).ok, false)
  })

  test('a completed child naming what it found is accepted', () => {
    const phase = [receipt('subagent', {
      tags: ['state:completed'],
      text: 'subagent {} {"result":"one JSON file under owner-test: totals.json"}',
    })]
    assert.equal(delegationSucceeded(phase, ['totals.json']).ok, true)
  })

  test('no child at all is refused', () => {
    assert.equal(delegationSucceeded([receipt('glob')], ['totals.json']).ok, false)
  })
})
