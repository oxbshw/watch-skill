/**
 * Where did this installation come from?
 *
 * An evaluation of this candidate inspected an installed npm runtime and could
 * not answer that: not which package versions composed it, not which Harness it
 * was measured against, not whether any of it matched something released.
 * Everything needed was already in the release manifest, and nothing carried it
 * to the machine the product runs on.
 *
 * The chain these hold is released-composition to installed-composition, and
 * the property that makes it worth having is that both ends compute the same
 * value from the same inputs. So the digest is tested for the three ways a
 * digest like this usually turns out to be worthless: it is not stable, it is
 * not the same on both sides, or it quietly carries the machine it was computed
 * on into an artifact that gets copied elsewhere.
 */

import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'packages', 'watch', 'cli', 'lib')

const {
  SCOPE, compositionDigest, describeProvenance, installedVersion,
  readComposition, renderProvenance,
} = await import(pathToFileURL(join(CLI, 'provenance.js')).href)
const { HARNESS_PACKAGE, HARNESS_VERSION, RELEASE_RUNTIME_DIGEST, VERSION } =
  await import(pathToFileURL(join(CLI, 'version.js')).href)

const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'docs', 'release-manifest.json'), 'utf8'))

const BASE = mkdtempSync(join(tmpdir(), 'watch-provenance-'))
after(() => { rmSync(BASE, { recursive: true, force: true, maxRetries: 5 }) })

let rooms = 0
/** A node_modules tree holding exactly the packages named. */
function runtime(packages, { harness = null } = {}) {
  rooms += 1
  const nodeModules = join(BASE, `room-${String(rooms)}`, 'node_modules')
  for (const [name, version] of Object.entries(packages)) {
    const dir = join(nodeModules, ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'),
      `${JSON.stringify({ name, version })}\n`, 'utf8')
  }
  if (harness !== null) {
    const dir = join(nodeModules, ...HARNESS_PACKAGE.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'),
      `${JSON.stringify({ name: HARNESS_PACKAGE, version: harness })}\n`, 'utf8')
  }
  return nodeModules
}

describe('the digest is a function of the composition and nothing else', () => {
  test('the same packages give the same digest', () => {
    const packages = [
      { name: `${SCOPE}/dsh-tools`, version: '0.1.0-preview.0' },
      { name: `${SCOPE}/dsh-contracts`, version: '0.1.0-preview.0' },
    ]
    assert.equal(compositionDigest(packages), compositionDigest(packages))
  })

  test('order does not change it', () => {
    const a = { name: `${SCOPE}/a`, version: '1.0.0' }
    const b = { name: `${SCOPE}/b`, version: '2.0.0' }
    assert.equal(compositionDigest([a, b]), compositionDigest([b, a]))
  })

  test('a different version changes it', () => {
    const first = [{ name: `${SCOPE}/a`, version: '1.0.0' }]
    const second = [{ name: `${SCOPE}/a`, version: '1.0.1' }]
    assert.notEqual(compositionDigest(first), compositionDigest(second))
  })

  test('a missing package changes it', () => {
    const full = [
      { name: `${SCOPE}/a`, version: '1.0.0' },
      { name: `${SCOPE}/b`, version: '1.0.0' },
    ]
    assert.notEqual(compositionDigest(full), compositionDigest(full.slice(0, 1)))
  })

  test('names and versions cannot be run together into a collision', () => {
    // `a@1` + `b@2` must not hash the same as a single `a@1b@2`.
    const separate = [
      { name: 'a', version: '1' },
      { name: 'b', version: '2' },
    ]
    const joined = [{ name: 'a', version: '1b@2' }]
    assert.notEqual(compositionDigest(separate), compositionDigest(joined))
  })
})

describe('reading an installation', () => {
  test('every first-party package is found, sorted', () => {
    const nodeModules = runtime({
      [`${SCOPE}/dsh-tools`]: '0.1.0-preview.0',
      [`${SCOPE}/dsh-contracts`]: '0.1.0-preview.0',
      '@other/thing': '9.9.9',
    })
    const found = readComposition(nodeModules)
    assert.deepEqual(found.map(entry => entry.name),
      [`${SCOPE}/dsh-contracts`, `${SCOPE}/dsh-tools`])
  })

  test('a machine that has not been set up reports no composition, not an error', () => {
    const provenance = describeProvenance(join(BASE, 'nothing-here', 'node_modules'))
    assert.equal(provenance.resolved, false)
    assert.deepEqual(provenance.packages, [])
    assert.match(renderProvenance(provenance).join('\n'), /deepwatch setup/)
  })

  test('a null runtime is answered rather than thrown at', () => {
    assert.equal(describeProvenance(null).resolved, false)
  })

  test('a package whose manifest will not parse is left out rather than guessed', () => {
    const nodeModules = runtime({ [`${SCOPE}/dsh-tools`]: '0.1.0-preview.0' })
    const broken = join(nodeModules, SCOPE, 'dsh-broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'package.json'), '{ not json', 'utf8')
    assert.deepEqual(readComposition(nodeModules).map(entry => entry.name),
      [`${SCOPE}/dsh-tools`])
  })

  test('the Harness version is read, and compared with the one this build was measured against', () => {
    const matching = describeProvenance(runtime({}, { harness: HARNESS_VERSION }))
    assert.equal(matching.harness.installed, HARNESS_VERSION)
    assert.equal(matching.harness.matches, true)

    const other = describeProvenance(runtime({}, { harness: '0.0.0-not-this-one' }))
    assert.equal(other.harness.matches, false)
    assert.equal(other.harness.expected, HARNESS_VERSION)
  })

  test('the CLI names itself, at the version it actually is', () => {
    assert.equal(describeProvenance(null).cli.version, VERSION)
  })
})

describe('nothing about this machine gets into the report', () => {
  test('no absolute path, user name or clock reading is rendered', () => {
    const nodeModules = runtime({
      [`${SCOPE}/dsh-tools`]: '0.1.0-preview.0',
    }, { harness: HARNESS_VERSION })
    const rendered = renderProvenance(describeProvenance(nodeModules)).join('\n')

    assert.equal(rendered.includes(BASE), false, 'a temporary path was printed')
    assert.doesNotMatch(rendered, /[A-Za-z]:[\\/]{1,2}Users/i)
    assert.doesNotMatch(rendered, /\/(?:home|Users)\//)
    assert.doesNotMatch(rendered, /\d{4}-\d{2}-\d{2}T/, 'a wall-clock time was printed')
  })

  test('the serialised provenance carries no path either', () => {
    const nodeModules = runtime({ [`${SCOPE}/dsh-tools`]: '0.1.0-preview.0' })
    const serialised = JSON.stringify(describeProvenance(nodeModules))
    assert.equal(serialised.includes(BASE), false)
    assert.equal(serialised.includes(nodeModules.replace(/\\/g, '\\\\')), false)
  })

  test('two machines with the same install agree', () => {
    const packages = { [`${SCOPE}/dsh-tools`]: '0.1.0-preview.0' }
    assert.equal(
      describeProvenance(runtime(packages)).compositionDigest,
      describeProvenance(runtime(packages)).compositionDigest)
  })
})

describe('the released manifest and an installation speak the same language', () => {
  test('the manifest records a composition digest for each scope', () => {
    assert.match(MANIFEST.integrity.composition.all, /^sha256:[0-9a-f]{64}$/)
    assert.match(MANIFEST.integrity.composition.runtime, /^sha256:[0-9a-f]{64}$/)
    assert.notEqual(MANIFEST.integrity.composition.all,
      MANIFEST.integrity.composition.runtime,
      'the two scopes cover the same packages, so one of them is wrong')
  })

  test('the CLI vouches for the digest the manifest actually recorded', () => {
    // The constant and the manifest are two copies of one fact, and a release
    // that bumps a package version without regenerating both would ship a CLI
    // vouching for a build that was never published.
    assert.equal(RELEASE_RUNTIME_DIGEST, MANIFEST.integrity.composition.runtime)
  })

  test('the runtime scope is the packages a profile installs', () => {
    const runtime = MANIFEST.integrity.packages
      .filter(entry => entry.name.startsWith(`${SCOPE}/dsh-`))
      .map(entry => ({ name: entry.name, version: entry.version }))
    assert.equal(compositionDigest(runtime), MANIFEST.integrity.composition.runtime)
    assert.ok(runtime.length < MANIFEST.integrity.packages.length)
  })

  test('the CLI recomputes the manifest digest from the packages the manifest names', () => {
    // The chain in one assertion: what the release recorded is exactly what a
    // machine holding those package versions computes for itself.
    const asInstalled = MANIFEST.integrity.packages.map(entry => ({
      name: entry.name, version: entry.version,
    }))
    assert.equal(compositionDigest(asInstalled), MANIFEST.integrity.composition.all,
      'the generator and the CLI compute different digests for one composition')
  })

  test('an installation of exactly the released runtime matches the release', () => {
    const packages = Object.fromEntries(MANIFEST.integrity.packages
      .filter(entry => entry.name.startsWith(`${SCOPE}/dsh-`))
      .map(entry => [entry.name, entry.version]))
    const provenance = describeProvenance(runtime(packages))
    assert.equal(provenance.compositionDigest, MANIFEST.integrity.composition.runtime)
    assert.equal(provenance.matchesRelease, true)
    assert.match(renderProvenance(provenance).join(String.fromCharCode(10)),
      /matches the published composition/)
  })

  test('an installation that is not the release says so, loudly', () => {
    const packages = Object.fromEntries(MANIFEST.integrity.packages
      .filter(entry => entry.name.startsWith(`${SCOPE}/dsh-`))
      .map(entry => [entry.name, entry.version]))
    packages[`${SCOPE}/dsh-tools`] = '0.0.0-tampered'
    const provenance = describeProvenance(runtime(packages))
    assert.equal(provenance.matchesRelease, false)
    assert.match(renderProvenance(provenance).join(String.fromCharCode(10)),
      /DOES NOT match the published composition/)
  })

  test('an installation missing one package does not match', () => {
    const packages = Object.fromEntries(MANIFEST.integrity.packages
      .filter(entry => entry.name.startsWith(`${SCOPE}/dsh-`))
      .slice(1)
      .map(entry => [entry.name, entry.version]))
    const provenance = describeProvenance(runtime(packages))
    assert.notEqual(provenance.compositionDigest, MANIFEST.integrity.composition.runtime)
    assert.equal(provenance.matchesRelease, false)
  })
})

describe('provenance works where a repository does not exist', () => {
  test('nothing in the module reads git', () => {
    // The point of the whole feature: a published install has no repository
    // beside it, and provenance that only works in a checkout does not work
    // where it matters.
    //
    // Asserted on the imports rather than on the text. The module explains at
    // length *why* it does not read git, and a check that cannot tell an
    // explanation from an implementation would fail on the documentation of
    // its own property.
    const source = readFileSync(
      join(ROOT, 'packages', 'watch', 'cli', 'src', 'provenance.ts'), 'utf8')
    const modules = source
      .split(String.fromCharCode(10))
      .filter(line => line.startsWith('import '))
      .map(line => line.slice(line.lastIndexOf(' ') + 1).split(String.fromCharCode(39)).join(''))
    assert.deepEqual(modules.filter(name => name.startsWith('node:')).sort(),
      ['node:crypto', 'node:fs', 'node:path'],
      'the module reaches beyond reading files and hashing them')
    assert.equal(modules.includes('node:child_process'), false)
  })

  test('a runtime with no .git anywhere above it still reports a full composition', () => {
    // Built under the OS temporary directory, which is not inside this
    // repository, so no ancestor holds a `.git` to fall back on.
    const packages = Object.fromEntries(MANIFEST.integrity.packages
      .filter(entry => entry.name.startsWith(`${SCOPE}/dsh-`))
      .map(entry => [entry.name, entry.version]))
    const nodeModules = runtime(packages, { harness: HARNESS_VERSION })
    let ancestor = nodeModules
    for (let depth = 0; depth < 12; depth += 1) {
      assert.equal(ancestor.endsWith('.git'), false)
      const next = dirname(ancestor)
      if (next === ancestor) break
      ancestor = next
    }
    const provenance = describeProvenance(nodeModules)
    assert.equal(provenance.resolved, true)
    assert.equal(provenance.compositionDigest, MANIFEST.integrity.composition.runtime)
    assert.equal(provenance.matchesRelease, true)
    assert.equal(provenance.harness.matches, true)
  })

  test('the shipped CLI has no git dependency in its built output either', () => {
    const built = readFileSync(join(CLI, 'provenance.js'), 'utf8')
    assert.doesNotMatch(built, /child_process/)
  })
})

void execFileSync
