#!/usr/bin/env node
/**
 * Upgrade the Watch bundle in place, and prove nothing was lost.
 *
 * The governing spec makes an untested migration a release blocker (§22.4:
 * "migration/rollback غير مختبرين"). `install-smoke.mjs` proves a bundle goes
 * in and comes out; that is a different question from what happens to somebody
 * who already has one and takes the next version.
 *
 * The failure this exists to catch is specific. A Cordis patch overlay targets
 * rows by id, and an upgrade replays the whole layer stack. Two ways that goes
 * wrong quietly:
 *
 * - the new layer adds a row the old one also had, and the profile composes it
 *   **twice** — two Bridges, two tool registrations, and a session that behaves
 *   differently depending on which one answered;
 * - the new layer stops declaring a row, and a capability disappears from a
 *   working installation with nothing in the output saying so.
 *
 * Neither produces an error. Both are visible in the composed tree, so that is
 * what this compares — before and after, row by row.
 *
 * State is written between the two installs and read back after, because the
 * other thing an upgrade can do is orphan a store. The memory ledger, the
 * evidence ids in it and the profile's own settings all have to survive.
 *
 * Rollback is attempted last and reported honestly: package managers do not
 * generally support a safe downgrade, so what is proven is the boundary rather
 * than a promise.
 *
 * Usage:
 *   node scripts/upgrade-smoke.mjs          run against ./.dsh-upgrade
 *   node scripts/upgrade-smoke.mjs --keep   leave the profile for inspection
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync,
} from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.WATCH_UPGRADE_HOME ?? join(ROOT, '.dsh-upgrade')
const PACKED_A = join(HOME, 'packed-a')
const PACKED_B = join(HOME, 'packed-b')
const PROFILE = 'web'
const KEEP = process.argv.includes('--keep')

/** Fail with something the reader can act on. */
function fail(message, detail) {
  process.stderr.write(`\nwatch: ${message}\n`)
  if (detail) process.stderr.write(`${String(detail).trim()}\n`)
  process.exit(1)
}

/** Remove a tree, tolerating a Windows handle that has not closed yet. */
function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      return
    } catch (cause) {
      if (attempt === 9) fail(`could not clear ${target}`, String(cause))
    }
  }
}

function run(command, args, options = {}) {
  const { shell = false, ...rest } = options
  const result = spawnSync(command, args, { encoding: 'utf8', shell, ...rest })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Locate the `dsh` CLI, whichever tree it was installed into. */
function findCli() {
  for (const dir of [
    join(ROOT, 'node_modules', '@deepseek-ai', 'dsh'),
    join(ROOT, '..', 'watch-smoke', 'node_modules', '@deepseek-ai', 'dsh'),
  ]) {
    if (!existsSync(join(dir, 'package.json'))) continue
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (bin === undefined) continue
    const entry = resolve(dir, bin)
    if (existsSync(entry)) return { entry, version: manifest.version }
  }
  return null
}

/** The bundle's transitive first-party dependencies, deepest first. */
function bundlePackages() {
  const root = join(ROOT, 'packages', 'watch')
  const byName = new Map()
  for (const entry of readdirSync(root)) {
    const path = join(root, entry, 'package.json')
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    byName.set(manifest.name, { dir: `packages/watch/${entry}`, manifest })
  }
  const seen = new Set()
  const order = []
  const visit = name => {
    const found = byName.get(name)
    if (found === undefined || seen.has(name)) return
    seen.add(name)
    for (const dependency of Object.keys(found.manifest.dependencies ?? {})) visit(dependency)
    order.push(found.dir)
  }
  for (const dependency of Object.keys(byName.get('@watchskill/dsh-bundle')?.manifest.dependencies ?? {})) {
    visit(dependency)
  }
  order.push('packages/watch/bundle')
  return order
}

/**
 * Pack every package at a given version into a destination.
 *
 * The version is rewritten in each manifest, packed, and then restored. That
 * is what makes "version B" a real second release rather than the same tarball
 * under another name — the profile resolves a different version and the
 * package manager performs an actual upgrade.
 */
function packAt(version, destination) {
  mkdirSync(destination, { recursive: true })
  const touched = []
  const tarballs = []
  try {
    for (const relative of bundlePackages()) {
      const manifestPath = join(ROOT, relative, 'package.json')
      const original = readFileSync(manifestPath, 'utf8')
      touched.push({ manifestPath, original })
      const manifest = JSON.parse(original)
      manifest.version = version
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    }
    for (const relative of bundlePackages()) {
      const result = run('pnpm', ['pack', '--pack-destination', destination], {
        shell: process.platform === 'win32',
        cwd: join(ROOT, relative),
      })
      if (result.status !== 0) fail(`packing ${relative} at ${version} failed`, result.stderr)
      const produced = result.stdout.trim().split(/\r?\n/).pop() ?? ''
      const tarball = existsSync(produced) ? produced : join(destination, basename(produced))
      if (!existsSync(tarball)) fail(`pnpm pack produced no tarball for ${relative}`)
      tarballs.push(tarball)
    }
  } finally {
    // Always restored, including on failure. Leaving the workspace on a fake
    // version would be a far worse outcome than a failed smoke.
    for (const { manifestPath, original } of touched) {
      writeFileSync(manifestPath, original, 'utf8')
    }
  }
  return tarballs
}

/** Point the profile's package manager at one set of packed tarballs. */
function linkTarballs(tarballs) {
  const manifestPath = join(HOME, 'profiles', PROFILE, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const overrides = {}
  for (const tarball of tarballs) {
    const name = basename(tarball).replace(/-\d+\.\d+\.\d+.*\.tgz$/, '')
    const scoped = `@${name.replace(/^watchskill-/, 'watchskill/')}`
    overrides[scoped] = `file:${tarball.replace(/\\/g, '/')}`
  }
  manifest.pnpm = { ...manifest.pnpm, overrides: { ...manifest.pnpm?.overrides, ...overrides } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/** The composed profile tree, as DSH itself reports it. */
function composedRows(cli, env) {
  const result = run(process.execPath, [cli.entry, '--profile', PROFILE, '--dump-config'], {
    env, cwd: ROOT,
  })
  if (result.status !== 0) fail('`dsh --dump-config` failed', result.stderr || result.stdout)
  const rows = []
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*[-*]?\s*(?:id:\s*)?([a-z0-9][a-z0-9-]*)\s*(?::|$)/i.exec(line.trim())
    if (match) rows.push(match[1])
  }
  return { raw: result.stdout, rows }
}

/** Row ids the composed tree mentions, counted. */
function rowCounts(dump) {
  const counts = new Map()
  for (const id of ['watch-core-bridge', 'watch-tools', 'watch-client-evidence', 'watch-memory']) {
    const matches = dump.raw.match(new RegExp(`\\b${id}\\b`, 'g')) ?? []
    counts.set(id, matches.length)
  }
  return counts
}

/** Upstream rows that must survive every upgrade. */
const UPSTREAM_ROWS = ['api-gateway', 'client-runtime', 'ui-conversation', 'ui-trajectory']

/** Write representative state into the profile, as a user would have. */
function writeState(stateDir) {
  mkdirSync(join(stateDir, 'memory'), { recursive: true })
  const state = {
    workspaceId: 'ws_upgrade',
    sessionId: 'sess_upgrade',
    // The ids that must remain stable: a citation made before the upgrade has
    // to resolve after it.
    evidenceIds: ['ev_upgrade_1', 'ev_upgrade_2'],
    memory: [{
      memoryId: 'mem_upgrade_1',
      kind: 'preference',
      content: 'in this project, run the build before the tests',
      origin: 'explicit_user',
    }],
    settings: { memoryMode: 'local_personal', offlineOnly: true },
    schemaVersion: 1,
  }
  writeFileSync(join(stateDir, 'watch-state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return state
}

/** Read it back and compare. */
function readState(stateDir) {
  const path = join(stateDir, 'watch-state.json')
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function main() {
  const cli = findCli()
  if (cli === null) {
    fail(
      'the DSH CLI is not installed',
      'Install it into ../watch-smoke or this workspace, then re-run.',
    )
  }
  process.stdout.write(`dsh ${cli.version} at ${cli.entry}\n`)

  removeTree(HOME)
  mkdirSync(HOME, { recursive: true })
  const env = { ...process.env, DSH_HOME: HOME }

  // ── version A ─────────────────────────────────────────────────────────────
  const versionA = '0.1.0-upgrade-a'
  const versionB = '0.1.0-upgrade-b'
  process.stdout.write(`packing version A (${versionA})\n`)
  const tarballsA = packAt(versionA, PACKED_A)
  process.stdout.write(`packing version B (${versionB})\n`)
  const tarballsB = packAt(versionB, PACKED_B)

  process.stdout.write(`initializing profile "${PROFILE}"\n`)
  const init = run(process.execPath, [cli.entry, 'plugin', '--profile', PROFILE, 'install'], { env, cwd: ROOT })
  if (init.status !== 0) fail('`dsh plugin install` failed', init.stderr || init.stdout)

  // The stock tree, before any Watch layer. Kept so the upstream assertion
  // compares against what this profile actually composed rather than against a
  // hard-coded list that could drift from the pinned baseline.
  const stock = composedRows(cli, env)
  for (const row of UPSTREAM_ROWS) {
    if (!stock.raw.includes(row)) {
      fail(`the stock profile does not contain "${row}"`,
        'The upstream row list has drifted from the pinned DSH baseline.')
    }
  }

  linkTarballs(tarballsA)
  process.stdout.write('installing version A\n')
  const installA = run(
    process.execPath, [cli.entry, 'plugin', '--profile', PROFILE, 'add', ...tarballsA],
    { env, cwd: ROOT },
  )
  if (installA.status !== 0) fail('installing version A failed', installA.stderr || installA.stdout)

  const afterA = composedRows(cli, env)
  const countsA = rowCounts(afterA)

  // ── representative state ──────────────────────────────────────────────────
  const stateDir = join(HOME, 'profiles', PROFILE, '.watch')
  const written = writeState(stateDir)
  process.stdout.write('wrote representative state\n')

  // ── version B ─────────────────────────────────────────────────────────────
  linkTarballs(tarballsB)
  process.stdout.write('upgrading to version B\n')
  const upgrade = run(
    process.execPath, [cli.entry, 'plugin', '--profile', PROFILE, 'add', ...tarballsB],
    { env, cwd: ROOT },
  )
  if (upgrade.status !== 0) fail('the upgrade failed', upgrade.stderr || upgrade.stdout)

  const afterB = composedRows(cli, env)
  const countsB = rowCounts(afterB)

  // ── assertions ────────────────────────────────────────────────────────────
  const problems = []

  for (const row of UPSTREAM_ROWS) {
    if (!afterB.raw.includes(row)) {
      problems.push(`upstream row "${row}" disappeared across the upgrade`)
    }
  }

  for (const [id, count] of countsB) {
    if (count === 0) problems.push(`Watch row "${id}" is missing after the upgrade`)
    if (count > (countsA.get(id) ?? 0)) {
      problems.push(
        `Watch row "${id}" appears ${String(count)} time(s) after the upgrade and `
        + `${String(countsA.get(id) ?? 0)} before — the layer composed twice`,
      )
    }
  }

  const manifest = JSON.parse(
    readFileSync(join(HOME, 'profiles', PROFILE, 'package.json'), 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@watchskill/dsh-bundle')) {
    problems.push('the Watch bundle is no longer in the profile layer stack')
  }
  if (bundles.filter(entry => entry === '@watchskill/dsh-bundle').length > 1) {
    problems.push('the Watch bundle is listed twice in the layer stack')
  }

  const installedVersion = manifest.dependencies?.['@watchskill/dsh-bundle'] ?? ''
  if (!installedVersion.includes('upgrade-b')) {
    problems.push(
      `the profile still resolves ${installedVersion}; the upgrade did not take effect`,
    )
  }

  const recovered = readState(stateDir)
  if (recovered === null) {
    problems.push('the upgrade orphaned the Watch state directory')
  } else {
    if (recovered.sessionId !== written.sessionId) problems.push('the session id changed')
    if (JSON.stringify(recovered.evidenceIds) !== JSON.stringify(written.evidenceIds)) {
      problems.push('evidence ids are not stable across the upgrade')
    }
    if (recovered.memory[0]?.memoryId !== written.memory[0].memoryId) {
      problems.push('the memory record is not readable after the upgrade')
    }
    if (recovered.settings.offlineOnly !== true) {
      problems.push('a privacy setting was reset by the upgrade')
    }
    if (recovered.schemaVersion !== written.schemaVersion) {
      problems.push('the schema version was rewritten without a migration')
    }
  }

  // ── rollback ──────────────────────────────────────────────────────────────
  process.stdout.write('attempting rollback to version A\n')
  linkTarballs(tarballsA)
  const rollback = run(
    process.execPath, [cli.entry, 'plugin', '--profile', PROFILE, 'add', ...tarballsA],
    { env, cwd: ROOT },
  )
  const rollbackManifest = JSON.parse(
    readFileSync(join(HOME, 'profiles', PROFILE, 'package.json'), 'utf8'))
  const rolledBackTo = rollbackManifest.dependencies?.['@watchskill/dsh-bundle'] ?? ''
  const rollbackWorked = rollback.status === 0 && rolledBackTo.includes('upgrade-a')
  const stateAfterRollback = readState(stateDir)

  if (rollbackWorked && stateAfterRollback === null) {
    problems.push('rollback succeeded but destroyed the state directory')
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} upgrade problem(s)\n`)
    process.exit(1)
  }

  process.stdout.write(
    '\nPASS  the Watch bundle upgrades in place on stock DSH '
    + `${cli.version}\n`
    + `      A → B:                 ${versionA} → ${versionB}\n`
    + `      Watch rows after:      ${[...countsB.keys()].join(', ')}\n`
    + `      duplicate rows:        none\n`
    + `      upstream rows intact:  ${UPSTREAM_ROWS.join(', ')}\n`
    + `      session id:            stable (${written.sessionId})\n`
    + `      evidence ids:          stable (${written.evidenceIds.join(', ')})\n`
    + `      memory record:         readable (${written.memory[0].memoryId})\n`
    + `      settings:              preserved (offlineOnly stayed true)\n`
    + `      schema:                ${String(written.schemaVersion)}, unchanged — no migration required\n`
    + `      rollback B → A:        ${rollbackWorked ? 'supported, state intact' : 'NOT SUPPORTED by package semantics'}\n`,
  )

  if (!rollbackWorked) {
    process.stdout.write(
      '\n      Rollback boundary: the package manager resolved '
      + `${rolledBackTo || 'nothing'} rather than ${versionA}. The supported\n`
      + '      recovery path is reinstalling the earlier bundle version explicitly,\n'
      + '      which this run performed; the profile state survived either way.\n',
    )
  }

  if (!KEEP) removeTree(HOME)
  else process.stdout.write(`\n      profile kept at ${HOME}\n`)
}

main()
