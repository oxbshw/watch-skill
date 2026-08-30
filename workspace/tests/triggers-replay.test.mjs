/**
 * Two rules that only exist if something enforces them.
 *
 * **A live trigger notices, and cannot act.** A trigger fires on observed
 * content, so a trigger that could reach the operator loop would be a page
 * deciding to click something by putting the right words on a screen. The
 * effect type has three members and none of them touches the world; the test
 * checks the set rather than the intent.
 *
 * **A candidate is promoted on a measurement, not on a claim.** ADR-008 makes
 * promotion conditional on an evaluation, and until the replay harness existed
 * the evaluation was supplied by whoever wanted the promotion — which is a
 * governance rule that grants itself. The harness runs the fixtures twice, and
 * treats a safety regression as untradeable against anything else.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  TRIGGER_EFFECTS,
  applyDelta,
  describeTrigger,
  evaluateTriggers,
  mayAct,
  startSession,
} from '@deepwatch/dsh-live'
import {
  canPromote,
  describeEvaluation,
  evaluateCandidate,
  evaluationMatchesFixtures,
  fixtureSetDigest,
  propose,
  scoreCase,
} from '@deepwatch/dsh-memory'

// ── triggers ────────────────────────────────────────────────────────────────

function event(seq, kind, text, overrides = {}) {
  return {
    seq,
    cursor: `c${String(seq)}`,
    kind,
    at: 1_000 * seq,
    mediaMs: 1_000 * seq,
    text,
    range: null,
    evidenceIds: [],
    ...overrides,
  }
}

function trigger(overrides = {}) {
  return {
    triggerId: 't1',
    label: 'deploy failed',
    when: { kind: 'text_contains', phrase: 'failed', caseSensitive: false },
    effect: 'notify',
    cooldownMs: 5_000,
    enabled: true,
    ...overrides,
  }
}

const SESSION = startSession({
  sessionId: 'live_1', target: 'https://example.test', kind: 'stream', startedAtMs: 0,
})

describe('a trigger notices and cannot act', () => {
  test('every effect the type allows is an observation', () => {
    assert.deepEqual([...TRIGGER_EFFECTS], ['pin', 'notify', 'snapshot'])
    for (const effect of TRIGGER_EFFECTS) {
      assert.equal(mayAct({ triggerId: 't', effect, eventSeq: 1, atMs: 0, reason: '' }), false)
    }
  })

  test('the description says so, in words a person reads before creating one', () => {
    assert.match(describeTrigger(trigger()), /never acts on what it sees/)
  })

  test('a text trigger fires on observed text', () => {
    const { firings } = evaluateTriggers(SESSION, [trigger()], [
      event(1, 'speech', 'the deploy step is starting'),
      event(2, 'ocr', 'Deploy FAILED with code 500'),
    ], 3_000)
    assert.equal(firings.length, 1)
    assert.equal(firings[0].eventSeq, 2)
    assert.equal(firings[0].effect, 'notify')
    assert.match(firings[0].reason, /contains "failed"/)
  })

  test('case sensitivity is respected when asked for', () => {
    const strict = trigger({ when: { kind: 'text_contains', phrase: 'FAILED', caseSensitive: true } })
    const { firings } = evaluateTriggers(SESSION, [strict], [
      event(1, 'ocr', 'deploy failed'),
    ], 2_000)
    assert.equal(firings.length, 0)
  })

  test('a cooldown stops a scrolling log from becoming a thousand notifications', () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      event(index + 1, 'ocr', 'the build failed again'))
    const { firings } = evaluateTriggers(SESSION, [trigger({ cooldownMs: 5_000 })], events, 21_000)
    // Events are one second apart; a five-second cooldown admits four of twenty.
    assert.ok(firings.length <= 5, `${String(firings.length)} firings got through the cooldown`)
    assert.ok(firings.length >= 1)
  })

  test('the cooldown carries across calls, so a new batch does not reset it', () => {
    const first = evaluateTriggers(SESSION, [trigger()], [event(1, 'ocr', 'failed')], 1_000)
    assert.equal(first.firings.length, 1)
    const second = evaluateTriggers(
      SESSION, [trigger()], [event(2, 'ocr', 'failed again')], 2_000, first.cooldowns)
    assert.equal(second.firings.length, 0, 'the cooldown reset between batches')
  })

  test('a disabled trigger never fires', () => {
    const { firings } = evaluateTriggers(
      SESSION, [trigger({ enabled: false })], [event(1, 'ocr', 'failed')], 1_000)
    assert.deepEqual(firings, [])
  })

  test('a gap trigger fires on a long gap and not on a short one', () => {
    const rule = trigger({
      triggerId: 't_gap',
      when: { kind: 'gap_longer_than', ms: 5_000 },
      effect: 'snapshot',
    })
    const short = evaluateTriggers(SESSION, [rule], [
      event(1, 'gap', 'gap', { range: { startMs: 0, endMs: 1_000 } }),
    ], 2_000)
    assert.equal(short.firings.length, 0)

    const long = evaluateTriggers(SESSION, [rule], [
      event(1, 'gap', 'gap', { range: { startMs: 0, endMs: 30_000 } }),
    ], 2_000)
    assert.equal(long.firings.length, 1)
    assert.equal(long.firings[0].effect, 'snapshot')
    assert.match(long.firings[0].reason, /30000ms capture gap/)
  })

  test('an event-kind trigger fires on the kind and nothing else', () => {
    const rule = trigger({ when: { kind: 'event_kind', eventKind: 'detector' }, effect: 'pin' })
    const { firings } = evaluateTriggers(SESSION, [rule], [
      event(1, 'speech', 'talking'),
      event(2, 'detector', 'page navigated'),
    ], 3_000)
    assert.equal(firings.length, 1)
    assert.equal(firings[0].eventSeq, 2)
  })

  test('silence is itself information, and fires with no event', () => {
    const observed = applyDelta(SESSION, {
      fromCursor: '', nextCursor: 'c1', isSnapshot: false, status: 'observing',
      events: [event(1, 'speech', 'still here')],
    }, 1_000)
    const rule = trigger({ triggerId: 't_quiet', when: { kind: 'silence_for', ms: 30_000 } })

    const soon = evaluateTriggers(observed, [rule], [], 5_000)
    assert.equal(soon.firings.length, 0)

    const later = evaluateTriggers(observed, [rule], [], 60_000)
    assert.equal(later.firings.length, 1)
    assert.equal(later.firings[0].eventSeq, null)
    assert.match(later.firings[0].reason, /nothing observed/)
  })

  test('a silence trigger does not fire while events are arriving', () => {
    const rule = trigger({ triggerId: 't_quiet', when: { kind: 'silence_for', ms: 1 } })
    const { firings } = evaluateTriggers(SESSION, [rule], [event(1, 'speech', 'talking')], 60_000)
    assert.deepEqual(firings, [])
  })

  test('evaluation is pure, so a replay fires the same triggers', () => {
    const events = [event(1, 'ocr', 'failed'), event(2, 'speech', 'and failed again')]
    const first = evaluateTriggers(SESSION, [trigger()], events, 3_000)
    const second = evaluateTriggers(SESSION, [trigger()], events, 3_000)
    assert.deepEqual(first.firings, second.firings)
  })
})

// ── the replay harness ──────────────────────────────────────────────────────

describe('a candidate is promoted on a measurement, not on a claim', () => {
  const CASES = [
    {
      caseId: 'c1',
      prompt: 'what did the installer report?',
      expects: ['0x80070643'],
      forbids: ['i cannot see', 'probably'],
    },
    {
      caseId: 'c2',
      prompt: 'did the deploy succeed?',
      expects: ['verified', 'evidence'],
      forbids: ['definitely worked'],
    },
  ]

  const candidate = propose({
    candidateId: 'cand_1',
    kind: 'lesson',
    target: { surface: 'answer_style', identifier: 'citation-first' },
    proposedBy: 'agent_1',
    proposedAt: '2026-08-28T10:00:00.000Z',
    content: 'lead with the citation, then the answer',
    rationale: 'people check the timestamp first',
    evidenceIds: ['ev_1'],
  })

  test('the proposal is admitted, so the rest of this is about promotion', () => {
    assert.equal(candidate.accepted, true)
    // Inert on purpose: a successful proposal changes nothing.
    assert.equal(candidate.candidate.stage, 'proposed')
  })

  /** The same candidate, moved to the stage promotion is decided from. */
  const evaluatedCandidate = { ...candidate.candidate, stage: 'evaluated' }

  /** A runner where the candidate genuinely helps. */
  const better = (replayCase, { withCandidate }) => ({
    caseId: replayCase.caseId,
    text: withCandidate
      ? `at 4:12, evidence ev_1: 0x80070643 — verified`
      : 'probably the installer failed',
    latencyMs: withCandidate ? 80 : 120,
    costUnits: withCandidate ? 3 : 4,
  })

  /** A runner where it helps on quality and introduces a violation. */
  const unsafe = (replayCase, { withCandidate }) => ({
    caseId: replayCase.caseId,
    text: withCandidate
      ? '0x80070643, verified with evidence — it definitely worked'
      : 'probably the installer failed',
    latencyMs: withCandidate ? 40 : 120,
    costUnits: withCandidate ? 1 : 4,
  })

  test('a real improvement is measured on both halves of the same run', async () => {
    const report = await evaluateCandidate(evaluatedCandidate, CASES, better,
      () => '2026-08-28T11:00:00.000Z')
    assert.equal(report.evaluation.casesRun, 2)
    assert.ok(report.evaluation.quality.after > report.evaluation.quality.before)
    assert.ok(report.evaluation.latencyMs.after < report.evaluation.latencyMs.before)
    assert.equal(report.evaluation.safetyViolations.after, 0)
    assert.deepEqual([...report.regressions], [])
  })

  test('the evaluation names the fixtures it ran on', async () => {
    const report = await evaluateCandidate(evaluatedCandidate, CASES, better)
    assert.equal(report.evaluation.fixtureSetDigest, fixtureSetDigest(CASES))
    assert.equal(evaluationMatchesFixtures(report.evaluation, CASES), true)
    // Run against something else and the claim stops matching.
    assert.equal(evaluationMatchesFixtures(report.evaluation, [CASES[0]]), false)
  })

  test('the fixture digest is order-independent but content-sensitive', () => {
    assert.equal(fixtureSetDigest(CASES), fixtureSetDigest([...CASES].reverse()))
    assert.notEqual(
      fixtureSetDigest(CASES),
      fixtureSetDigest([{ ...CASES[0], expects: ['something else'] }, CASES[1]]),
    )
  })

  test('a safety violation is counted, not averaged away', async () => {
    const report = await evaluateCandidate(evaluatedCandidate, CASES, unsafe)
    // Summed rather than averaged: one violation across two cases is one
    // violation, and a mean would report half of one.
    assert.equal(report.rawViolations.before, 1, 'the baseline itself violates on c1')
    assert.equal(report.rawViolations.after, 1, 'the candidate violates on c2 instead')
    assert.deepEqual([...report.newViolations], ['c2'])
    assert.deepEqual([...report.fixedViolations], ['c1'])
  })

  test('a swap is a regression, not a wash', async () => {
    // The candidate fixes c1 and breaks c2. The raw totals net to zero, and a
    // gate reading them would have promoted it — so the reported figure is
    // floored at the baseline plus the new violations, and the swap shows as
    // an increase.
    const report = await evaluateCandidate(evaluatedCandidate, CASES, unsafe)
    assert.equal(report.rawViolations.after, report.rawViolations.before,
      'the fixture no longer exercises a swap')
    assert.ok(report.evaluation.safetyViolations.after > report.evaluation.safetyViolations.before,
      'a swap netted to zero and would have been promoted')
  })

  test('a safety regression is refused however good everything else is', async () => {
    const report = await evaluateCandidate(evaluatedCandidate, CASES, unsafe)
    // Quality up, latency down, cost down — and still refused.
    assert.ok(report.evaluation.quality.after > report.evaluation.quality.before)
    assert.ok(report.evaluation.latencyMs.after < report.evaluation.latencyMs.before)
    assert.ok(report.evaluation.cost.after < report.evaluation.cost.before)

    const decision = canPromote(evaluatedCandidate, report.evaluation, {
      approvedBy: 'reviewer_1', approvedAt: '2026-08-28T12:00:00.000Z', policyId: null,
    })
    assert.equal(decision.allowed, false)
  })

  test('the summary leads with the safety regression when there is one', async () => {
    const report = await evaluateCandidate(evaluatedCandidate, CASES, unsafe)
    const line = describeEvaluation(report)
    assert.match(line, /^Refused:/)
    assert.match(line, /Nothing else is weighed against this/)
  })

  test('an improvement summarises as an improvement', async () => {
    const report = await evaluateCandidate(evaluatedCandidate, CASES, better)
    const line = describeEvaluation(report)
    assert.match(line, /quality up/)
    assert.match(line, /no new safety violations/)
  })

  test('scoring is over substrings, so a rewording is not a regression', () => {
    const score = scoreCase(CASES[0], {
      caseId: 'c1',
      text: 'The installer reported 0X80070643 during setup.',
      latencyMs: 10,
      costUnits: 1,
    })
    assert.equal(score.quality, 1, 'a different casing scored as a miss')
    assert.equal(score.violations, 0)
  })

  test('an evaluated candidate with no cases run cannot be promoted', () => {
    const empty = {
      candidateId: evaluatedCandidate.candidateId,
      fixtureSetDigest: fixtureSetDigest([]),
      casesRun: 0,
      quality: { before: 0, after: 0 },
      cost: { before: 0, after: 0 },
      latencyMs: { before: 0, after: 0 },
      safetyViolations: { before: 0, after: 0 },
      evaluatedAt: '2026-08-28T12:00:00.000Z',
    }
    const decision = canPromote(evaluatedCandidate, empty, {
      approvedBy: 'reviewer_1', approvedAt: '2026-08-28T12:00:00.000Z', policyId: null,
    })
    assert.equal(decision.allowed, false)
  })

  test('the proposer still cannot approve their own candidate', async () => {
    const report = await evaluateCandidate(evaluatedCandidate, CASES, better)
    const decision = canPromote(evaluatedCandidate, report.evaluation, {
      approvedBy: 'agent_1', approvedAt: '2026-08-28T12:00:00.000Z', policyId: null,
    })
    assert.equal(decision.allowed, false)
  })

  test('a clean evaluation and an independent approval promote', async () => {
    const report = await evaluateCandidate(evaluatedCandidate, CASES, better)
    const decision = canPromote(evaluatedCandidate, report.evaluation, {
      approvedBy: 'reviewer_1', approvedAt: '2026-08-28T12:00:00.000Z', policyId: null,
    })
    assert.equal(decision.allowed, true)
  })
})
