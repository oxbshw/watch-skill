/**
 * The Memory product: the surfaces, the operations, and the whole slice.
 *
 * The second vertical slice of the vision is one continuous journey, and it is
 * tested here as one continuous journey rather than as thirteen unit tests
 * that each pass in isolation. That distinction matters: every step in it is
 * individually easy, and the failure people actually hit is the one where step
 * 11 quietly stops holding because of a cache added for step 6.
 *
 *   correct → Taste → new session → Why remembered? → corrected behavior →
 *   edit → next turn → Forget → rebuild → new session → absent → replay
 *   does not resurrect → export does not contain it
 *
 * Alongside it: the four memory modes have to *behave* differently, not merely
 * be labelled differently, and personal taste must not walk into a shared
 * workspace on its own.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import { Context } from '@deepseek-ai/cordis'
import WatchMemoryService from '@deepwatch/dsh-memory'

import {
  MEMORY_OPERATIONS,
  MEMORY_VIEWS,
  MODE_DESCRIPTION,
  availableOperations,
  eventsForTimeline,
  influencedSession,
  isSharedWithWorkspace,
  recordsForView,
  toCard,
  whyChip,
} from '@deepwatch/dsh-client-memory'

import {
  MemoryCardRow,
  MemoryWorkbench,
  WhyRememberedChip,
} from '@deepwatch/dsh-client-memory/components'

/** A literal newline, spelled once. */
const NEWLINE = '\n'

const SCOPE = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'proj_1',
  sessionId: 'sess_1',
}

async function mountMemory(config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'watch-memory-ui-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchMemoryService, {
    mode: 'local_personal',
    directory,
    ...config,
  })
  return {
    ctx,
    directory,
    /** Close the ledger and leave the directory, which is what a restart is. */
    close: () => fiber.dispose(),
    dispose: async () => {
      await fiber.dispose()
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

/** Remount the same directory, which is what a restart actually is. */
async function remount(directory, config = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchMemoryService, {
    mode: 'local_personal',
    directory,
    ...config,
  })
  return { ctx, dispose: () => fiber.dispose() }
}

function record(overrides = {}) {
  const now = '2026-08-27T10:00:00.000Z'
  return {
    memoryId: 'mem_1',
    kind: 'preference',
    subjectScope: 'project',
    scopeId: 'proj_1',
    content: 'prefer tabs over spaces',
    origin: 'explicit_user',
    sourceRefs: ['msg_7'],
    evidenceRefs: [],
    confidence: 1,
    status: 'active',
    sensitivity: 'private',
    validFrom: now,
    validUntil: null,
    createdAt: now,
    updatedAt: now,
    lastConfirmedAt: now,
    supersedes: [],
    contradictedBy: [],
    locale: 'en',
    ...overrides,
  }
}

// ── the surfaces ────────────────────────────────────────────────────────────

describe('the Memory surfaces', () => {
  test('every view the vision names exists, in order', () => {
    assert.deepEqual(
      [...MEMORY_VIEWS],
      ['taste', 'timeline', 'wiki', 'decisions', 'lessons', 'failures', 'sources'],
    )
  })

  test('every operation the vision names exists', () => {
    assert.deepEqual(
      [...MEMORY_OPERATIONS],
      ['confirm', 'edit', 'reject', 'dispute', 'forget', 'move_scope', 'export'],
    )
  })

  test('each view shows its own kinds and nobody else’s', () => {
    const records = [
      record({ memoryId: 'm-pref', kind: 'preference' }),
      record({ memoryId: 'm-dec', kind: 'decision' }),
      record({ memoryId: 'm-les', kind: 'lesson' }),
      record({ memoryId: 'm-fail', kind: 'failure' }),
      record({ memoryId: 'm-fact', kind: 'fact' }),
    ]
    assert.deepEqual(recordsForView('taste', records).map(r => r.memoryId), ['m-pref'])
    assert.deepEqual(recordsForView('decisions', records).map(r => r.memoryId), ['m-dec'])
    assert.deepEqual(recordsForView('lessons', records).map(r => r.memoryId), ['m-les'])
    assert.deepEqual(recordsForView('failures', records).map(r => r.memoryId), ['m-fail'])
    assert.deepEqual(recordsForView('sources', records).map(r => r.memoryId), ['m-fact'])
  })

  test('a list ordered only by time would reshuffle; this one does not', () => {
    const same = '2026-08-27T10:00:00.000Z'
    const records = [
      record({ memoryId: 'm-b', updatedAt: same }),
      record({ memoryId: 'm-a', updatedAt: same }),
    ]
    assert.deepEqual(recordsForView('taste', records).map(r => r.memoryId), ['m-a', 'm-b'])
    assert.deepEqual(recordsForView('taste', [...records].reverse()).map(r => r.memoryId), ['m-a', 'm-b'])
  })

  test('a card exposes every provenance field', () => {
    const card = toCard(record())
    for (const field of ['memoryId', 'kind', 'scope', 'origin', 'confidence', 'status', 'provenance', 'lastConfirmedAt']) {
      assert.ok(field in card, `card is missing ${field}`)
    }
    assert.deepEqual([...card.provenance], ['msg_7'])
  })

  test('sensitive content is withheld but the record still appears', () => {
    const card = toCard(record({ sensitivity: 'sensitive' }))
    assert.equal(card.withheld, true)
    assert.match(card.content, /withheld/)
    assert.equal(card.memoryId, 'mem_1')

    const revealed = toCard(record({ sensitivity: 'sensitive' }), { revealSensitive: true })
    assert.equal(revealed.withheld, false)
    assert.equal(revealed.content, 'prefer tabs over spaces')
  })

  test('reject is offered on a proposal and never on an active memory', () => {
    assert.ok(availableOperations(record({ status: 'proposed' })).includes('reject'))
    assert.equal(availableOperations(record({ status: 'active' })).includes('reject'), false)
  })

  test('dispute is offered on an active memory and never on a proposal', () => {
    assert.ok(availableOperations(record({ status: 'active' })).includes('dispute'))
    assert.equal(availableOperations(record({ status: 'proposed' })).includes('dispute'), false)
  })

  test('forget is available in every state', () => {
    for (const status of ['proposed', 'active', 'disputed', 'superseded', 'expired']) {
      assert.ok(availableOperations(record({ status })).includes('forget'), `forget missing for ${status}`)
    }
  })

  test('a memory that never reached a turn shows no reason, rather than a fake one', () => {
    assert.equal(whyChip(toCard(record())), null)
    const withReason = toCard(record(), {
      reasons: new Map([['mem_1', [{ at: '2026-08-27T11:00:00.000Z', sessionId: 'sess_1', reason: 'matches "indentation"', tokenEstimate: 8 }]]]),
    })
    assert.match(whyChip(withReason), /matches "indentation"/)
    assert.equal(influencedSession(withReason, 'sess_1'), true)
    assert.equal(influencedSession(withReason, 'sess_2'), false)
  })

  test('the timeline is newest first and deterministic', () => {
    const events = [
      { eventId: 'e2', kind: 'record.activated', memoryId: 'm1', at: '2026-08-27T10:00:00.000Z', actor: 'user', record: null, detail: {} },
      { eventId: 'e1', kind: 'record.confirmed', memoryId: 'm1', at: '2026-08-27T10:00:00.000Z', actor: 'user', record: null, detail: {} },
      { eventId: 'e3', kind: 'record.forgotten', memoryId: 'm1', at: '2026-08-27T12:00:00.000Z', actor: 'user', record: null, detail: {} },
    ]
    assert.deepEqual(eventsForTimeline(events).map(e => e.eventId), ['e3', 'e1', 'e2'])
  })
})

// ── modes ───────────────────────────────────────────────────────────────────

describe('memory modes behave differently, not just read differently', () => {
  test('each mode has a description that says what it actually does', () => {
    for (const mode of ['off', 'session_only', 'local_personal', 'workspace_shared']) {
      assert.notEqual(MODE_DESCRIPTION[mode], undefined)
      assert.notEqual(MODE_DESCRIPTION[mode], '')
    }
    assert.match(MODE_DESCRIPTION.workspace_shared, /personal taste stays private/i)
  })

  test('personal taste never enters a shared workspace on its own', () => {
    const preference = record({ subjectScope: 'workspace', kind: 'preference' })
    assert.equal(isSharedWithWorkspace(preference, 'workspace_shared'), false)

    const decision = record({ subjectScope: 'workspace', kind: 'decision' })
    assert.equal(isSharedWithWorkspace(decision, 'workspace_shared'), true)
  })

  test('sensitive project facts stay out of a shared workspace', () => {
    const sensitive = record({ subjectScope: 'project', kind: 'fact', sensitivity: 'sensitive' })
    assert.equal(isSharedWithWorkspace(sensitive, 'workspace_shared'), false)
  })

  test('no mode other than workspace_shared shares anything', () => {
    const decision = record({ subjectScope: 'workspace', kind: 'decision' })
    for (const mode of ['off', 'session_only', 'local_personal']) {
      assert.equal(isSharedWithWorkspace(decision, mode), false, `${mode} shared something`)
    }
  })

  test('moving personal taste to the workspace needs an explicit choice', async () => {
    const m = await mountMemory()
    try {
      const stored = m.ctx.watchMemory.remember({
        kind: 'preference',
        content: 'write in Egyptian Arabic',
        origin: 'explicit_user',
        subjectScope: 'user',
        scopeId: 'user_1',
      }, { userAuthenticated: true })

      const refused = m.ctx.watchMemory.moveScope(stored.memoryId, {
        subjectScope: 'workspace',
        scopeId: 'ws_1',
      })
      assert.equal(refused.moved, false)
      assert.match(refused.reason, /private by default/i)

      const allowed = m.ctx.watchMemory.moveScope(stored.memoryId, {
        subjectScope: 'workspace',
        scopeId: 'ws_1',
      }, { shareExplicitly: true })
      assert.equal(allowed.moved, true)
      assert.equal(m.ctx.watchMemory.list(SCOPE).find(r => r.memoryId === stored.memoryId).subjectScope, 'workspace')
    } finally {
      await m.dispose()
    }
  })

  test('narrowing a scope back out never needs permission', async () => {
    const m = await mountMemory()
    try {
      const stored = m.ctx.watchMemory.remember({
        kind: 'decision',
        content: 'this project uses TypeScript',
        origin: 'explicit_user',
        subjectScope: 'workspace',
        scopeId: 'ws_1',
      }, { userAuthenticated: true })
      const back = m.ctx.watchMemory.moveScope(stored.memoryId, { subjectScope: 'project', scopeId: 'proj_1' })
      assert.equal(back.moved, true)
    } finally {
      await m.dispose()
    }
  })

  test('rejecting a proposal removes it; rejecting an active memory is refused', async () => {
    const m = await mountMemory()
    try {
      const proposed = m.ctx.watchMemory.remember({
        kind: 'preference',
        content: 'seems to prefer short replies',
        origin: 'inferred',
        subjectScope: 'user',
        scopeId: 'user_1',
        confidence: 0.4,
      })
      assert.equal(proposed.status, 'proposed')
      assert.equal(m.ctx.watchMemory.reject(proposed.memoryId, 'not true'), true)
      assert.equal(m.ctx.watchMemory.list(SCOPE).some(r => r.memoryId === proposed.memoryId), false)

      const active = m.ctx.watchMemory.remember({
        kind: 'preference',
        content: 'answer directly first',
        origin: 'explicit_user',
        subjectScope: 'user',
        scopeId: 'user_1',
      }, { userAuthenticated: true })
      assert.equal(active.status, 'active')
      assert.equal(m.ctx.watchMemory.reject(active.memoryId, 'no'), false)
    } finally {
      await m.dispose()
    }
  })

  test('a rejection stores the reason and never the content', async () => {
    const m = await mountMemory()
    try {
      const proposed = m.ctx.watchMemory.remember({
        kind: 'preference',
        content: 'a very specific thing about this person',
        origin: 'inferred',
        subjectScope: 'user',
        scopeId: 'user_1',
        confidence: 0.4,
      })
      m.ctx.watchMemory.reject(proposed.memoryId, 'wrong')
      const serialized = JSON.stringify(m.ctx.watchMemory.events().filter(e => e.kind === 'record.rejected'))
      assert.match(serialized, /wrong/)
      assert.equal(/a very specific thing about this person/.test(serialized), false)
    } finally {
      await m.dispose()
    }
  })
})

// ── the vertical slice ──────────────────────────────────────────────────────

describe('the second vertical slice, end to end', () => {
  test('correct, see it, use it, edit it, forget it, and prove it is gone', async () => {
    const m = await mountMemory()
    const directory = m.directory
    try {
      // 1. The person corrects the agent's behavior.
      const correction = m.ctx.watchMemory.correct({
        kind: 'preference',
        content: 'in this project, always run the type build before the tests',
        origin: 'explicit_user',
        subjectScope: 'project',
        scopeId: 'proj_1',
      }, { userAuthenticated: true })
      assert.equal(correction.stored, true)
      const memoryId = correction.memoryId

      // 2. A project-scoped preference exists.
      const stored = m.ctx.watchMemory.list(SCOPE).find(r => r.memoryId === memoryId)
      assert.equal(stored.subjectScope, 'project')
      assert.equal(stored.status, 'active')

      // 3. It is visible in Taste.
      const inTaste = recordsForView('taste', m.ctx.watchMemory.list(SCOPE))
      assert.ok(inTaste.some(r => r.memoryId === memoryId), 'not visible in Taste')

      // 4. A new session compiles it into context.
      const nextSession = { ...SCOPE, sessionId: 'sess_2' }
      const packet = m.ctx.watchMemory.compile(nextSession)
      assert.ok(packet.items.some(item => item.memoryId === memoryId), 'Context Compiler did not select it')

      // 5. The reply can say why it was remembered — from the ledger, not recomputed.
      const reasons = m.ctx.watchMemory.whyRemembered(memoryId, 'sess_2')
      assert.ok(reasons.length > 0)
      assert.notEqual(reasons[0].reason, '')
      const card = toCard(stored, { reasons: new Map([[memoryId, reasons]]) })
      assert.match(whyChip(card), /Remembered:/)
      assert.equal(influencedSession(card, 'sess_2'), true)

      // 6. The person edits it.
      const edited = m.ctx.watchMemory.correct({
        kind: 'preference',
        content: 'in this project, run the type build and the lint before the tests',
        origin: 'explicit_user',
        subjectScope: 'project',
        scopeId: 'proj_1',
      }, { userAuthenticated: true })
      assert.equal(edited.stored, true)

      // 7. The correction takes effect on the very next turn.
      const afterEdit = m.ctx.watchMemory.compile({ ...SCOPE, sessionId: 'sess_3' })
      const texts = afterEdit.items.map(item => item.content).join('\n')
      assert.match(texts, /and the lint/)
      assert.equal(/always run the type build before the tests/.test(texts), false,
        'the superseded value still reached context')

      // 8. The person forgets it.
      assert.equal(m.ctx.watchMemory.forget(edited.memoryId), true)

      // 9. Projections are rebuilt from the ledger.
      const taste = join(directory, 'taste.md')
      assert.equal(existsSync(taste), true)
      assert.equal(/and the lint/.test(readFileSync(taste, 'utf8')), false,
        'taste.md still carries a forgotten memory')

      // 10-11. A new session, after a restart, does not retrieve it. The
      // ledger is closed and the directory kept — deleting it here would make
      // every assertion below pass against an empty database, which is the
      // shape this test is supposed to be proving something about.
      await m.close()
    } catch (error) {
      await m.dispose()
      throw error
    }

    const restarted = await remount(directory)
    try {
      const packet = restarted.ctx.watchMemory.compile({ ...SCOPE, sessionId: 'sess_4' })
      const text = packet.items.map(item => item.content).join(NEWLINE)
      assert.equal(/and the lint/.test(text), false, 'a forgotten memory came back after restart')

      // And the value it replaced does not come back into force either.
      // Forgetting a correction must not reinstate the thing it corrected —
      // that would make "forget" mean "restore what I already rejected".
      assert.equal(/always run the type build before the tests/.test(text), false,
        'forgetting a correction resurrected the value it superseded')

      // 12. Replay — the fold over the whole event log — does not resurrect it.
      const records = restarted.ctx.watchMemory.list(SCOPE)
      assert.equal(records.some(r => /and the lint/.test(r.content)), false,
        'replay resurrected a forgotten memory')

      // The superseded original stays readable — it happened, and hiding it
      // would misrepresent the history — but it is not in force.
      const superseded = records.find(r => /always run the type build/.test(r.content))
      assert.notEqual(superseded, undefined, 'the corrected original vanished without being forgotten')
      assert.equal(superseded.status, 'superseded')

      // 13. The export does not contain the forgotten memory.
      const exported = restarted.ctx.watchMemory.export(SCOPE, { includeEvents: true })
      const serialized = JSON.stringify(exported)
      assert.equal(/and the lint/.test(serialized), false,
        'the export contains a forgotten memory')
    } finally {
      await restarted.dispose()
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test('an export withholds sensitive content unless it is asked for', async () => {
    const m = await mountMemory()
    try {
      m.ctx.watchMemory.remember({
        kind: 'fact',
        content: 'the staging password rotates on Fridays',
        origin: 'explicit_user',
        subjectScope: 'project',
        scopeId: 'proj_1',
        sensitivity: 'sensitive',
      }, { userAuthenticated: true })

      const guarded = JSON.stringify(m.ctx.watchMemory.export(SCOPE))
      assert.equal(/rotates on Fridays/.test(guarded), false)
      assert.match(guarded, /withheld/)

      const full = JSON.stringify(m.ctx.watchMemory.export(SCOPE, { includeSensitive: true }))
      assert.match(full, /rotates on Fridays/)
    } finally {
      await m.dispose()
    }
  })
})

// ── rendering ───────────────────────────────────────────────────────────────

describe('what the Memory surface draws', () => {
  test('a card renders every provenance field as its own element', () => {
    const markup = renderToStaticMarkup(createElement(MemoryCardRow, {
      card: toCard(record()),
      onOperation: () => {},
    }))
    for (const field of ['memory_id', 'kind', 'scope', 'origin', 'confidence', 'status', 'provenance', 'last_confirmed']) {
      assert.match(markup, new RegExp(`data-watch-field="${field}"`), `missing ${field}`)
    }
  })

  test('a never-confirmed memory says so rather than showing an empty cell', () => {
    const markup = renderToStaticMarkup(createElement(MemoryCardRow, {
      card: toCard(record({ lastConfirmedAt: null, origin: 'inferred' })),
      onOperation: () => {},
    }))
    assert.match(markup, /never/)
  })

  test('the operations a record allows are the buttons that appear', () => {
    const markup = renderToStaticMarkup(createElement(MemoryCardRow, {
      card: toCard(record({ status: 'proposed' })),
      onOperation: () => {},
    }))
    assert.match(markup, /data-watch-operation="reject"/)
    assert.equal(/data-watch-operation="dispute"/.test(markup), false)
  })

  test('the chip is absent when nothing was recorded, present when something was', () => {
    const bare = renderToStaticMarkup(createElement(WhyRememberedChip, { card: toCard(record()) }))
    assert.equal(bare, '')

    const withReason = renderToStaticMarkup(createElement(WhyRememberedChip, {
      card: toCard(record(), {
        reasons: new Map([['mem_1', [{ at: '2026-08-27T11:00:00.000Z', sessionId: 'sess_1', reason: 'matches the word build', tokenEstimate: 8 }]]]),
      }),
    }))
    assert.match(withReason, /Remembered: matches the word build/)
  })

  test('the workbench states the mode it is in on every screen', () => {
    for (const mode of ['off', 'session_only', 'local_personal', 'workspace_shared']) {
      const markup = renderToStaticMarkup(createElement(MemoryWorkbench, {
        view: 'taste',
        cards: [],
        events: [],
        mode,
        onView: () => {},
        onOperation: () => {},
      }))
      assert.match(markup, new RegExp(`data-watch-memory-mode="${mode}"`))
      assert.match(markup, /data-watch-mode-description/)
    }
  })

  test('every view is reachable from the workbench', () => {
    const markup = renderToStaticMarkup(createElement(MemoryWorkbench, {
      view: 'taste',
      cards: [],
      events: [],
      mode: 'local_personal',
      onView: () => {},
      onOperation: () => {},
    }))
    for (const view of MEMORY_VIEWS) {
      assert.match(markup, new RegExp(`data-watch-memory-view="${view}"`))
    }
  })

  test('memory content carries its language and follows its own direction', () => {
    const markup = renderToStaticMarkup(createElement(MemoryCardRow, {
      card: toCard(record({ content: 'اكتب بالعربية المصرية', locale: 'ar-EG' })),
      onOperation: () => {},
    }))
    assert.match(markup, /lang="ar-EG"/)
    assert.match(markup, /dir="auto"/)
  })
})
