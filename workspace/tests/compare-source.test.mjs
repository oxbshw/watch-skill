/**
 * Compare, fed from records Watch Core actually minted.
 *
 * The engine was correct and unreachable: the mode was registered with no
 * records, so the shipped product drew Compare's empty state and there was no
 * path from a verification to the surface that compares two of them. These hold
 * the path, and the one property that matters more than the path — that
 * translating a record cannot change what Core said about it.
 *
 * The verdict is the whole risk. A UI that defaulted a missing verdict to
 * VERIFIED, or that mapped an unfamiliar state onto a familiar one, would be
 * minting verdicts outside Core in the one place a person is most likely to
 * believe them: a screen whose entire purpose is showing what changed.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { comparableRecords, labelFor, sideIdOf, toComparable }
  from '@deepwatch/dsh-client-evidence'
import { compareRecords } from '@deepwatch/dsh-client-evidence'
import { CompareModeView } from '@deepwatch/dsh-client-evidence/compare-mode'

// The registration module rather than the package's client entry: that entry
// imports CSS modules for the tool-call rows and cannot be loaded by a test
// runner, and the bundled entry needs `window`. Neither can answer the question
// this file exists to ask.
const REGISTRATION = await import(pathToFileURL(join(
  dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'watch',
  'client-evidence', 'lib', 'client', 'compare-registration.js')).href)

/** A Library record as the wire delivers it. */
function record(overrides = {}) {
  return {
    recordId: 'rec_1',
    revisionId: 'rev_1',
    title: 'totals.json contains the stated totals',
    modality: 'document',
    observedAt: '2026-02-01T10:00:00.000Z',
    source: 'watch-core',
    runId: 'run_1',
    verdict: 'VERIFIED',
    tags: ['verification'],
    evidenceIds: ['ev_1'],
    current: true,
    ...overrides,
  }
}

describe('a translated record says exactly what Core said', () => {
  test('the verdict is copied, not interpreted', () => {
    for (const verdict of ['VERIFIED', 'FAILED', 'PARTIAL', 'INCONCLUSIVE']) {
      assert.equal(toComparable(record({ verdict })).claims[0].verdict, verdict)
    }
  })

  test('a verdict Core never minted stays absent', () => {
    const side = toComparable(record({ verdict: null }))
    assert.equal(side.claims[0].verdict, null)
    assert.equal(side.kind, 'evidence',
      'a record with no verdict was presented as a verification')
  })

  test('a state this build has never seen travels through untouched', () => {
    // Nothing in the translation enumerates the verdicts it accepts, so nothing
    // in it can quietly drop one Core introduces later.
    const side = toComparable(record({ verdict: 'SUPERSEDED_BY_RECHECK' }))
    assert.equal(side.claims[0].verdict, 'SUPERSEDED_BY_RECHECK')
  })

  test('evidence and provenance are carried, never re-derived', () => {
    const side = toComparable(record({ evidenceIds: ['ev_1', 'ev_2'], source: 'core-stdio' }))
    assert.deepEqual(side.claims[0].evidenceIds, ['ev_1', 'ev_2'])
    assert.equal(side.claims[0].provenance, 'core-stdio')
  })

  test('a superseded record keeps saying so', () => {
    assert.match(labelFor(record({ current: false })), /superseded/)
    assert.doesNotMatch(labelFor(record({ current: true })), /superseded/)
  })

  test('an unknown observation time is stated rather than invented', () => {
    assert.match(labelFor(record({ observedAt: null })), /time unknown/)
    assert.equal(toComparable(record({ observedAt: null })).at, null)
  })
})

describe('two records of the same subject stay two records', () => {
  test('sides are identified by revision, so a re-run is comparable with its original', () => {
    const first = record({ recordId: 'rec_1', revisionId: 'rev_1' })
    const second = record({ recordId: 'rec_1', revisionId: 'rev_2' })
    assert.notEqual(sideIdOf(first), sideIdOf(second))
    assert.equal(comparableRecords([first, second]).length, 2,
      'two revisions of one record collapsed into one side')
  })

  test('runs minted in the same millisecond remain distinct and stably ordered', () => {
    const at = '2026-02-01T10:00:00.000Z'
    const listed = comparableRecords([
      record({ recordId: 'rec_b', revisionId: 'rev_b', observedAt: at }),
      record({ recordId: 'rec_a', revisionId: 'rev_a', observedAt: at }),
    ])
    assert.equal(listed.length, 2)
    const again = comparableRecords([
      record({ recordId: 'rec_a', revisionId: 'rev_a', observedAt: at }),
      record({ recordId: 'rec_b', revisionId: 'rev_b', observedAt: at }),
    ])
    assert.deepEqual(listed.map(e => e.recordId), again.map(e => e.recordId),
      'the picker reorders itself between renders, so a selection changes meaning')
  })

  test('one identity appears once', () => {
    const same = record()
    assert.equal(comparableRecords([same, same, same]).length, 1)
  })

  test('verifications are offered before unruled evidence', () => {
    const listed = comparableRecords([
      record({ recordId: 'e', revisionId: 'e', verdict: null }),
      record({ recordId: 'v', revisionId: 'v', verdict: 'FAILED' }),
    ])
    assert.equal(listed[0].recordId, 'v')
  })
})

describe('the comparison of two real Core records', () => {
  test('VERIFIED becoming FAILED is reported as a contradiction', () => {
    // The engine's own distinction, and the stronger of the two: a verdict that
    // merely moved is one thing, and two verdicts that cannot both hold is
    // another. Asserted as the engine actually classifies it rather than as the
    // weaker word, so a regression that downgraded this to `verdict_changed`
    // would fail here.
    const before = toComparable(record({
      recordId: 'r', revisionId: 'rev_1', verdict: 'VERIFIED' }))
    const after = toComparable(record({
      recordId: 'r', revisionId: 'rev_2', verdict: 'FAILED' }))
    const comparison = compareRecords(before, after)
    assert.equal(comparison.comparable, true)
    assert.deepEqual(comparison.claims.map(entry => entry.disposition), ['contradictory'])
    assert.equal(comparison.summary.contradictory, 1)
  })

  test('a verdict that moved without contradicting is reported as changed', () => {
    const before = toComparable(record({
      recordId: 'r', revisionId: 'rev_1', verdict: 'VERIFIED' }))
    const after = toComparable(record({
      recordId: 'r', revisionId: 'rev_2', verdict: 'PARTIAL' }))
    const dispositions = compareRecords(before, after).claims.map(entry => entry.disposition)
    assert.ok(dispositions.includes('verdict_changed'),
      `expected a verdict change, saw ${dispositions.join(', ')}`)
  })

  test('an inconclusive side is not reported as agreement', () => {
    const ruled = toComparable(record({
      recordId: 'r', revisionId: 'rev_1', verdict: 'VERIFIED' }))
    const unruled = toComparable(record({
      recordId: 'r', revisionId: 'rev_2', verdict: 'INCONCLUSIVE' }))
    const comparison = compareRecords(ruled, unruled)
    assert.equal(
      comparison.claims.every(entry => entry.disposition === 'matching'), false,
      'a verdict that became INCONCLUSIVE was drawn as no change at all')
  })

  test('nothing in a comparison mints a verdict', () => {
    const left = toComparable(record({ revisionId: 'rev_1', verdict: null }))
    const right = toComparable(record({ revisionId: 'rev_2', verdict: null }))
    const serialised = JSON.stringify(compareRecords(left, right))
    assert.doesNotMatch(serialised, /"verdict":"(VERIFIED|FAILED|PARTIAL)"/,
      'a verdict appeared in a comparison of two records that had none')
  })
})

describe('the rendered surface', () => {
  test('two Core records reach the picker', () => {
    const records = comparableRecords([
      record({ recordId: 'r', revisionId: 'rev_1', title: 'first run', verdict: 'VERIFIED' }),
      record({ recordId: 'r', revisionId: 'rev_2', title: 'second run', verdict: 'FAILED' }),
    ])
    const html = renderToStaticMarkup(createElement(CompareModeView, { records }))
    assert.match(html, /first run/)
    assert.match(html, /second run/)
    assert.doesNotMatch(html, /There are no records to compare yet/,
      'the surface rendered its empty state while holding two records')
  })

  test('with no records it says so rather than drawing an empty diff', () => {
    const html = renderToStaticMarkup(createElement(CompareModeView, { records: [] }))
    assert.match(html, /There are no records to compare yet/)
  })

  test('a reader is never shown a verdict the records did not carry', () => {
    const records = comparableRecords([
      record({ recordId: 'r', revisionId: 'rev_1', verdict: null, title: 'unruled left' }),
      record({ recordId: 'r', revisionId: 'rev_2', verdict: null, title: 'unruled right' }),
    ])
    const html = renderToStaticMarkup(createElement(CompareModeView, { records }))
    assert.doesNotMatch(html, /VERIFIED|FAILED/)
  })
})

describe('the shipped plugin actually feeds Compare', () => {
  /** A slot service that remembers what was registered into it. */
  function slots() {
    const registered = []
    return {
      registered,
      inject(_name, register) { register() },
      register(entry, component) { registered.push({ entry, component }) },
    }
  }

  /** A context that records nested plugins and hands out a fake remote. */
  function context(withRemote) {
    const service = slots()
    const nested = []
    const ctx = {
      slots: service,
      plugin(definition) {
        nested.push(definition)
        if (!withRemote) return
        definition.apply({ slots: service, remote: { watchQuery: reader() } })
      },
    }
    return { ctx, service, nested }
  }

  const asked = []
  function reader() {
    return {
      librarySearch: async (request) => {
        asked.push(request)
        return { value: { records: [
          { recordId: 'r', revisionId: 'rev_1', title: 'first run', modality: 'document',
            observedAt: '2026-02-01T10:00:00.000Z', source: 'watch-core', runId: 'run_1',
            verdict: 'VERIFIED', tags: [], evidenceIds: [], current: true },
          { recordId: 'r', revisionId: 'rev_2', title: 'second run', modality: 'document',
            observedAt: '2026-02-01T11:00:00.000Z', source: 'watch-core', runId: 'run_2',
            verdict: 'FAILED', tags: [], evidenceIds: [], current: true },
        ] } }
      },
    }
  }

  test('Compare is registered bound to a reader, not bare', () => {
    // The defect this catches: the mode was registered with no records and no
    // way to get any, so the shipped product drew the empty state forever. A
    // bare registration passes every test that renders the component directly
    // with fixtures, which is why this asserts on what the plugin registers.
    const { ctx, service } = context(true)
    REGISTRATION.registerCompare(ctx)
    const compare = service.registered.find(item => item.entry.id === 'compare')
    assert.ok(compare !== undefined, 'no Compare view was registered')

    // Asserted structurally rather than by rendering. Server rendering never
    // runs effects, so a static render of a correctly wired Compare shows the
    // same empty state as a bare one -- which is exactly how a registration
    // with no source of records passed every existing test.
    const element = compare.component({})
    assert.equal(element.type, CompareModeView)
    assert.notEqual(element.props.reads, undefined,
      'the registered Compare view has no source of records')
  })

  test('the reader it is bound to is the one the Host mounted', async () => {
    const before = asked.length
    const { ctx, service } = context(true)
    REGISTRATION.registerCompare(ctx)
    const compare = service.registered.find(item => item.entry.id === 'compare')
    const answer = await compare.component({}).props.reads.librarySearch({
      protocol: 1, requestId: 'probe', query: 'verification',
      modalities: [], limit: 10, cursor: null, deadlineMs: 1000,
    })
    assert.equal(asked.length, before + 1, 'the bound reader was never consulted')
    assert.equal(comparableRecords(answer.value.records).length, 2)
  })

  test('Compare declares the dependency it needs, in its own scope', () => {
    // Declared on a nested plugin rather than the whole package: the tool views
    // need no Host round-trip, and parking them because a profile mounts no
    // query gateway would lose them for an unrelated reason.
    const { ctx, nested } = context(false)
    REGISTRATION.registerCompare(ctx)
    assert.equal(nested.length, 1, 'Compare was not mounted in its own scope')
    assert.deepEqual(nested[0].inject, REGISTRATION.COMPARE_INJECT)
    assert.deepEqual(REGISTRATION.COMPARE_INJECT,
      ['slots', 'remote', 'remote.watchQuery'])
  })

  test('without a query gateway no Compare tab is drawn at all', () => {
    // Better than a tab that loads nothing: a surface that cannot explain its
    // own emptiness is the defect this whole file is about.
    const { ctx, service } = context(false)
    REGISTRATION.registerCompare(ctx)
    assert.equal(service.registered.some(item => item.entry.id === 'compare'), false)
  })
})
