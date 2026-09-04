/**
 * The memory store is plaintext, so its permissions are the protection.
 *
 * Nothing here claims encryption, and nothing in the product does either — the
 * Memory page says "Not encrypted" and will keep saying it until an at-rest
 * design exists that somebody has reviewed. What that makes true is narrower
 * and worth holding: if the only thing standing between a person's memory
 * ledger and every other account on the machine is a file mode, the file mode
 * has to be set rather than left to the umask.
 *
 * Windows has no POSIX modes, so the mode assertions run where they mean
 * something and the disclosure is worded for both.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const memoryPlugin = await import(pathToFileURL(
  join(ROOT, 'packages', 'watch', 'memory', 'lib', 'index.js')).href)

const BASE = mkdtempSync(join(tmpdir(), 'watch-memory-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })

const POSIX = process.platform !== 'win32'
let rooms = 0

async function mounted() {
  rooms += 1
  const directory = join(BASE, `store-${String(rooms)}`)
  const ctx = new Context()
  await ctx.plugin(memoryPlugin, {
    mode: 'local_personal', directory,
    inferredThreshold: 0.8, tokenBudget: 600, writeProjections: true,
  })
  return { ctx, directory, memory: ctx.get('watchMemory') }
}

describe('a personal store is created as tightly as the platform allows', () => {
  test('the directory is owner-only', { skip: !POSIX }, async () => {
    const { directory } = await mounted()
    assert.equal(statSync(directory).mode & 0o777, 0o700,
      'the memory directory is readable by somebody other than its owner')
  })

  test('the ledger file is owner-only', { skip: !POSIX }, async () => {
    const { directory } = await mounted()
    const mode = statSync(join(directory, 'memory-events.db')).mode & 0o777
    assert.equal(mode & 0o077, 0, `the ledger is group- or world-accessible (${mode.toString(8)})`)
  })

  test('a rewritten projection does not keep looser permissions', { skip: !POSIX }, async () => {
    // `mode` on a write applies at creation only, so a projection rebuilt over
    // an existing file would keep whatever it was first given.
    const { memory, directory } = await mounted()
    memory.remember({ kind: 'preference', content: 'tabs', origin: 'explicit_user' })
    if (typeof memory.project === 'function') await memory.project()
    for (const name of ['taste.md', 'index.md', 'log.md']) {
      const path = join(directory, name)
      try {
        const mode = statSync(path).mode & 0o777
        assert.equal(mode & 0o077, 0, `${name} is group- or world-accessible`)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
  })

  test('mounting twice does not loosen what the first mount tightened', { skip: !POSIX }, async () => {
    const { directory } = await mounted()
    const before = statSync(directory).mode & 0o777
    const ctx = new Context()
    await ctx.plugin(memoryPlugin, {
      mode: 'local_personal', directory,
      inferredThreshold: 0.8, tokenBudget: 600, writeProjections: true,
    })
    assert.equal(statSync(directory).mode & 0o777, before)
  })
})

describe('the product never claims the store is encrypted', () => {
  const settings = readFileSync(join(ROOT, 'packages', 'watch', 'client-settings',
    'src', 'client', 'components.tsx'), 'utf8')

  test('the storage disclosure says it is not encrypted', () => {
    assert.match(settings, /Not encrypted/)
  })

  test('nothing promises encryption at rest', () => {
    // The one thing a privacy setting must never do. A claim here would be
    // read as a guarantee by exactly the people least able to check it.
    assert.doesNotMatch(settings, /encrypted at rest[^.]{0,40}(yes|enabled|on\b)/i)
    assert.doesNotMatch(settings, /is encrypted/i)
  })

  test('the disclosure describes the permissions that are actually applied', () => {
    assert.match(settings, /owner-only/)
  })
})

describe('the store does not put itself into diagnostics', () => {
  test('no memory directory path is rendered on the settings page', () => {
    const settings = readFileSync(join(ROOT, 'packages', 'watch', 'client-settings',
      'src', 'client', 'components.tsx'), 'utf8')
    assert.doesNotMatch(settings, /[A-Za-z]:[\/]{1,2}Users/i)
    assert.doesNotMatch(settings, /\/(?:home|Users)\//)
    assert.doesNotMatch(settings, /config\.directory/)
  })

  test('no remembered content is rendered on the settings page', () => {
    const settings = readFileSync(join(ROOT, 'packages', 'watch', 'client-settings',
      'src', 'client', 'components.tsx'), 'utf8')
    assert.doesNotMatch(settings, /records\.map|record\.content/)
  })
})
