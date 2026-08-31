/**
 * The walk that decides what the managed runtime installs, and the reasons it
 * is allowed to refuse.
 *
 * `scripts/gen-managed-runtime.mjs` is a gate as much as a generator. It reads
 * one committed file — the audited closure — and either produces an exact
 * dependency set or stops the build. Everything it can be wrong about is
 * something a person would only discover much later, on a machine that
 * installed cleanly and would not start: a peer that resolves to nothing, two
 * required ranges no single version satisfies, a package whose licence nobody
 * can name, evidence somebody edited by hand.
 *
 * So each of those is made to happen here, in a copy of the workspace's
 * generator inputs, and the assertion is that the build stops. A generator
 * that only ever runs against good input is a generator whose refusals have
 * never been read.
 *
 * The range comparison is tested separately and first, because every refusal
 * above depends on it and a satisfier that quietly answers `false` where it
 * means "I could not read that" would turn all of them into false alarms.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const { satisfies, compare, parseVersion, UnsupportedRange } = await import(
  pathToFileURL(join(ROOT, 'scripts', 'lib', 'semver-lite.mjs')).href)

const rooms = []
test.after(() => {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/**
 * A copy of everything the generator reads and writes, and nothing else.
 *
 * Small on purpose: the generator's inputs are one evidence file, the catalog,
 * and the package manifests. If that list grows, this fixture breaks and says
 * so, which is the point — a generator that started reading `node_modules` or
 * a lockfile would no longer be reproducible from committed evidence.
 */
function generatorRoot() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'deepwatch-gen-')))
  rooms.push(dir)
  cpSync(join(ROOT, 'scripts'), join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'inventory'), { recursive: true })
  cpSync(join(ROOT, 'inventory', 'dsh-closure.json'), join(dir, 'inventory', 'dsh-closure.json'))
  cpSync(join(ROOT, 'pnpm-workspace.yaml'), join(dir, 'pnpm-workspace.yaml'))
  const packages = join(ROOT, 'packages', 'watch')
  for (const name of readdirSync(packages)) {
    const manifest = join(packages, name, 'package.json')
    try {
      mkdirSync(join(dir, 'packages', 'watch', name), { recursive: true })
      cpSync(manifest, join(dir, 'packages', 'watch', name, 'package.json'))
    } catch {
      // Not a package directory.
    }
  }
  mkdirSync(join(dir, 'packages', 'watch', 'cli', 'src', 'generated'), { recursive: true })
  return dir
}

/** Rewrite the evidence, re-sealing its digest so only the change is under test. */
function reseal(dir, edit) {
  const path = join(dir, 'inventory', 'dsh-closure.json')
  const document = JSON.parse(readFileSync(path, 'utf8'))
  edit(document)
  document.digest = undefined
  document.digest = `sha256:${createHash('sha256')
    .update(JSON.stringify({ ...document, digest: undefined })).digest('hex')}`
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
}

/** Run the generator in a prepared root. */
function generate(dir, args = []) {
  const ran = spawnSync(process.execPath,
    [join(dir, 'scripts', 'gen-managed-runtime.mjs'), ...args],
    { encoding: 'utf8', timeout: 120_000, cwd: dir })
  return {
    code: ran.status ?? 1,
    stdout: ran.stdout ?? '',
    stderr: ran.stderr ?? '',
    manifest: join(dir, 'inventory', 'managed-runtime.json'),
  }
}

describe('deciding whether a version satisfies a range', () => {
  test('the shapes the audited closure actually contains', () => {
    const cases = [
      ['0.1.1-rc.2', '^0.1.1-rc.2', true],
      ['0.1.1-rc.2', '0.1.1-rc.2', true],
      ['0.1.1-rc.2', '^0.1.0', false],
      ['4.0.2', '^4.0.1', true],
      ['4.0.1', '4.0.1', true],
      ['4.0.1', '^4.0.2', false],
      ['18.3.1', '^18.2.0', true],
      ['19.2.8', '^18.2.0', false],
      ['18.3.1', '^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0', true],
      ['15.0.0', '^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0', false],
      ['1.2.3', '>=1.2.0 <2.0.0', true],
      ['2.0.0', '>=1.2.0 <2.0.0', false],
      ['1.5.0', '>= 1.2', true],
      ['1.2.3', '~1.2.0', true],
      ['1.3.0', '~1.2.0', false],
      ['18.3.1', '^18', true],
      ['1.0.0', '^1.0 || ^2.0', true],
      ['0.0.3', '^0.0.3', true],
      ['0.0.4', '^0.0.3', false],
      ['2.0.0-rc.1', '^1.2.3', false],
    ]
    for (const [version, range, expected] of cases) {
      assert.equal(satisfies(version, range), expected, `${version} vs ${range}`)
    }
  })

  test('every range in the audited closure is one this can read', () => {
    // The property that lets a refusal be believed. A range this cannot parse
    // throws rather than answering, so the generator stops instead of
    // reporting a conflict that is really a gap in this file.
    const closure = JSON.parse(
      readFileSync(join(ROOT, 'inventory', 'dsh-closure.json'), 'utf8'))
    const ranges = new Set()
    for (const record of closure.packages) {
      for (const range of Object.values(record.peerDependencies ?? {})) ranges.add(range)
      for (const range of Object.values(record.dependencies ?? {})) ranges.add(range)
      for (const range of Object.values(record.optionalDependencies ?? {})) ranges.add(range)
    }
    assert.ok(ranges.size > 100, 'the closure got small; re-read this test')
    const unreadable = []
    for (const range of ranges) {
      try {
        satisfies('1.2.3', range)
      } catch {
        unreadable.push(range)
      }
    }
    assert.deepEqual(unreadable, [])
  })

  test('an unreadable range throws rather than answering false', () => {
    assert.throws(() => satisfies('1.2.3', 'workspace:*'), UnsupportedRange)
    assert.throws(() => satisfies('1.2.3', 'npm:thing@1'), UnsupportedRange)
  })

  test('prereleases order below the release they lead to', () => {
    assert.ok(compare(parseVersion('0.1.1-rc.2'), parseVersion('0.1.1')) < 0)
    assert.ok(compare(parseVersion('0.1.1-rc.2'), parseVersion('0.1.1-rc.10')) < 0)
    assert.equal(compare(parseVersion('1.2.3'), parseVersion('1.2.3')), 0)
  })
})

describe('the generator refuses rather than guessing', () => {
  test('the same evidence produces the same file, twice, in two places', () => {
    const first = generatorRoot()
    const second = generatorRoot()
    assert.equal(generate(first).code, 0)
    assert.equal(generate(second).code, 0)

    assert.equal(
      readFileSync(join(first, 'inventory', 'managed-runtime.json'), 'utf8'),
      readFileSync(join(second, 'inventory', 'managed-runtime.json'), 'utf8'),
      'the derivation is not reproducible')
    // And the same as the committed one, which is what `--check` enforces.
    assert.equal(
      readFileSync(join(first, 'inventory', 'managed-runtime.json'), 'utf8'),
      readFileSync(join(ROOT, 'inventory', 'managed-runtime.json'), 'utf8'))
  })

  test('evidence edited by hand is refused, because it is no longer evidence', () => {
    const dir = generatorRoot()
    const path = join(dir, 'inventory', 'dsh-closure.json')
    const document = JSON.parse(readFileSync(path, 'utf8'))
    document.packages[0].version = '99.0.0'
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)

    const ran = generate(dir)
    assert.notEqual(ran.code, 0)
    assert.match(ran.stderr, /edited by hand/)
  })

  test('a required peer with no exact resolution stops the build', () => {
    const dir = generatorRoot()
    reseal(dir, document => {
      document.packages = document.packages.filter(
        entry => entry.name !== '@deepseek-ai/dsh-invariants')
    })

    const ran = generate(dir)
    assert.notEqual(ran.code, 0)
    assert.match(ran.stderr, /dsh-invariants/)
    assert.match(ran.stderr, /no exact version/)
  })

  test('two required ranges no version satisfies stop the build', () => {
    // Exactly the shape of the conflict this found for real: the workspace
    // pinned cordis to 4.0.1 while three plugins in the closure required
    // ^4.0.2, and no single hoisted version could satisfy both.
    const dir = generatorRoot()
    reseal(dir, document => {
      for (const record of document.packages) {
        if (record.name !== '@deepseek-ai/dsh-app-boot') continue
        record.peerDependencies = { ...record.peerDependencies, react: '^99.0.0' }
      }
    })

    const ran = generate(dir)
    assert.notEqual(ran.code, 0)
    assert.match(ran.stderr, /react@/)
    assert.match(ran.stderr, /No single version can coexist/)
  })

  test('a package whose licence nobody can name stops the build', () => {
    const dir = generatorRoot()
    reseal(dir, document => {
      for (const record of document.packages) {
        if (record.name === '@deepseek-ai/dsh-invariants') record.license = 'UNKNOWN'
      }
    })

    const ran = generate(dir)
    assert.notEqual(ran.code, 0)
    assert.match(ran.stderr, /licence/)
  })

  test('a stale committed manifest fails the freshness gate', () => {
    const dir = generatorRoot()
    assert.equal(generate(dir).code, 0)
    const path = join(dir, 'inventory', 'managed-runtime.json')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"installedPackages"', '"stale"'))

    const ran = generate(dir, ['--check'])
    assert.notEqual(ran.code, 0)
    assert.match(ran.stderr, /stale/)
  })

  test('a stale generated module fails the freshness gate too', () => {
    const dir = generatorRoot()
    assert.equal(generate(dir).code, 0)
    const path = join(
      dir, 'packages', 'watch', 'cli', 'src', 'generated', 'managed-runtime.ts')
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n// edited\n`)

    const ran = generate(dir, ['--check'])
    assert.notEqual(ran.code, 0)
    assert.match(ran.stderr, /managed-runtime\.ts/)
  })

  test('the committed artifacts are current', () => {
    // The gate as `npm run check` runs it, against the real tree.
    const ran = spawnSync(process.execPath,
      [join(ROOT, 'scripts', 'gen-managed-runtime.mjs'), '--check'],
      { encoding: 'utf8', timeout: 120_000, cwd: ROOT })
    assert.equal(ran.status, 0, `${ran.stdout ?? ''}${ran.stderr ?? ''}`)
  })
})
