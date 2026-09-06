/**
 * The first read after a connection gets a load budget, and only the first.
 *
 * This started as a fix for the wrong thing. The first `watch_search_sources`
 * of a session failed, and the obvious reading — a slow model load against a
 * deadline sized for a read — was wrong: measured with a fifteen-minute
 * client deadline, the first search in a fresh Core *never answered*, while a
 * second one issued afterwards in the same process answered in 51 seconds and
 * a third in 1.2. That is a deadlock, not slowness, and the cure was in Core:
 * the embedding stack is now imported on the thread that owns the Bridge
 * server rather than lazily on a worker. A first search now answers in under
 * a second.
 *
 * What survives is this: warming is best-effort, and where it was skipped the
 * first read still pays for the import. So the first read after each
 * connection keeps a larger budget — keyed on the Bridge's restart count,
 * because a restarted Core is a new process — and it is deliberately not
 * large enough to make a hang look like patience.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { Context, Service } from '@deepseek-ai/cordis'
import { applySensoryTools } from '@deepwatch/dsh-tools'

/** A Core that answers instantly and remembers the deadline it was handed. */
class RecordingCore extends Service {
  constructor(ctx, config) {
    super(ctx, 'watchCore')
    this.asked = []
    this.restartCount = config?.restartCount ?? 0
    this.reply = config?.reply ?? { ok: true, value: { sources: [], total: 0 } }
  }

  health() {
    return { restartCount: this.restartCount }
  }

  async request(method, params, options) {
    this.asked.push({ method, deadlineMs: options?.deadlineMs ?? null })
    return this.reply
  }
}

const COLD = 60_000
const WARM = 30_000

async function mount(reply) {
  const ctx = new Context()
  const registered = new Map()
  await ctx.plugin({
    name: 'sensory-harness',
    apply(inner) {
      inner.provide('tools', {
        register: definition => registered.set(definition.name, definition),
      })
    },
  })
  await ctx.plugin(RecordingCore, reply === undefined ? {} : { reply })
  const core = ctx.get('watchCore')
  applySensoryTools(ctx, {
    readTimeoutMs: WARM, coldReadTimeoutMs: COLD, liveStartTimeoutMs: 60_000,
  })
  const search = (query = 'anything') => registered.get('watch_search_sources')
    .execute({ query }, { signal: undefined, agent: {}, callId: 'c1' })
  return { ctx, core, registered, search }
}

describe('the first read after a connection gets a load budget', () => {
  test('the first search is given the cold deadline', async () => {
    const host = await mount()
    await host.search()
    assert.equal(host.core.asked.length, 1)
    assert.equal(host.core.asked[0].deadlineMs, COLD,
      'the first search was deadlined as though the model were already loaded')
  })

  test('and every search after it gets the ordinary one', async () => {
    const host = await mount()
    await host.search()
    await host.search()
    await host.search()
    assert.deepEqual(host.core.asked.map(entry => entry.deadlineMs),
      [COLD, WARM, WARM],
      'a warm process kept paying the cold budget, so a real hang waits three minutes')
  })

  test('a restarted engine is cold again', async () => {
    // The model went with the process. A flag set before the restart would
    // spend the ordinary deadline on the load a second time.
    const host = await mount()
    await host.search()
    await host.search()
    host.core.restartCount = 1
    await host.search()
    assert.deepEqual(host.core.asked.map(entry => entry.deadlineMs),
      [COLD, WARM, COLD])
  })

  test('a read that did not come back does not count as warming', async () => {
    // A refusal proves nothing about whether the model loaded, and the cost of
    // assuming the worse case is one more generous deadline rather than a
    // wrong answer.
    const host = await mount({
      ok: false,
      error: {
        error: 'bridge.deadline_exceeded', message: 'no', fix: 'retry',
        retryable: false,
      },
    })
    await host.search()
    await host.search()
    assert.deepEqual(host.core.asked.map(entry => entry.deadlineMs), [COLD, COLD])
  })

  test('a refusal is still returned to the model, with its fix', async () => {
    const host = await mount({
      ok: false,
      error: {
        error: 'bridge.deadline_exceeded',
        message: '"watch.library.search" did not return within 30000ms.',
        fix: 'Inspect the operation receipt before retrying.',
        retryable: false,
      },
    })
    const answer = await host.search()
    assert.equal(answer.ok, false)
    assert.equal(answer.error, 'bridge.deadline_exceeded')
    assert.ok(answer.fix.length > 0, 'a failure the caller cannot act on is not reported')
  })
})
