/**
 * Whether every bundle row survives the config the bundle actually gives it.
 *
 * `verify:bundle` imports each row's module and checks it exports `apply`. That
 * catches a missing entry point and nothing else, and this branch found out
 * what else there is: the budget row is composed as `{ enforce: true }`, the
 * loader hands that object through as it stands, and the plugin read
 * `limits.modelRounds` off an undefined `limits`. It threw inside `apply`,
 * which took down the whole plugin tree, which meant the profile did not serve,
 * which meant `deepwatch setup` failed at the composition step — three minutes
 * of provisioning away from the one-line cause.
 *
 * Every unit test passed, because every unit test supplied a complete config.
 * So this one supplies exactly what the bundle supplies: the row's own `config`
 * block, read out of `cordis.patch.yml`, and nothing else.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context, Service } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH = join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml')

/**
 * The `@deepwatch/dsh-technology/*` rows and the config each is composed with.
 *
 * Parsed from the patch rather than restated, so a row added next month is
 * covered by this the day it is added. Deliberately small: the YAML here is a
 * list of `- id: … name: … config: …` blocks with scalar leaves, and a real
 * parser would be a dependency added to read six keys.
 */
function technologyRows() {
  const text = readFileSync(PATCH, 'utf8')
  const rows = []
  const lines = text.split('\n')
  for (let at = 0; at < lines.length; at += 1) {
    const idLine = /^\s*- id: (watch-[a-z-]+)\s*$/.exec(lines[at] ?? '')
    if (idLine === null) continue
    const nameLine = /^\s*name: '(@deepwatch\/dsh-technology\/[a-z-]+)'\s*$/
      .exec(lines[at + 1] ?? '')
    if (nameLine === null) continue

    const config = {}
    if (/^\s*config:\s*$/.test(lines[at + 2] ?? '')) {
      for (let below = at + 3; below < lines.length; below += 1) {
        const entry = /^\s{8}([a-zA-Z]+):\s*(.+?)\s*$/.exec(lines[below] ?? '')
        if (entry === null) break
        const [, key, raw] = entry
        config[key] = raw === 'true' ? true : raw === 'false' ? false
          : /^-?\d+$/.test(raw) ? Number(raw) : raw
      }
    }
    rows.push({ id: idLine[1], module: nameLine[1], config })
  }
  return rows
}

/** The subpath's file inside the built package. */
const libFor = (moduleName) => join(
  ROOT, 'packages', 'watch', 'technology', 'lib',
  `${moduleName.slice('@deepwatch/dsh-technology/'.length)}.js`)

/** Stand-ins for the services a row may inject, so `apply` can be reached. */
class StubLlm extends Service {
  constructor(ctx) { super(ctx, 'llm') }
  stream() { return (async function* none() { /* nothing */ })() }
}
class StubSettings extends Service {
  constructor(ctx) { super(ctx, 'settings') }
  section() { return undefined }
  register(_ns, _schema, options = {}) {
    return { get: () => options.base, watch: () => { /* nothing */ } }
  }
}
class StubProvenance extends Service {
  constructor(ctx) { super(ctx, 'watchProvenance') }
  activeTurn() { return null }
  isReady() { return false }
  openTurn() { /* nothing */ }
  closeTurn() { /* nothing */ }
}

describe('every technology row mounts with the config the bundle gives it', () => {
  const rows = technologyRows()

  test('the patch still declares the rows this reads', () => {
    assert.ok(rows.length >= 4,
      `expected several technology rows, parsed ${String(rows.length)} — the patch shape moved`)
    const ids = rows.map(row => row.id)
    for (const wanted of ['watch-provenance', 'watch-observation', 'watch-budget',
      'watch-delegation', 'watch-routing']) {
      assert.ok(ids.includes(wanted), `${wanted} is no longer parsed from the patch`)
    }
  })

  for (const row of technologyRows()) {
    test(`${row.id} applies with ${JSON.stringify(row.config)}`, async () => {
      const plugin = await import(pathToFileURL(libFor(row.module)).href)
      const ctx = new Context()
      await ctx.plugin(StubSettings)
      await ctx.plugin(StubLlm)
      // Not when the row under test provides it: a stub standing in for the
      // very service being mounted collides with it, and the collision would
      // read as a config failure it is not.
      if (!row.module.endsWith('/provenance')) await ctx.plugin(StubProvenance)
      // Exactly what the loader does: hand the row's own config block to
      // `apply`, with no schema defaults folded in first.
      await ctx.plugin(plugin, row.config)
    })
  }

  test('the budget row in particular is composed without limits', () => {
    // The specific shape that broke a clean-room build. If somebody later adds
    // a `limits` block to the row, this stops being the regression it was
    // written for and should be re-read rather than deleted.
    const budget = technologyRows().find(row => row.id === 'watch-budget')
    assert.notEqual(budget, undefined)
    assert.deepEqual(budget.config, { enforce: true })
  })
})
