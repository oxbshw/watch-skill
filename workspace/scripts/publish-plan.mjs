#!/usr/bin/env node
/**
 * What this release still has to publish, and what the registry already has.
 *
 * A partial release is the normal bad day. Twenty packages publish in
 * dependency order, the fourteenth fails, and the job stops — leaving thirteen
 * versions live and seven not. The tag is then unreleasable in the obvious
 * sense: an npm version can never be replaced, so re-running a job that starts
 * at the first package fails immediately on a version it already published.
 *
 * The wrong fix is a `--force` or a "skip what exists" flag, because "exists"
 * is not the question. The question is whether what exists **is what this run
 * would have uploaded**. If the registry holds `@deepwatch/cli@0.1.0` built
 * from a different commit, skipping it silently ships a release whose halves
 * disagree, and no later check would catch it: every gate compares
 * `name@version`, and both byte sets wear the same version.
 *
 * So this script asks the registry for the integrity of what it holds and
 * compares it with the integrity of the tarball this release would upload.
 * Three outcomes per package, and only one of them is new:
 *
 *   publish  nothing is on the registry at this version
 *   skip     the registry holds these exact bytes — already done, resumable
 *   refuse   the registry holds *different* bytes at this version
 *
 * A single refusal fails the whole plan. There is no recovery from a version
 * that was published from something else; the recovery is a new version, and
 * that is a decision for a person.
 *
 * Usage:
 *   node scripts/publish-plan.mjs --artifacts .release-artifacts \
 *     [--out .release-artifacts/publish-plan.json] [--json]
 *
 * @module scripts/publish-plan
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { publishOrder } from './publish-order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * npm's `dist.integrity`, computed the way npm computes it.
 *
 * Subresource-integrity form: the algorithm, a dash, and the base64 of the
 * raw digest over the tarball as uploaded. npm publishes the file unchanged,
 * so a tarball this repository packed reproducibly from the released commit
 * has the integrity the registry will report for it.
 *
 * @param file - path to a `.tgz`.
 * @returns e.g. `sha512-4x8f…==`.
 */
export function tarballIntegrity(file) {
  return `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
}

/** The sha1 npm also reports, for a version published before integrity existed. */
export function tarballShasum(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex')
}

/**
 * What the registry holds at `name@version`, or null when it holds nothing.
 *
 * `npm view` exits non-zero for an unpublished version and for a network
 * failure, and those must not be confused: treating an unreachable registry as
 * "not published" would turn an outage into twenty duplicate uploads. So the
 * absent case is recognised by npm's own `E404`, and anything else throws.
 *
 * @param name - package name.
 * @param version - exact version.
 * @param run - injectable runner, for tests.
 * @returns `{ integrity, shasum }`, or null when the version does not exist.
 */
export function registryDist(name, version, run = defaultRun) {
  const result = run(['view', `${name}@${version}`, 'dist', '--json'])
  if (result.status === 0) {
    const text = result.stdout.trim()
    if (text === '') return null
    const dist = JSON.parse(text)
    return { integrity: dist.integrity ?? null, shasum: dist.shasum ?? null }
  }
  const stderr = `${result.stderr ?? ''}${result.stdout ?? ''}`
  if (/E404|is not in this registry|no such package/i.test(stderr)) return null
  throw new Error(`npm view ${name}@${version} failed: ${stderr.trim().slice(0, 300)}`)
}

/**
 * npm's own entry point, run by the node that is running this.
 *
 * Not `spawnSync('npm', args, { shell: true })`. On Windows `npm` is a `.cmd`,
 * which node will not launch without a shell, and a shell concatenates an
 * argument array instead of escaping it -- for arguments that include a
 * package name read out of a manifest. Running `npm-cli.js` directly avoids
 * the shell on every platform and pins the npm that ships with this node.
 *
 * @returns the path to `npm-cli.js`, or null when this node has no bundled npm.
 */
function npmCli() {
  const here = dirname(process.execPath)
  for (const candidate of [
    join(here, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(here, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(here, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** `npm` on this machine, with output captured. */
function defaultRun(args) {
  const cli = npmCli()
  if (cli !== null) {
    return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: ROOT })
  }
  // A node installed without its own npm. `npm` is then a script on PATH with
  // a shebang, which execvp handles, and Windows always has the bundled copy.
  return spawnSync('npm', args, { encoding: 'utf8', cwd: ROOT })
}

/**
 * The plan: one decision per package, in publish order.
 *
 * @param options - `artifacts` directory, and `run` for tests.
 * @returns `{ ok, version, entries }` where a false `ok` means at least one refusal.
 */
export function buildPlan({ artifacts, run = defaultRun } = {}) {
  const inventoryPath = join(artifacts, 'packed-artifacts.json')
  if (!existsSync(inventoryPath)) {
    throw new Error(`publish-plan: no packed-artifacts.json in ${artifacts}; run npm run pack`)
  }
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  const packed = new Map(inventory.packages.map(entry => [entry.name, entry]))

  const entries = []
  let ok = true
  let version = null
  for (const { name } of publishOrder()) {
    const record = packed.get(name)
    if (record === undefined) {
      entries.push({ name, action: 'refuse', reason: 'not present in packed-artifacts.json' })
      ok = false
      continue
    }
    version ??= record.version
    const file = join(artifacts, record.file)
    if (!existsSync(file)) {
      entries.push({
        name, version: record.version, file: record.file,
        action: 'refuse', reason: 'the inventory names a tarball that is not here',
      })
      ok = false
      continue
    }

    // The sealed digest first: a tarball that is not the one this release
    // sealed must never be compared against the registry, let alone uploaded.
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (sha256 !== record.sha256) {
      entries.push({
        name, version: record.version, file: record.file,
        action: 'refuse',
        reason: `sha256 ${sha256.slice(0, 12)}… does not match the sealed ${record.sha256.slice(0, 12)}…`,
      })
      ok = false
      continue
    }

    const dist = registryDist(name, record.version, run)
    if (dist === null) {
      entries.push({
        name, version: record.version, file: record.file,
        action: 'publish', reason: 'not on the registry',
      })
      continue
    }

    const integrity = tarballIntegrity(file)
    const shasum = tarballShasum(file)
    const matches = dist.integrity !== null
      ? dist.integrity === integrity
      : dist.shasum === shasum
    if (matches) {
      entries.push({
        name, version: record.version, file: record.file,
        action: 'skip',
        reason: `already published, and the registry holds these exact bytes (${dist.integrity ?? dist.shasum})`,
      })
      continue
    }
    entries.push({
      name, version: record.version, file: record.file,
      action: 'refuse',
      reason: `${name}@${record.version} is already published with DIFFERENT bytes `
        + `(registry ${dist.integrity ?? dist.shasum}, ours ${dist.integrity !== null ? integrity : shasum})`,
    })
    ok = false
  }
  return { ok, version, entries }
}

function main(argv) {
  const flag = (name, fallback = null) => {
    const at = argv.indexOf(name)
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
  }
  const artifacts = flag('--artifacts', join(ROOT, '.release-artifacts'))
  const out = flag('--out', join(artifacts, 'publish-plan.json'))

  let plan
  try {
    plan = buildPlan({ artifacts })
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }

  writeFileSync(out, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  } else {
    for (const entry of plan.entries) {
      process.stdout.write(`${entry.action.padEnd(8)}${entry.name} — ${entry.reason}\n`)
    }
    const counted = action => plan.entries.filter(entry => entry.action === action).length
    process.stdout.write(
      `\n${String(counted('publish'))} to publish, ${String(counted('skip'))} already done, `
      + `${String(counted('refuse'))} refused\n`)
  }

  if (!plan.ok) {
    for (const entry of plan.entries.filter(item => item.action === 'refuse')) {
      process.stderr.write(`::error::${entry.name}: ${entry.reason}\n`)
    }
    process.stderr.write(
      '::error::A published version can never be replaced. The recovery is a new '
      + 'version, not a retry. See docs/releasing.md.\n')
    return 1
  }
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
