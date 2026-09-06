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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { Context } from '@deepseek-ai/cordis'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// The service class, not the module namespace. `@deepwatch/dsh-memory` default
// exports the class and cordis wants a constructor or something with `apply`;
// handing it the namespace fails with "invalid plugin" on every platform.
const { default: WatchMemoryService } = await import(pathToFileURL(
  join(ROOT, 'packages', 'watch', 'memory', 'lib', 'index.js')).href)

const BASE = mkdtempSync(join(tmpdir(), 'watch-memory-'))

/**
 * Every store this file mounts, so each one can be closed.
 *
 * The ledger holds an open SQLite handle, and on Windows an open file makes its
 * directory undeletable -- so without this the suite passes and then fails in
 * its own teardown, which reads as a product fault rather than a test one.
 */
const mounts = []
after(async () => {
  for (const fiber of mounts) {
    try { await fiber.dispose() } catch { /* already gone */ }
  }
  rmSync(BASE, { recursive: true, force: true, maxRetries: 5 })
})

const POSIX = process.platform !== 'win32'
let rooms = 0

async function mounted() {
  rooms += 1
  const directory = join(BASE, `store-${String(rooms)}`)
  const ctx = new Context()
  const fiber = await ctx.plugin(WatchMemoryService, {
    mode: 'local_personal', directory,
    inferredThreshold: 0.8, tokenBudget: 600, writeProjections: true,
  })
  mounts.push(fiber)
  return { ctx, directory, fiber, memory: ctx.get('watchMemory') }
}

describe('a personal store is created as tightly as the platform allows', () => {
  test('the store mounts and writes where it was told to', async () => {
    // Runs everywhere, and deliberately. Every other test in this describe is
    // POSIX-only, so a mistake in the shared setup -- handing cordis a module
    // namespace instead of the service class, say -- skips silently on Windows
    // and fails on Linux, which is exactly what happened. This one fails on the
    // machine the mistake is made on.
    const { directory } = await mounted()
    assert.equal(statSync(directory).isDirectory(), true,
      'the personal store did not create its directory')
    assert.equal(statSync(join(directory, 'memory-events.db')).isFile(), true,
      'the ledger was not created')
  })

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

  test('every file in a store that has been written to is owner-only',
    { skip: !POSIX }, async () => {
      // The whole directory, not a list of names. SQLite writes `-wal` and
      // `-shm` beside the ledger and the write-ahead log holds the same
      // memories the ledger does; a check that named three Markdown files
      // would have said the store was protected while two files carrying its
      // contents were world-readable.
      //
      // `mode` on a write applies at creation only, so this runs after a real
      // change rather than on a freshly created store.
      const { memory, directory } = await mounted()
      const stored = memory.correct({
        kind: 'preference',
        content: 'in this project, run the type build before the tests',
        origin: 'explicit_user',
        subjectScope: 'project',
        scopeId: 'proj_1',
      }, { userAuthenticated: true })
      assert.equal(stored.stored, true,
        `nothing was written, so nothing was checked: ${String(stored.reason)}`)

      const files = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
      assert.ok(files.length > 1,
        'only one file in the store, so the sidecar case is untested')
      for (const name of files) {
        const mode = statSync(join(directory, name)).mode & 0o777
        assert.equal(mode & 0o077, 0,
          `${name} is group- or world-accessible (${mode.toString(8)})`)
      }
    })

  test('mounting twice does not loosen what the first mount tightened', { skip: !POSIX }, async () => {
    const { directory } = await mounted()
    const before = statSync(directory).mode & 0o777
    const ctx = new Context()
    mounts.push(await ctx.plugin(WatchMemoryService, {
      mode: 'local_personal', directory,
      inferredThreshold: 0.8, tokenBudget: 600, writeProjections: true,
    }))
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
