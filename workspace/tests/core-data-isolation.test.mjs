/**
 * A profile's engine keeps its own data, and never takes away a chosen one.
 *
 * `deepwatch setup` composed a Bridge row naming the binary and nothing about
 * where that engine should keep anything, so Watch Core fell back to its own
 * default — `~/.watch-skill`, one directory for the whole machine. That is
 * right for somebody with one install and wrong the moment there are two: a
 * second composed profile read and wrote the first one's Library, Memory,
 * receipts and indexes, and a clean room built to prove something about a fresh
 * install was reading a directory an earlier install had filled. The isolation
 * a clean room claimed was being supplied by hand, by whoever remembered to
 * export the variable.
 *
 * Two properties, and the second is what keeps the first from being rude:
 *
 *   1. a composed profile supplies its own directory, inside itself;
 *   2. it supplies it only where nobody has chosen one — an exported
 *      `WATCHSKILL_DATA_DIR` still wins, because a person who set it meant it.
 *
 * Read from the child rather than from the config, because what the config says
 * and what the process receives are exactly the two things that were disagreeing.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Context } from '@deepseek-ai/cordis'
import WatchCoreService from '@deepwatch/dsh-core-bridge'

import { writeCoreBinOverride } from '../packages/watch/cli/lib/lib/compose.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'core-env-echo.mjs')

/** Spawn the engine once through the Bridge and report what it received. */
async function envSeenByCore(config, ambient) {
  const out = join(mkdtempSync(join(tmpdir(), 'watch-env-echo-')), 'seen.json')
  const had = Object.prototype.hasOwnProperty.call(process.env, 'WATCHSKILL_DATA_DIR')
  const before = process.env['WATCHSKILL_DATA_DIR']
  process.env['WATCH_ENV_ECHO_OUT'] = out
  if (ambient === undefined) delete process.env['WATCHSKILL_DATA_DIR']
  else process.env['WATCHSKILL_DATA_DIR'] = ambient

  const ctx = new Context()
  const fiber = await ctx.plugin(WatchCoreService, {
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    autoConnect: false,
    startupTimeoutMs: 10_000,
    requestTimeoutMs: 2_000,
    ...config,
  })
  try {
    // The fixture writes and exits, so the connect fails. That is fine: the
    // question is what the spawn carried, and the spawn happened.
    await ctx.watchCore.connect()
    for (let waited = 0; waited < 100 && !existsSync(out); waited += 1) {
      await new Promise((settled) => { setTimeout(settled, 20) })
    }
    assert.ok(existsSync(out), 'the engine never reported its environment')
    return JSON.parse(readFileSync(out, 'utf8'))
  } finally {
    await fiber.dispose()
    delete process.env['WATCH_ENV_ECHO_OUT']
    if (had) process.env['WATCHSKILL_DATA_DIR'] = before
    else delete process.env['WATCHSKILL_DATA_DIR']
  }
}

describe('a profile-scoped data directory reaches the engine', () => {
  test('a composed dataDir arrives as WATCHSKILL_DATA_DIR', async () => {
    const wanted = join(tmpdir(), 'watch-profile-a-data')
    const seen = await envSeenByCore({ dataDir: wanted }, undefined)
    assert.equal(seen.WATCHSKILL_DATA_DIR, wanted)
  })

  test('two profiles are handed two different directories', async () => {
    const first = await envSeenByCore({ dataDir: join(tmpdir(), 'watch-profile-a-data') }, undefined)
    const second = await envSeenByCore({ dataDir: join(tmpdir(), 'watch-profile-b-data') }, undefined)
    assert.notEqual(first.WATCHSKILL_DATA_DIR, second.WATCHSKILL_DATA_DIR,
      'two profiles would share one engine data directory')
  })

  test('composing nothing leaves the engine its own default', async () => {
    // Absent rather than empty: the engine decides, exactly as before, and
    // this change does not quietly relocate an existing single-profile install.
    const seen = await envSeenByCore({}, undefined)
    assert.equal(seen.WATCHSKILL_DATA_DIR, null)
  })
})

describe('a directory somebody chose is not overruled', () => {
  test('an exported WATCHSKILL_DATA_DIR wins over the composed one', async () => {
    const chosen = join(tmpdir(), 'the-directory-i-chose')
    const seen = await envSeenByCore({ dataDir: join(tmpdir(), 'profile-would-have-used') }, chosen)
    assert.equal(seen.WATCHSKILL_DATA_DIR, chosen,
      'a profile overruled a data directory the person had exported')
  })
})

describe('setup composes the directory inside the profile it belongs to', () => {
  test('the override names a dataDir under the profile', () => {
    const profile = mkdtempSync(join(tmpdir(), 'watch-profile-'))
    writeCoreBinOverride(profile, join(profile, 'core', 'watch-skill.exe'))
    const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    const row = /^\s*dataDir:\s*'([^']+)'/m.exec(patch)
    assert.ok(row !== null, 'the composed override names no data directory')
    assert.ok(row[1].startsWith(profile.replace(/\\/g, '/')),
      `the data directory is outside the profile: ${row[1]}`)
  })

  test('two profiles compose two different directories', () => {
    const read = (dir) => {
      mkdirSync(dir, { recursive: true })
      writeCoreBinOverride(dir, join(dir, 'core', 'watch-skill.exe'))
      return /^\s*dataDir:\s*'([^']+)'/m
        .exec(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'))[1]
    }
    const base = mkdtempSync(join(tmpdir(), 'watch-profiles-'))
    assert.notEqual(read(join(base, 'one')), read(join(base, 'two')),
      'two composed profiles would share one engine data directory')
  })
})
