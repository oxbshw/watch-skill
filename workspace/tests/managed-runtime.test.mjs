/**
 * The managed runtime: what setup is allowed to install, where it may read it
 * from, and what must be true after every way of failing to build it.
 *
 * Three things this file is really about.
 *
 * **The dependency set is derived, and exact.** `--legacy-peer-deps` is the
 * only mode that finishes on the Harness closure, and it installs no peers at
 * all, so every required peer has to be named explicitly at an exact version.
 * A hand-written list of those names would be right the day it was written;
 * `scripts/gen-managed-runtime.mjs` walks the audited closure instead, and
 * these tests hold the result to the only properties that matter — every
 * version exact, every version satisfying every range that asked for it, and
 * the whole thing reproducible from committed evidence with no registry, no
 * clock and no locale involved.
 *
 * **An artifact directory is verified before it is used.** Nothing under
 * `@deepwatch` is published, so setup installs from local tarballs. That is
 * only safe if "local tarballs" means a complete set that matches an inventory
 * byte for byte — not a directory with an extra copy of one package, or a
 * renamed file, or a link to somewhere else.
 *
 * **A failed setup leaves the machine as it found it.** The transaction has
 * twelve phases. Each one is made to fail here, and each time the assertions
 * are the same four: nothing partial at the destination, an existing healthy
 * runtime untouched, a message that says truthfully what was left behind, and
 * a clean retry that still works. The previous design installed straight into
 * the final directory and printed that nothing had been left behind while
 * leaving a manifest and half a `node_modules` exactly where the next run
 * would find them and believe them.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeArtifactSet, tarballName } from './fixtures/artifact-set.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'packages', 'watch', 'cli')
const FAKE_NPM = join(HERE, 'fixtures', 'fake-npm.cjs')
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version

const provision = await import(pathToFileURL(join(CLI, 'lib', 'lib', 'provision.js')).href)
const bundle = await import(pathToFileURL(join(CLI, 'lib', 'lib', 'bundle.js')).href)
const semver = await import(pathToFileURL(join(ROOT, 'scripts', 'lib', 'semver-lite.mjs')).href)

const MANIFEST = JSON.parse(
  readFileSync(join(ROOT, 'inventory', 'managed-runtime.json'), 'utf8'))
const CLOSURE = JSON.parse(readFileSync(join(ROOT, 'inventory', 'dsh-closure.json'), 'utf8'))

const rooms = []
test.after(() => {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

function room(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  rooms.push(dir)
  return dir
}

/** An artifact directory whose contents match its inventory. */
function artifacts(options = {}) {
  const made = writeArtifactSet(VERSION, options)
  rooms.push(made.directory)
  return made
}

/** Everything provisioning needs, pointed at a stub package manager. */
function provisioning(extra = {}) {
  const home = room('deepwatch-home-')
  const set = extra.artifacts ?? artifacts()
  const read = provision.readArtifacts(set.directory)
  assert.ok(!('failure' in read), read.detail ?? '')
  return {
    home,
    destination: join(home, 'harness'),
    mode: 'local-artifacts',
    artifacts: set.directory,
    packages: read.packages,
    env: { ...process.env, ...extra.env },
    installer: { command: process.execPath, prefix: [FAKE_NPM] },
    timeoutMs: 60_000,
    ...extra.options,
  }
}

/** Every path under a directory, so churn at a destination is visible. */
function census(dir) {
  const out = []
  const walk = (at, prefix) => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)
      try {
        if (readdirSync(full).length >= 0) { walk(full, `${prefix}${name}/`); continue }
      } catch {
        out.push(`${prefix}${name}`)
      }
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

describe('the dependency set is derived from the audited closure', () => {
  test('every version is exact, and no range or tag survives', () => {
    const dependencies = provision.managedDependencies()
    assert.ok(Object.keys(dependencies).length > 1)
    for (const [name, version] of Object.entries(dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
        `${name} is ${version}; a range in the runtime manifest is a runtime nobody measured`)
    }
  })

  test('the manifest and the shipped module agree', () => {
    const dependencies = provision.managedDependencies()
    const fromManifest = Object.fromEntries(
      MANIFEST.dependencies.map(entry => [entry.name, entry.version]))
    assert.deepEqual(dependencies, fromManifest)
    assert.equal(provision.managedManifestDigest(), MANIFEST.digest)
  })

  test('the walk reaches a fixpoint: nothing required is left out', () => {
    // Re-derived here from the same evidence, by a different walk, because a
    // generator that agrees with itself proves nothing.
    const index = new Map(CLOSURE.packages.map(entry => [entry.name, entry]))
    const explicit = new Set(MANIFEST.dependencies.map(entry => entry.name))

    const installed = new Set()
    const queue = [...explicit]
    while (queue.length > 0) {
      const name = queue.pop()
      if (installed.has(name)) continue
      const record = index.get(name)
      if (record === undefined) continue
      installed.add(name)
      for (const dependency of Object.keys(record.dependencies ?? {})) queue.push(dependency)
    }

    const missing = []
    for (const name of installed) {
      const record = index.get(name)
      const meta = record.peerDependenciesMeta ?? {}
      for (const peer of Object.keys(record.peerDependencies ?? {})) {
        if (meta[peer]?.optional === true) continue
        if (!installed.has(peer)) missing.push(`${name} requires ${peer}`)
      }
    }
    assert.deepEqual(missing, [], 'the generated set does not close the required-peer graph')
  })

  test('every chosen version satisfies every range that asked for it', () => {
    // The check that caught a real conflict: the workspace pinned cordis to
    // 4.0.1 while three cordis plugins in the pinned Harness closure require
    // ^4.0.2. One of those two had to move, and a manifest that just picked
    // one would have installed a runtime with three unsatisfied peers.
    const unsatisfied = []
    for (const entry of MANIFEST.dependencies) {
      for (const asked of entry.requestedBy ?? []) {
        if (!semver.satisfies(entry.version, asked.range)) {
          unsatisfied.push(`${entry.name}@${entry.version} vs ${asked.range} (${asked.by})`)
        }
      }
    }
    assert.deepEqual(unsatisfied, [])
  })

  test('optional and platform-specific packages are classified apart', () => {
    assert.ok(MANIFEST.counts['platform-optional'] > 0,
      'a closure with per-platform binaries must say so')
    assert.ok(MANIFEST.counts['optional-peer'] > 0)
    for (const entry of MANIFEST.classification) {
      assert.ok([
        'required-peer', 'optional-peer', 'platform-optional', 'optional-dependency',
        'transitive-dependency', 'development-only', 'unreachable',
      ].includes(entry.kind), `${entry.name} has the unknown classification ${entry.kind}`)
    }
    // Nothing in the required set may be a package that is only installed on
    // some platforms: that is a runtime that works on the machine that built it.
    const conditional = new Set(MANIFEST.classification
      .filter(entry => entry.kind === 'platform-optional').map(entry => entry.name))
    for (const entry of MANIFEST.dependencies) {
      assert.ok(!conditional.has(entry.name),
        `${entry.name} is platform-specific and cannot be a required dependency`)
    }
  })

  test('the licence summary does not hide the copyleft components', () => {
    // Every LGPL component in this closure is a per-platform libvips binary,
    // so a summary that counted only the unconditional packages would read as
    // though there is no LGPL here at all.
    const conditional = MANIFEST.conditionalLicences.licences.map(entry => entry.license)
    assert.ok(conditional.some(name => /LGPL/.test(name)),
      'the conditional licence list must name the LGPL components')
    for (const entry of [...MANIFEST.licences, ...MANIFEST.conditionalLicences.licences]) {
      assert.ok(!/^(UNKNOWN|UNLICENSED)$/i.test(entry.license))
    }
  })

  test('the manifest is reproducible: no clock, no path, no locale', () => {
    const text = readFileSync(join(ROOT, 'inventory', 'managed-runtime.json'), 'utf8')
    assert.doesNotMatch(text, /[A-Za-z]:\\\\|\/(home|Users)\//, 'a machine path leaked in')
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:/, 'a timestamp makes this unreproducible')

    // Ordered by code unit rather than by collation: `localeCompare` weights
    // `-`, `.` and `/` differently depending on the ICU data a runtime was
    // built with, so two machines with identical input produce different files.
    const names = MANIFEST.dependencies.map(entry => entry.name)
    assert.deepEqual(names, [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
    const classified = MANIFEST.classification.map(entry => entry.name)
    assert.deepEqual(classified, [...classified].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
  })

  test('the manifest names the evidence it came from, and the evidence matches', () => {
    assert.equal(MANIFEST.evidence.digest, CLOSURE.digest)
    const recomputed = `sha256:${createHash('sha256')
      .update(JSON.stringify({ ...CLOSURE, digest: undefined })).digest('hex')}`
    assert.equal(recomputed, CLOSURE.digest,
      'the committed closure evidence has been edited by hand')
  })
})

describe('an artifact directory is verified before anything is installed', () => {
  test('a complete, matching set is accepted, minus the CLI', () => {
    const set = artifacts()
    const read = provision.readArtifacts(set.directory)

    assert.ok(!('failure' in read))
    assert.equal(read.inventoryCount, 20)
    assert.equal(read.packages.length, 19, 'the runtime does not need the command that built it')
    assert.ok(read.packages.every(entry => entry.integrity.startsWith('sha256:')))
    assert.ok(read.packages.some(entry => entry.name === '@deepwatch/dsh-bundle'))
  })

  test('a missing tarball is refused', () => {
    const set = artifacts({
      after: dir => { rmSync(join(dir, tarballName('@deepwatch/dsh-wiki', VERSION))) },
    })
    const read = provision.readArtifacts(set.directory)
    assert.equal(read.failure, 'artifacts-missing')
    assert.match(read.detail, /dsh-wiki/)
  })

  test('an extra tarball the inventory does not name is refused', () => {
    // Two versions of one package in a directory is a directory nobody can say
    // what a `file:` install would pick.
    const set = artifacts({
      after: dir => { writeFileSync(join(dir, 'deepwatch-dsh-wiki-9.9.9.tgz'), 'extra') },
    })
    const read = provision.readArtifacts(set.directory)
    assert.equal(read.failure, 'artifacts-mismatch')
    assert.match(read.detail, /does not name/)
  })

  test('a renamed tarball is refused', () => {
    const set = artifacts({
      inventory: rows => rows.map(row => (row.name === '@deepwatch/dsh-sdk'
        ? { ...row, file: 'renamed.tgz' }
        : row)),
    })
    const read = provision.readArtifacts(set.directory)
    assert.equal(read.failure, 'artifacts-missing')
    assert.match(read.detail, /renamed\.tgz/)
  })

  test('a changed byte is refused before any install begins', () => {
    const set = artifacts({
      after: dir => {
        const file = join(dir, tarballName('@deepwatch/dsh-bundle', VERSION))
        const body = readFileSync(file)
        body[0] ^= 0xff
        writeFileSync(file, body)
      },
    })
    const read = provision.readArtifacts(set.directory)
    assert.equal(read.failure, 'artifacts-mismatch')
    assert.match(read.detail, /digest/)
  })

  test('a wrong recorded size is refused', () => {
    const set = artifacts({
      inventory: rows => rows.map(row => (row.name === '@deepwatch/dsh-live'
        ? { ...row, bytes: row.bytes + 1 }
        : row)),
    })
    const read = provision.readArtifacts(set.directory)
    assert.equal(read.failure, 'artifacts-mismatch')
    assert.match(read.detail, /bytes/)
  })

  test('a short inventory is refused', () => {
    const set = artifacts({ inventory: rows => rows.slice(0, 12) })
    const read = provision.readArtifacts(set.directory)
    assert.equal(read.failure, 'artifacts-mismatch')
    assert.match(read.detail, /release set is 20/)
  })

  test('a symbolic link in the directory is refused', () => {
    const target = room('deepwatch-linktarget-')
    const set = artifacts({
      after: dir => {
        try {
          symlinkSync(target, join(dir, 'linked'), 'junction')
        } catch {
          // A machine that cannot make links cannot run this case.
        }
      },
    })
    if (!existsSync(join(set.directory, 'linked'))) return
    const read = provision.readArtifacts(set.directory)
    assert.equal(read.failure, 'artifacts-mismatch')
    assert.match(read.detail, /symbolic link/)
  })

  test('an unpacked package beside the tarballs is refused', () => {
    const set = artifacts({
      after: dir => {
        mkdirSync(join(dir, 'dsh-bundle'), { recursive: true })
        writeFileSync(join(dir, 'dsh-bundle', 'package.json'), '{"name":"unpacked"}')
      },
    })
    const read = provision.readArtifacts(set.directory)
    assert.equal(read.failure, 'artifacts-mismatch')
    assert.match(read.detail, /unpacked package directory/)
  })

  test('a directory inside node_modules is refused', () => {
    // A package manager rewrites that tree whenever it runs, including the one
    // setup is about to start, so a digest checked there was true a moment ago.
    const outer = room('deepwatch-nm-')
    const inside = join(outer, 'node_modules', 'artifacts')
    artifacts({ dir: inside })
    const read = provision.readArtifacts(inside)
    assert.equal(read.failure, 'artifacts-mismatch')
    assert.match(read.detail, /node_modules/)
  })

  test('a relative directory is refused rather than guessed at', () => {
    const read = provision.readArtifacts('./artifacts')
    assert.equal(read.failure, 'artifacts-missing')
    assert.match(read.detail, /absolute/)
  })

  test('a directory with no inventory cannot be verified, so it is refused', () => {
    const bare = room('deepwatch-bare-')
    writeFileSync(join(bare, 'deepwatch-dsh-wiki-1.0.0.tgz'), 'x')
    const read = provision.readArtifacts(bare)
    assert.equal(read.failure, 'artifacts-missing')
    assert.match(read.detail, /packed-artifacts\.json/)
  })
})

describe('the staged manifest is what the runtime is installed from', () => {
  test('DeepWatch packages are named by a relative path into the runtime', () => {
    const set = artifacts()
    const read = provision.readArtifacts(set.directory)
    const manifest = JSON.parse(provision.managedManifest(read.packages))

    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      if (!name.startsWith('@deepwatch/')) continue
      assert.match(spec, /^file:\.artifacts\//,
        `${name} must install from the runtime's own copy, not from where it came from`)
    }
    // Nothing absolute reaches a file the product reads.
    assert.doesNotMatch(JSON.stringify(manifest), /[A-Za-z]:\\\\|\/(home|Users)\//)
  })

  test('the Harness and its generated peers are exact', () => {
    const manifest = JSON.parse(provision.managedManifest([]))
    assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.1.1-rc.2')
    for (const [name, spec] of Object.entries(manifest.dependencies)) {
      assert.match(spec, /^\d+\.\d+\.\d+/, `${name} is ${spec}`)
    }
  })
})

describe('building the runtime is a transaction', () => {
  test('a successful run promotes once and leaves no staging behind', async () => {
    const options = provisioning()
    const report = await provision.provisionManagedRuntime(options)

    assert.equal(report.outcome, 'installed', report.detail)
    assert.equal(report.cleanup, '', 'a successful run must not claim to have left anything')
    assert.equal(report.quarantined, undefined)
    assert.ok(report.installedPackages > 0)
    assert.ok(report.elapsedMs >= 0)
    assert.ok(Array.isArray(report.timings) && report.timings.length >= 10)
    assert.ok(existsSync(join(options.destination, 'node_modules')))
    assert.ok(existsSync(report.receipt))

    const siblings = readdirSync(options.home)
    assert.deepEqual(siblings.filter(name => name.includes('staging')), [],
      'a promoted runtime left its staging directory behind')
    assert.deepEqual(siblings.filter(name => name.includes('previous')), [])
  })

  test('the runtime keeps its own copy of every tarball, re-hashed after copying', async () => {
    const options = provisioning()
    const report = await provision.provisionManagedRuntime(options)
    assert.equal(report.outcome, 'installed', report.detail)

    const kept = join(options.destination, '.artifacts')
    const receipt = JSON.parse(readFileSync(report.receipt, 'utf8'))
    assert.equal(receipt.deepwatchPackages.length, 19)
    for (const entry of receipt.deepwatchPackages) {
      const copy = join(kept, entry.file)
      assert.ok(existsSync(copy), `${entry.file} was not copied into the runtime`)
      const actual = `sha256:${createHash('sha256').update(readFileSync(copy)).digest('hex')}`
      assert.equal(actual, entry.integrity, `${entry.file} is not what was verified`)
    }
  })

  test('the promoted runtime does not need the artifact directory or the checkout', async () => {
    // The property the whole copy step exists for. After promotion the
    // artifact directory is deleted outright, and the runtime still resolves
    // its own bundle from its own Harness anchor.
    const set = artifacts()
    const options = provisioning({ artifacts: set })
    const report = await provision.provisionManagedRuntime(options)
    assert.equal(report.outcome, 'installed', report.detail)

    rmSync(set.directory, { recursive: true, force: true, maxRetries: 5 })
    assert.ok(!existsSync(set.directory))

    const anchor = join(
      options.destination, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const found = bundle.resolveBundle(anchor, options.destination)
    assert.notEqual(found.bundle, null, found.detail)
    assert.ok(found.bundle.dir.startsWith(options.destination),
      'the bundle must be inside the runtime, not borrowed from outside it')
  })

  test('the receipt records provenance without making the runtime depend on it', async () => {
    const options = provisioning()
    const report = await provision.provisionManagedRuntime(options)
    const receipt = JSON.parse(readFileSync(report.receipt, 'utf8'))

    assert.equal(receipt.deepwatchSource, 'local-artifacts')
    assert.equal(receipt.deepwatchArtifactOrigin, options.artifacts)
    assert.equal(receipt.manifestDigest, provision.managedManifestDigest())
    assert.ok(receipt.installArguments.includes('--legacy-peer-deps'))
    assert.ok(Array.isArray(receipt.timings) && receipt.timings.length > 0)
    assert.ok(typeof receipt.cliPeakRssBytes === 'number')
    // The runtime boots from its own copies; nothing reads the origin path.
    const manifest = readFileSync(join(options.destination, 'package.json'), 'utf8')
    assert.ok(!manifest.includes(options.artifacts))
  })

  test('a second run is idempotent and does not duplicate a runtime', async () => {
    const options = provisioning()
    const first = await provision.provisionManagedRuntime(options)
    assert.equal(first.outcome, 'installed', first.detail)
    const second = await provision.provisionManagedRuntime(options)

    assert.equal(second.outcome, 'installed', second.detail)
    assert.equal(second.root, first.root, 'a second run built a different runtime')
    const siblings = readdirSync(options.home)
      .filter(name => name.startsWith('harness.'))
    assert.deepEqual(siblings, [], 'a second run left a staging or previous directory behind')
  })

  test('a held lock stops a second setup rather than racing it', async () => {
    const options = provisioning()
    writeFileSync(join(options.home, 'setup.lock'),
      `${JSON.stringify({ pid: 1, at: Date.now() }, null, 2)}\n`)

    const report = await provision.provisionManagedRuntime(options)
    assert.equal(report.outcome, 'locked')
    assert.equal(report.cleanup, '', 'a refusal that changed nothing must not claim otherwise')
    assert.ok(!existsSync(options.destination), 'a locked run wrote where the runtime goes')
    assert.match(report.fix, /setup\.lock/)
  })

  test('a lock older than a setup can possibly take is recovered, once', async () => {
    const options = provisioning()
    const lock = join(options.home, 'setup.lock')
    mkdirSync(options.home, { recursive: true })
    writeFileSync(lock, `${JSON.stringify(
      { pid: 1, at: Date.now() - 60 * 60 * 1000 }, null, 2)}\n`)

    const report = await provision.provisionManagedRuntime(options)
    assert.equal(report.outcome, 'installed', report.detail)
    assert.ok(!existsSync(lock), 'the lock was not released')
  })

  test('cancellation is a distinct outcome, and leaves the destination alone', async () => {
    const controller = new AbortController()
    const options = provisioning({
      env: { FAKE_NPM_HANG: '1' },
      options: { signal: controller.signal },
    })
    const running = provision.provisionManagedRuntime(options)
    setTimeout(() => { controller.abort() }, 200)
    const report = await running

    assert.equal(report.outcome, 'cancelled')
    assert.ok(!existsSync(options.destination))
    assert.match(report.cleanup, /kept at/)
  })

  test('a deadline that elapses is a timeout, not a failed install', async () => {
    const options = provisioning({
      env: { FAKE_NPM_HANG: '1' },
      options: { timeoutMs: 1500 },
    })
    const report = await provision.provisionManagedRuntime(options)

    assert.equal(report.outcome, 'timeout')
    assert.ok(!existsSync(options.destination))
  })

  test('a non-zero install is reported as one, and installs nothing', async () => {
    const options = provisioning({ env: { FAKE_NPM_EXIT: '7' } })
    const report = await provision.provisionManagedRuntime(options)

    assert.equal(report.outcome, 'install-failed')
    assert.equal(report.phase, 'install')
    assert.ok(!existsSync(options.destination))
  })

  test('a package manager that cannot start is not a failed install', async () => {
    const options = provisioning({
      options: { installer: { command: join(HERE, 'no-such-npm'), prefix: [] } },
    })
    const report = await provision.provisionManagedRuntime(options)

    assert.equal(report.outcome, 'no-package-manager')
    assert.ok(!existsSync(options.destination))
  })

  for (const [variable, phase, outcome] of [
    ['FAKE_NPM_MISSING_PEER', 'peers', 'peers-unresolved'],
    ['FAKE_NPM_BAD_VERSION', 'integrity', 'integrity-mismatch'],
    ['FAKE_NPM_NO_LICENCE', 'licence', 'licence-refused'],
    ['FAKE_NPM_NO_HARNESS', 'harness-boot', 'harness-not-runnable'],
    ['FAKE_NPM_DEAD_DSH', 'harness-boot', 'harness-not-runnable'],
    ['FAKE_NPM_NO_BUNDLE', 'bundle', 'bundle-unresolvable'],
    // The one that everything else survived. A profile can initialise, install,
    // and dump its configuration cleanly and still fail to import a plugin,
    // bind a port or serve a page — which is exactly what happened, and got
    // promoted with a tick beside it, until composition started opening it.
    ['FAKE_DSH_NO_SERVE', 'composition', 'composition-failed'],
  ]) {
    test(`a tree that fails the ${phase} check never reaches the destination`, async () => {
      const options = provisioning({ env: { [variable]: '1' } })
      const report = await provision.provisionManagedRuntime(options)

      assert.equal(report.outcome, outcome, report.detail)
      assert.equal(report.phase, phase)
      assert.ok(!existsSync(options.destination),
        'a validation failure left a runtime where a person will find it')
      assert.match(report.cleanup, /kept at/, 'the message must say what was left behind')
      assert.ok(existsSync(report.quarantined), 'the quarantine path must be real')
      assert.ok(!existsSync(join(options.home, 'setup.lock')), 'the lock was not released')
    })
  }

  for (const phase of [
    'artifact-copy', 'artifact-recheck', 'manifest', 'install', 'peers', 'integrity',
    'licence', 'harness-boot', 'bundle', 'composition', 'receipt', 'promote',
  ]) {
    test(`a failure in the ${phase} phase leaves a healthy runtime untouched`, async () => {
      const options = provisioning()
      const healthy = await provision.provisionManagedRuntime(options)
      assert.equal(healthy.outcome, 'installed', healthy.detail)
      const before = census(options.destination)
      const receiptBefore = readFileSync(healthy.receipt, 'utf8')

      const failed = await provision.provisionManagedRuntime({ ...options, failAt: phase })
      assert.notEqual(failed.outcome, 'installed', `the ${phase} phase did not fail`)
      assert.equal(failed.phase, phase)

      // The existing runtime is exactly as it was.
      assert.deepEqual(census(options.destination), before,
        `a failure in ${phase} changed the runtime that was already working`)
      assert.equal(readFileSync(healthy.receipt, 'utf8'), receiptBefore)

      // And the message is true about what is on disk.
      if (failed.cleanup === '') {
        assert.equal(failed.quarantined, undefined,
          'a report claiming nothing was left named a quarantine directory')
      } else {
        assert.ok(existsSync(failed.quarantined),
          'the report named a directory that is not there')
        assert.match(failed.cleanup, /Remove that directory/)
      }

      // And a clean retry still works.
      const retried = await provision.provisionManagedRuntime(options)
      assert.equal(retried.outcome, 'installed', retried.detail)
      assert.ok(existsSync(join(options.destination, 'node_modules')))
    })
  }

  test('a failed run never reuses a quarantined attempt on the next try', async () => {
    const options = provisioning()
    const failed = await provision.provisionManagedRuntime({ ...options, failAt: 'promote' })
    assert.equal(failed.outcome, 'promotion-failed')
    const quarantined = failed.quarantined
    assert.ok(existsSync(quarantined))

    const retried = await provision.provisionManagedRuntime(options)
    assert.equal(retried.outcome, 'installed', retried.detail)
    assert.notEqual(retried.root, quarantined, 'the retry promoted the quarantined attempt')
    assert.ok(existsSync(quarantined), 'the quarantined attempt was silently removed')
  })
})
