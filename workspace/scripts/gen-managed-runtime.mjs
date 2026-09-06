#!/usr/bin/env node
/**
 * Derive the manifest the managed DeepWatch runtime is installed from, out of
 * the audited closure and nothing else.
 *
 * `deepwatch setup` installs with `--legacy-peer-deps`, because that is the
 * only mode that finishes on this graph. That mode installs **no peers at
 * all**, so every *required* peer has to be named explicitly on the same
 * command line, at an exact version, or the Harness installs cleanly and will
 * not start. The list of those peers is what this produces.
 *
 * **It is derived, never written down.** A hand-kept list of twenty-one
 * package names is a list that is right on the day it is written and silently
 * wrong after the next baseline bump — and "twenty-one" is an observation
 * about one version of one dependency graph, not a fact about the product.
 * This walks the graph instead: from the pinned Harness and the peers the
 * DeepWatch packages declare, it computes what npm will install, finds the
 * required peers that leaves out, adds them, and repeats until nothing is
 * missing. If the answer changes, this changes with it.
 *
 * **It is offline and platform-independent.** Everything comes from
 * `inventory/dsh-closure.json`, which `gen-dsh-closure.mjs` captured once from
 * a real install. No registry is consulted here, no `node_modules` is read, no
 * date or hostname or path is recorded, and every list is ordered by code unit
 * rather than by the machine's collation. The same evidence therefore produces
 * byte-identical output on Windows, Linux and macOS — which
 * `tests/managed-runtime.test.mjs` asserts rather than hopes.
 *
 * **It fails rather than guesses.** A required peer with no exact resolution,
 * two required ranges no single version satisfies, a peer still missing when
 * the walk closes, a package whose licence nobody can name, or evidence that
 * does not match the digest recorded against it — each stops the build. The
 * one thing this must never do is emit a range: `latest`, a tag, a caret or a
 * tilde in a runtime manifest is a runtime that differs from the one that was
 * measured.
 *
 * Usage:
 *   node scripts/gen-managed-runtime.mjs           write the manifest
 *   node scripts/gen-managed-runtime.mjs --check   fail if it is stale
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { byCodeUnit } from './lib/order.mjs'
import { catalog, resolveRange } from './lib/catalog.mjs'
import { satisfies, UnsupportedRange } from './lib/semver-lite.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const EVIDENCE = join(ROOT, 'inventory', 'dsh-closure.json')
const OUT = join(ROOT, 'inventory', 'managed-runtime.json')
const MODULE = join(ROOT, 'packages', 'watch', 'cli', 'src', 'generated', 'managed-runtime.ts')

/** The version of this derivation, so a manifest says which walk produced it. */
const GENERATOR_VERSION = '1.0.0'

/** The Harness, which is the one root that is not derived from anything. */
const HARNESS = '@deepseek-ai/dsh'

/** Licence strings that name no licence, however they are spelled. */
const UNKNOWN_LICENCE = /^(unknown|unlicensed|see licen[cs]e)/i

/** A refusal that names the gate rather than a stack. */
class Refusal extends Error {}

/** Read the audited closure, and prove it is the one recorded. */
function readEvidence() {
  if (!existsSync(EVIDENCE)) {
    throw new Refusal(
      'inventory/dsh-closure.json is not there. Capture it with '
      + '`node scripts/gen-dsh-closure.mjs` — it is the one step that uses the network.')
  }
  const document = JSON.parse(readFileSync(EVIDENCE, 'utf8'))
  const recorded = document.digest
  const recomputed = `sha256:${createHash('sha256')
    .update(JSON.stringify({ ...document, digest: undefined })).digest('hex')}`
  if (recorded !== recomputed) {
    throw new Refusal(
      'inventory/dsh-closure.json does not match the digest recorded inside it, so it '
      + 'has been edited by hand. Re-capture it rather than adjusting it.')
  }
  return document
}

/**
 * The required peers the DeepWatch packages declare, with `catalog:` resolved.
 *
 * These are roots of the walk because the managed runtime contains the
 * DeepWatch packages as well as the Harness, and a peer only DeepWatch
 * requires is still a module something will import at runtime.
 *
 * @returns {Map<string, { range: string, by: string[] }>} peer to what asked.
 */
function deepwatchRequiredPeers() {
  const entries = catalog(ROOT)
  const base = join(ROOT, 'packages', 'watch')
  const wanted = new Map()
  for (const directory of readdirSync(base).sort(byCodeUnit)) {
    const manifestPath = join(base, directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.private === true) continue
    const meta = manifest.peerDependenciesMeta ?? {}
    for (const [peer, declared] of Object.entries(manifest.peerDependencies ?? {})) {
      if (meta[peer]?.optional === true) continue
      const range = resolveRange(entries, peer, declared)
      const found = wanted.get(peer)
      if (found === undefined) wanted.set(peer, { range, by: [manifest.name] })
      else {
        found.by.push(manifest.name)
        // Every declaration is checked against the chosen version later, so
        // keeping one representative range here loses nothing.
        if (!found.range.includes(range)) found.range = range
      }
    }
  }
  return wanted
}

/**
 * What npm will actually install, given a set of explicit root dependencies.
 *
 * The walk follows `dependencies` only. `optionalDependencies` are deliberately
 * not followed: they are installed when the platform allows and skipped when it
 * does not, so treating one as present is how a manifest becomes correct on the
 * machine that generated it and wrong everywhere else.
 *
 * @param {Iterable<string>} roots - the explicit dependency names.
 * @param {Map<string, object>} index - the closure, by package name.
 * @returns {Set<string>} every package npm will end up installing.
 */
function transitivelyInstalled(roots, index) {
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const name = queue.pop()
    if (seen.has(name)) continue
    const record = index.get(name)
    if (record === undefined) continue
    seen.add(name)
    for (const dependency of Object.keys(record.dependencies ?? {})) {
      if (!seen.has(dependency)) queue.push(dependency)
    }
  }
  return seen
}

/**
 * Every required-peer demand the installed set makes, and who makes it.
 *
 * @param {Set<string>} installed - what will be installed.
 * @param {Map<string, object>} index - the closure, by package name.
 * @returns {Map<string, { range: string, by: string[] }[]>} peer to demands.
 */
function requiredPeerDemands(installed, index) {
  const demands = new Map()
  for (const name of [...installed].sort(byCodeUnit)) {
    const record = index.get(name)
    if (record === undefined) continue
    const meta = record.peerDependenciesMeta ?? {}
    for (const [peer, range] of Object.entries(record.peerDependencies ?? {})) {
      if (meta[peer]?.optional === true) continue
      const list = demands.get(peer) ?? []
      list.push({ range, by: [name] })
      demands.set(peer, list)
    }
  }
  return demands
}

/** How a package is reached, for the classification the manifest records. */
function classify(name, record, installed, requiredPeers, optionalPeers) {
  if (requiredPeers.has(name)) return 'required-peer'
  if (record !== undefined && (record.os !== null || record.cpu !== null)) {
    return 'platform-optional'
  }
  if (record !== undefined && record.optional === true) return 'optional-dependency'
  if (optionalPeers.has(name)) return 'optional-peer'
  if (record !== undefined && record.dev === true) return 'development-only'
  return installed.has(name) ? 'transitive-dependency' : 'unreachable'
}

/** The TypeScript module the CLI reads the manifest from. */
function moduleSource(document) {
  const rows = document.dependencies
    .map(entry => `  '${entry.name}': '${entry.version}',`).join('\n')
  return [
    '/**',
    ' * The exact dependency set the managed DeepWatch runtime is installed from.',
    ' *',
    ' * Generated by `scripts/gen-managed-runtime.mjs` from',
    ' * `inventory/dsh-closure.json`. Do not edit: the audited closure is the',
    ' * source of truth, `npm run managed:check` fails when this drifts from it,',
    ' * and a hand-edited version here is a runtime nobody measured.',
    ' *',
    ' * Every entry is an exact version. `setup` installs with',
    ' * `--legacy-peer-deps`, which installs no peers at all, so the required',
    ' * peers below are supplied explicitly on the same command line. A range in',
    ' * this file would be a runtime that differs from the one that was tested.',
    ' *',
    ' * @module @deepwatch/cli/generated/managed-runtime',
    ' */',
    '',
    '/** The audited closure this was derived from. */',
    `export const CLOSURE_DIGEST = '${document.evidence.digest}'`,
    '',
    '/** The digest of the generated manifest itself. */',
    `export const MANIFEST_DIGEST = '${document.digest}'`,
    '',
    '/** How many of the entries below are required peers rather than the Harness. */',
    `export const REQUIRED_PEER_COUNT = ${String(document.counts['required-peer'] ?? 0)}`,
    '',
    '/** Exact package versions the managed runtime is installed from. */',
    'export const MANAGED_DEPENDENCIES: Readonly<Record<string, string>> = {',
    rows,
    '}',
    '',
  ].join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  const evidence = readEvidence()

  const index = new Map()
  for (const record of evidence.packages) index.set(record.name, record)

  const harnessVersion = evidence.harness?.version
  if (typeof harnessVersion !== 'string') {
    throw new Refusal('inventory/dsh-closure.json records no pinned Harness version')
  }
  if (index.get(HARNESS)?.version !== harnessVersion) {
    throw new Refusal(
      `the closure contains ${HARNESS}@${String(index.get(HARNESS)?.version)} and the `
      + `capture says the baseline is ${harnessVersion}`)
  }

  // The walk. Roots are the pinned Harness and the peers DeepWatch requires;
  // everything else is discovered.
  const deepwatch = deepwatchRequiredPeers()
  /** @type {Map<string, { range: string, by: string[] }[]>} */
  const demands = new Map()
  const explicit = new Set([HARNESS])
  for (const [peer, found] of deepwatch) {
    if (peer === HARNESS) continue
    explicit.add(peer)
    demands.set(peer, [{ range: found.range, by: found.by.slice().sort(byCodeUnit) }])
  }

  let installed = new Set()
  let closed = false
  for (let round = 0; round < 32; round += 1) {
    installed = transitivelyInstalled(explicit, index)
    const wanted = requiredPeerDemands(installed, index)
    for (const [peer, list] of wanted) {
      const existing = demands.get(peer) ?? []
      demands.set(peer, [...existing, ...list])
    }
    // Already-explicit peers are not "still missing": a peer the closure has
    // no record of can never enter the installed set, and looping on it would
    // report a cycle where the real answer is that it has no resolution — which
    // is what the exactness check below says, by name.
    const missing = [...wanted.keys()]
      .filter(peer => !installed.has(peer) && !explicit.has(peer)).sort(byCodeUnit)
    if (missing.length === 0) { closed = true; break }
    for (const peer of missing) explicit.add(peer)
  }
  if (!closed) {
    throw new Refusal(
      'the required-peer walk did not close after 32 rounds, which means the graph grows '
      + 'without bound rather than reaching a fixpoint')
  }

  // Every optional peer, so the manifest can say what it deliberately left out.
  const optionalPeers = new Set()
  for (const name of installed) {
    const record = index.get(name)
    const meta = record?.peerDependenciesMeta ?? {}
    for (const [peer, detail] of Object.entries(meta)) {
      if (detail?.optional === true && !explicit.has(peer)) optionalPeers.add(peer)
    }
  }

  // Resolve, and refuse anything that cannot be resolved exactly.
  const problems = []
  const dependencies = []
  for (const name of [...explicit].sort(byCodeUnit)) {
    const record = index.get(name)
    if (record === undefined || typeof record.version !== 'string') {
      problems.push(`${name} is required and the audited closure has no exact version for it`)
      continue
    }
    if (!/^\d+\.\d+\.\d+/.test(record.version)) {
      problems.push(`${name} resolves to ${record.version}, which is not an exact version`)
      continue
    }
    const asked = (demands.get(name) ?? []).slice()
      .sort((a, b) => byCodeUnit(a.by.join(','), b.by.join(',')))
    const unsatisfied = []
    for (const demand of asked) {
      try {
        if (!satisfies(record.version, demand.range)) {
          unsatisfied.push(`${demand.by.join(', ')} asks for ${demand.range}`)
        }
      } catch (error) {
        if (error instanceof UnsupportedRange) {
          problems.push(`${name}: ${error.message}, so it cannot be checked`)
          continue
        }
        throw error
      }
    }
    if (unsatisfied.length > 0) {
      problems.push(
        `${name}@${record.version} does not satisfy every required range — `
        + `${unsatisfied.join('; ')}. No single version can coexist here.`)
      continue
    }
    const licence = typeof record.license === 'string' ? record.license : null
    if (licence === null || UNKNOWN_LICENCE.test(licence)) {
      problems.push(`${name}@${record.version} has no licence this closure can name`)
      continue
    }
    dependencies.push({
      name,
      version: record.version,
      role: name === HARNESS ? 'harness' : 'required-peer',
      integrity: record.integrity,
      license: licence,
      requestedBy: asked.map(demand => ({ by: demand.by.join(', '), range: demand.range })),
    })
  }

  // The licence closure of everything that will be installed, not just the
  // explicit roots: a notice obligation does not care how a package was reached.
  const licences = new Map()
  const unnamed = []
  for (const name of [...installed].sort(byCodeUnit)) {
    const record = index.get(name)
    const licence = typeof record?.license === 'string' ? record.license : null
    if (licence === null || UNKNOWN_LICENCE.test(licence)) { unnamed.push(name); continue }
    licences.set(licence, (licences.get(licence) ?? 0) + 1)
  }
  if (unnamed.length > 0) {
    problems.push(
      `${String(unnamed.length)} installed package(s) have no licence this closure can `
      + `name: ${unnamed.slice(0, 5).join(', ')}`)
  }

  // And the licences of everything installed *conditionally* — the
  // platform-specific and optional packages. These are counted apart because
  // they are not installed everywhere, and folded into the list above they
  // would be an overstatement of what a given machine has. Left out entirely
  // they would be worse: every LGPL component in this closure is a
  // platform-specific `sharp` binary, so a licence summary that omits
  // conditional packages reads as though there is no LGPL here at all.
  const conditional = new Map()
  for (const record of evidence.packages) {
    if (installed.has(record.name)) continue
    const kind = classify(record.name, record, installed, explicit, optionalPeers)
    if (kind === 'unreachable' || kind === 'development-only') continue
    const licence = typeof record.license === 'string' ? record.license : null
    if (licence === null || UNKNOWN_LICENCE.test(licence)) continue
    conditional.set(licence, (conditional.get(licence) ?? 0) + 1)
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`  ${problem}\n`)
    throw new Refusal(`${String(problems.length)} problem(s) in the managed-runtime closure`)
  }

  const counts = {}
  const classification = []
  for (const record of evidence.packages) {
    const kind = classify(record.name, record, installed, explicit, optionalPeers)
    counts[kind] = (counts[kind] ?? 0) + 1
    classification.push({ name: record.name, version: record.version, kind })
  }
  classification.sort((a, b) => byCodeUnit(a.name, b.name))
  // The Harness is counted as itself, not as a peer it is not.
  counts['required-peer'] = dependencies.filter(entry => entry.role === 'required-peer').length

  const document = {
    generatedBy: 'scripts/gen-managed-runtime.mjs',
    generatorVersion: GENERATOR_VERSION,
    note:
      'The exact dependency set `deepwatch setup` installs the managed runtime '
      + 'from. Derived from inventory/dsh-closure.json by walking required, '
      + 'non-optional peer dependencies to a fixpoint from the pinned Harness and '
      + 'the peers the DeepWatch packages declare. Every version is exact: setup '
      + 'installs with --legacy-peer-deps, which installs no peers, so each one '
      + 'below is named on the install command line. No range, tag or `latest` '
      + 'may appear here.',
    harness: { package: HARNESS, version: harnessVersion },
    evidence: {
      file: 'inventory/dsh-closure.json',
      digest: evidence.digest,
      capturedPackages: evidence.total,
    },
    installedPackages: installed.size,
    counts,
    licences: [...licences].sort((a, b) => byCodeUnit(a[0], b[0]))
      .map(([name, count]) => ({ license: name, packages: count })),
    conditionalLicences: {
      note:
        'Packages installed only where the platform or an optional dependency '
        + 'admits them. Counted apart from the list above so neither number '
        + 'overstates the other. Every LGPL-3.0-or-later component in this closure '
        + 'is here: they are the per-platform libvips binaries behind sharp, '
        + 'fetched by the user\'s own package manager under their publisher\'s '
        + 'terms. See docs/THIRD_PARTY_NOTICES.',
      licences: [...conditional].sort((a, b) => byCodeUnit(a[0], b[0]))
        .map(([name, count]) => ({ license: name, packages: count })),
    },
    dependencies,
    classification,
  }
  const body = JSON.stringify({ ...document, digest: undefined })
  document.digest = `sha256:${createHash('sha256').update(body).digest('hex')}`

  const json = `${JSON.stringify(document, null, 2)}\n`
  const source = moduleSource(document)

  if (check) {
    const stale = []
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== json) stale.push('inventory/managed-runtime.json')
    if (!existsSync(MODULE) || readFileSync(MODULE, 'utf8') !== source) {
      stale.push('packages/watch/cli/src/generated/managed-runtime.ts')
    }
    if (stale.length > 0) {
      process.stderr.write(
        `watch: ${stale.join(' and ')} ${stale.length === 1 ? 'is' : 'are'} stale — run `
        + '`node scripts/gen-managed-runtime.mjs`\n')
      process.exit(1)
    }
    process.stdout.write(
      `managed-runtime: current — ${String(dependencies.length)} exact dependencies, `
      + `${String(counts['required-peer'])} required peer(s)\n`)
    return
  }

  writeFileSync(OUT, json, 'utf8')
  writeFileSync(MODULE, source, 'utf8')
  process.stdout.write(
    `managed-runtime: ${String(dependencies.length)} exact dependencies `
    + `(${String(counts['required-peer'])} required peers), `
    + `${String(installed.size)} packages installed, `
    + `${String(document.licences.length)} distinct licence(s)\n  ${document.digest}\n`)
}

try {
  main()
} catch (error) {
  if (error instanceof Refusal) {
    process.stderr.write(`watch: ${error.message}\n`)
    process.exit(1)
  }
  throw error
}
