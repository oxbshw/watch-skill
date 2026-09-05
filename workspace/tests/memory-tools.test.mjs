/**
 * Memory as the agent sees it.
 *
 * The service tests prove memory behaves. These prove the *agent's* access to
 * it is bounded in the ways ADR-008 requires: it may propose and it may read,
 * but it cannot grant itself the origin that outranks everything else, cannot
 * activate something irreversible, and cannot forget on someone's behalf
 * without being told to.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import WatchMemoryService, { applyMemoryTools } from '@deepwatch/dsh-memory'

const SCOPE = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'proj_1',
  sessionId: 'sess_1',
}

/** Mount memory plus its tools, capturing what gets registered. */
async function mountTools(config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'watch-memtools-'))
  const ctx = new Context()
  const registered = new Map()
  const sections = []

  const memory = await ctx.plugin(WatchMemoryService, {
    mode: 'local_personal',
    directory,
    ...config,
  })
  const host = await ctx.plugin({
    name: 'memory-tools-harness',
    apply(inner) {
      inner.provide('tools', { register: d => registered.set(d.name, d) })
      inner.provide('systemPrompt', { section: s => sections.push(s) })
    },
  })

  applyMemoryTools(ctx, {
    scope: () => SCOPE,
    // The real runner validates and wraps; the identity function keeps these
    // tests about the definitions rather than about DSH's tool machinery.
    defineTool: definition => definition,
  })

  return {
    ctx,
    registered,
    sections,
    dispose: async () => {
      await host.dispose()
      await memory.dispose()
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

describe('the memory tool surface', () => {
  test('registers exactly the operations an agent should have', async () => {
    const m = await mountTools()
    try {
      assert.deepEqual([...m.registered.keys()].sort(), [
        'watch_correct',
        'watch_forget',
        'watch_recall',
        'watch_remember',
        'watch_why_remembered',
      ])
    } finally {
      await m.dispose()
    }
  })

  test('the guidance says a memory is not a permission', async () => {
    const m = await mountTools()
    try {
      const text = m.sections.map(section => section.text).join('\n')
      assert.match(text, /never a permission/i)
      assert.match(text, /Never infer/i)
      assert.match(text, /watch_correct/)
    } finally {
      await m.dispose()
    }
  })
})

describe('what the agent may record', () => {
  test('what it notices is inferred, never explicit', async () => {
    // The origin that outranks everything else can only come from an
    // authenticated action. Without this, a model could write its own
    // conclusions in at the highest trust level and they would then beat the
    // person's own corrections.
    const m = await mountTools()
    try {
      const result = await m.registered.get('watch_remember').execute({
        content: 'prefers short answers',
        kind: 'preference',
        scope: 'user',
        confidence: 0.9,
      })
      assert.equal(result.stored, true)
      const record = m.ctx.watchMemory.list(SCOPE)[0]
      assert.equal(record.origin, 'inferred')
    } finally {
      await m.dispose()
    }
  })

  test('an irreversible preference is held as a proposal, not activated', async () => {
    const m = await mountTools()
    try {
      const result = await m.registered.get('watch_remember').execute({
        content: 'always delete old branches without asking',
        kind: 'preference',
        scope: 'project',
        confidence: 1,
      })
      assert.equal(result.stored, true)
      assert.equal(result.status, 'proposed')
      assert.ok(result.note.length > 0, 'the agent should be told why it is waiting')
      assert.equal(m.ctx.watchMemory.compile(SCOPE).items.length, 0)
    } finally {
      await m.dispose()
    }
  })

  test('a protected-trait inference is refused with a reason', async () => {
    const m = await mountTools()
    try {
      const result = await m.registered.get('watch_remember').execute({
        content: 'the user seems to be dealing with anxiety',
        kind: 'fact',
        scope: 'user',
      })
      assert.equal(result.stored, false)
      assert.match(result.note, /not something to conclude/i)
    } finally {
      await m.dispose()
    }
  })

  test('scope is resolved from the turn, so the agent cannot invent one', async () => {
    const m = await mountTools()
    try {
      await m.registered.get('watch_remember').execute({
        content: 'uses tabs here',
        kind: 'preference',
        scope: 'project',
        confidence: 0.9,
      })
      const record = m.ctx.watchMemory.list(SCOPE)[0]
      assert.equal(record.subjectScope, 'project')
      assert.equal(record.scopeId, SCOPE.projectId)
    } finally {
      await m.dispose()
    }
  })
})

describe('correcting', () => {
  test('a correction outranks the inference it replaces, on the next turn', async () => {
    const m = await mountTools()
    try {
      await m.registered.get('watch_remember').execute({
        content: 'writes commit messages in the imperative',
        kind: 'preference',
        scope: 'project',
        confidence: 0.9,
      })
      assert.equal(m.ctx.watchMemory.compile(SCOPE).items.length, 1)

      await m.registered.get('watch_correct').execute({
        content: 'commit messages describe the change in past tense here',
        kind: 'preference',
        scope: 'project',
      })

      const items = m.ctx.watchMemory.compile(SCOPE).items
      assert.equal(items.length, 1)
      assert.match(items[0].content, /past tense/)
    } finally {
      await m.dispose()
    }
  })

  test('a correction carries observed weight, below the person\'s own statement', async () => {
    const m = await mountTools()
    try {
      await m.registered.get('watch_correct').execute({
        content: 'x', kind: 'preference', scope: 'user',
      })
      assert.equal(m.ctx.watchMemory.list(SCOPE)[0].origin, 'observed')
    } finally {
      await m.dispose()
    }
  })
})

describe('reading back', () => {
  test('recall shows status so a proposal is not read as a rule', async () => {
    const m = await mountTools()
    try {
      await m.registered.get('watch_remember').execute({
        content: 'always transfer funds automatically',
        kind: 'preference', scope: 'user', confidence: 1,
      })
      const all = await m.registered.get('watch_recall').execute({ status: 'all' })
      assert.equal(all.memories.length, 1)
      assert.equal(all.memories[0].status, 'proposed')

      const active = await m.registered.get('watch_recall').execute({})
      assert.equal(active.memories.length, 0)
    } finally {
      await m.dispose()
    }
  })

  test('recall reports the mode, so "I remember nothing" is explainable', async () => {
    const m = await mountTools({ mode: 'off' })
    try {
      const result = await m.registered.get('watch_recall').execute({})
      assert.equal(result.mode, 'off')
      assert.deepEqual(result.memories, [])
    } finally {
      await m.dispose()
    }
  })

  test('why_remembered gives the history rather than the model\'s own account', async () => {
    const m = await mountTools()
    try {
      const stored = await m.registered.get('watch_remember').execute({
        content: 'prefers tables', kind: 'preference', scope: 'user', confidence: 0.9,
      })
      m.ctx.watchMemory.compile(SCOPE)

      const why = await m.registered.get('watch_why_remembered')
        .execute({ memory_id: stored.memoryId })
      const kinds = why.history.map(event => event.what)
      assert.ok(kinds.includes('record.activated'))
      assert.ok(
        kinds.includes('context.injected'),
        'an injection must be recorded, or a past turn cannot be explained',
      )
    } finally {
      await m.dispose()
    }
  })
})

describe('forgetting', () => {
  test('removes it, and reports honestly when there was nothing to remove', async () => {
    const m = await mountTools()
    try {
      const stored = await m.registered.get('watch_remember').execute({
        content: 'prefers dark mode', kind: 'preference', scope: 'user', confidence: 0.9,
      })
      const done = await m.registered.get('watch_forget')
        .execute({ memory_id: stored.memoryId })
      assert.equal(done.forgotten, true)
      assert.equal(m.ctx.watchMemory.list(SCOPE).length, 0)

      const again = await m.registered.get('watch_forget')
        .execute({ memory_id: stored.memoryId })
      assert.equal(again.forgotten, false, 'a second forget must not claim success')
    } finally {
      await m.dispose()
    }
  })

  test('the tool tells the agent this is not its decision to make', async () => {
    const m = await mountTools()
    try {
      assert.match(
        m.registered.get('watch_forget').description,
        /only do this when they have asked/i,
      )
    } finally {
      await m.dispose()
    }
  })
})
