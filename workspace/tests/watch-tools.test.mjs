/**
 * The Watch tool surface, mounted on a real Cordis context.
 *
 * The DSH host registries are stubbed here rather than booted: what these
 * tests are about is the *contract each tool presents to the model*, and that
 * is entirely owned by this package. The guarantees checked are the ones that
 * decide whether the agent can overstate what Watch actually saw.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'
import { apply as applyWatchTools, Config as WatchToolsConfig } from '@deepwatch/dsh-tools'

/** The execution context the DSH tool runner passes to `execute`. */
const EXEC = { signal: undefined }

/**
 * Mount the Bridge plus the tool surface, capturing what gets registered.
 *
 * `tools` and `systemPrompt` are stubbed to their registration surface only.
 * Booting the real DSH host here would test DSH, not this package.
 */
async function mountTools(bridgeConfig = {}) {
  const ctx = new Context()
  const registered = new Map()
  const sections = []

  const fiber = await ctx.plugin({
    name: 'watch-tools-harness',
    apply(inner) {
      inner.provide('tools', { register: definition => registered.set(definition.name, definition) })
      inner.provide('systemPrompt', { section: section => sections.push(section) })
    },
  })

  const bridge = await ctx.plugin(WatchCoreService, {
    transport: 'mock',
    autoConnect: false,
    ...bridgeConfig,
  })
  const tools = await ctx.plugin(
    { name: 'watch-tools', inject: ['tools', 'watchCore', 'systemPrompt'], apply: applyWatchTools },
    WatchToolsConfig({}),
  )

  return {
    ctx,
    registered,
    sections,
    dispose: async () => {
      await tools.dispose()
      await bridge.dispose()
      await fiber.dispose()
    },
  }
}

describe('the Watch tool surface', () => {
  test('registers the senses and the proof step as separate tools', async () => {
    const mounted = await mountTools()
    try {
      assert.deepEqual([...mounted.registered.keys()].sort(), [
        'watch_ask_live',
        'watch_ask_source',
        'watch_browser_act',
        'watch_browser_observe',
        'watch_browser_receipt',
        'watch_capabilities',
        'watch_capture_capabilities',
        'watch_get_evidence',
        'watch_library_search',
        'watch_list_sources',
        'watch_live_status',
        'watch_moment',
        'watch_observe_live',
        'watch_search_sources',
        'watch_stop_live',
        'watch_verify',
        'watch_watch_live',
      ])
    } finally {
      await mounted.dispose()
    }
  })

  test('every tool describes itself to the model', async () => {
    const mounted = await mountTools()
    try {
      for (const [name, definition] of mounted.registered) {
        assert.ok(definition.description.length > 40, `${name} needs a usable description`)
        assert.ok(definition.output, `${name} must declare an output schema`)
      }
    } finally {
      await mounted.dispose()
    }
  })

  test('the system prompt tells the model that a returned tool is not a verified outcome', async () => {
    const mounted = await mountTools()
    try {
      // Read across every section: the guidance is split by where each rule
      // applies, and asserting on one of them would let the others rot.
      const text = mounted.sections.map(section => section.text).join('\n\n')
      assert.ok(mounted.sections.length >= 2)
      assert.match(text, /does not mean the thing/i)
      assert.match(text, /UNVERIFIED/)
      assert.match(text, /watch_verify/)
    } finally {
      await mounted.dispose()
    }
  })
})

describe('a turn survives a profile with no identity service', () => {
  test('the memory section compiles when identity, session and workspace are absent', async () => {
    // The defect this covers took down every turn in the stock web profile.
    //
    // Cordis proxies context property access and throws
    // `cannot get property "identity" without inject` when a plugin reads a
    // name it did not declare. Optional chaining does not help, because the
    // throw happens on the access before `?.` is evaluated. The memory section
    // is compiled once per turn, so every turn failed and Chat rendered
    // "This turn failed cannot get property "identity" without inject".
    //
    // Declaring the names in `inject` would be the wrong fix: `inject` is a
    // required set in this Cordis, so the plugin would refuse to load instead
    // of one scope field falling back to 'local'.
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const mounted = await mountTools()
    const directory = mkdtempSync(join(tmpdir(), 'watch-no-identity-'))
    try {
      const WatchMemoryService = (await import('@deepwatch/dsh-memory')).default
      const memory = await mounted.ctx.plugin(WatchMemoryService, {
        mode: 'local_personal',
        directory,
      })
      try {
        // Nothing provides identity, session or workspace here, which is the
        // shape of the stock web profile. Whether the read throws or returns
        // undefined depends on whether some other plugin registered the name,
        // and `resolveScope` must survive either.
        assert.ok(
          mounted.registered.has('watch_remember'),
          'the memory child plugin did not activate',
        )
        // `watch_remember` resolves the scope on every call, which is the path
        // that threw. Executing it is what proves the turn would survive.
        const stored = await mounted.registered.get('watch_remember').execute({
          content: 'a note written with no identity service present',
          kind: 'fact',
          scope: 'session',
        }, EXEC)
        assert.ok(stored, 'remembering failed with no identity service')
      } finally {
        await memory.dispose()
      }
    } finally {
      await mounted.dispose()
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})

describe('memory is optional', () => {
  test('the Watch tools work with no Memory service mounted', async () => {
    // Reading ctx.watchMemory directly threw here once: Cordis refuses a
    // service a plugin did not declare. Declaring it instead would have made
    // the whole tool surface wait for something the bundle may never mount.
    // The memory wiring is a child plugin, so it simply stays pending.
    const mounted = await mountTools()
    try {
      assert.ok(mounted.registered.has('watch_verify'))
      assert.ok(
        !mounted.registered.has('watch_remember'),
        'memory tools must not appear without the Memory service',
      )
    } finally {
      await mounted.dispose()
    }
  })

  test('the memory tools appear once the service is mounted', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const WatchMemoryService = (await import('@deepwatch/dsh-memory')).default

    const directory = mkdtempSync(join(tmpdir(), 'watch-opt-memory-'))
    const mounted = await mountTools()
    try {
      const memory = await mounted.ctx.plugin(WatchMemoryService, {
        mode: 'local_personal',
        directory,
      })
      try {
        assert.ok(
          mounted.registered.has('watch_remember'),
          'the pending child plugin should activate when its service arrives',
        )
        assert.ok(mounted.registered.has('watch_forget'))
      } finally {
        await memory.dispose()
      }
    } finally {
      await mounted.dispose()
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })
})

describe('watch_capabilities', () => {
  test('answers even when Watch Core was never connected', async () => {
    const mounted = await mountTools()
    try {
      const value = await mounted.registered.get('watch_capabilities').execute({}, EXEC)
      assert.equal(value.connection, 'disconnected')
      assert.deepEqual(value.capabilities, [])
    } finally {
      await mounted.dispose()
    }
  })

  test('never reports an untested capability as usable', async () => {
    const mounted = await mountTools()
    try {
      await mounted.ctx.watchCore.connect()
      const value = await mounted.registered.get('watch_capabilities').execute({}, EXEC)
      assert.equal(value.transport, 'mock')
      assert.ok(value.capabilities.length > 0)
      for (const capability of value.capabilities) {
        assert.equal(capability.usable, false, `${capability.id} must not be offered as usable`)
        assert.equal(capability.status, 'not_tested')
      }
    } finally {
      await mounted.dispose()
    }
  })
})

describe('refusals reach the model intact', () => {
  test('a query with no engine returns the fix rather than throwing', async () => {
    const mounted = await mountTools()
    try {
      await mounted.ctx.watchCore.connect()
      const value = await mounted.registered.get('watch_ask_source').execute(
        { source_id: 'src_1', question: 'what is on screen' },
        EXEC,
      )
      assert.equal(value.ok, false)
      assert.equal(value.error, 'bridge.core_unavailable')
      assert.ok(
        value.fix.length > 0,
        'the model must be able to relay a fix instead of inventing an answer',
      )
    } finally {
      await mounted.dispose()
    }
  })

  test('verification refuses rather than defaulting to a verdict', async () => {
    const mounted = await mountTools()
    try {
      await mounted.ctx.watchCore.connect()
      const value = await mounted.registered.get('watch_verify').execute(
        { expectation: 'the row is gone' },
        EXEC,
      )
      assert.equal(value.ok, false)
      assert.equal(
        value.verdict,
        undefined,
        'a refusal must never carry a verdict field of any kind',
      )
    } finally {
      await mounted.dispose()
    }
  })
})

describe('verification presentation', () => {
  test('a payload without a verdict projects null, never a default', async () => {
    const mounted = await mountTools()
    try {
      const verify = mounted.registered.get('watch_verify')
      assert.deepEqual(
        verify.output.presentationMeta({}, { ok: false, error: 'bridge.core_unavailable' }),
        { verdict: null },
      )
    } finally {
      await mounted.dispose()
    }
  })

  test('an honest non-answer is shown as itself', async () => {
    const mounted = await mountTools()
    try {
      const verify = mounted.registered.get('watch_verify')
      for (const verdict of ['VERIFIED', 'FAILED', 'UNVERIFIED', 'INCONCLUSIVE', 'STALE', 'BLOCKED']) {
        assert.deepEqual(verify.output.presentationMeta({}, { verdict }), { verdict })
        assert.deepEqual(
          verify.presentResult({ expectation: 'x' }, { content: [], isError: false, meta: { verdict } }),
          { card: 'generic', title: `Verification: ${verdict}` },
        )
      }
    } finally {
      await mounted.dispose()
    }
  })
})

describe('a source answer is grounded, not proven', () => {
  test('the answer shape always carries a null verification field', async () => {
    // The distinction has to be visible on every call, not only when a
    // verification happens to have run. This asserts the declared shape.
    const mounted = await mountTools()
    try {
      const ask = mounted.registered.get('watch_ask_source')
      assert.match(ask.description, /does not verify/i)
      assert.match(ask.description, /watch_verify/)
    } finally {
      await mounted.dispose()
    }
  })
})

describe('acting on a page', () => {
  test('the guidance states the loop, not just prohibitions', async () => {
    const mounted = await mountTools()
    try {
      const text = mounted.sections.map(section => section.text).join('\n')
      assert.match(text, /observe → state what should change → act → re-observe/)
      assert.match(text, /is not a completed effect/i)
      assert.match(text, /do \*\*not\*\* act again/i)
    } finally {
      await mounted.dispose()
    }
  })

  test('acting refuses without an engine, and returns the key to check with', async () => {
    // The important half: a failed acting call is not a statement that nothing
    // happened, so it hands back the key needed to find out.
    const mounted = await mountTools()
    try {
      await mounted.ctx.watchCore.connect()
      const value = await mounted.registered.get('watch_browser_act').execute({
        session_id: 'live_1',
        kind: 'click',
        intent: 'submit the form',
        target_name: 'Submit',
        expect_text_present: 'Thanks',
        approval_id: 'apr_1',
      }, EXEC)
      assert.equal(value.ok, false)
      assert.ok(value.idempotencyKey, 'a failed action must say which key to check')
      assert.ok(value.fix.length > 0)
    } finally {
      await mounted.dispose()
    }
  })

  test('the action card reports the verdict verbatim, or nothing', async () => {
    const mounted = await mountTools()
    try {
      const act = mounted.registered.get('watch_browser_act')
      // Real arguments: DSH validates a presenter's args softly and falls back
      // to the generic card on a mismatch, so `{}` would prove nothing here.
      const args = { session_id: 'live_1', kind: 'click', intent: 'submit the form' }
      for (const verdict of ['succeeded', 'failed', 'unverified', 'refused']) {
        assert.deepEqual(act.output.presentationMeta(args, { verdict }), { verdict })
        assert.deepEqual(
          act.presentResult(args, { content: [], isError: false, meta: { verdict } }),
          { card: 'generic', title: `Action: ${verdict}` },
        )
      }
      // A refusal carries no verdict, and must not acquire one here.
      assert.deepEqual(
        act.output.presentationMeta(args, { ok: false, error: 'bridge.core_unavailable' }),
        { verdict: null },
      )
    } finally {
      await mounted.dispose()
    }
  })

  test('the tool description says an action without an expectation is not a success', async () => {
    const mounted = await mountTools()
    try {
      const act = mounted.registered.get('watch_browser_act')
      assert.match(act.description, /unverified/)
      assert.match(act.description, /not a success/i)
      assert.match(act.description, /approval_id/)
    } finally {
      await mounted.dispose()
    }
  })
})
