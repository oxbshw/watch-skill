/**
 * The Library, and the promise that makes a citation worth keeping.
 *
 * The journey under test is the one from the vision:
 *
 *   index a source → search → result → evidence → exact timestamp →
 *   the source changes → the old evidence still opens → it is marked stale
 *
 * Two things are easy to get wrong in ways nobody notices for months. Old
 * evidence can quietly stop resolving, which turns every receipt older than the
 * last re-index into a dead link. Or it can quietly start resolving against the
 * *new* revision, which is worse: the citation then points at something nobody
 * observed, and it looks fine.
 *
 * The other rule tested here is a separation: the Library is not memory. It
 * holds what was seen, not what is believed, and nothing in it carries a scope,
 * a confidence or a status.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  applyFilters,
  currentRevision,
  describeSearch,
  facetsFor,
  findRevision,
  freshnessOf,
  isAddressable,
  isCurrentRevision,
  locate,
  rankResults,
  searchPlan,
  withRevision,
} from '@deepwatch/dsh-library'

import { LibrarySurface, RevisionHistory } from '@deepwatch/dsh-library/components'

function revision(sourceId, number, overrides = {}) {
  return {
    sourceRevisionId: `${sourceId}@r${String(number)}`,
    sourceId,
    revision: number,
    contentDigest: `sha256:${sourceId}-${String(number)}`,
    observedAt: `2026-08-2${String(number)}T10:00:00.000Z`,
    durationMs: 600_000,
    indexState: 'indexed',
    indexError: null,
    scripts: ['Latin'],
    ...overrides,
  }
}

function source(sourceId, overrides = {}) {
  return {
    sourceId,
    kind: 'video',
    title: `Source ${sourceId}`,
    locator: `https://example.test/${sourceId}`,
    revisions: [revision(sourceId, 1)],
    collections: ['onboarding'],
    entities: [],
    ...overrides,
  }
}

function evidence(sourceRevisionId, overrides = {}) {
  return {
    sourceRevisionId,
    temporalRange: { startMs: 90_000, endMs: 92_000 },
    freshness: 'current',
    ...overrides,
  }
}

function hit(sourceId, sourceRevisionId, path, overrides = {}) {
  return {
    sourceId,
    sourceRevisionId,
    range: { startMs: 90_000, endMs: 92_000 },
    text: 'the deploy step is here',
    path,
    score: 1,
    evidenceIds: ['ev_1'],
    ...overrides,
  }
}

function result(sourceId, hits, overrides = {}) {
  return {
    sourceId,
    title: `Source ${sourceId}`,
    kind: 'video',
    hits,
    current: true,
    ...overrides,
  }
}

// ── revisions ───────────────────────────────────────────────────────────────

describe('a source that changed is a different revision', () => {
  test('the current revision is the highest, not the most recently written', () => {
    const s = {
      ...source('src_1'),
      revisions: [
        revision('src_1', 2, { observedAt: '2026-08-20T10:00:00.000Z' }),
        revision('src_1', 1, { observedAt: '2026-08-27T10:00:00.000Z' }),
      ],
    }
    assert.equal(currentRevision(s).revision, 2)
  })

  test('adding a revision keeps every older one', () => {
    const v2 = withRevision(source('src_1'), revision('src_1', 2))
    assert.equal(v2.revisions.length, 2)
    assert.notEqual(findRevision(v2, 'src_1@r1'), null)
    assert.equal(currentRevision(v2).sourceRevisionId, 'src_1@r2')
  })

  test('an older indexed revision becomes stale, not deleted', () => {
    const v2 = withRevision(source('src_1'), revision('src_1', 2))
    assert.equal(findRevision(v2, 'src_1@r1').indexState, 'stale')
    assert.equal(findRevision(v2, 'src_1@r2').indexState, 'indexed')
  })

  test('a source with no revisions has no current one, rather than a guess', () => {
    assert.equal(currentRevision({ ...source('src_1'), revisions: [] }), null)
  })
})

describe('the journey: index, search, cite, re-index, still open', () => {
  test('evidence against the current revision keeps the freshness it was given', () => {
    const sources = [source('src_1')]
    assert.equal(freshnessOf(evidence('src_1@r1'), sources), 'current')
    assert.equal(freshnessOf(evidence('src_1@r1', { freshness: 'gap' }), sources), 'gap',
      'the Library upgraded a gap to current')
  })

  test('after a re-index, the old evidence is stale', () => {
    const sources = [withRevision(source('src_1'), revision('src_1', 2))]
    assert.equal(freshnessOf(evidence('src_1@r1'), sources), 'stale')
    assert.equal(freshnessOf(evidence('src_1@r2'), sources), 'current')
  })

  test('after a re-index, the old evidence still opens', () => {
    const sources = [withRevision(source('src_1'), revision('src_1', 2))]
    assert.equal(isAddressable(evidence('src_1@r1'), sources), true)
    const located = locate(evidence('src_1@r1'), sources)
    assert.notEqual(located, null)
    assert.equal(located.revision, 1)
    assert.deepEqual(located.range, { startMs: 90_000, endMs: 92_000 },
      'the exact timestamp moved')
  })

  test('old evidence is never re-pointed at the new revision', () => {
    const sources = [withRevision(source('src_1'), revision('src_1', 2))]
    const located = locate(evidence('src_1@r1'), sources)
    assert.equal(located.sourceRevisionId, 'src_1@r1')
    assert.equal(located.supersededBy, 'src_1@r2',
      'the surface has no way to offer the current revision')
  })

  test('evidence whose source the Library does not hold is unavailable, not expired', () => {
    assert.equal(freshnessOf(evidence('missing@r1'), [source('src_1')]), 'unavailable')
    assert.equal(isAddressable(evidence('missing@r1'), [source('src_1')]), false)
    assert.equal(locate(evidence('missing@r1'), [source('src_1')]), null)
  })

  test('isCurrentRevision answers about the source, not about one observation', () => {
    const sources = withRevision(source('src_1'), revision('src_1', 2))
    assert.equal(isCurrentRevision(sources, 'src_1@r2'), true)
    assert.equal(isCurrentRevision(sources, 'src_1@r1'), false)
  })
})

// ── search ──────────────────────────────────────────────────────────────────

describe('search says how it found things', () => {
  test('hybrid is reported as hybrid', () => {
    const plan = searchPlan({ lexical: true, semantic: true })
    assert.equal(plan.path, 'both')
    assert.equal(plan.degradedBecause, '')
  })

  test('missing embeddings is a stated degradation, not silence', () => {
    const plan = searchPlan({ lexical: true, semantic: false })
    assert.equal(plan.path, 'lexical')
    assert.match(plan.degradedBecause, /embeddings/)
    assert.notEqual(plan.fix, '')
    assert.match(plan.explanation, /paraphrase/)
  })

  test('a missing lexical index is also stated', () => {
    const plan = searchPlan({ lexical: false, semantic: true })
    assert.equal(plan.path, 'semantic')
    assert.match(plan.degradedBecause, /lexical/)
  })

  test('nothing available says so and says what to do', () => {
    const plan = searchPlan({ lexical: false, semantic: false })
    assert.equal(plan.path, 'none')
    assert.notEqual(plan.fix, '')
  })

  test('the results line always names the path', () => {
    const line = describeSearch(searchPlan({ lexical: true, semantic: false }), [
      result('src_1', [hit('src_1', 'src_1@r1', 'lexical')]),
    ])
    assert.match(line, /1 hit\(s\) in 1 source\(s\)/)
    assert.match(line, /Exact matching only/)
  })

  test('an exact match outranks a pile of paraphrases', () => {
    const ranked = rankResults([
      result('src_semantic', [
        hit('src_semantic', 'src_semantic@r1', 'semantic'),
        hit('src_semantic', 'src_semantic@r1', 'semantic', { text: 'b' }),
        hit('src_semantic', 'src_semantic@r1', 'semantic', { text: 'c' }),
      ]),
      result('src_lexical', [hit('src_lexical', 'src_lexical@r1', 'lexical')]),
    ])
    assert.equal(ranked[0].sourceId, 'src_lexical')
  })

  test('ranking is stable for equal results', () => {
    const results = [
      result('src_b', [hit('src_b', 'src_b@r1', 'lexical')]),
      result('src_a', [hit('src_a', 'src_a@r1', 'lexical')]),
    ]
    assert.deepEqual(rankResults(results).map(r => r.sourceId), ['src_a', 'src_b'])
    assert.deepEqual(rankResults([...results].reverse()).map(r => r.sourceId), ['src_a', 'src_b'])
  })
})

describe('facets come from the results, not from the schema', () => {
  const sources = [
    source('src_1', { collections: ['onboarding'] }),
    source('src_2', { kind: 'page', collections: ['runbooks'], revisions: [revision('src_2', 1, { scripts: ['Arabic'] })] }),
  ]
  const results = [
    result('src_1', [hit('src_1', 'src_1@r1', 'lexical')]),
    result('src_2', [hit('src_2', 'src_2@r1', 'semantic')], { kind: 'page' }),
  ]

  test('only values that occur are offered', () => {
    const facets = facetsFor(results, sources)
    assert.deepEqual(facets.kind.map(f => f.value).sort(), ['page', 'video'])
    assert.deepEqual(facets.script.map(f => f.value).sort(), ['Arabic', 'Latin'])
    assert.equal(facets.kind.every(f => f.count > 0), true)
  })

  test('a facet with nothing behind it is absent, not shown as zero', () => {
    const facets = facetsFor([results[0]], sources)
    assert.equal(facets.kind.some(f => f.value === 'page'), false)
    assert.equal(facets.script.some(f => f.value === 'Arabic'), false)
  })

  test('the retrieval path is itself a facet', () => {
    const facets = facetsFor(results, sources)
    assert.deepEqual(facets.path.map(f => f.value).sort(), ['lexical', 'semantic'])
  })

  test('filters narrow by kind, collection, script and index state', () => {
    assert.deepEqual(applyFilters(results, sources, { kinds: ['page'] }).map(r => r.sourceId), ['src_2'])
    assert.deepEqual(applyFilters(results, sources, { collections: ['runbooks'] }).map(r => r.sourceId), ['src_2'])
    assert.deepEqual(applyFilters(results, sources, { scripts: ['Arabic'] }).map(r => r.sourceId), ['src_2'])
    assert.deepEqual(applyFilters(results, sources, { indexStates: ['indexed'] }).map(r => r.sourceId).sort(), ['src_1', 'src_2'])
  })

  test('currentOnly drops results against superseded revisions', () => {
    const stale = [result('src_1', [hit('src_1', 'src_1@r1', 'lexical')], { current: false })]
    assert.deepEqual(applyFilters(stale, sources, { currentOnly: true }), [])
    assert.equal(applyFilters(stale, sources, {}).length, 1)
  })
})

// ── separation ──────────────────────────────────────────────────────────────

describe('the Library is not memory', () => {
  test('nothing the Library exports carries memory’s vocabulary', async () => {
    const library = await import('@deepwatch/dsh-library')
    const names = Object.keys(library)
    for (const forbidden of ['MemoryRecord', 'MemoryLedger', 'toCard', 'recordsForView', 'availableOperations']) {
      assert.equal(names.includes(forbidden), false, `the Library re-exports ${forbidden}`)
    }
  })

  test('a source has no scope, confidence or status', () => {
    const s = source('src_1')
    for (const field of ['subjectScope', 'confidence', 'status', 'origin', 'sensitivity']) {
      assert.equal(field in s, false, `a source carries ${field}, which belongs to memory`)
    }
  })
})

// ── rendering ───────────────────────────────────────────────────────────────

describe('what the Library draws', () => {
  const sources = [withRevision(source('src_1'), revision('src_1', 2))]
  const results = [result('src_1', [hit('src_1', 'src_1@r1', 'lexical')], { current: false })]

  function render(plan) {
    return renderToStaticMarkup(createElement(LibrarySurface, {
      plan,
      results,
      facets: facetsFor(results, sources),
      sources,
      freshnessOf: h => freshnessOf({ sourceRevisionId: h.sourceRevisionId, freshness: 'current' }, sources),
      onOpenHit: () => {},
      onOpenRevision: () => {},
      onFilter: () => {},
    }))
  }

  test('the retrieval path is on the row, not in a legend', () => {
    const markup = render(searchPlan({ lexical: true, semantic: true }))
    assert.match(markup, /data-watch-path="lexical"/)
    assert.match(markup, /data-watch-hit-path="lexical"/)
  })

  test('a degraded search says what is missing and how to fix it', () => {
    const markup = render(searchPlan({ lexical: true, semantic: false }))
    assert.match(markup, /data-watch-search-plan="lexical"/)
    assert.match(markup, /data-watch-search-fix/)
    assert.match(markup, /Bind an embeddings role/)
  })

  test('a stale hit says stale, with a glyph as well as a tone', () => {
    const markup = render(searchPlan({ lexical: true, semantic: true }))
    assert.match(markup, /data-watch-freshness="stale"/)
    assert.match(markup, /⌛/)
  })

  test('a superseded source says the source changed', () => {
    const markup = render(searchPlan({ lexical: true, semantic: true }))
    assert.match(markup, /The source has changed since these were observed/)
  })

  test('every revision is listed and openable, including superseded ones', () => {
    const markup = renderToStaticMarkup(createElement(RevisionHistory, {
      source: sources[0],
      onOpen: () => {},
    }))
    assert.match(markup, /data-watch-revision="src_1@r1"/)
    assert.match(markup, /data-watch-revision="src_1@r2"/)
    assert.match(markup, /data-watch-index-state="stale"/)
    assert.match(markup, /current/)
  })

  test('a failed index says why on the revision it failed on', () => {
    const failed = {
      ...source('src_1'),
      revisions: [revision('src_1', 1, { indexState: 'failed', indexError: 'ffmpeg is not installed' })],
    }
    const markup = renderToStaticMarkup(createElement(RevisionHistory, { source: failed, onOpen: () => {} }))
    assert.match(markup, /data-watch-index-state="failed"/)
    assert.match(markup, /ffmpeg is not installed/)
  })

  test('hit text keeps its own direction', () => {
    const markup = render(searchPlan({ lexical: true, semantic: true }))
    assert.match(markup, /dir="auto"/)
  })
})
