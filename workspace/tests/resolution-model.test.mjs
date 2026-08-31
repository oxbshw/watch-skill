/**
 * Where everything actually is, and what can therefore see what.
 *
 * This file exists because a plausible wrong answer cost a working setup. The
 * reasoning was: `@deepwatch/cli` depends on `@deepwatch/dsh-bundle`, the
 * Harness resolves a profile layer from its own installation first, so the
 * Harness will find the bundle. Every step is true and the conclusion is
 * false — because the Harness is not installed where the CLI is. `setup` puts
 * it under the user's DeepWatch home, and the CLI lives wherever the user
 * installed it: an npm prefix, a project's `node_modules`, an npx cache.
 * Unrelated directories, so Node's resolver walking up from one never reaches
 * the other.
 *
 * So the directory model is written down here and asserted, in real separated
 * directories, rather than reasoned about. The load-bearing assertion is a
 * *negative* one — resolution must fail before the bundle is installed into
 * the managed runtime — because that is the assumption that was wrong, and an
 * assumption nobody can accidentally restore is one with a failing test
 * attached to it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'packages', 'watch', 'cli')
const VERSION = JSON.parse(
  await import('node:fs').then(fs => fs.readFileSync(join(CLI, 'package.json'), 'utf8'))).version

const paths = await import(pathToFileURL(join(CLI, 'lib', 'lib', 'paths.js')).href)
const harness = await import(pathToFileURL(join(CLI, 'lib', 'lib', 'harness.js')).href)

const rooms = []
test.after(() => {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/**
 * A scratch directory, by the path a resolver will report.
 *
 * `realpathSync` because macOS hands out `/var/folders/...` from `TMPDIR` and
 * that is a symlink to `/private/var/folders/...`. Node's resolver returns the
 * real path, so a test comparing what it got against what `mkdtemp` said
 * compares two spellings of the same directory and fails on one platform only.
 * The product has the same hazard and answers it the same way -- see
 * `isInside` in `lib/bundle.ts`, which resolves both sides before comparing.
 */
function room(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  rooms.push(dir)
  return dir
}

/** Write a package into a tree, and hand back its directory. */
function place(root, name, manifest) {
  const dir = join(root, 'node_modules', ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'),
    `${JSON.stringify({ name, ...manifest }, null, 2)}\n`)
  return dir
}

/**
 * The two roots a real installation has, in unrelated directories.
 *
 * Separate `mkdtemp` calls rather than siblings under one parent, so there is
 * no shared ancestor holding a `node_modules` that could answer a lookup from
 * either side and make the test pass for the wrong reason.
 */
function separated() {
  const cliRoot = room('deepwatch-cliroot-')
  const home = room('deepwatch-home-')
  const managed = join(home, 'harness')
  mkdirSync(managed, { recursive: true })
  return { cliRoot, home, managed }
}

describe('the directory model', () => {
  test('the paths a setup uses are the ones documented here', () => {
    const home = room('deepwatch-paths-')
    const env = { DEEPWATCH_HOME: home, DEEPWATCH_PROFILE: 'deepwatch' }

    // Written out rather than implied, because every one of these was a thing
    // somebody had to work out from source while a setup was failing.
    assert.equal(paths.deepwatchHome(env), home)
    assert.equal(paths.dshHome(env), join(home, 'dsh-home'))
    assert.equal(paths.profileName(env), 'deepwatch')
    assert.equal(harness.harnessDir(env), join(home, 'harness'))
    assert.equal(harness.receiptPath(env),
      join(home, 'harness', 'deepwatch-install-receipt.json'))

    // The profile file DSH composes, and the anchor it resolves bundles from.
    const profile = join(paths.dshHome(env), 'profiles', 'deepwatch', 'package.json')
    assert.equal(profile, join(home, 'dsh-home', 'profiles', 'deepwatch', 'package.json'))
    const anchor = join(
      harness.harnessDir(env), 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    assert.ok(anchor.startsWith(harness.harnessDir(env)))
  })

  test('DSH_HOME overrides the profile location without moving the runtime', () => {
    const home = room('deepwatch-split-')
    const dshHome = room('deepwatch-dshhome-')
    const env = { DEEPWATCH_HOME: home, DSH_HOME: dshHome }

    assert.equal(paths.dshHome(env), dshHome)
    assert.equal(harness.harnessDir(env), join(home, 'harness'))
  })
})

describe('what the Harness can see, in real separated directories', () => {
  test('the CLI installation and the managed runtime share no node_modules', () => {
    const { cliRoot, managed } = separated()
    assert.ok(!managed.startsWith(cliRoot))
    assert.ok(!cliRoot.startsWith(managed))
  })

  test('the bundle beside the CLI is INVISIBLE to the Harness', () => {
    const { cliRoot, managed } = separated()

    // A complete, correct packed CLI installation.
    place(cliRoot, '@deepwatch/cli', { version: VERSION })
    place(cliRoot, '@deepwatch/dsh-bundle', {
      version: VERSION, dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    // And the managed runtime, holding only the Harness.
    const anchor = join(place(managed, '@deepseek-ai/dsh', { version: '0.1.1-rc.2' }),
      'package.json')

    assert.ok(existsSync(join(cliRoot, 'node_modules', '@deepwatch', 'dsh-bundle')),
      'the bundle really is installed beside the CLI')

    // The assertion the whole design rests on.
    const probe = createRequire(anchor).resolve.paths('@deepwatch/dsh-bundle') ?? []
    const reached = probe
      .map(searchPath => join(searchPath, '@deepwatch', 'dsh-bundle', 'package.json'))
      .filter(candidate => existsSync(candidate))
    assert.deepEqual(reached, [],
      'the Harness must not be able to resolve a bundle that lives beside the CLI')

    assert.throws(
      () => createRequire(anchor).resolve('@deepwatch/dsh-bundle/package.json'),
      { code: 'MODULE_NOT_FOUND' })
  })

  test('none of the probed paths is the CLI installation or a source checkout', () => {
    const { cliRoot, managed } = separated()
    const anchor = join(place(managed, '@deepseek-ai/dsh', { version: '0.1.1-rc.2' }),
      'package.json')

    for (const searchPath of createRequire(anchor).resolve.paths('@deepwatch/dsh-bundle') ?? []) {
      assert.ok(!searchPath.startsWith(cliRoot),
        `resolution must not reach the CLI installation: ${searchPath}`)
      assert.ok(!searchPath.startsWith(ROOT),
        `resolution must not reach the source workspace: ${searchPath}`)
    }
  })

  test('once the bundle is IN the managed runtime, the Harness resolves it', () => {
    const { managed } = separated()
    const anchor = join(place(managed, '@deepseek-ai/dsh', { version: '0.1.1-rc.2' }),
      'package.json')
    const dir = place(managed, '@deepwatch/dsh-bundle', {
      version: VERSION, dsh: { bundle: { patch: './cordis.patch.yml' } },
    })

    const resolved = createRequire(anchor).resolve('@deepwatch/dsh-bundle/package.json')
    assert.equal(dirname(resolved), dir)
  })

  test('resolution does not depend on the working directory', () => {
    const { managed } = separated()
    const anchor = join(place(managed, '@deepseek-ai/dsh', { version: '0.1.1-rc.2' }),
      'package.json')
    place(managed, '@deepwatch/dsh-bundle', {
      version: VERSION, dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    const elsewhere = room('deepwatch-cwd-')

    const before = process.cwd()
    try {
      process.chdir(elsewhere)
      assert.ok(createRequire(anchor).resolve('@deepwatch/dsh-bundle/package.json')
        .startsWith(managed))
    } finally {
      process.chdir(before)
    }
  })

  test('NODE_PATH cannot smuggle a bundle in', () => {
    const { cliRoot, managed } = separated()
    place(cliRoot, '@deepwatch/dsh-bundle', { version: VERSION })
    const anchor = join(place(managed, '@deepseek-ai/dsh', { version: '0.1.1-rc.2' }),
      'package.json')

    // `resolve.paths` is the lookup order DSH itself probes, and it is not
    // NODE_PATH-sensitive. A managed runtime that only resolved because of an
    // ambient variable would break the moment the variable was not set.
    const before = process.env.NODE_PATH
    try {
      process.env.NODE_PATH = join(cliRoot, 'node_modules')
      const reached = (createRequire(anchor).resolve.paths('@deepwatch/dsh-bundle') ?? [])
        .map(searchPath => join(searchPath, '@deepwatch', 'dsh-bundle', 'package.json'))
        .filter(candidate => existsSync(candidate))
      assert.deepEqual(reached, [])
    } finally {
      if (before === undefined) delete process.env.NODE_PATH
      else process.env.NODE_PATH = before
    }
  })
})

describe('the managed runtime is what setup must build', () => {
  test('provisioning targets the harness directory under the DeepWatch home', () => {
    const home = room('deepwatch-target-')
    assert.equal(harness.harnessDir({ DEEPWATCH_HOME: home }), join(home, 'harness'))
  })

  test('the install invocation is built in exactly one place', async () => {
    const install = await import(
      pathToFileURL(join(CLI, 'lib', 'lib', 'install.js')).href)
    const args = install.installInvocation(['a-package@1.0.0'])

    assert.ok(args.includes('install'))
    assert.ok(args.includes('--legacy-peer-deps'),
      'the measured install mode, not npm default peer resolution')
    assert.ok(args.includes('--registry=https://registry.npmjs.org'))
    assert.equal(args.at(-1), 'a-package@1.0.0')
    // No shell, so nothing here is ever a string to be parsed.
    for (const argument of args) assert.equal(typeof argument, 'string')
  })

  test('the release tooling calls the product builder, not a copy of it', async () => {
    // The one property that matters: `scripts/lib/install.mjs` has to be a
    // re-export, so there is no second place that can decide differently about
    // `--legacy-peer-deps`. Two implementations of one boundary is the shape of
    // the defect that shipped.
    const shared = await import(
      pathToFileURL(join(ROOT, 'scripts', 'lib', 'install.mjs')).href)
    const install = await import(
      pathToFileURL(join(CLI, 'lib', 'lib', 'install.js')).href)

    assert.equal(shared.installInvocation, install.installInvocation,
      "the release tooling must import the product's builder, not reimplement it")
  })

  test('the managed dependency set is exact, and never a range', async () => {
    const provision = await import(
      pathToFileURL(join(CLI, 'lib', 'lib', 'provision.js')).href)
    const dependencies = provision.managedDependencies()

    assert.ok(Object.keys(dependencies).length > 1)
    for (const [name, version] of Object.entries(dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
        `${name} is pinned to ${version}, and a range here is a runtime nobody measured`)
    }
    assert.ok(Object.hasOwn(dependencies, '@deepseek-ai/dsh'))
  })
})
