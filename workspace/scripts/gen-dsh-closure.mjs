#!/usr/bin/env node
/**
 * Capture the audited dependency closure the managed DeepWatch runtime is
 * built from, so every later decision is made from committed evidence rather
 * than from a registry that may answer differently tomorrow.
 *
 * This is the one step that talks to the network, and it is run by hand rather
 * than by a gate. It performs the install the product will perform — the same
 * exact Harness version, the same install invocation — and records what npm
 * resolved: every package, its exact version, its integrity, its licence, its
 * platform constraints and its peer declarations. `gen-managed-runtime.mjs`
 * then derives the runtime manifest from *this file* and never from a
 * registry, which is what makes that derivation deterministic, offline and
 * identical on Windows, Linux and macOS.
 *
 * **Why the roots are what they are.** The managed runtime holds two things
 * that need peers: the pinned Harness, and the DeepWatch packages. Seeding
 * only the Harness produces a closure that looks complete and is not — npm
 * resolves `react` to 19, because that is what the Harness's own range
 * admits, while every DeepWatch client package declares `react: ^18.2.0` as a
 * *required* peer. The resulting runtime installs cleanly, boots the Harness,
 * and cannot render a DeepWatch surface. So the seed is the Harness plus the
 * required peers the DeepWatch packages declare, and npm resolves one set that
 * satisfies both. Nothing here is hand-picked: `react` is in the manifest
 * because two packages in the real graph require it, and for no other reason.
 *
 * **Why `--legacy-peer-deps`, and what it costs.** npm's default peer
 * resolution does not finish on this closure — measured twice, roughly ten and
 * seventy minutes, about 3 GB resident, no files written. The fast mode
 * completes in seconds and installs no peers at all, which leaves twenty-one
 * *required* peers missing and a Harness that will not start. Neither is
 * correct alone. This installs with the fast mode and then supplies the
 * missing required peers explicitly, round after round, until the set closes —
 * which is exactly what the product does, from the manifest this produces.
 *
 * Usage:
 *   node scripts/gen-dsh-closure.mjs            capture into inventory/
 *   node scripts/gen-dsh-closure.mjs --keep     leave the room for inspection
 */

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { byCodeUnit } from './lib/order.mjs'
import { catalog, resolveRange } from './lib/catalog.mjs'
import { resolveNpm, run } from './lib/process.mjs'
import { installInvocation } from './lib/install.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'inventory', 'dsh-closure.json')

/** The Harness this distribution is built against. Stated once, in the catalog. */
const HARNESS = '@deepseek-ai/dsh'

/** How many rounds of supplying missing peers before the set is called open. */
const ROUNDS = 8

/** How long one npm invocation may take before it is a hang rather than work. */
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000

/**
 * The required peers the DeepWatch packages declare.
 *
 * Read from the workspace manifests with `catalog:` resolved, because that is
 * what a packed tarball declares and therefore what the managed runtime will
 * actually have to satisfy. Optional peers are left out: an optional peer that
 * is absent is a decision, not a hole.
 *
 * @returns {Map<string, string>} peer name to the range DeepWatch asks for.
 */
function deepwatchRequiredPeers() {
  const entries = catalog(ROOT)
  const base = join(ROOT, 'packages', 'watch')
  const wanted = new Map()
  for (const directory of readdirSync(base).sort(byCodeUnit)) {
    const manifestPath = join(base, directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const meta = manifest.peerDependenciesMeta ?? {}
    for (const [peer, declared] of Object.entries(manifest.peerDependencies ?? {})) {
      if (meta[peer]?.optional === true) continue
      const range = resolveRange(entries, peer, declared)
      // The strictest declaration wins where two packages disagree; an exact
      // pin beats a caret, and the generator re-checks the result against
      // every declaration anyway.
      const existing = wanted.get(peer)
      if (existing === undefined || (existing.startsWith('^') && !range.startsWith('^'))) {
        wanted.set(peer, range)
      }
    }
  }
  return wanted
}

/** Every package directory in a tree, scopes expanded. */
function installedPackages(room) {
  const modules = join(room, 'node_modules')
  const found = new Map()
  if (!existsSync(modules)) return found
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const name of readdirSync(join(modules, entry))) {
        found.set(`${entry}/${name}`, join(modules, entry, name))
      }
      continue
    }
    found.set(entry, join(modules, entry))
  }
  return found
}

/**
 * Required peers the tree declares and does not contain.
 *
 * @param {string} room - the install directory.
 * @returns {Map<string, { range: string, by: string[] }>} the missing peers.
 */
function missingRequiredPeers(room) {
  const present = installedPackages(room)
  const missing = new Map()
  for (const [owner, dir] of present) {
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const meta = manifest.peerDependenciesMeta ?? {}
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (meta[peer]?.optional === true) continue
      if (present.has(peer)) continue
      const found = missing.get(peer)
      if (found === undefined) missing.set(peer, { range, by: [owner] })
      else found.by.push(owner)
    }
  }
  return missing
}

/**
 * The lockfile, reduced to the facts the derivation needs.
 *
 * Only the hoisted top level is recorded. A nested `node_modules/a/node_modules/b`
 * is npm resolving a conflict inside the tree, which is npm's business; what
 * the managed-runtime manifest is about is the packages a resolver will find
 * from the root, and recording the nested duplicates would make the evidence
 * depend on hoisting decisions that are not part of the contract.
 *
 * @param {string} room - the install directory.
 * @returns {{ packages: object[], nested: string[] }} the evidence rows.
 */
function readLock(room) {
  const lock = JSON.parse(readFileSync(join(room, 'package-lock.json'), 'utf8'))
  const packages = []
  const nested = []
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === '') continue
    const name = path.startsWith('node_modules/') ? path.slice('node_modules/'.length) : null
    if (name === null || name.includes('/node_modules/')) {
      nested.push(path)
      continue
    }
    packages.push({
      name,
      version: entry.version,
      resolved: entry.resolved ?? null,
      integrity: entry.integrity ?? null,
      license: entry.license ?? null,
      os: entry.os ?? null,
      cpu: entry.cpu ?? null,
      optional: entry.optional === true,
      dev: entry.dev === true,
      hasInstallScript: entry.hasInstallScript === true,
      dependencies: sortedRecord(entry.dependencies),
      optionalDependencies: sortedRecord(entry.optionalDependencies),
      peerDependencies: sortedRecord(entry.peerDependencies),
      peerDependenciesMeta: sortedMeta(entry.peerDependenciesMeta),
    })
  }
  packages.sort((a, b) => byCodeUnit(a.name, b.name))
  nested.sort(byCodeUnit)
  return { packages, nested }
}

/** A dependency record, in one order on every machine. */
function sortedRecord(record) {
  if (record === undefined || record === null) return null
  const out = {}
  for (const key of Object.keys(record).sort(byCodeUnit)) out[key] = record[key]
  return Object.keys(out).length === 0 ? null : out
}

/** The peer metadata, reduced to the one flag that changes a decision. */
function sortedMeta(record) {
  if (record === undefined || record === null) return null
  const out = {}
  for (const key of Object.keys(record).sort(byCodeUnit)) {
    out[key] = { optional: record[key]?.optional === true }
  }
  return Object.keys(out).length === 0 ? null : out
}

async function main() {
  const keep = process.argv.includes('--keep')
  const npm = resolveNpm()
  if (npm === null) {
    process.stderr.write('watch: no npm this tooling can run was found\n')
    process.exit(1)
  }

  const entries = catalog(ROOT)
  const harnessVersion = entries.get(HARNESS)
  if (harnessVersion === undefined) {
    process.stderr.write(`watch: pnpm-workspace.yaml does not pin ${HARNESS}\n`)
    process.exit(1)
  }

  const seeds = [`${HARNESS}@${harnessVersion}`]
  const deepwatchPeers = deepwatchRequiredPeers()
  for (const [name, range] of [...deepwatchPeers].sort((a, b) => byCodeUnit(a[0], b[0]))) {
    // The Harness itself is already seeded exactly; a DeepWatch package
    // declaring it again must not re-open it to a range.
    if (name === HARNESS) continue
    seeds.push(`${name}@${range}`)
  }

  const room = mkdtempSync(join(tmpdir(), 'deepwatch-closure-'))
  const rounds = []
  try {
    mkdirSync(room, { recursive: true })
    writeFileSync(join(room, 'package.json'), `${JSON.stringify({
      name: 'deepwatch-closure-capture', private: true, version: '0.0.0',
    }, null, 2)}\n`)
    writeFileSync(join(room, '.npmrc'), 'audit=false\nfund=false\n')

    process.stdout.write(`  seeding ${String(seeds.length)} roots in ${room}\n`)
    const seeded = await run(npm.command, [...npm.prefix, ...installInvocation(seeds)],
      { cwd: room, timeoutMs: INSTALL_TIMEOUT_MS })
    if (seeded.code !== 0) {
      process.stderr.write(`watch: the seed install failed\n${seeded.stderr.slice(-2000)}\n`)
      process.exit(1)
    }
    rounds.push({ round: 0, supplied: seeds.length, installed: installedPackages(room).size })

    for (let round = 1; round <= ROUNDS; round += 1) {
      const missing = missingRequiredPeers(room)
      if (missing.size === 0) break
      if (round === ROUNDS) {
        process.stderr.write(
          `watch: ${String(missing.size)} required peers did not close after `
          + `${String(ROUNDS)} rounds\n`)
        process.exit(1)
      }
      const specs = [...missing].map(([name, found]) => `${name}@${found.range}`).sort(byCodeUnit)
      process.stdout.write(`  round ${String(round)}: supplying ${String(specs.length)} required peers\n`)
      const supplied = await run(npm.command, [...npm.prefix, ...installInvocation(specs)],
        { cwd: room, timeoutMs: INSTALL_TIMEOUT_MS })
      if (supplied.code !== 0) {
        process.stderr.write(`watch: supplying peers failed\n${supplied.stderr.slice(-2000)}\n`)
        process.exit(1)
      }
      rounds.push({ round, supplied: specs.length, installed: installedPackages(room).size })
    }

    const remaining = missingRequiredPeers(room)
    if (remaining.size !== 0) {
      process.stderr.write(`watch: ${String(remaining.size)} required peers remain missing\n`)
      process.exit(1)
    }

    const { packages, nested } = readLock(room)
    const rootManifest = JSON.parse(readFileSync(join(room, 'package.json'), 'utf8'))
    const document = {
      generatedBy: 'scripts/gen-dsh-closure.mjs',
      note:
        'The audited dependency closure the managed DeepWatch runtime is built '
        + 'from. Captured by performing the install the product performs, and '
        + 'recording what npm resolved. `scripts/gen-managed-runtime.mjs` derives '
        + 'the runtime manifest from this file alone — offline, and identically on '
        + 'every platform. Re-capture with `node scripts/gen-dsh-closure.mjs` when '
        + 'the pinned baseline moves.',
      harness: { package: HARNESS, version: harnessVersion },
      registry: 'https://registry.npmjs.org',
      installMode: '--legacy-peer-deps, with required peers supplied explicitly',
      seeds: seeds.slice().sort(byCodeUnit),
      seedReason:
        'The pinned Harness, plus the required peers the DeepWatch packages '
        + 'declare. Seeding the Harness alone resolves react to 19, which no '
        + 'DeepWatch client package accepts.',
      rounds,
      roots: sortedRecord(rootManifest.dependencies),
      nestedResolutions: nested,
      total: packages.length,
      packages,
    }
    // The digest covers everything a derivation reads, so a manifest generated
    // from one capture cannot be presented as evidence from another.
    const body = JSON.stringify({ ...document, digest: undefined })
    document.digest = `sha256:${createHash('sha256').update(body).digest('hex')}`

    mkdirSync(dirname(OUT), { recursive: true })
    writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    process.stdout.write(
      `\ndsh-closure: ${String(packages.length)} packages, ${String(rounds.length)} round(s), `
      + `0 required peers missing\n  ${document.digest}\n`)
  } finally {
    if (!keep) rmSync(room, { recursive: true, force: true, maxRetries: 5 })
    else process.stdout.write(`  kept ${room}\n`)
  }
}

await main()
