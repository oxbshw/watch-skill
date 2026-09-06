/**
 * Whether a child agent can run at all, and what happens when it cannot.
 *
 * The owner evaluation spawned three subagents. All three ended immediately
 * with `has no provider/model`, the UI said "3 subagents", the parent called
 * them "not completed" and redid the work itself. Three ghost sessions, one
 * cause, and nothing anywhere that said what the cause was.
 *
 * The cause is a mismatch, not a bug in either half: upstream inherits
 * `parent.options.provider`, and this distribution resolves a route per request
 * from the binding a person made, so there is nothing in `options` to inherit.
 * These tests hold the fix at the seam upstream's own error message points at,
 * and hold the three consequences that made it expensive — a child created
 * before anyone asked whether it could run, an identical failure repeated, and
 * a child that borrows authority it should give back.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TECH = join(ROOT, 'packages', 'watch', 'technology', 'lib')

const delegationPlugin = await import(pathToFileURL(join(TECH, 'delegation.js')).href)
const { DELEGATION_SERVICE, IDENTICAL_FAILURE_LIMIT, resolveRoute } = delegationPlugin

const PROVIDER = 'openrouter'
const MODEL = 'moonshotai/kimi-k3'

/** Settings holding a binding and the selection projected from it. */
class StubSettings extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'settings')
    this.bound = config.bound !== false
    this.document = {
      'watch-bindings': {
        version: 1,
        roles: this.bound
          ? { agent_model: { provider: PROVIDER, model: MODEL, boundAt: '2026-09-04T00:00:00Z' } }
          : {},
      },
      'agent-default-model': this.bound
        ? { provider: PROVIDER, model: MODEL }
        : { provider: '', model: '' },
    }
  }

  section(ns) { return this.document[ns] }

  edit(mutate) {
    mutate(this.document)
    this.ctx.emit('settings/document-updated', 'watch-bindings', 2)
  }
}

/** Provenance with a turn open and a route it has or has not proved. */
class StubProvenance extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'watchProvenance')
    this.turn = config.turn === undefined ? 'agent-1#1' : config.turn
    this.proved = config.proved !== false
    this.opened = []
    this.closed = []
  }

  activeTurn() { return this.turn }
  isReady() { return this.proved }
  openTurn(id) { this.opened.push(id) }
  closeTurn(id) { this.closed.push(id) }
}

/** An agent loop that asks the waterfall for its call configuration. */
class StubLoop extends Service {
  constructor(ctx) {
    super(ctx, 'stubLoop')
  }

  /** What upstream does: propose a seed config, then run the waterfall over it. */
  async requestConfig(seed = {}) {
    return this.ctx.waterfall(
      'agent/request', { turn: 1, step: 1 }, () => Promise.resolve(seed))
  }
}

async function mount({ bound = true, proved = true, turn = 'agent-1#1' } = {}) {
  const ctx = new Context()
  await ctx.plugin(StubSettings, { bound })
  await ctx.plugin(StubProvenance, { proved, turn })
  await ctx.plugin(delegationPlugin)
  await ctx.plugin(StubLoop)
  return {
    ctx,
    delegation: ctx.get(DELEGATION_SERVICE),
    provenance: ctx.get('watchProvenance'),
    settings: ctx.get('settings'),
    loop: ctx.get('stubLoop'),
  }
}

describe('a child inherits the route its parent is actually using', () => {
  test('the waterfall supplies the bound route when nothing else did', async () => {
    // The exact failure: a config proposal with no provider and no model, which
    // upstream turns into `has no provider/model` on the child's first step.
    const host = await mount()
    const config = await host.loop.requestConfig({})
    assert.equal(config.provider, PROVIDER, 'a child would still have no provider')
    assert.equal(config.model, MODEL)
  })

  test('an explicit route on the request is not replaced', async () => {
    // Somebody chose it. A deployment that overrode an explicit selection would
    // be making the decision this whole subsystem exists to stop making.
    const host = await mount()
    const config = await host.loop.requestConfig({ provider: 'other', model: 'other/model' })
    assert.equal(config.provider, 'other')
    assert.equal(config.model, 'other/model')
  })

  test('with nothing bound the waterfall changes nothing, and says why elsewhere', async () => {
    const host = await mount({ bound: false })
    const config = await host.loop.requestConfig({})
    assert.equal(config.provider, undefined)
    const route = host.delegation.route()
    assert.equal(route.ok, false)
    assert.equal(route.code, 'no_binding')
    assert.match(route.reason, /Bind a model/)
  })

  test('an unproved route is refused rather than spent', async () => {
    // A child spends real requests. It may only use a route this Host proved,
    // for the same reason the parent may only use one.
    const host = await mount({ proved: false })
    const route = host.delegation.route()
    assert.equal(route.ok, false)
    assert.equal(route.code, 'route_unproved')
    assert.match(route.reason, /provider test/)
  })

  test('the resolver reads the binding first and the selection as its projection', () => {
    const settings = {
      section: ns => ns === 'watch-bindings'
        ? { version: 1, roles: { agent_model: { provider: 'a', model: 'm' } } }
        : { provider: 'stale', model: 'stale' },
    }
    const route = resolveRoute(settings, undefined)
    assert.equal(route.ok, true)
    assert.equal(route.provider, 'a', 'a stale projection outranked the decision')
  })

  test('unreadable settings are their own answer, not an empty route', () => {
    const route = resolveRoute(undefined, undefined)
    assert.equal(route.ok, false)
    assert.equal(route.code, 'settings_unreadable')
  })
})

describe('a child that cannot run is not created', () => {
  test('preflight refuses before anything exists, with a code a caller can branch on', async () => {
    const host = await mount({ bound: false })
    const answer = host.delegation.preflight()
    assert.equal(answer.ok, false)
    assert.equal(answer.code, 'no_binding')
    assert.equal(answer.suppressed, false, 'the first refusal was suppressed')
    assert.equal(host.delegation.runningCount(), 0, 'a ghost child was created anyway')
  })

  test('the same missing configuration does not create three ghosts', async () => {
    // The evaluation's actual shape. The second and third attempts told nobody
    // anything the first had not.
    const host = await mount({ bound: false })
    const answers = [
      host.delegation.preflight(),
      host.delegation.preflight(),
      host.delegation.preflight(),
    ]
    assert.deepEqual(answers.map(a => a.suppressed), [false, true, true])
    assert.equal(host.delegation.runningCount(), 0)
    const history = host.delegation.history()
    assert.deepEqual(history.map(entry => entry.outcome), ['refused', 'suppressed', 'suppressed'])
  })

  test('fixing the configuration makes the failure worth reporting again', async () => {
    const host = await mount({ bound: false })
    host.delegation.preflight()
    assert.equal(host.delegation.preflight().suppressed, true)
    // A settings write may have fixed the very thing that was refused.
    host.settings.edit(() => {})
    assert.equal(host.delegation.preflight().suppressed, false,
      'a corrected configuration stayed suppressed')
  })

  test('a permitted preflight is recorded too, so the history is the whole story', async () => {
    const host = await mount()
    const answer = host.delegation.preflight()
    assert.equal(answer.ok, true)
    assert.deepEqual(host.delegation.history().map(entry => entry.outcome), ['permitted'])
  })
})

describe('a child borrows its parent’s authority and gives it back', () => {
  test('starting a child opens a scope inside the parent’s turn', async () => {
    const host = await mount()
    host.ctx.emit('subagent/start', { child: { id: 'child-1' } })
    assert.deepEqual(host.provenance.opened, ['agent-1#1'],
      'the child’s calls would not be attributable to the parent’s turn')
    assert.equal(host.delegation.runningCount(), 1)
  })

  test('ending it gives the scope back', async () => {
    const host = await mount()
    host.ctx.emit('subagent/start', { child: { id: 'child-1' } })
    host.ctx.emit('subagent/end', { child: { id: 'child-1' } })
    assert.deepEqual(host.provenance.closed, ['agent-1#1'])
    assert.equal(host.delegation.runningCount(), 0)
  })

  test('a child started outside any turn borrows nothing', async () => {
    // There is no authority to lend, so none is lent. The child's calls will be
    // refused by the routing guard, which is the correct outcome.
    const host = await mount({ turn: null })
    host.ctx.emit('subagent/start', { child: { id: 'child-1' } })
    assert.deepEqual(host.provenance.opened, [])
    assert.equal(host.delegation.runningCount(), 0)
  })

  test('an end for a child nobody started changes nothing', async () => {
    const host = await mount()
    host.ctx.emit('subagent/end', { child: { id: 'never-started' } })
    assert.deepEqual(host.provenance.closed, [])
  })

  test('two children are two scopes, and closing one leaves the other', async () => {
    const host = await mount()
    host.ctx.emit('subagent/start', { child: { id: 'a' } })
    host.ctx.emit('subagent/start', { child: { id: 'b' } })
    host.ctx.emit('subagent/end', { child: { id: 'a' } })
    assert.equal(host.delegation.runningCount(), 1)
    assert.equal(host.provenance.opened.length, 2)
    assert.equal(host.provenance.closed.length, 1)
  })
})

describe('the seams this relies on', () => {
  test('agent/request is still the waterfall upstream says it is', (t) => {
    const source = pinned('core', 'agent', 'src', 'runtime-types.ts')
    if (source === null) {
      t.skip('the pinned Harness baseline is not checked out; run scripts/upstream-sync.mjs')
      return
    }
    const at = source.split('\n').findIndex(line => line.includes("'agent/request'(this"))
    assert.notEqual(at, -1, 'upstream no longer declares agent/request')
    const above = source.split('\n').slice(Math.max(0, at - 20), at).join('\n')
    assert.match(above, /@mode waterfall/,
      'agent/request stopped being a waterfall; the route supply would answer it instead')
  })

  test('upstream still inherits the parent route it cannot find here', (t) => {
    const source = pinned('subagent', 'subagent', 'src', 'child-agent.ts')
    if (source === null) {
      t.skip('the pinned Harness baseline is not checked out; run scripts/upstream-sync.mjs')
      return
    }
    assert.match(source, /parent\.options\.provider/,
      'the inheritance this works around has changed; re-read child-agent.ts')
  })

  test('subagent start and end are still emits', (t) => {
    const source = pinned('subagent', 'subagent', 'src', 'index.ts')
    if (source === null) {
      t.skip('the pinned Harness baseline is not checked out; run scripts/upstream-sync.mjs')
      return
    }
    for (const event of ['subagent/start', 'subagent/end']) {
      assert.ok(source.includes(`'${event}'`), `upstream no longer declares ${event}`)
    }
  })

  test('the bundle composes delegation ahead of routing', () => {
    const patch = readFileSync(
      join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml'), 'utf8')
    const delegationAt = patch.indexOf('id: watch-delegation')
    const routingAt = patch.indexOf('id: watch-routing')
    assert.ok(delegationAt > 0 && delegationAt < routingAt)
  })

  test('the breaker limit is one, and says so', () => {
    assert.equal(IDENTICAL_FAILURE_LIMIT, 1)
  })
})

/** One pinned upstream file, or null when the baseline is absent. */
function pinned(...relative) {
  try {
    return readFileSync(
      join(ROOT, 'upstream', 'deepseek-harness', 'packages', ...relative), 'utf8')
  } catch {
    return null
  }
}
