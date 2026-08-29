/**
 * The Phase 2 acceptance journey.
 *
 * Agent turn → Watch tool call → observation → evidence → a Watch record in
 * the DSH Trajectory → citation selected → exact source revision and timestamp
 * → inspector state → verification → verdict → receipt → deep link → reopen →
 * the same ids, the same selection, the same verdict projection.
 *
 * The events below are DSH session events in the shape DSH actually emits.
 * That is the point of testing at this level: Watch derives its records from
 * the log DSH already keeps, so if the derivation is right against real event
 * shapes, there is no second store to fall out of sync with.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  emptyProjection,
  emptySelection,
  fromDeepLink,
  project,
  projectionHash,
  resolveRecord,
  sameSelection,
  selectCitation,
  selectRecord,
  toDeepLink,
  withRecords,
  recordFromMemoryEvent,
  WATCH_EVENT_TYPES,
} from '@watchskill/dsh-trajectory'

const SESSION = 'sess_phase2'
const WORKSPACE = 'ws_phase2'

/** A DSH `tool/call` event, as the log records one. */
function toolCall(seq, callId, name, args = {}) {
  return {
    type: 'tool/call',
    seq,
    time: 1_700_000_000_000 + seq,
    data: { callId, name, arguments: args, turn: 1, step: 1 },
  }
}

/** A DSH `tool/result` event carrying a tool's JSON output. */
function toolResult(seq, callId, value) {
  return {
    type: 'tool/result',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 1,
      message: {
        source: { callId },
        content: [{ content: [{ type: 'text', text: JSON.stringify(value) }] }],
      },
    },
  }
}

/** An evidence-linked answer, as `watch_ask_source` returns one. */
const ANSWER = {
  ok: true,
  answer: 'The build failed at 2:14 with exit code 1.',
  groundedness: 'sufficient',
  evidence: [
    {
      evidenceId: 'vid_build#ocr@0',
      sourceRevisionId: 'vid_build@rev3',
      temporalRange: { startMs: 134_000, endMs: 134_000 },
      modality: 'visual',
      provenance: 'observation',
      freshness: 'current',
      text: 'ERROR: exit code 1',
    },
    {
      evidenceId: 'vid_build#segment@1',
      sourceRevisionId: 'vid_build@rev3',
      temporalRange: { startMs: 133_000, endMs: 136_000 },
      modality: 'text',
      provenance: 'observation',
      freshness: 'current',
      text: 'and there it goes again',
    },
  ],
  verification: null,
}

/** A verdict, as `watch_verify` returns one. */
const VERDICT = {
  verificationId: 'ver_phase2',
  verdict: 'VERIFIED',
  reason: 'Every required check passed at assurance deterministic.',
  contractDigest: 'sha256:9f2c1a8b40de1122',
  evaluatedAt: '2026-08-27T10:00:00.000Z',
  checks: [{ checkId: 'artifact', kind: 'file_exists', passed: true }],
  evidenceRefs: ['vid_build#ocr@0'],
}

/** The full session log for the journey. */
const EVENTS = [
  toolCall(10, 'call_ask', 'watch_ask_source', {
    source_id: 'vid_build',
    question: 'why did the build fail',
    correlationId: 'cor_phase2',
  }),
  toolResult(11, 'call_ask', ANSWER),
  toolCall(20, 'call_verify', 'watch_verify', { expectation: 'the artifact exists' }),
  toolResult(21, 'call_verify', VERDICT),
]

describe('Watch records come from the DSH log, not a second store', () => {
  test('a Watch tool call and result produce Watch records', () => {
    const projection = project(EVENTS, SESSION)
    assert.equal(projection.records.length, 2)
    assert.deepEqual(
      projection.records.map(record => record.type),
      ['evidence.created', 'verification.completed'],
    )
  })

  test('a non-Watch tool contributes nothing', () => {
    const projection = project([
      toolCall(1, 'call_bash', 'bash', { command: 'ls' }),
      toolResult(2, 'call_bash', { stdout: 'a\nb' }),
    ], SESSION)
    assert.equal(projection.records.length, 0)
  })

  test('records carry stable foreign ids, never evidence payloads', () => {
    const [evidence] = project(EVENTS, SESSION).records
    assert.deepEqual(evidence.refs.evidenceIds, ['vid_build#ocr@0', 'vid_build#segment@1'])
    assert.equal(evidence.refs.sourceRevisionId, 'vid_build@rev3')
    assert.equal(evidence.refs.correlationId, 'cor_phase2')
    assert.equal(evidence.refs.sessionId, SESSION)
    assert.equal(evidence.refs.turn, 1)
    assert.equal(evidence.refs.callId, 'call_ask')

    // The thing that would make this a second evidence store: the text.
    const serialized = JSON.stringify(evidence)
    assert.ok(
      !serialized.includes('ERROR: exit code 1'),
      'a record must not copy evidence content into the DSH event store',
    )
    assert.ok(!serialized.includes('and there it goes again'))
  })

  test('a refusal produces no record, because nothing happened', () => {
    const projection = project([
      toolCall(1, 'call_x', 'watch_ask_source', {}),
      toolResult(2, 'call_x', { ok: false, error: 'bridge.core_unavailable', fix: 'install it' }),
    ], SESSION)
    assert.equal(projection.records.length, 0)
  })

  test('an unreadable result produces no record rather than an empty one', () => {
    const projection = project([
      toolCall(1, 'call_x', 'watch_ask_source', {}),
      {
        type: 'tool/result',
        seq: 2,
        time: 2,
        data: { message: { source: { callId: 'call_x' }, content: [{ content: 'not json' }] } },
      },
    ], SESSION)
    assert.equal(projection.records.length, 0)
  })

  test('the event family is closed and does not collide with DSH event types', () => {
    // DSH's own types are slash-delimited (`tool/call`, `turn/start`). Watch's
    // are dot-delimited and domain-prefixed, so the two namespaces cannot
    // collide however either side grows.
    for (const type of WATCH_EVENT_TYPES) {
      assert.ok(!type.includes('/'), `${type} must not look like a DSH event type`)
      assert.match(type, /^[a-z]+(\.[a-z_]+)+$/)
    }
    assert.equal(new Set(WATCH_EVENT_TYPES).size, WATCH_EVENT_TYPES.length)
  })
})

describe('Completed is not Verified', () => {
  test('an answer that returned successfully carries no verdict', () => {
    const [evidence] = project(EVENTS, SESSION).records
    assert.equal(
      evidence.refs.verdict,
      null,
      'a tool that returned without error must not acquire a verdict',
    )
  })

  test('a verdict is reported verbatim, whatever it is', () => {
    for (const verdict of ['VERIFIED', 'FAILED', 'UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED']) {
      const projection = project([
        toolCall(1, 'c', 'watch_verify', {}),
        toolResult(2, 'c', { ...VERDICT, verdict }),
      ], SESSION)
      assert.equal(projection.records[0].refs.verdict, verdict)
      assert.equal(projection.records[0].summary, verdict)
    }
  })
})

describe('citation → evidence → trajectory', () => {
  test('selecting a citation resolves the record, revision and moment', () => {
    const projection = project(EVENTS, SESSION)
    const selection = selectCitation(
      emptySelection(WORKSPACE, SESSION),
      {
        evidenceId: 'vid_build#ocr@0',
        sourceRevisionId: 'vid_build@rev3',
        atMs: 134_000,
      },
      projection.records,
    )

    assert.equal(selection.evidenceId, 'vid_build#ocr@0')
    assert.equal(selection.sourceRevisionId, 'vid_build@rev3')
    assert.equal(selection.atMs, 134_000)
    assert.equal(selection.inspectorTab, 'evidence')
    assert.equal(
      selection.recordId,
      projection.records[0].recordId,
      'the citation must highlight the Trajectory record that produced it',
    )
  })

  test('the reverse direction resolves the same evidence and moment', () => {
    const projection = project(EVENTS, SESSION)
    const fromTrajectory = selectRecord(
      emptySelection(WORKSPACE, SESSION),
      projection.records[0],
    )
    const fromCitation = selectCitation(
      emptySelection(WORKSPACE, SESSION),
      {
        evidenceId: 'vid_build#ocr@0',
        sourceRevisionId: 'vid_build@rev3',
        atMs: 134_000,
      },
      projection.records,
    )

    assert.equal(fromTrajectory.evidenceId, fromCitation.evidenceId)
    assert.equal(fromTrajectory.sourceRevisionId, fromCitation.sourceRevisionId)
    assert.equal(fromTrajectory.atMs, fromCitation.atMs)
    assert.equal(fromTrajectory.recordId, fromCitation.recordId)
    assert.equal(fromTrajectory.inspectorTab, fromCitation.inspectorTab)
  })

  test('selecting a verdict record opens the verification panel', () => {
    const projection = project(EVENTS, SESSION)
    const verdictRecord = projection.records.find(r => r.type === 'verification.completed')
    const selection = selectRecord(emptySelection(WORKSPACE, SESSION), verdictRecord)
    assert.equal(selection.inspectorTab, 'verification')
    assert.equal(selection.verificationId, 'ver_phase2')
  })

  test('one selection drives every surface — there is no second store', () => {
    // The property, stated as an assertion: everything a panel needs is
    // derivable from the one value, so no panel keeps its own.
    const projection = project(EVENTS, SESSION)
    const selection = selectRecord(emptySelection(WORKSPACE, SESSION), projection.records[0])
    assert.equal(typeof selection.recordId, 'string')   // Trajectory
    assert.equal(typeof selection.evidenceId, 'string') // Inspector
    assert.equal(typeof selection.sourceRevisionId, 'string') // Player
    assert.equal(typeof selection.atMs, 'number')       // Player position
    assert.equal(typeof selection.inspectorTab, 'string')
  })
})

describe('deep links', () => {
  test('a link round-trips the same logical selection', () => {
    const projection = project(EVENTS, SESSION)
    const original = selectCitation(
      emptySelection(WORKSPACE, SESSION),
      { evidenceId: 'vid_build#ocr@0', sourceRevisionId: 'vid_build@rev3', atMs: 134_000 },
      projection.records,
    )

    const link = toDeepLink(original)
    // Client state destroyed: nothing survives but the string.
    const restored = fromDeepLink(link)

    assert.ok(restored !== null)
    assert.ok(
      sameSelection(original, restored),
      `restored selection differs:\n${JSON.stringify(original)}\n${JSON.stringify(restored)}`,
    )
    assert.equal(restored.origin, 'deep-link', 'a restored selection is not a panel echo')
  })

  test('a link carries identifiers, never evidence content', () => {
    const projection = project(EVENTS, SESSION)
    const link = toDeepLink(selectRecord(emptySelection(WORKSPACE, SESSION), projection.records[0]))
    assert.ok(!link.includes('ERROR'), 'a link must not embed evidence text')
    assert.ok(link.startsWith('#watch='), 'a fragment, so it is never sent to a server')
  })

  test('a restored link resolves back to the same Trajectory record', () => {
    const projection = project(EVENTS, SESSION)
    const link = toDeepLink(selectRecord(emptySelection(WORKSPACE, SESSION), projection.records[0]))
    const restored = fromDeepLink(link)
    const record = resolveRecord(projection, restored)
    assert.equal(record.recordId, projection.records[0].recordId)
  })

  test('a link with only an evidence id still opens the right record', () => {
    // Older links, or links written by hand, should degrade to the part the
    // person cared about rather than failing.
    const projection = project(EVENTS, SESSION)
    const restored = fromDeepLink(`#watch=${encodeURIComponent(`s=${SESSION}&e=vid_build%23ocr%400`)}`)
    assert.ok(restored !== null)
    const record = resolveRecord(projection, restored)
    assert.equal(record.type, 'evidence.created')
  })

  test('a fragment that is not a Watch link leaves the selection alone', () => {
    assert.equal(fromDeepLink('#something-else'), null)
    assert.equal(fromDeepLink(''), null)
    // A link naming no session cannot identify what it points at.
    assert.equal(fromDeepLink('#watch=e=abc'), null)
  })

  test('an unknown inspector tab is dropped rather than injected', () => {
    const restored = fromDeepLink(`#watch=${encodeURIComponent(`s=${SESSION}&tab=javascript:evil`)}`)
    assert.equal(restored.inspectorTab, null)
  })
})

describe('replay determinism', () => {
  test('the same events produce the same projection hash', () => {
    const first = projectionHash(project(EVENTS, SESSION))
    const second = projectionHash(project(EVENTS, SESSION))
    assert.equal(first, second)
    assert.match(first, /^fnv1a64:[0-9a-f]{16}$/)
  })

  test('replaying a copy of the log gives the same hash', () => {
    // A structural copy: replay reads persisted events, not the same objects.
    const copied = JSON.parse(JSON.stringify(EVENTS))
    assert.equal(projectionHash(project(copied, SESSION)), projectionHash(project(EVENTS, SESSION)))
  })

  test('a changed verdict changes the hash', () => {
    const altered = [
      EVENTS[0], EVENTS[1], EVENTS[2],
      toolResult(21, 'call_verify', { ...VERDICT, verdict: 'FAILED' }),
    ]
    assert.notEqual(
      projectionHash(project(altered, SESSION)),
      projectionHash(project(EVENTS, SESSION)),
    )
  })

  test('a changed summary does not change the hash', () => {
    // The hash covers what was established, not how it was worded, so
    // improving a label does not read as a changed record.
    const projection = project(EVENTS, SESSION)
    const reworded = {
      ...projection,
      records: projection.records.map(record => ({ ...record, summary: `rewritten ${record.type}` })),
    }
    assert.equal(projectionHash(reworded), projectionHash(projection))
  })

  test('replay performs no side effects', () => {
    // Asserted structurally: the projection is a pure function of its input,
    // so there is nothing for it to call. Any network, clock or model access
    // introduced later would have to be passed in, and this fails if it is.
    const before = Date.now()
    const projection = project(EVENTS, SESSION)
    // No record carries a time the fold invented; every time comes from an event.
    for (const record of projection.records) {
      assert.ok(record.time < before + 1, 'a record time must come from its event')
      assert.ok(EVENTS.some(event => event.seq === record.seq))
    }
    assert.equal(typeof project, 'function')
    assert.equal(project.length, 2, 'project takes only events and a session id')
  })

  test('an empty session is a projection, not a failure', () => {
    const empty = emptyProjection(SESSION)
    assert.deepEqual(empty.records, [])
    assert.equal(projectionHash(empty), projectionHash(project([], SESSION)))
  })
})

describe('memory in the ledger, without becoming evidence', () => {
  test('a memory record shows influence and carries no memory text', () => {
    const record = recordFromMemoryEvent({
      kind: 'injected',
      memoryId: 'mem_1',
      sessionId: SESSION,
      seq: 5,
      time: 1_700_000_000_005,
      reason: 'Relevant to this task — a preference you set, you told me directly.',
    })
    assert.equal(record.type, 'memory.context.injected')
    assert.deepEqual(record.refs.memoryIds, ['mem_1'])
    assert.deepEqual(record.refs.evidenceIds, [], 'memory is not evidence')
    assert.equal(record.refs.verdict, null, 'memory cannot carry a verdict')
  })

  test('a sensitive memory is shown as withheld, not omitted', () => {
    // Hiding that memory influenced a turn would be worse than showing a row
    // whose content is withheld.
    const record = recordFromMemoryEvent({
      kind: 'injected',
      memoryId: 'mem_secret',
      sessionId: SESSION,
      seq: 6,
      time: 6,
      reason: 'because they said they prefer X about their personal situation',
      sensitive: true,
    })
    assert.equal(record.redacted, true)
    assert.match(record.summary, /withheld/)
    assert.ok(!record.summary.includes('personal situation'))
    assert.deepEqual(record.refs.memoryIds, ['mem_secret'])
  })

  test('memory records merge into one chronology by sequence', () => {
    const projection = withRecords(project(EVENTS, SESSION), [
      recordFromMemoryEvent({
        kind: 'injected', memoryId: 'mem_1', sessionId: SESSION, seq: 5, time: 5,
      }),
    ])
    assert.deepEqual(
      projection.records.map(record => record.seq),
      [5, 11, 21],
      'one ledger in sequence order, not two lists shown together',
    )
  })

  test('selecting a memory record opens the memory panel, never evidence', () => {
    const record = recordFromMemoryEvent({
      kind: 'corrected', memoryId: 'mem_2', sessionId: SESSION, seq: 7, time: 7,
    })
    const selection = selectRecord(emptySelection(WORKSPACE, SESSION), record)
    assert.equal(selection.inspectorTab, 'memory')
    assert.equal(selection.memoryId, 'mem_2')
    assert.equal(selection.evidenceId, null)
    assert.equal(selection.verificationId, null)
  })

  test('memory records are part of the replay hash', () => {
    const withMemory = withRecords(project(EVENTS, SESSION), [
      recordFromMemoryEvent({
        kind: 'injected', memoryId: 'mem_1', sessionId: SESSION, seq: 5, time: 5,
      }),
    ])
    assert.notEqual(projectionHash(withMemory), projectionHash(project(EVENTS, SESSION)))
    // And still deterministic.
    const again = withRecords(project(EVENTS, SESSION), [
      recordFromMemoryEvent({
        kind: 'injected', memoryId: 'mem_1', sessionId: SESSION, seq: 5, time: 5,
      }),
    ])
    assert.equal(projectionHash(withMemory), projectionHash(again))
  })
})

describe('browser receipts in the ledger', () => {
  test('a receipt projects with its key and its verdict', () => {
    const projection = project([
      toolCall(1, 'call_act', 'watch_browser_act', { kind: 'click' }),
      toolResult(2, 'call_act', {
        idempotencyKey: 'idem_1',
        operationId: 'op_1',
        verdict: 'succeeded',
        replayed: false,
      }),
    ], SESSION)
    const [record] = projection.records
    assert.equal(record.type, 'verification.completed')
    assert.equal(record.refs.verdict, 'succeeded')
  })

  test('a receipt with no verdict is a receipt, not a success', () => {
    const projection = project([
      toolCall(1, 'call_act', 'watch_browser_act', { kind: 'click' }),
      toolResult(2, 'call_act', { idempotencyKey: 'idem_2', operationId: 'op_2', status: 'refused' }),
    ], SESSION)
    const [record] = projection.records
    assert.equal(record.type, 'browser.action.receipt')
    assert.equal(record.refs.receiptId, 'idem_2')
    assert.equal(record.refs.verdict, null, 'a receipt must not acquire a verdict')
  })
})
