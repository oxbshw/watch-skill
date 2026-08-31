/**
 * How the DeepWatch bundle reaches a profile, and every way it must refuse to.
 *
 * `setup` used to compose with `dsh plugin add @deepwatch/dsh-bundle` — a bare
 * package name. `dsh plugin` forwards to pnpm, pnpm resolves a name against
 * the public registry, and **nothing under `@deepwatch` is published**. On any
 * machine that was a 404. It only ever appeared to work inside this
 * repository, where a workspace link answered before the registry was asked —
 * which is the worst possible place for it to work, because that is where it
 * was tested.
 *
 * The bundle is not fetched now. `setup` builds a managed runtime containing
 * both the Harness and the DeepWatch packages, and the Harness resolves a
 * profile layer from its own installation before it looks in the profile — the
 * contract its in-box bundles rely on. Composition is therefore a package
 * *name* written into the layer list and no path at all.
 *
 * The anchor is explicit in every call here, because the anchor is the whole
 * point: `tests/resolution-model.test.mjs` proves the CLI's own installation
 * and the managed runtime are unrelated directories, so a bundle visible from
 * the CLI says nothing about what the Harness will load.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'packages', 'watch', 'cli')
const BUNDLE_SOURCE = join(ROOT, 'packages', 'watch', 'bundle')
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version

const { resolveBundle } = await import(
  pathToFileURL(join(CLI, 'lib', 'lib', 'bundle.js')).href)
const { requiredBundles, writeArtifactOverrides } = await import(
  pathToFileURL(join(CLI, 'lib', 'lib', 'compose.js')).href)

const rooms = []
test.after(() => {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/**
 * A managed runtime: the Harness, and whatever else a case needs beside it.
 *
 * Returns the Harness's own `package.json`, which is the anchor DSH resolves
 * profile bundles from and therefore the only anchor worth testing against.
 */
function managed(prefix = 'deepwatch-managed-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  rooms.push(dir)
  const harness = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(harness, { recursive: true })
  const anchor = join(harness, 'package.json')
  writeFileSync(anchor, `${JSON.stringify({
    name: '@deepseek-ai/dsh', version: '0.1.1-rc.2',
  }, null, 2)}\n`)
  return { dir, anchor }
}

/** Put a bundle package into a managed runtime, with the manifest asked for. */
function addBundle(room, overrides = {}) {
  const dir = join(room.dir, 'node_modules', '@deepwatch', 'dsh-bundle')
  mkdirSync(dir, { recursive: true })
  const { omitPatchFile, ...manifestOverrides } = overrides
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: '@deepwatch/dsh-bundle',
    version: VERSION,
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...manifestOverrides,
  }, null, 2)}\n`)
  if (omitPatchFile !== true) {
    cpSync(join(BUNDLE_SOURCE, 'cordis.patch.yml'), join(dir, 'cordis.patch.yml'))
  }
  return dir
}

describe('finding the bundle in the managed runtime', () => {
  test('resolves the copy installed beside the Harness', () => {
    const room = managed()
    const dir = addBundle(room)

    const found = resolveBundle(room.anchor, room.dir)
    assert.notEqual(found.bundle, null, found.detail)
    assert.equal(found.bundle.name, '@deepwatch/dsh-bundle')
    assert.equal(found.bundle.version, VERSION)
    assert.equal(found.bundle.dir, dir)
    assert.equal(found.bundle.patch, './cordis.patch.yml')
    assert.match(found.bundle.digest, /^sha256:[0-9a-f]{64}$/)
  })

  test('does not depend on the working directory', () => {
    const room = managed()
    addBundle(room)
    const elsewhere = managed('deepwatch-elsewhere-')

    const before = process.cwd()
    try {
      process.chdir(elsewhere.dir)
      const found = resolveBundle(room.anchor, room.dir)
      assert.notEqual(found.bundle, null, found.detail)
      assert.ok(found.bundle.dir.startsWith(room.dir),
        'the bundle must come from the anchor it was asked about, not from cwd')
    } finally {
      process.chdir(before)
    }
  })

  test('the digest changes when the layer changes', () => {
    const first = managed()
    addBundle(first)
    const second = managed()
    const dir = addBundle(second)
    writeFileSync(join(dir, 'cordis.patch.yml'), '# different\n')

    assert.notEqual(
      resolveBundle(first.anchor, first.dir).bundle.digest,
      resolveBundle(second.anchor, second.dir).bundle.digest)
  })
})

describe('refusing what must not be composed', () => {
  test('a missing bundle fails closed, with a fix', () => {
    const room = managed()

    const found = resolveBundle(room.anchor, room.dir)
    assert.equal(found.bundle, null)
    assert.equal(found.failure, 'missing')
    assert.match(found.fix, /deepwatch setup/)
  })

  test('a bundle outside the managed runtime is not found', () => {
    // The exact arrangement that used to be assumed: the bundle installed
    // beside the CLI, and the Harness somewhere else entirely.
    const runtime = managed()
    const cliInstall = managed('deepwatch-cliroot-')
    addBundle(cliInstall)

    const found = resolveBundle(runtime.anchor, runtime.dir)
    assert.equal(found.bundle, null)
    assert.equal(found.failure, 'missing')
  })

  test('a bundle above the managed runtime is refused, not borrowed', () => {
    // Node's resolver walks upwards from the anchor, so a stray
    // `@deepwatch/dsh-bundle` in any parent directory of the DeepWatch home
    // answers this lookup. Resolving is not the same as being contained, and a
    // runtime that borrowed one would depend on a directory setup never wrote
    // and cannot vouch for.
    const outer = mkdtempSync(join(tmpdir(), 'deepwatch-outer-'))
    rooms.push(outer)
    const inner = join(outer, 'home', 'harness')
    mkdirSync(join(inner, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    const anchor = join(inner, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    writeFileSync(anchor, `${JSON.stringify({
      name: '@deepseek-ai/dsh', version: '0.1.1-rc.2',
    }, null, 2)}\n`)

    const stray = join(outer, 'node_modules', '@deepwatch', 'dsh-bundle')
    mkdirSync(stray, { recursive: true })
    writeFileSync(join(stray, 'package.json'), `${JSON.stringify({
      name: '@deepwatch/dsh-bundle', version: VERSION,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`)
    cpSync(join(BUNDLE_SOURCE, 'cordis.patch.yml'), join(stray, 'cordis.patch.yml'))

    const found = resolveBundle(anchor, inner)
    assert.equal(found.bundle, null,
      'a bundle outside the promoted managed root must never be composed')
    assert.equal(found.failure, 'outside-managed-root')
    assert.match(found.fix, /deepwatch setup/)
  })

  test('a wrong version is refused rather than composed', () => {
    const room = managed()
    addBundle(room, { version: '0.0.1-something-else' })

    const found = resolveBundle(room.anchor, room.dir)
    assert.equal(found.bundle, null)
    assert.equal(found.failure, 'version-mismatch')
    assert.match(found.detail, /0\.0\.1-something-else/)
  })

  test('a workspace symlink is refused', () => {
    const room = managed()
    const checkout = mkdtempSync(join(tmpdir(), 'deepwatch-checkout-'))
    rooms.push(checkout)
    writeFileSync(join(checkout, 'package.json'), `${JSON.stringify({
      name: '@deepwatch/dsh-bundle', version: VERSION,
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)}\n`)
    cpSync(join(BUNDLE_SOURCE, 'cordis.patch.yml'), join(checkout, 'cordis.patch.yml'))

    mkdirSync(join(room.dir, 'node_modules', '@deepwatch'), { recursive: true })
    try {
      symlinkSync(checkout, join(room.dir, 'node_modules', '@deepwatch', 'dsh-bundle'), 'junction')
    } catch {
      return // a machine that cannot create links cannot run this case
    }

    const found = resolveBundle(room.anchor, room.dir)
    assert.equal(found.bundle, null)
    assert.equal(found.failure, 'linked')
    assert.match(found.fix, /development checkout/)
  })

  test('a runtime inside a package workspace is refused', () => {
    const room = managed()
    addBundle(room)
    writeFileSync(join(room.dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')

    const found = resolveBundle(room.anchor, room.dir)
    assert.equal(found.bundle, null)
    assert.equal(found.failure, 'workspace')
  })

  test('a package that declares no layer is not a bundle', () => {
    const room = managed()
    addBundle(room, { dsh: {} })

    const found = resolveBundle(room.anchor, room.dir)
    assert.equal(found.bundle, null)
    assert.equal(found.failure, 'not-a-bundle')
  })

  test('a declared layer that is not in the package is refused', () => {
    const room = managed()
    addBundle(room, { omitPatchFile: true })

    const found = resolveBundle(room.anchor, room.dir)
    assert.equal(found.bundle, null)
    assert.equal(found.failure, 'not-a-bundle')
    assert.match(found.detail, /cordis\.patch\.yml/)
  })

  test('a path with spaces is an ordinary runtime, not a failure', () => {
    const room = managed('deepwatch managed with spaces ')
    addBundle(room)

    const found = resolveBundle(room.anchor, room.dir)
    assert.notEqual(found.bundle, null, found.detail)
    assert.ok(found.bundle.dir.includes(' '))
  })
})

describe('the layer list a DeepWatch profile needs', () => {
  test('the Harness app layer is added, because a named profile does not get one', () => {
    // The Harness seeds a new profile's bundles from its *name*: `web` gets
    // `@deepseek-ai/dsh-web-app`, anything else gets only `@deepseek-ai/dsh-base`.
    // DeepWatch composes a profile of its own rather than editing somebody's
    // `web`, so it has to add that layer itself. Without it the profile boots,
    // prints nothing, listens on no port and exits zero.
    const bundles = requiredBundles(['@deepseek-ai/dsh-base'])

    assert.deepEqual(bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepwatch/dsh-bundle',
    ])
    assert.doesNotMatch(JSON.stringify(bundles), /[A-Za-z]:\\|\/(home|Users)\//)
  })

  test('a second setup composes nothing new', () => {
    const once = requiredBundles([])
    const twice = requiredBundles(once)
    assert.deepEqual(twice, once)
  })

  test('a duplicate layer is never appended, because it would refuse to boot', () => {
    let bundles = []
    for (let attempt = 0; attempt < 5; attempt += 1) bundles = requiredBundles(bundles)
    assert.equal(new Set(bundles).size, bundles.length,
      'a duplicated layer composes every row twice and the loader refuses to boot')
    assert.equal(bundles.length, 3)
  })

  test('unrelated entries are preserved, after the ones DeepWatch requires', () => {
    const bundles = requiredBundles(['@deepseek-ai/dsh-base', 'some-plugin'])
    assert.ok(bundles.includes('some-plugin'), 'a layer somebody else added was dropped')
    assert.deepEqual(bundles, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepwatch/dsh-bundle',
      'some-plugin',
    ])
  })
})

describe('telling pnpm where the local packages are', () => {
  test('the overrides go where pnpm still reads them', () => {
    // pnpm 11 stopped reading `pnpm.overrides` from package.json and says so
    // in a warning that is easy to miss. A profile that relied on the old home
    // resolved nineteen packages straight to a 404.
    const dir = mkdtempSync(join(tmpdir(), 'deepwatch-overrides-'))
    rooms.push(dir)
    writeFileSync(join(dir, 'pnpm-workspace.yaml'),
      ['packages:', '  - .', '', 'nodeLinker: hoisted', ''].join('\n'))

    const written = writeArtifactOverrides(dir, [
      join(dir, '.artifacts', `deepwatch-dsh-bundle-${VERSION}.tgz`),
      join(dir, '.artifacts', `deepwatch-dsh-memory-${VERSION}.tgz`),
    ])

    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')
    assert.equal(written, 2)
    assert.match(yaml, /^overrides:$/m)
    assert.match(yaml, /'@deepwatch\/dsh-bundle': 'file:/)
    assert.match(yaml, /'@deepwatch\/dsh-memory': 'file:/)
    // The Harness's own settings are not this function's to touch.
    assert.match(yaml, /nodeLinker: hoisted/)
    // A `file:` specifier is read as a path, and a backslash is not one.
    assert.doesNotMatch(yaml.slice(yaml.indexOf('overrides:')), /\\/)
  })

  test('a second run replaces the block rather than appending another', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepwatch-overrides-again-'))
    rooms.push(dir)
    const tarball = join(dir, '.artifacts', `deepwatch-dsh-bundle-${VERSION}.tgz`)

    writeArtifactOverrides(dir, [tarball])
    writeArtifactOverrides(dir, [tarball])
    const yaml = readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')

    assert.equal(yaml.split('overrides:').length - 1, 1,
      'a second setup left two overrides blocks, and pnpm reads one of them')
  })
})

describe('the registry is never asked about @deepwatch', () => {
  test('setup names no @deepwatch package as an install argument', () => {
    const source = readFileSync(join(CLI, 'src', 'setup.ts'), 'utf8')
    assert.doesNotMatch(source, /'add',\s*'@deepwatch/,
      'setup must not hand a @deepwatch name to `dsh plugin add`')
    assert.doesNotMatch(source, /plugin[\s\S]{0,80}add[\s\S]{0,40}@deepwatch/,
      'no plugin-add path may name the unpublished scope')
  })

  test('composition installs paths, and tells pnpm where every package is first', () => {
    const source = readFileSync(join(CLI, 'src', 'lib', 'compose.js').replace('.js', '.ts'), 'utf8')
    // `plugin add` is handed tarball paths from the runtime's own copies.
    assert.match(source, /'add', \.\.\.tarballs/,
      'the profile install must name files, never a package in an unpublished scope')
    // And the overrides are written before it, or the transitive @deepwatch
    // dependencies of the bundle go straight to the registry and 404.
    assert.ok(
      source.indexOf('writeArtifactOverrides(profileDir') < source.indexOf("'add', ...tarballs"),
      'the overrides have to exist before pnpm resolves anything')
  })

  test('the DeepWatch packages are installed from file: specs, never a version range', () => {
    const source = readFileSync(join(CLI, 'src', 'lib', 'provision.ts'), 'utf8')
    assert.match(source, /file:\$\{/, 'local artifacts become file: specs')
    // The registry mode exists for after publication and must be reachable
    // only by an explicit choice, never as a fallback.
    assert.match(source, /SourceMode/)
    assert.doesNotMatch(source, /catch[\s\S]{0,120}registry/i)
  })

  test('an unpublished scope is never requested when no artifacts are given', () => {
    const source = readFileSync(join(CLI, 'src', 'setup.ts'), 'utf8')
    // Setup refuses rather than asking a registry for a scope that is not there.
    assert.match(source, /are not published, so there is nowhere to get them/)
  })

  test('the bundle package name reaches composition as a constant, not a spec', () => {
    const source = readFileSync(join(CLI, 'src', 'version.ts'), 'utf8')
    assert.match(source, /BUNDLE_PACKAGE = '@deepwatch\/dsh-bundle'/)
    assert.doesNotMatch(source, /@deepwatch\/dsh-bundle@/)
  })

  test('the CLI and the bundle are released at one version', () => {
    const bundle = JSON.parse(readFileSync(join(BUNDLE_SOURCE, 'package.json'), 'utf8'))
    assert.equal(bundle.version, VERSION,
      'BUNDLE_VERSION is the CLI version; a drift here composes an unmeasured pair')
  })
})
