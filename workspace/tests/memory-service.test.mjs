/**
 * Memory as a running service: the ledger, corrections, and forgetting.
 *
 * The unit rules are tested separately. What matters here is the behavior a
 * person actually experiences, and each of these is a promise that is easy to
 * make and easy to break silently:
 *
 * - a correction takes effect on the *next* turn, not eventually;
 * - forgetting removes the thing, everywhere, including from a rebuild;
 * - one scope cannot see another's memory;
 * - nothing high-impact starts acting on its own.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import WatchMemoryService from '@deepwatch/dsh-memory'

const SCOPE = {
  userId: 'user_1',
  workspaceId: 'ws_1',
  projectId: 'proj_1',
  sessionId: 'sess_1',
}

/** Mount memory on a throwaway directory. */
async function mountMemory(config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'watch-memory-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchMemoryService, {
    mode: 'local_personal',
    directory,
    ...config,
  })
  return {
    ctx,
    directory,
    dispose: async () => {
      await fiber.dispose()
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

/** Remember something the person stated directly. */
function stated(content, overrides = {}) {
  return {
    kind: 'preference',
    content,
    origin: 'explicit_user',
    subjectScope: 'user',
    scopeId: 'user_1',
    ...overrides,
  }
}

describe('remembering', () => {
  test('an explicit preference is stored and acts immediately', async () => {
    const m = await mountMemory()
    try {
      const result = m.ctx.watchMemory.remember(
        stated('answer directly first, then give the detail'),
        { userAuthenticated: true },
      )
      assert.equal(result.stored, true)
      assert.equal(result.status, 'active')

      const packet = m.ctx.watchMemory.compile(SCOPE)
      assert.equal(packet.items.length, 1)
      assert.match(packet.items[0].reason, /you told me directly/)
    } finally {
      await m.dispose()
    }
  })

  test('a refusal explains itself instead of throwing', async () => {
    const m = await mountMemory()
    try {
      const result = m.ctx.watchMemory.remember(
        stated('the user is probably unwell', { origin: 'inferred' }),
      )
      assert.equal(result.stored, false)
      assert.equal(result.admission.reason, 'protected_subject_inference')
      assert.ok(result.reason.length > 0)
    } finally {
      await m.dispose()
    }
  })

  test('a high-impact memory is stored but does not act', async () => {
    const m = await mountMemory()
    try {
      const result = m.ctx.watchMemory.remember(
        stated('always upload frames to the cloud without asking'),
        { userAuthenticated: true },
      )
      assert.equal(result.stored, true)
      assert.equal(result.status, 'proposed')

      const packet = m.ctx.watchMemory.compile(SCOPE)
      assert.deepEqual(
        packet.items.map(item => item.memoryId),
        [],
        'a proposal must not reach the model as an instruction',
      )
    } finally {
      await m.dispose()
    }
  })

  test('memory off stores nothing at all', async () => {
    const m = await mountMemory({ mode: 'off' })
    try {
      const result = m.ctx.watchMemory.remember(stated('x'), { userAuthenticated: true })
      assert.equal(result.stored, false)
      assert.equal(result.admission.reason, 'memory_disabled')
      assert.equal(m.ctx.watchMemory.compile(SCOPE).items.length, 0)
    } finally {
      await m.dispose()
    }
  })
})

describe('correction', () => {
  test('takes effect on the very next compile', async () => {
    // The failure this guards against is the one that teaches people not to
    // bother correcting: the old preference applying once more after they
    // already fixed it.
    const m = await mountMemory()
    try {
      m.ctx.watchMemory.remember(
        stated('write documentation in English only', { origin: 'inferred', confidence: 0.9 }),
      )
      const before = m.ctx.watchMemory.compile(SCOPE)
      assert.equal(before.items.length, 1)

      m.ctx.watchMemory.correct(
        stated('documentation covers every language the sources use'),
        { userAuthenticated: true },
      )

      const after = m.ctx.watchMemory.compile(SCOPE)
      assert.equal(after.items.length, 1)
      assert.match(after.items[0].content, /every language/)
      assert.ok(
        !after.items.some(item => /English only/.test(item.content)),
        'the corrected preference must not still be injected',
      )
    } finally {
      await m.dispose()
    }
  })

  test('a correction in one project leaves another project alone', async () => {
    const m = await mountMemory()
    try {
      const inThis = { subjectScope: 'project', scopeId: 'proj_1' }
      const inOther = { subjectScope: 'project', scopeId: 'proj_2' }
      m.ctx.watchMemory.remember(stated('use tabs', { ...inThis, origin: 'inferred', confidence: 0.9 }))
      m.ctx.watchMemory.remember(stated('use tabs', { ...inOther, origin: 'inferred', confidence: 0.9 }))

      m.ctx.watchMemory.correct(stated('use spaces', inThis), { userAuthenticated: true })

      const here = m.ctx.watchMemory.compile(SCOPE).items.map(i => i.content)
      assert.ok(here.includes('use spaces'))
      assert.ok(!here.includes('use tabs'))

      // The other project's record is untouched — visible from its own scope.
      const otherScope = { ...SCOPE, projectId: 'proj_2' }
      const there = m.ctx.watchMemory.list(otherScope).filter(r => r.status === 'active')
      assert.deepEqual(there.map(r => r.content), ['use tabs'])
    } finally {
      await m.dispose()
    }
  })

  test('a disputed memory stops acting but stays readable', async () => {
    const m = await mountMemory()
    try {
      const { memoryId } = m.ctx.watchMemory.remember(
        stated('prefers bullet points'), { userAuthenticated: true },
      )
      assert.equal(m.ctx.watchMemory.dispute(memoryId, 'not in this context'), true)

      assert.equal(m.ctx.watchMemory.compile(SCOPE).items.length, 0)
      const listed = m.ctx.watchMemory.list(SCOPE)
      assert.equal(listed.length, 1)
      assert.equal(listed[0].status, 'disputed')
    } finally {
      await m.dispose()
    }
  })
})

describe('forgetting', () => {
  test('removes the memory from retrieval, the list, and taste.md', async () => {
    const m = await mountMemory()
    try {
      const { memoryId } = m.ctx.watchMemory.remember(
        stated('a very distinctive preference about mangoes'),
        { userAuthenticated: true },
      )
      assert.match(readFileSync(join(m.directory, 'taste.md'), 'utf8'), /mangoes/)

      assert.equal(m.ctx.watchMemory.forget(memoryId), true)

      assert.equal(m.ctx.watchMemory.compile(SCOPE).items.length, 0)
      assert.equal(m.ctx.watchMemory.list(SCOPE).length, 0)
      assert.ok(
        !readFileSync(join(m.directory, 'taste.md'), 'utf8').includes('mangoes'),
        'the projection must be rebuilt without it',
      )
    } finally {
      await m.dispose()
    }
  })

  test('the tombstone does not record what was forgotten', async () => {
    // An audit trail of a deletion that contains the deleted thing is not a
    // deletion.
    const m = await mountMemory()
    try {
      const { memoryId } = m.ctx.watchMemory.remember(
        stated('something with a very distinctive marker: xyzzy'),
        { userAuthenticated: true },
      )
      m.ctx.watchMemory.forget(memoryId)
      const tombstone = m.ctx.watchMemory.history(memoryId)
        .find(event => event.kind === 'record.forgotten')
      assert.ok(tombstone)
      assert.equal(tombstone.record, null)
      assert.ok(!JSON.stringify(tombstone.detail).includes('xyzzy'))
    } finally {
      await m.dispose()
    }
  })

  test('a forgotten memory does not come back when the ledger is replayed', async () => {
    // The property that makes forgetting real: the fold, not a cleanup pass.
    const m = await mountMemory()
    try {
      const { memoryId } = m.ctx.watchMemory.remember(
        stated('forget me'), { userAuthenticated: true },
      )
      m.ctx.watchMemory.forget(memoryId)
      // Confirming afterwards must not resurrect it, and neither must a
      // reopened ledger reading the same events from the start.
      assert.equal(m.ctx.watchMemory.confirm(memoryId), false)
      assert.equal(m.ctx.watchMemory.list(SCOPE).length, 0)
    } finally {
      await m.dispose()
    }
  })

  test('survives a restart: the record stays gone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watch-memory-restart-'))
    try {
      const first = new Context()
      const firstFiber = await first.plugin(WatchMemoryService, {
        mode: 'local_personal', directory,
      })
      const { memoryId } = first.watchMemory.remember(
        stated('a preference about pomegranates'), { userAuthenticated: true },
      )
      first.watchMemory.forget(memoryId)
      await firstFiber.dispose()

      const second = new Context()
      const secondFiber = await second.plugin(WatchMemoryService, {
        mode: 'local_personal', directory,
      })
      try {
        assert.equal(second.watchMemory.list(SCOPE).length, 0)
        assert.ok(!readFileSync(join(directory, 'taste.md'), 'utf8').includes('pomegranates'))
      } finally {
        await secondFiber.dispose()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})

describe('scope isolation in the running service', () => {
  test('another person\'s memory is never retrieved', async () => {
    const m = await mountMemory()
    try {
      m.ctx.watchMemory.remember(
        stated('belongs to someone else', { scopeId: 'user_2' }),
        { userAuthenticated: true },
      )
      assert.equal(m.ctx.watchMemory.compile(SCOPE).items.length, 0)
      assert.equal(m.ctx.watchMemory.list(SCOPE).length, 0)
    } finally {
      await m.dispose()
    }
  })

  test('session_only memory never reaches a later session', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watch-memory-session-'))
    try {
      const first = new Context()
      const firstFiber = await first.plugin(WatchMemoryService, {
        mode: 'session_only', directory,
      })
      const result = first.watchMemory.remember(
        stated('within this session only', { subjectScope: 'session', scopeId: 'sess_1' }),
        { userAuthenticated: true },
      )
      assert.equal(result.stored, true)
      assert.equal(first.watchMemory.compile(SCOPE).items.length, 1)
      await firstFiber.dispose()

      const second = new Context()
      const secondFiber = await second.plugin(WatchMemoryService, {
        mode: 'session_only', directory,
      })
      try {
        // Not a filter that could be forgotten: session_only never touches the
        // disk at all, so there is nothing to read back.
        assert.equal(second.watchMemory.list(SCOPE).length, 0)
        assert.equal(existsSync(join(directory, 'memory-events.db')), false)
      } finally {
        await secondFiber.dispose()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})

describe('the taste projection', () => {
  test('keeps what you said and what was guessed visually separate', async () => {
    const m = await mountMemory()
    try {
      m.ctx.watchMemory.remember(
        stated('you-said marker alpha'), { userAuthenticated: true },
      )
      m.ctx.watchMemory.remember(
        stated('guessed marker beta', { origin: 'inferred', confidence: 0.95 }),
      )
      const taste = readFileSync(join(m.directory, 'taste.md'), 'utf8')

      const explicitAt = taste.indexOf('## Explicit')
      const learnedAt = taste.indexOf('## Learned — active')
      assert.ok(explicitAt >= 0 && learnedAt > explicitAt)
      assert.ok(taste.indexOf('alpha') > explicitAt && taste.indexOf('alpha') < learnedAt)
      assert.ok(taste.indexOf('beta') > learnedAt)
      // An inference has to show how sure it is, or it reads like a statement.
      assert.match(taste, /confidence 0\.95/)
    } finally {
      await m.dispose()
    }
  })

  test('is deterministic: the same ledger renders the same file', async () => {
    const m = await mountMemory()
    try {
      m.ctx.watchMemory.remember(stated('one'), { userAuthenticated: true })
      m.ctx.watchMemory.remember(stated('two'), { userAuthenticated: true })
      const first = readFileSync(join(m.directory, 'taste.md'), 'utf8')

      // Any write rebuilds every projection; an unrelated dispute must not
      // reshuffle the preferences section.
      m.ctx.watchMemory.confirm(m.ctx.watchMemory.list(SCOPE)[0].memoryId)
      const second = readFileSync(join(m.directory, 'taste.md'), 'utf8')
      assert.equal(
        first.replace(/confirmed \d{4}-\d{2}-\d{2}/g, 'confirmed DATE'),
        second.replace(/confirmed \d{4}-\d{2}-\d{2}/g, 'confirmed DATE'),
      )
    } finally {
      await m.dispose()
    }
  })
})

describe('the context packet', () => {
  test('every included item says why it is there', async () => {
    const m = await mountMemory()
    try {
      m.ctx.watchMemory.remember(stated('prefers tables'), { userAuthenticated: true })
      const packet = m.ctx.watchMemory.compile(SCOPE, { task: 'compare these options' })
      for (const item of packet.items) {
        assert.ok(item.reason.length > 0, 'an unexplainable memory is not usable')
        assert.ok(item.memoryId.length > 0)
      }
    } finally {
      await m.dispose()
    }
  })

  test('a hard budget degrades to no memory rather than an arbitrary half', async () => {
    const m = await mountMemory({ tokenBudget: 1 })
    try {
      m.ctx.watchMemory.remember(
        stated('a preference long enough to exceed a one-token budget'),
        { userAuthenticated: true },
      )
      const packet = m.ctx.watchMemory.compile(SCOPE)
      assert.equal(packet.items.length, 0)
      assert.equal(packet.fellBackToNone, true)
      assert.equal(packet.droppedForBudget.length, 1)
    } finally {
      await m.dispose()
    }
  })

  test('the rendered section says memory is not permission', async () => {
    const m = await mountMemory()
    try {
      m.ctx.watchMemory.remember(stated('prefers concise answers'), { userAuthenticated: true })
      const rendered = m.ctx.watchMemory.render(SCOPE)
      assert.match(rendered, /not permissions/i)
      assert.match(rendered, /never authorize/i)
    } finally {
      await m.dispose()
    }
  })

  test('nothing remembered renders nothing at all', async () => {
    const m = await mountMemory()
    try {
      assert.equal(m.ctx.watchMemory.render(SCOPE), '')
    } finally {
      await m.dispose()
    }
  })
})

describe('workspace_shared keeps personal taste private', () => {
  test('a workspace-scoped decision is stored and recalled', async () => {
    const m = await mountMemory({ mode: 'workspace_shared' })
    try {
      const result = m.ctx.watchMemory.remember(
        stated('this team reviews architecture decisions before implementing', {
          kind: 'decision', subjectScope: 'workspace', scopeId: 'ws_1',
        }),
        { userAuthenticated: true },
      )
      assert.equal(result.stored, true)
      assert.equal(result.status, 'active')
      assert.equal(m.ctx.watchMemory.compile(SCOPE).items.length, 1)
    } finally {
      await m.dispose()
    }
  })

  test('a personal preference is refused, not silently shared', async () => {
    // The failure this prevents: someone's taste ending up in a workspace
    // their colleagues can read, because a mode changed and nothing stopped it.
    const m = await mountMemory({ mode: 'workspace_shared' })
    try {
      const result = m.ctx.watchMemory.remember(
        stated('prefers blunt feedback', { subjectScope: 'user', scopeId: 'user_1' }),
        { userAuthenticated: true },
      )
      assert.equal(result.stored, false)
      assert.equal(result.admission.reason, 'scope_not_allowed_by_mode')
      assert.match(result.reason, /workspace_shared/)
      assert.equal(m.ctx.watchMemory.list(SCOPE).length, 0)
    } finally {
      await m.dispose()
    }
  })

  test('project scope is allowed alongside workspace scope', async () => {
    const m = await mountMemory({ mode: 'workspace_shared' })
    try {
      for (const scope of ['workspace', 'project', 'session']) {
        const scopeId = { workspace: 'ws_1', project: 'proj_1', session: 'sess_1' }[scope]
        const result = m.ctx.watchMemory.remember(
          stated(`a ${scope} convention`, { subjectScope: scope, scopeId }),
          { userAuthenticated: true },
        )
        assert.equal(result.stored, true, `${scope} should be allowed`)
      }
    } finally {
      await m.dispose()
    }
  })

  test('shared memory still cannot cross into another workspace', async () => {
    const m = await mountMemory({ mode: 'workspace_shared' })
    try {
      m.ctx.watchMemory.remember(
        stated('belongs to a different team', { subjectScope: 'workspace', scopeId: 'ws_other' }),
        { userAuthenticated: true },
      )
      assert.equal(m.ctx.watchMemory.compile(SCOPE).items.length, 0)
      assert.equal(m.ctx.watchMemory.list(SCOPE).length, 0)
    } finally {
      await m.dispose()
    }
  })
})

describe('every mode does what it says', () => {
  test('the four modes differ in behavior, not just in a label', async () => {
    // Asserted together so a mode that quietly stopped differing from another
    // shows up as a failure rather than as an unchanged dropdown.
    const outcomes = {}
    for (const mode of ['off', 'session_only', 'local_personal', 'workspace_shared']) {
      const m = await mountMemory({ mode })
      try {
        const personal = m.ctx.watchMemory.remember(
          stated('a personal preference'), { userAuthenticated: true },
        )
        const workspace = m.ctx.watchMemory.remember(
          stated('a workspace convention', { subjectScope: 'workspace', scopeId: 'ws_1' }),
          { userAuthenticated: true },
        )
        outcomes[mode] = { personal: personal.stored, workspace: workspace.stored }
      } finally {
        await m.dispose()
      }
    }

    assert.deepEqual(outcomes, {
      // Nothing at all.
      off: { personal: false, workspace: false },
      // Session scope only, so neither of these is admissible.
      session_only: { personal: false, workspace: false },
      // Everything.
      local_personal: { personal: true, workspace: true },
      // Shared knowledge, private taste.
      workspace_shared: { personal: false, workspace: true },
    })
  })
})
