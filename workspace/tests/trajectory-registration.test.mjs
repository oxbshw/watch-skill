/**
 * Watch registered into DSH's own event system.
 *
 * The definition is driven here the way the DSH engine drives one — match,
 * start, update, buildViewNode — over real session event shapes. That is what
 * makes this a test of the seam rather than of a mock: if upstream's contract
 * and this definition ever disagree, the engine would call it exactly like
 * this and get exactly this result.
 *
 * The view builder is driven the same way, and its output is asserted to equal
 * the pure `project()` fold. Live and replay must be the same picture, and the
 * only way to be sure is to check they agree.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  WATCH_TARGET,
  WatchSelectionStore,
  WatchViewBuilder,
  emptySelection,
  project,
  projectionHash,
  selectRecord,
  watchTrajectoryDefinition,
} from '@deepwatch/dsh-trajectory'

const SESSION = 'sess_reg'
const WORKSPACE = 'ws_reg'

function toolCall(seq, callId, name, args = {}) {
  return { type: 'tool/call', seq, time: 1000 + seq, data: { callId, name, arguments: args, turn: 1, step: 1 } }
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

const ANSWER = {
  ok: true,
  answer: 'it failed at 2:14',
  groundedness: 'sufficient',
  evidence: [{
    evidenceId: 'ev_1',
    sourceRevisionId: 'src@rev1',
    temporalRange: { startMs: 134_000, endMs: 134_000 },
    modality: 'visual',
    provenance: 'observation',
    freshness: 'current',
    text: 'ERROR: exit code 1',
  }],
}

/** Drive the definition the way the DSH engine does. */
function runDefinition(events, sessionId = SESSION) {
  const definition = watchTrajectoryDefinition(sessionId)
  const contexts = new Map()

  for (const event of events) {
    const matched = definition.match(event)
    if (matched === null) continue
    if (matched.role === 'start') {
      const context = { key: `watch:${matched.id}`, kind: definition.kind, id: matched.id }
      context.state = definition.start(context, { event })
      context.start = { event }
      contexts.set(matched.id, context)
      continue
    }
    const context = contexts.get(matched.id)
    if (context === undefined) continue
    context.state = definition.update(context, { event })
  }

  return [...contexts.values()]
    .map(context => definition.buildViewNode(context))
    .filter(node => node !== null)
}

describe('the definition claims the right events', () => {
  test('it claims Watch tool calls and their results', () => {
    const definition = watchTrajectoryDefinition(SESSION)
    assert.deepEqual(
      definition.match(toolCall(1, 'c1', 'watch_ask_source')),
      { id: 'c1', role: 'start' },
    )
    assert.deepEqual(
      definition.match(toolResult(2, 'c1', ANSWER)),
      { id: 'c1', role: 'update' },
    )
  })

  test('it does not claim a non-Watch tool call', () => {
    const definition = watchTrajectoryDefinition(SESSION)
    assert.equal(definition.match(toolCall(1, 'c1', 'bash')), null)
    assert.equal(definition.match({ type: 'turn/start', seq: 1, time: 1, data: {} }), null)
  })

  test('its target does not collide with an upstream one', () => {
    // `chat` and `trajectory` are upstream's. A collision would silently
    // replace one of their view builders.
    assert.equal(WATCH_TARGET, 'watchEvidence')
    assert.notEqual(WATCH_TARGET, 'trajectory')
    assert.notEqual(WATCH_TARGET, 'chat')
    assert.equal(watchTrajectoryDefinition(SESSION).kind, 'watch-evidence')
  })
})

describe('the definition builds the records the fold builds', () => {
  test('a Watch call and result produce one view node with its records', () => {
    const nodes = runDefinition([toolCall(1, 'c1', 'watch_ask_source'), toolResult(2, 'c1', ANSWER)])
    assert.equal(nodes.length, 1)
    assert.equal(nodes[0].target, WATCH_TARGET)
    assert.equal(nodes[0].data.records.length, 1)
    assert.equal(nodes[0].data.records[0].type, 'evidence.created')
    assert.deepEqual(nodes[0].data.records[0].refs.evidenceIds, ['ev_1'])
  })

  test('a call that produced nothing contributes no node at all', () => {
    // A refusal already shows as a failed Tool row in DSH's own ledger. An
    // empty Watch row beside it would be a claim nothing backs.
    const nodes = runDefinition([
      toolCall(1, 'c1', 'watch_ask_source'),
      toolResult(2, 'c1', { ok: false, error: 'bridge.core_unavailable', fix: 'install it' }),
    ])
    assert.deepEqual(nodes, [])
  })

  test('a call with no result yet contributes nothing', () => {
    assert.deepEqual(runDefinition([toolCall(1, 'c1', 'watch_ask_source')]), [])
  })

  test('the definition and the pure fold agree exactly', () => {
    // Live and replay are the same picture, asserted rather than assumed.
    const events = [
      toolCall(1, 'c1', 'watch_ask_source'),
      toolResult(2, 'c1', ANSWER),
      toolCall(3, 'c2', 'watch_verify'),
      toolResult(4, 'c2', {
        verificationId: 'ver_1',
        verdict: 'VERIFIED',
        reason: 'passed',
        contractDigest: 'sha256:abc',
        evaluatedAt: '2026-08-27T00:00:00.000Z',
      }),
    ]
    const builder = new WatchViewBuilder(SESSION)
    const live = builder.replace({ nodes: runDefinition(events) })
    const replayed = project(events, SESSION)

    assert.equal(projectionHash(live), projectionHash(replayed))
    assert.deepEqual(
      live.records.map(record => record.recordId),
      replayed.records.map(record => record.recordId),
    )
  })
})

describe('the view builder', () => {
  test('patching and replacing reach the same projection', () => {
    const events = [toolCall(1, 'c1', 'watch_ask_source'), toolResult(2, 'c1', ANSWER)]
    const nodes = runDefinition(events)

    const replaced = new WatchViewBuilder(SESSION).replace({ nodes })
    const patched = new WatchViewBuilder(SESSION).patch({ nodes })
    assert.equal(projectionHash(replaced), projectionHash(patched))
  })

  test('an empty session is a projection, not undefined', () => {
    const builder = new WatchViewBuilder(SESSION)
    assert.deepEqual(builder.empty.records, [])
    assert.deepEqual(builder.replace({ nodes: [] }).records, [])
  })

  test('records stay in one chronology across contexts', () => {
    const nodes = runDefinition([
      toolCall(10, 'c2', 'watch_verify'),
      toolResult(11, 'c2', {
        verificationId: 'v', verdict: 'FAILED', reason: 'nope',
        contractDigest: 'd', evaluatedAt: 'now',
      }),
      toolCall(1, 'c1', 'watch_ask_source'),
      toolResult(2, 'c1', ANSWER),
    ])
    const projection = new WatchViewBuilder(SESSION).replace({ nodes })
    assert.deepEqual(projection.records.map(record => record.seq), [2, 11])
  })
})

describe('the canonical selection store', () => {
  test('subscribers see a change once', () => {
    const store = new WatchSelectionStore(WORKSPACE, SESSION)
    const seen = []
    const off = store.subscribe(selection => seen.push(selection.evidenceId))
    try {
      const projection = project(
        [toolCall(1, 'c1', 'watch_ask_source'), toolResult(2, 'c1', ANSWER)],
        SESSION,
      )
      store.set(selectRecord(store.get(), projection.records[0]))
      assert.deepEqual(seen, ['ev_1'])
    } finally {
      off()
    }
  })

  test('re-selecting the same thing does not notify', () => {
    // Panels both read and write this store. An echo would loop: a panel
    // reacts to its own change, re-selects, and notifies again.
    const store = new WatchSelectionStore(WORKSPACE, SESSION)
    const projection = project(
      [toolCall(1, 'c1', 'watch_ask_source'), toolResult(2, 'c1', ANSWER)],
      SESSION,
    )
    const selection = selectRecord(store.get(), projection.records[0])
    store.set(selection)

    let notifications = 0
    const off = store.subscribe(() => { notifications += 1 })
    try {
      store.set({ ...selection })
      store.set({ ...selection, origin: 'a-different-panel' })
      assert.equal(notifications, 0, 'only what is selected counts, not who moved it')
    } finally {
      off()
    }
  })

  test('a link round-trips through the store', () => {
    const store = new WatchSelectionStore(WORKSPACE, SESSION)
    const projection = project(
      [toolCall(1, 'c1', 'watch_ask_source'), toolResult(2, 'c1', ANSWER)],
      SESSION,
    )
    store.set(selectRecord(store.get(), projection.records[0]))
    const link = store.link()

    // Client state destroyed.
    const reopened = new WatchSelectionStore(WORKSPACE, SESSION)
    assert.equal(reopened.restore(link), true)
    assert.equal(reopened.get().evidenceId, 'ev_1')
    assert.equal(reopened.get().atMs, 134_000)
    assert.equal(reopened.get().origin, 'deep-link')
  })

  test('a fragment that is not a Watch link leaves the selection alone', () => {
    const store = new WatchSelectionStore(WORKSPACE, SESSION)
    const before = store.get()
    assert.equal(store.restore('#unrelated'), false)
    assert.deepEqual(store.get(), before)
  })

  test('disposing releases every subscriber', () => {
    const store = new WatchSelectionStore(WORKSPACE, SESSION)
    let notified = 0
    store.subscribe(() => { notified += 1 })
    store.dispose()
    store.set({ ...emptySelection(WORKSPACE, SESSION), evidenceId: 'ev_after' })
    assert.equal(notified, 0)
  })
})
