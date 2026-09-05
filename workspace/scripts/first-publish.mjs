#!/usr/bin/env node
/**
 * One-time npm bootstrap for the first @deepwatch publication.
 *
 * Dry-run is the default and never contacts npm. `--check-access` performs
 * the read-only identity/organisation probes. Publishing additionally needs
 * both `--publish` and `--confirm-first-publish`; there is intentionally no
 * environment-variable shortcut.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNpm } from './lib/process.mjs'
import { publishOrder } from './publish-order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const EXPECTED_ORDER = Object.freeze([
  '@deepwatch/dsh-client-brand',
  '@deepwatch/dsh-contracts',
  '@deepwatch/dsh-trajectory',
  '@deepwatch/dsh-workspace',
  '@deepwatch/dsh-client-evidence',
  '@deepwatch/dsh-memory',
  '@deepwatch/dsh-client-memory',
  '@deepwatch/dsh-technology',
  '@deepwatch/dsh-library',
  '@deepwatch/dsh-core-bridge',
  '@deepwatch/dsh-tools',
  '@deepwatch/dsh-client-remotes',
  '@deepwatch/dsh-client-settings',
  '@deepwatch/dsh-live',
  '@deepwatch/dsh-bundle',
  '@deepwatch/cli',
  '@deepwatch/dsh-wiki',
  '@deepwatch/dsh-adapters',
  '@deepwatch/dsh-sdk',
  '@deepwatch/dsh-tenancy',
])

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? fallback : process.argv[at + 1]
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * The dist-tag a version shape earns, by the same rule the release workflow uses.
 *
 * This was hardcoded to `preview`, which was right while every version was
 * `0.1.0-preview.N` and silently wrong the moment one was not: a stable `0.1.0`
 * published under `preview` leaves `npm i @deepwatch/cli` resolving nothing,
 * because `latest` would not exist. A prerelease must never take `latest`, and a
 * stable release must never take anything else.
 *
 * A prerelease shape this train has no tag for is a refusal rather than a guess
 * — the workflow makes the same call, and the two must not disagree about a
 * publication that cannot be taken back.
 */
export function distTag(version) {
  if (/-preview\./.test(version)) return 'preview'
  if (/-rc\./.test(version)) return 'next'
  if (version.includes('-')) {
    throw new Error(`${version} is a prerelease this train has no dist-tag for`)
  }
  return 'latest'
}

function npm(args) {
  const spec = resolveNpm()
  if (spec === null) return { code: 1, stdout: '', stderr: 'npm is unavailable' }
  return run(spec.command, [...spec.prefix, ...args], { cwd: ROOT })
}

function gitClean() {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: join(ROOT, '..'),
  })
  if (status.code !== 0) throw new Error('git status failed')
  if (status.stdout.trim() !== '') {
    throw new Error('the worktree is dirty; first publication requires an exact committed candidate')
  }
}

function extractPackageJson(tarball) {
  const result = run('tar', ['-xzOf', basename(tarball), 'package/package.json'], {
    cwd: dirname(tarball),
  })
  if (result.code !== 0) throw new Error(`${basename(tarball)} cannot be read as an npm tarball`)
  return JSON.parse(result.stdout)
}

function filesIn(tarball) {
  const result = run('tar', ['-tzf', basename(tarball)], { cwd: dirname(tarball) })
  if (result.code !== 0) throw new Error(`${basename(tarball)} cannot be listed`)
  return result.stdout.split(/\r?\n/)
    .map(file => file.trim().replace(/^package\//, ''))
    .filter(file => file !== '' && !file.endsWith('/'))
    .sort()
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function verifyArtifacts(directory) {
  const inventoryPath = join(directory, 'packed-artifacts.json')
  if (!existsSync(inventoryPath)) throw new Error('packed-artifacts.json is absent')
  const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8'))
  if (inventory.counts?.packages !== 20 || inventory.packages?.length !== 20) {
    throw new Error('the inventory does not contain exactly 20 packages')
  }

  const derived = publishOrder().map(entry => entry.name)
  if (!sameJson(derived, EXPECTED_ORDER)) {
    throw new Error('the manifest dependency graph no longer matches the approved first-publish order')
  }

  const records = new Map(inventory.packages.map(record => [record.name, record]))
  const verified = []
  for (const name of EXPECTED_ORDER) {
    const record = records.get(name)
    if (record === undefined) throw new Error(`${name} is absent from the inventory`)
    if (record.access !== 'public') throw new Error(`${name} does not declare public access`)
    const tarball = resolve(directory, record.file)
    if (dirname(tarball) !== resolve(directory)) throw new Error(`${name} names a tarball outside the artifact directory`)
    if (!existsSync(tarball)) throw new Error(`${name} tarball is absent`)
    const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
    if (sha256 !== record.sha256) throw new Error(`${name} tarball SHA-256 does not match the inventory`)

    const manifest = extractPackageJson(tarball)
    if (manifest.name !== name || manifest.version !== record.version) {
      throw new Error(`${name} tarball identity does not match the inventory`)
    }
    if (!manifest.name.startsWith('@deepwatch/') || manifest.private === true) {
      throw new Error(`${name} is outside the public @deepwatch scope`)
    }
    if (manifest.publishConfig?.access !== 'public') {
      throw new Error(`${name} tarball does not declare publishConfig.access=public`)
    }
    if (!sameJson(filesIn(tarball), [...record.files].sort())) {
      throw new Error(`${name} file list does not match the inventory`)
    }
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (dependency.startsWith('@deepwatch/') && !records.has(dependency)) {
          throw new Error(`${name} ${field} names ${dependency}, which is outside the inventory`)
        }
        if (String(range).startsWith('workspace:') || String(range).startsWith('file:')) {
          throw new Error(`${name} contains a source fallback for ${dependency}`)
        }
      }
    }
    if (!sameJson(manifest.dependencies ?? {}, record.dependencies ?? {})) {
      throw new Error(`${name} dependency graph does not match the inventory`)
    }
    if (!sameJson(manifest.peerDependencies ?? {}, record.peerDependencies ?? {})) {
      throw new Error(`${name} peer dependency graph does not match the inventory`)
    }
    verified.push({ name, version: manifest.version, file: record.file, sha256 })
  }
  return verified
}

function checkAccess() {
  const identity = npm(['whoami', '--registry=https://registry.npmjs.org/'])
  if (identity.code !== 0 || identity.stdout.trim() === '') {
    throw new Error('npm identity check failed; authenticate with a short-lived, 2FA-protected publisher token')
  }
  const access = npm(['access', 'list', 'packages', '@deepwatch', '--json'])
  if (access.code !== 0) {
    throw new Error('npm organisation access check failed for @deepwatch')
  }
  // Deliberately report only that the checks passed. User names, tokens and
  // npm configuration do not belong in a release artifact.
  return { identity: 'verified', organisation: '@deepwatch', access: 'verified' }
}

function initialState(mode, artifacts, access) {
  return {
    schemaVersion: 1,
    mode,
    artifacts: resolve(artifacts),
    access,
    created: [],
    skipped: [],
    failed: [],
    remaining: [...EXPECTED_ORDER],
  }
}

function saveState(path, state) {
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

async function main() {
  const artifacts = resolve(option('artifacts', join(ROOT, '.release-artifacts')))
  const statePath = resolve(option('state', join(artifacts, 'first-publish-state.json')))
  const publishing = process.argv.includes('--publish')
  const confirmed = process.argv.includes('--confirm-first-publish')
  const wantsAccess = process.argv.includes('--check-access') || publishing

  gitClean()
  const verified = verifyArtifacts(artifacts)
  const access = wantsAccess ? checkAccess() : { identity: 'not_checked', organisation: '@deepwatch', access: 'not_checked' }
  const state = initialState(publishing ? 'publish' : 'dry-run', artifacts, access)
  saveState(statePath, state)

  if (!publishing) {
    process.stdout.write(`first-publish dry-run: verified ${String(verified.length)} public tarballs\n`)
    process.stdout.write('No registry write was attempted. Add --check-access for read-only npm access checks.\n')
    return 0
  }
  if (!confirmed) throw new Error('--publish also requires --confirm-first-publish')

  for (const item of verified) {
    const present = npm(['view', `${item.name}@${item.version}`, 'version', '--json'])
    if (present.code === 0) {
      state.skipped.push({ name: item.name, version: item.version, reason: 'already_exists' })
      state.remaining.shift()
      saveState(statePath, state)
      continue
    }
    const result = npm([
      'publish', join(artifacts, item.file), '--access', 'public', '--tag', distTag(item.version),
    ])
    if (result.code !== 0) {
      state.failed.push({ name: item.name, version: item.version, category: 'publish_failed' })
      saveState(statePath, state)
      throw new Error(`${item.name} failed; inspect the redacted npm console output and resume from the state report`)
    }
    state.created.push({ name: item.name, version: item.version })
    state.remaining.shift()
    saveState(statePath, state)
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code }).catch(error => {
    process.stderr.write(`first-publish: ${error.message}\n`)
    process.exitCode = 1
  })
}
