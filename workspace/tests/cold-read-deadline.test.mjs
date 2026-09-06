/**
 * The first search of a session pays for a model load, and 30s does not cover it.
 *
 * Measured in the acceptance room against 1.4.0, on a fast laptop: the first
 * `watch.library.search` in a freshly started Core came back at 30003ms as
 * `bridge.deadline_exceeded`, and the next one — same process, same query —
 * answered in 4388ms. A semantic search loads an embedding model on first use,
 * and the read deadline was sized for a read.
 *
 * The consequence is specific and bad: the first `watch_search_sources` an
 * agent makes after the product opens is exactly the cold one, so the tool
 * that finds which source mentioned something fails the first time it is
 * asked, on a machine where nothing is wrong. Raising every read's deadline
 * would trade that for waiting two minutes to be told about a genuine hang, so
 * the first read after a connection gets its own budget and the rest keep the
 * ordinary one.
 *
 * Keyed on the Bridge's restart count, because a Core that exited and was
 * restarted is a new process with a cold model again.
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

const COLD = 180_000
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
