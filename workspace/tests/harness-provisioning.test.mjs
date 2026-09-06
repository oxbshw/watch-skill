/**
 * How the DeepSeek Harness arrives, and what may never happen while it does.
 *
 * `@deepwatch/cli` declares the Harness as an exact optional peer dependency
 * and, only in `setup` and only after consent, fetches that exact version into
 * DeepWatch's own home. Both halves of that sentence are load-bearing, and
 * both are asserted here:
 *
 * - **the declaration** is what keeps the dependency visible to a lockfile, an
 *   SBOM and a reviewer, rather than appearing on a machine at runtime where
 *   no dependency review would ever see it;
 * - **the consent** is what keeps four hundred packages and a set of prebuilt
 *   native binaries off a machine whose owner typed `--help`.
 *
 * Most of this runs against a *clean room*: the built CLI copied to a temp
 * directory with no `node_modules` beside it, which is exactly the shape of an
 * install where the optional peer was not provided. Without that, this
 * workspace's own auto-installed peer would answer every lookup and none of
 * the interesting paths would ever be reached.
 *
 * Nothing here installs anything, and `ensureHarness` could not if it wanted
 * to: it detects and reports, and building a runtime belongs to
 * `lib/provision.ts`, which `tests/managed-runtime.test.mjs` exercises. A
 * suite that downloaded five hundred packages to prove the product asks first
 * would have missed the point.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { writeArtifactSet } from './fixtures/artifact-set.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'packages', 'watch', 'cli')
const SENTINEL = join(HERE, 'fixtures', 'egress-sentinel.cjs')
const MANIFEST = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8'))
const VERSION = await import(pathToFileURL(join(CLI, 'lib', 'version.js')).href)

/** Every room this file opened, closed once at the end. */
const rooms = []
test.after(() => {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/**
 * The CLI as it exists on a machine that did not provide the optional peer.
 *
 * A copy rather than the workspace tree, because module resolution starts from
 * the file's own location: from here `@deepseek-ai/dsh` resolves to nothing,
 * which is the state this whole feature exists to handle.
 */
function cleanRoom() {
  const dir = mkdtempSync(join(tmpdir(), 'dwharness-'))
  rooms.push(dir)
  cpSync(join(CLI, 'lib'), join(dir, 'lib'), { recursive: true })
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  return { dir, home, bin: join(dir, 'lib', 'bin.js') }
}

/** The clean room's own `harness` module, resolving peers the way it would. */
function harnessModule(room) {
  return import(pathToFileURL(join(room.dir, 'lib', 'lib', 'harness.js')).href)
}

/** An environment with nothing inherited that could point at a real install. */
function env(room, extra = {}) {
  const clean = { ...process.env }
  for (const key of Object.keys(clean)) {
    if (key.startsWith('DEEPWATCH_') || key === 'DSH_HOME') delete clean[key]
  }
  return { ...clean, DEEPWATCH_HOME: room.home, ...extra }
}

/**
 * A Harness that answers `--version` with whatever it was told to say.
 *
 * Planted at the path `setup` would have installed to, so the *provisioned*
 * branch is what gets exercised. The marker beside it is how these tests prove
 * an existing installation was left alone.
 */
function plantHarness(room, version, { runnable = true } = {}) {
  const pkg = join(room.home, 'harness', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(join(pkg, 'lib'), { recursive: true })
  writeFileSync(join(pkg, 'package.json'),
    `${JSON.stringify({ name: '@deepseek-ai/dsh', version }, null, 2)}\n`)
  writeFileSync(join(pkg, 'lib', 'bin.js'), runnable
    ? `if (process.argv.includes('--version')) { process.stdout.write('${version}\\n') }\n`
    : 'process.exit(3)\n')
  const marker = join(room.home, 'harness', 'do-not-delete.txt')
  writeFileSync(marker, 'a user installation this command does not own\n')
  return marker
}

/**
 * A verified artifact directory, for the paths that need one to get as far as
 * printing a plan.
 *
 * Fixture tarballs: everything asserted here happens before a package manager
 * is started, and the reader's job at that point is to check bytes against an
 * inventory. What is inside them is the packed-install gate's question.
 */
function artifactDirectory() {
  const { directory } = writeArtifactSet(MANIFEST.version)
  rooms.push(directory)
  return directory
}

/** Run the CLI as a child, the way a person does. */
function deepwatch(room, args, extra = {}) {
  const ran = spawnSync(process.execPath, [room.bin, ...args], {
    encoding: 'utf8', timeout: 120_000, env: env(room, extra),
  })
  return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
}

/** Run the CLI under the egress sentinel and report what it touched. */
function underSentinel(room, args, extra = {}) {
  const logDir = mkdtempSync(join(tmpdir(), 'dwharness-egress-'))
  rooms.push(logDir)
  const log = join(logDir, 'violations.jsonl')
  const ran = spawnSync(process.execPath, ['--require', SENTINEL, room.bin, ...args], {
    encoding: 'utf8', timeout: 300_000,
    env: env(room, { WATCH_EGRESS_LOG: log, WATCH_OFFLINE_ONLY: '1', ...extra }),
  })
  const violations = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line))
    : []
  return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '', violations }
}

/** Everything under a directory, with sizes, so churn is visible. */
function census(dir) {
  const out = []
  const walk = (at, prefix) => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name)
      const stats = statSync(full)
      if (stats.isDirectory()) walk(full, `${prefix}${name}/`)
      else out.push(`${prefix}${name} ${stats.size}`)
    }
  }
  if (existsSync(dir)) walk(dir, '')
  return out
}

describe('the dependency is declared, not conjured at runtime', () => {
  test('the manifest names the exact Harness version as an optional peer', () => {
    // The whole architecture in one assertion. A runtime download with no
    // declaration would pass every other test in this file and still leave a
    // dependency that no lockfile, SBOM or reviewer could ever see.
    assert.equal(MANIFEST.peerDependencies?.['@deepseek-ai/dsh'], VERSION.HARNESS_VERSION,
      'the peer range must be the exact version, never a range or `latest`')
    assert.equal(MANIFEST.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional, true,
      '`deepwatch --help` must not drag in four hundred packages')
    assert.ok(!/[\^~*x]|latest/.test(VERSION.HARNESS_VERSION),
      'setup must install one known version, never whatever is newest')
  })
})

describe('nothing reaches the network unless setup was told to', () => {
  test('doctor, --help and --version make no non-loopback connection', () => {
    const room = cleanRoom()
    for (const args of [['--version'], ['--help'], ['doctor'], ['doctor', '--json']]) {
      const ran = underSentinel(room, args)
      assert.deepEqual(ran.violations, [],
        `deepwatch ${args.join(' ')} reached the network`)
      assert.ok(!/WATCH_EGRESS_VIOLATION/.test(ran.stderr), 'the sentinel fired')
    }
  })

  test('setup with no artifact directory refuses, and never asks a registry', () => {
    const room = cleanRoom()
    // Nothing under `@deepwatch` is published, so there is no registry answer
    // to fall back to. A product that tried anyway would get a 404 for a scope
    // that does not exist and report it as a network problem.
    const ran = underSentinel(room, ['setup', '--yes'])

    assert.notEqual(ran.code, 0)
    assert.deepEqual(ran.violations, [], 'a refusal reached the network')
    const said = ran.stdout + ran.stderr
    assert.match(said, /--artifacts/, 'the refusal did not say what is missing')
    assert.match(said, /not published/, 'the refusal did not say why')
    assert.ok(!existsSync(join(room.home, 'harness')),
      'a refusal wrote where the runtime goes')
  })

  test('setup without consent prints the plan and downloads nothing', () => {
    const room = cleanRoom()
    const artifacts = artifactDirectory()
    // No TTY here, and no `--yes`: the non-interactive path, which is the one
    // that would otherwise install five hundred packages inside somebody's CI.
    const ran = deepwatch(room, ['setup', '--artifacts', artifacts])

    assert.notEqual(ran.code, 0, 'setup that installed nothing must not report success')
    const said = ran.stdout + ran.stderr
    assert.match(said, /registry\.npmjs\.org/, 'the registry was not named before asking')
    assert.match(said, /@deepseek-ai\/dsh/, 'the package was not named before asking')
    assert.ok(said.includes(VERSION.HARNESS_VERSION), 'the exact version was not shown')
    assert.ok(said.includes(room.home), 'where it would be written was not shown')
    assert.ok(said.includes(artifacts), 'where the local packages come from was not shown')
    assert.match(said, /LGPL/, 'the licence notice was not shown before asking')
    assert.match(said, /--yes/, 'the refusal did not say how to agree')
    assert.match(said, /\b19\b|\bpeer/, 'the generated peer count was not shown')

    assert.ok(!existsSync(join(room.home, 'harness', 'node_modules')),
      'setup wrote an installation nobody agreed to')
  })

  test('offline mode refuses and records zero non-loopback egress', () => {
    const room = cleanRoom()
    // `--offline` with `--yes`: consent is present and must still lose to the
    // policy, or offline means nothing.
    const ran = underSentinel(room, ['setup', '--offline', '--yes'])

    assert.notEqual(ran.code, 0)
    assert.deepEqual(ran.violations, [], 'an offline run reached the network')
    assert.match(ran.stdout + ran.stderr, /offline/i, 'the refusal did not say why')
  })

  test('starting the app never provisions, even with the profile missing', () => {
    const room = cleanRoom()
    const ran = underSentinel(room, ['web'])
    assert.notEqual(ran.code, 0)
    assert.deepEqual(ran.violations, [], 'deepwatch web fetched something')
  })
})

describe('an existing installation is inspected, never overwritten', () => {
  test('a wrong version is refused, and says which two versions those are', async () => {
    const room = cleanRoom()
    const marker = plantHarness(room, '9.9.9')
    const { ensureHarness } = await harnessModule(room)

    const result = await ensureHarness({ env: env(room), consent: true })

    assert.equal(result.harness, null, 'an untested Harness version was accepted')
    assert.equal(result.failure, 'version-mismatch')
    assert.equal(result.installed, false, 'a refusal must not have installed anything')
    assert.match(result.detail, /9\.9\.9/, 'the refusal did not name what it found')
    assert.ok(result.detail.includes(VERSION.HARNESS_VERSION),
      'the refusal did not name what DeepWatch was built against')
    assert.ok(existsSync(marker), 'setup deleted an installation it does not own')

    const said = deepwatch(room, ['doctor']).stdout
    assert.match(said, /9\.9\.9/, 'doctor hid the version actually installed')
  })

  test('a compatible installation is reused, and left byte-for-byte alone', async () => {
    const room = cleanRoom()
    const marker = plantHarness(room, VERSION.HARNESS_VERSION)
    const before = census(join(room.home, 'harness'))
    const { ensureHarness } = await harnessModule(room)

    const result = await ensureHarness({ env: env(room), consent: true })

    assert.notEqual(result.harness, null, 'a Harness of the right version was not reused')
    assert.equal(result.installed, false, 'a reused Harness must not be reinstalled')
    assert.equal(result.harness.source, 'provisioned')
    assert.ok(result.detail.includes(VERSION.HARNESS_VERSION))
    assert.deepEqual(census(join(room.home, 'harness')), before, 'reuse touched the installation')
    assert.equal(readFileSync(marker, 'utf8'), 'a user installation this command does not own\n')
  })

  test('a half-written installation is not ready, and does not read as ready', async () => {
    const room = cleanRoom()
    // A directory and a manifest, and no entry point: what a cancelled install
    // leaves behind. A check that looked for the directory would call this
    // ready and then fail somewhere much less legible.
    const pkg = join(room.home, 'harness', 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'),
      `${JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION.HARNESS_VERSION })}\n`)
    const { harness, ensureHarness } = await harnessModule(room)

    assert.equal(harness(env(room)), null, 'a directory was mistaken for a program')
    const result = await ensureHarness({ env: env(room) })
    assert.equal(result.failure, 'absent', 'a partial install was treated as present')

    const report = JSON.parse(deepwatch(room, ['doctor', '--json']).stdout)
    const finding = report.findings.find(entry => /harness/i.test(entry.name))
    assert.notEqual(finding.state, 'reachable', 'doctor reported a half-install as working')
    assert.notEqual(finding.fix, '', 'doctor reported a problem with no way out of it')
  })

  test('a Harness that does not run fails closed rather than being started', async () => {
    const room = cleanRoom()
    plantHarness(room, VERSION.HARNESS_VERSION, { runnable: false })
    const { ensureHarness } = await harnessModule(room)

    const result = await ensureHarness({ env: env(room), consent: true })
    assert.equal(result.harness, null, 'a Harness that cannot answer --version was accepted')
    assert.equal(result.failure, 'not-runnable')

    // And the product refuses to start rather than exec'ing it and hoping.
    const ran = deepwatch(room, ['web'])
    assert.notEqual(ran.code, 0)
  })

  test('provisioning is idempotent: twice is the same as once', async () => {
    const room = cleanRoom()
    plantHarness(room, VERSION.HARNESS_VERSION)
    const { ensureHarness } = await harnessModule(room)

    const first = await ensureHarness({ env: env(room), consent: true })
    const after = census(join(room.home, 'harness'))
    const second = await ensureHarness({ env: env(room), consent: true })

    assert.equal(first.installed, false)
    assert.equal(second.installed, false)
    assert.equal(first.detail, second.detail, 'the same machine reported two different states')
    assert.deepEqual(census(join(room.home, 'harness')), after, 'the second run wrote something')
  })

  test('the plan is exact, and is what the refusal shows', async () => {
    const room = cleanRoom()
    const artifacts = artifactDirectory()
    const provision = await import(
      pathToFileURL(join(room.dir, 'lib', 'lib', 'provision.js')).href)
    const setup = await import(pathToFileURL(join(room.dir, 'lib', 'setup.js')).href)
    const read = provision.readArtifacts(artifacts)
    assert.ok(!('failure' in read), read.detail ?? '')

    const destination = join(room.home, 'harness')
    const plan = provision.managedPlan(destination, 'local-artifacts', artifacts, read.packages)

    assert.equal(plan.registry, 'https://registry.npmjs.org')
    assert.equal(plan.harness.package, '@deepseek-ai/dsh')
    assert.equal(plan.harness.version, VERSION.HARNESS_VERSION)
    assert.ok(plan.peers > 0, 'the plan must say how many peers it will install')
    assert.equal(plan.deepwatch.length, 19, 'the CLI is not part of the runtime it built')
    assert.ok(plan.destination.startsWith(room.home), 'setup would write outside its own home')
    assert.match(plan.manifestDigest, /^sha256:[0-9a-f]{64}$/)

    const rendered = setup.renderManagedPlan(plan)
    for (const part of [
      plan.registry, plan.harness.package, plan.harness.version, plan.destination,
      artifacts, String(plan.peers), String(plan.deepwatch.length),
    ]) {
      assert.ok(rendered.includes(part), `the plan did not show ${part}`)
    }
    assert.match(rendered, /LGPL/, 'the plan did not mention the licence it should')
    assert.match(rendered, /never requested from a registry/,
      'the plan did not say the DeepWatch packages are not fetched')
  })

  test('provisioning reads no provider credential, and leaves a receipt', async () => {
    const room = cleanRoom()
    const source = readFileSync(join(CLI, 'src', 'lib', 'harness.ts'), 'utf8')
    for (const name of [
      'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY',
      'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'DEEPSEEK_API_KEY',
    ]) {
      assert.ok(!source.includes(name), `harness.ts reads ${name}`)
    }
    // And it records what it did, so an install can be audited and undone.
    const { receiptPath } = await harnessModule(room)
    assert.ok(receiptPath(env(room)).startsWith(room.home))
  })
})

describe('the licence position is written down, not inferred', () => {
  test('every unusual licence in the closure has a deliberate review', () => {
    const sbom = JSON.parse(readFileSync(join(ROOT, 'docs', 'sbom.json'), 'utf8'))
    const review = JSON.parse(readFileSync(join(ROOT, 'inventory', 'licence-review.json'), 'utf8'))
    const rules = review.packages.map(entry => ({ ...entry, pattern: new RegExp(entry.match) }))

    for (const entry of rules) {
      assert.ok(Array.isArray(entry.licenses) && entry.licenses.length > 0,
        `${entry.match}: no licence`)
      for (const field of ['component', 'arrivesVia', 'classification', 'reason']) {
        assert.ok(typeof entry[field] === 'string' && entry[field].length > 20,
          `${entry.match}: ${field} is not a real answer`)
      }
      assert.equal(entry.redistributedByDeepWatch, false,
        'a redistributed component needs more than a review entry')
    }

    // Anything unknown or copyleft must be named individually. This is the
    // assertion that stops the gate from being satisfied by widening an
    // allowlist instead of reading a package.
    const needsReview = sbom.thirdParty.filter(
      pkg => pkg.license === 'UNKNOWN' || /GPL/.test(pkg.license))
    assert.ok(needsReview.length > 0, 'the closure changed shape; re-read this test')
    for (const pkg of needsReview) {
      const entry = rules.find(rule => rule.pattern.test(pkg.name))
      assert.ok(entry !== undefined, `${pkg.name}@${pkg.version} (${pkg.license}) is unreviewed`)
      assert.ok(entry.licenses.includes(pkg.license),
        `${pkg.name} now declares ${pkg.license}, which its review does not cover`)
    }
  })

  test('the notices name the LGPL component and the decision left open', () => {
    const notices = readFileSync(join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    assert.match(notices, /LGPL-3\.0-or-later/)
    assert.match(notices, /libvips/)
    assert.match(notices, /inventory\/licence-review\.json/)
    assert.ok(notices.includes(`${VERSION.HARNESS_PACKAGE}@${VERSION.HARNESS_VERSION}`),
      'the notices do not say which Harness version setup installs')
    assert.match(notices, /optional peer/i)
  })

  test('the allowlist was not widened to make the gate pass', () => {
    // Reviewing a package is a decision with a reason attached. Adding its
    // licence to the allowlist is a decision about every future package too.
    const gate = readFileSync(join(ROOT, 'scripts', 'gen-sbom.mjs'), 'utf8')
    const allowlist = /ALLOWED_LICENSES = new Set\(\[([^\]]*)\]\)/s.exec(gate)?.[1] ?? ''
    assert.ok(allowlist !== '', 'the allowlist moved; this test can no longer see it')
    assert.ok(!/GPL/.test(allowlist), 'a copyleft licence was added to the blanket allowlist')
    assert.ok(!/UNKNOWN/.test(allowlist), 'UNKNOWN was added to the blanket allowlist')
    assert.match(gate, /licence-review\.json/, 'the gate no longer consults the review')
  })
})
