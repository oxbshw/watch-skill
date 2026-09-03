/**
 * `WATCH_CORE_BIN` has to reach the thing that spawns the engine.
 *
 * It was accepted, documented, and reported on by `doctor` — and ignored by
 * composition. The bundle composes the Bridge with `command: watch-skill`, so
 * a machine where the engine is real but off `PATH` got
 * `spawn watch-skill ENOENT`, the Bridge fell back to its mock, and every
 * capability reported `not_tested` with `missing: ["watch-core"]` while
 * `doctor` cheerfully confirmed the binary was fine.
 *
 * That is the worst shape a configuration variable can have: honoured in the
 * report and not in the runtime. A person following the diagnostic has no way
 * to discover that the diagnostic is describing a different code path.
 *
 * The override is written into the profile's own patch layer, which is
 * upstream's documented place for per-profile changes and is applied after
 * every bundle layer. These hold the three properties that make it correct:
 * it targets the Bridge row, it restates the row's whole config, and it pins
 * `stdio` so a named engine that will not start is a fault rather than a
 * silent mock.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'packages', 'watch', 'cli')

const { writeCoreBinOverride } = await import(
  pathToFileURL(join(CLI, 'lib', 'lib', 'compose.js')).href)

const rooms = []
test.after(() => {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/** A profile directory carrying the patch layer the Harness writes for a new one. */
function profile(initial = '# Your patch layer for this dsh profile\n[]\n') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deepwatch-corebin-')))
  rooms.push(dir)
  writeFileSync(join(dir, 'cordis.patch.yml'), initial, 'utf8')
  return dir
}

const read = dir => readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')

describe('the Bridge is pointed at the executable a person named', () => {
  test('the override targets the Bridge row and names the binary', () => {
    const dir = profile()
    writeCoreBinOverride(dir, 'D:\\watch\\.venv\\Scripts\\watch-skill.exe')
    const patch = read(dir)
    assert.match(patch, /^- id: watch-core-bridge$/m)
    assert.match(patch, /command: 'D:\/watch\/\.venv\/Scripts\/watch-skill\.exe'/)
  })

  test('the path is written with forward slashes', () => {
    // A YAML scalar keeps its backslashes, and a Windows path that survives
    // quoting still has to survive being read back as a command.
    const dir = profile()
    const written = writeCoreBinOverride(dir, 'C:\\Program Files\\watch\\watch-skill.exe')
    assert.equal(written.includes('\\'), false)
    assert.equal(read(dir).includes('\\'), false)
  })

  test('it keeps `auto`, so a Core that cannot speak Bridge is reported honestly', () => {
    // Pinning `stdio` looked right and was wrong. Naming the binary is not the
    // same as asserting it speaks the Bridge protocol -- Watch Skill 1.4.0rc1
    // ships `serve` and no `bridge` subcommand -- and pinning it turned an
    // honest "running on the mock backend" into a spawn that fails every time,
    // which the health panel then reported as a connection.
    const dir = profile()
    writeCoreBinOverride(dir, '/usr/local/bin/watch-skill')
    assert.match(read(dir), /transport: auto/)
    assert.doesNotMatch(read(dir), /transport: stdio/)
  })

  test('the row states what it is for, and not the timeouts', () => {
    // A Loader patch replaces the targeted row's whole `config`, so this used
    // to restate every key including the timeouts — which made it a second
    // copy of a boundary the bundle patch already declares, and the copy that
    // wins, because it is written last.
    //
    // That is not hypothetical. Raising the startup budget to 45s in the
    // bundle changed nothing for any profile built by `deepwatch setup`: the
    // clean room kept the ten seconds that reported a healthy first start as
    // a dead engine, and the fix looked applied while the composed profile
    // disagreed. Omitted, the service schema governs, and its defaults are
    // the values the bundle declares.
    const patch = (() => { const dir = profile(); writeCoreBinOverride(dir, 'x'); return read(dir) })()
    for (const key of ['transport', 'command', 'args', 'cwd', 'autoConnect']) {
      assert.ok(patch.includes(`${key}:`), `the override drops ${key}`)
    }
    for (const key of ['startupTimeoutMs', 'requestTimeoutMs']) {
      assert.ok(!patch.includes(`${key}:`),
        `the override restates ${key}, so the bundle's value cannot govern`)
    }
  })
})

describe('the patch layer stays a document, and stays the person’s', () => {
  test('the empty flow sequence the Harness writes is removed', () => {
    // `[]` followed by block entries is not a document any YAML reader will
    // accept, so leaving it would make the first override unparseable.
    const dir = profile()
    writeCoreBinOverride(dir, 'x')
    const lines = read(dir).split(/\r?\n/).map(line => line.trim())
    assert.equal(lines.includes('[]'), false)
  })

  test('a second run replaces the block rather than appending one', () => {
    const dir = profile()
    writeCoreBinOverride(dir, '/first/watch-skill')
    writeCoreBinOverride(dir, '/second/watch-skill')
    const patch = read(dir)
    assert.equal((patch.match(/- id: watch-core-bridge/g) ?? []).length, 1)
    assert.ok(patch.includes('/second/watch-skill'))
    assert.equal(patch.includes('/first/watch-skill'), false)
  })

  test('anything a person put in the file survives', () => {
    const dir = profile('# mine\n- id: some-row\n  disabled: true\n')
    writeCoreBinOverride(dir, 'x')
    const patch = read(dir)
    assert.match(patch, /^- id: some-row$/m)
    assert.match(patch, /^# mine$/m)
    assert.match(patch, /^- id: watch-core-bridge$/m)
  })

  test('the block is findable again, so it is never guessed at', () => {
    const dir = profile()
    writeCoreBinOverride(dir, 'x')
    const patch = read(dir)
    assert.match(patch, /# deepwatch: Watch Core binary/)
    assert.match(patch, /# deepwatch: end of Watch Core binary override/)
  })
})

describe('composition asks for it, and the bundle default stands without it', () => {
  test('setup passes the variable through rather than only reporting it', () => {
    const setup = readFileSync(join(CLI, 'src', 'setup.ts'), 'utf8')
    assert.match(setup, /watchCoreBin: watchCoreBin\(env\)/)
  })

  test('the bundle still composes `auto` for a machine that names nothing', () => {
    // The default is right when nobody has said where the engine is: connect
    // the real one when it is on PATH, and report the mock honestly when it is
    // not. The override is what a person opts into.
    const bundle = readFileSync(
      join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml'), 'utf8')
    assert.match(bundle, /transport: auto/)
    assert.match(bundle, /command: watch-skill/)
  })
})
