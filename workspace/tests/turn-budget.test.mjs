/**
 * Whether a turn can be stopped, and whether anyone can see it coming.
 *
 * The evaluation's single turn ran 47 model rounds, 76 tool calls, three
 * subagents and nine minutes, and pushed about 2.97M tokens through the model
 * at a 97% cache hit rate. The cache is why it went unnoticed: the cost signal
 * that normally ends a runaway had been optimised away, so the only thing that
 * could stop the turn was the model deciding it was finished.
 *
 * These hold three things. That the counting is real and includes the cheap
 * tokens, because a status bar showing only billed input would have called
 * that turn small. That a hard limit stops the *next model request* rather
 * than interrupting an action, so nothing is left half-done. And that the
 * defaults sit above the run they were measured against — a budget that fires
 * during ordinary work is a budget people learn to raise.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { Context, Service } from '@deepseek-ai/cordis'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TECH = join(ROOT, 'packages', 'watch', 'technology', 'lib')

const budgetPlugin = await import(pathToFileURL(join(TECH, 'budget.js')).href)
const {
  BUDGET_SERVICE, BudgetExceededError, DEFAULT_LIMITS, breachesIn, resolveLimits,
} = budgetPlugin

/** What the evaluation actually spent, so the defaults are checked against it. */
const OBSERVED = {
  modelRounds: 47,
  toolCalls: 76,
  subagents: 3,
  uncachedInputTokens: 90_497,
  cacheReadTokens: 2_877_440,
  outputTokens: 35_405,
  wallClockMs: 594_000,
}

/** An adapter that streams a usage chunk, the way a real one reports tokens. */
class StubLlm extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'llm')
    this.usage = config.usage ?? { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 }
    this.dispatched = 0
  }

  stream(options) {
    const ctx = this.ctx
    const self = this
    return (async function* pulled() {
      const inner = await ctx.waterfall('llm/stream', options, () => {
        self.dispatched += 1
        return (async function* served() {
          yield { type: 'usage', usage: self.usage }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      })
      for await (const chunk of inner) yield chunk
    })()
  }
}

/** A loop that proposes steps through the waterfall, as upstream does. */
class StubLoop extends Service {
  constructor(ctx) { super(ctx, 'stubLoop') }

  async step(turn) {
    return this.ctx.waterfall(
      'agent/pre-step',
      { agent: { id: 'agent-1' }, turn },
      () => Promise.resolve({ kind: 'enter', messages: [] }))
  }
}

async function mount({ limits = {}, enforce = true, usage } = {}) {
  const ctx = new Context()
  await ctx.plugin(StubLlm, usage === undefined ? {} : { usage })
  await ctx.plugin(budgetPlugin, { enforce, limits })
  await ctx.plugin(StubLoop)
  const budget = ctx.get(BUDGET_SERVICE)
  const drain = async () => {
    for await (const chunk of ctx.get('llm').stream({ provider: 'p', model: 'm' })) void chunk
  }
  return {
    ctx,
    budget,
    loop: ctx.get('stubLoop'),
    llm: ctx.get('llm'),
    drain,
    attempt: async () => {
      try {
        await drain()
        return { ok: true }
      } catch (error) { return { ok: false, error } }
    },
  }
}

describe('a turn is counted while it runs', () => {
  test('model rounds are counted as the loop proposes them', async () => {
    const host = await mount()
    await host.loop.step(1)
    await host.loop.step(1)
    assert.equal(host.budget.spendFor('agent-1#1').modelRounds, 2)
  })

  test('the pre-step waterfall still returns the loop’s own decision', async () => {
    // Counting must not answer the question it is counting.
    const host = await mount()
    const decision = await host.loop.step(1)
    assert.deepEqual(decision, { kind: 'enter', messages: [] })
  })

  test('tokens are counted from the stream, in the disjoint counts upstream reports', async () => {
    const host = await mount({ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } })
    await host.loop.step(1)
    await host.drain()
    const spend = host.budget.spendFor('agent-1#1')
    assert.equal(spend.uncachedInputTokens, 100)
    assert.equal(spend.outputTokens, 20)
    assert.equal(spend.cacheReadTokens, 900)
  })

  test('the total includes cache reads, which is the number that was hidden', async () => {
    const host = await mount({ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 } })
    await host.loop.step(1)
    await host.drain()
    const spend = host.budget.spendFor('agent-1#1')
    assert.equal(spend.totalContextTokens, 1020,
      'the cheap tokens were left out of the total, which is how a runaway looks small')
  })

  test('tool calls and subagents are counted', async () => {
    const host = await mount()
    await host.loop.step(1)
    host.ctx.emit('tools/result', {}, {})
    host.ctx.emit('tools/result', {}, {})
    host.ctx.emit('subagent/start', { child: { id: 'c' } })
    const spend = host.budget.spendFor('agent-1#1')
    assert.equal(spend.toolCalls, 2)
    assert.equal(spend.subagents, 1)
  })

  test('the wall clock is read live rather than at the end', async () => {
    const host = await mount()
    await host.loop.step(1)
    await new Promise((done) => { setTimeout(done, 25) })
    assert.ok(host.budget.spendFor('agent-1#1').wallClockMs >= 20)
  })

  test('a turn nobody opened spends nothing', async () => {
    const host = await mount()
    assert.equal(host.budget.spendFor('never-opened').modelRounds, 0)
  })
})

describe('a soft limit is a warning, not a stop', () => {
  test('crossing a warn threshold announces once and keeps going', async () => {
    const host = await mount({ limits: { modelRounds: { warn: 2, hard: 99 } } })
    const warnings = []
    host.ctx.on('watch/budget-warning', (breach) => { warnings.push(breach.dimension) })
    await host.loop.step(1)
    await host.loop.step(1)
    await host.loop.step(1)
    assert.deepEqual(warnings, ['modelRounds'], 'a threshold was announced more than once')
    const result = await host.attempt()
    assert.equal(result.ok, true, 'a soft limit stopped the turn')
    assert.equal(host.budget.outcomeFor('agent-1#1'), 'warned')
  })
})

describe('a hard limit stops the next request, not the current action', () => {
  test('the request is refused with a typed error naming the dimension', async () => {
    const host = await mount({ limits: { modelRounds: { warn: 1, hard: 2 } } })
    await host.loop.step(1)
    await host.loop.step(1)
    const result = await host.attempt()
    assert.equal(result.ok, false)
    assert.ok(result.error instanceof BudgetExceededError)
    assert.equal(result.error.dimension, 'modelRounds')
    assert.equal(result.error.spent, 2)
    assert.equal(result.error.limit, 2)
    assert.match(result.error.message, /Nothing was interrupted mid-action/)
  })

  test('nothing reaches the adapter once the budget is spent', async () => {
    const host = await mount({ limits: { modelRounds: { warn: 1, hard: 2 } } })
    await host.loop.step(1)
    await host.loop.step(1)
    await host.attempt()
    assert.equal(host.llm.dispatched, 0, 'a request went out after the budget was spent')
  })

  test('the stop is announced once and the turn reports it', async () => {
    const host = await mount({ limits: { toolCalls: { warn: 1, hard: 2 } } })
    const stops = []
    host.ctx.on('watch/budget-stopped', (breach) => { stops.push(breach.dimension) })
    await host.loop.step(1)
    host.ctx.emit('tools/result', {}, {})
    host.ctx.emit('tools/result', {}, {})
    await host.attempt()
    await host.attempt()
    assert.deepEqual(stops, ['toolCalls'], 'the stop was announced more than once')
    assert.equal(host.budget.outcomeFor('agent-1#1'), 'stopped')
  })

  test('a turn within budget is not stopped and reports so', async () => {
    const host = await mount()
    await host.loop.step(1)
    const result = await host.attempt()
    assert.equal(result.ok, true)
    assert.equal(host.budget.outcomeFor('agent-1#1'), 'within_budget')
    assert.equal(host.llm.dispatched, 1)
  })

  test('enforcement off counts without refusing', async () => {
    const host = await mount({ enforce: false, limits: { modelRounds: { warn: 1, hard: 1 } } })
    await host.loop.step(1)
    await host.loop.step(1)
    const result = await host.attempt()
    assert.equal(result.ok, true, 'a disabled budget still refused a request')
    assert.equal(host.budget.spendFor('agent-1#1').modelRounds, 2, 'it stopped counting too')
  })
})

describe('a partially configured row still boots', () => {
  test('the composed shape — enforce only, no limits — mounts and enforces', async () => {
    // The regression this exists for took down the whole plugin tree on a
    // profile's first boot. The bundle row supplies `{ enforce: true }` and
    // nothing else; the loader hands that object through as it stands, and a
    // plugin that assumed a schema default had been applied threw reading
    // `limits.modelRounds` of undefined. Every unit test passed, because every
    // unit test supplied both fields.
    const ctx = new Context()
    await ctx.plugin(StubLlm, {})
    await ctx.plugin(budgetPlugin, { enforce: true })
    await ctx.plugin(StubLoop)
    const budget = ctx.get(BUDGET_SERVICE)
    assert.deepEqual(budget.limitTable().modelRounds, DEFAULT_LIMITS.modelRounds)
    await ctx.get('stubLoop').step(1)
    assert.equal(budget.spendFor('agent-1#1').modelRounds, 1)
  })

  test('no config at all mounts, and enforces by default', async () => {
    // An absent flag is not a request to stop enforcing.
    const ctx = new Context()
    await ctx.plugin(StubLlm, {})
    await ctx.plugin(budgetPlugin)
    await ctx.plugin(StubLoop)
    assert.deepEqual(
      ctx.get(BUDGET_SERVICE).limitTable().toolCalls, DEFAULT_LIMITS.toolCalls)
  })

  test('an empty limits object is the same as none', () => {
    assert.deepEqual(resolveLimits({}), resolveLimits(undefined))
    assert.deepEqual(resolveLimits(undefined).modelRounds, DEFAULT_LIMITS.modelRounds)
  })
})

describe('the defaults are above the run they were measured against', () => {
  test('every observed figure is under its hard limit', () => {
    for (const [dimension, spent] of Object.entries(OBSERVED)) {
      assert.ok(spent < DEFAULT_LIMITS[dimension].hard,
        `${dimension}: the measured run (${String(spent)}) would have been stopped by the `
        + `default hard limit (${String(DEFAULT_LIMITS[dimension].hard)})`)
    }
  })

  test('the run would have been visible as a warning', () => {
    // The point of a soft threshold: the shape shows while it is happening.
    const spend = { ...OBSERVED, cacheWriteTokens: 0, totalContextTokens: 0 }
    const warned = breachesIn(spend, DEFAULT_LIMITS)
    assert.ok(warned.length > 0, 'the measured run would have crossed no threshold at all')
    assert.ok(warned.some(breach => breach.dimension === 'modelRounds'))
  })

  test('a profile may override one dimension without losing the rest', () => {
    const limits = resolveLimits({ toolCalls: { hard: 5 } })
    assert.equal(limits.toolCalls.hard, 5)
    assert.equal(limits.toolCalls.warn, DEFAULT_LIMITS.toolCalls.warn,
      'overriding one bound silently dropped the other')
    assert.equal(limits.modelRounds.hard, DEFAULT_LIMITS.modelRounds.hard)
  })

  test('a hard breach outranks a warning in the report', () => {
    const spend = {
      modelRounds: 100, toolCalls: 60, subagents: 0, uncachedInputTokens: 0,
      cacheReadTokens: 0, outputTokens: 0, wallClockMs: 0, totalContextTokens: 0,
    }
    const found = breachesIn(spend, DEFAULT_LIMITS)
    assert.equal(found[0].level, 'hard')
    assert.equal(found[0].dimension, 'modelRounds')
  })
})
