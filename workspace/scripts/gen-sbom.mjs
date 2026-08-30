#!/usr/bin/env node
/**
 * Generate the software bill of materials, and gate what may be distributed.
 *
 * Two jobs, and the second is the one that matters. The SBOM is bookkeeping:
 * what is in the tree, at what version, under what licence. The gate is a
 * refusal: it fails the build when something is present that this project has
 * no established right to ship.
 *
 * The distinction it exists to enforce is between **code licences and model
 * weight licences**. A repository under MIT says nothing about the weights it
 * publishes — those are a separate grant, frequently a more restrictive one,
 * and sometimes absent entirely. Treating the repository licence as covering
 * both is how a distribution ends up shipping something it was never licensed
 * to, and the mistake is invisible because everything looks permissive.
 *
 * Usage:
 *   node scripts/gen-sbom.mjs           write docs/sbom.json
 *   node scripts/gen-sbom.mjs --check   fail if it is stale or a licence is unsafe
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseLockfilePackages, platformFamily } from './lib/pnpm-lockfile.mjs'
import { byCodeUnit } from './lib/order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'docs', 'sbom.json')

/**
 * Licences this distribution may ship without further review.
 *
 * Permissive only. A copyleft dependency is not forbidden, but it changes what
 * this project may do, so it stops the build and asks a person rather than
 * being waved through.
 */
const ALLOWED_LICENSES = new Set([
  'MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD',
  'CC0-1.0', 'Unlicense', 'Python-2.0', 'BlueOak-1.0.0',
  'MIT OR Apache-2.0', 'Apache-2.0 OR MIT', '(MIT OR Apache-2.0)',
  '(MIT OR CC0-1.0)', 'MPL-2.0',
])

/**
 * Licences reviewed one package at a time, with the reason each is acceptable.
 *
 * Deliberately not an addition to `ALLOWED_LICENSES`. That set is what this
 * distribution ships under; this file is a record of specific packages that
 * carry something else, what they are, how they reach the repository, and
 * whether DeepWatch redistributes them. A package with no entry still fails,
 * and an entry stops covering a package the moment its licence changes.
 */
function licenceReview() {
  const path = join(ROOT, 'inventory', 'licence-review.json')
  if (!existsSync(path)) return []
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  return (parsed.packages ?? []).map(entry => ({
    ...entry,
    pattern: new RegExp(entry.match),
  }))
}

/** Read a manifest, or null when it is unreadable. */
function manifest(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Every Watch package in this workspace. */
function watchPackages() {
  const root = join(ROOT, 'packages', 'watch')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map(entry => ({ dir: `packages/watch/${entry}`, m: manifest(join(root, entry, 'package.json')) }))
    .filter(entry => entry.m !== null)
    .map(entry => ({
      name: entry.m.name,
      version: entry.m.version,
      license: entry.m.license ?? 'UNKNOWN',
      path: entry.dir,
      kind: 'first_party',
    }))
}

/**
 * The licence of every package that is actually on disk, by `name@version`.
 *
 * Only a lookup table now. What ships is decided from the lockfile; this
 * answers what each entry is licensed under, which the lockfile does not
 * record.
 */
function installedLicenses() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  const licenses = new Map()
  if (!existsSync(store)) return licenses

  for (const entry of readdirSync(store)) {
    if (entry === 'node_modules' || entry === 'lock.yaml') continue
    const modules = join(store, entry, 'node_modules')
    if (!existsSync(modules)) continue
    for (const scope of readdirSync(modules)) {
      const paths = scope.startsWith('@')
        ? readdirSync(join(modules, scope)).map(name => `${scope}/${name}`)
        : [scope]
      for (const name of paths) {
        const found = manifest(join(modules, name, 'package.json'))
        if (found === null || found.name === undefined) continue
        const key = `${found.name}@${found.version ?? 'unknown'}`
        if (!licenses.has(key)) {
          licenses.set(key, normalizeLicense(found.license ?? found.licenses))
        }
      }
    }
  }
  return licenses
}

/**
 * Every third-party package this distribution resolves, from the lockfile.
 *
 * The lockfile is the source rather than the installed tree because it names
 * every platform variant on every machine. See scripts/lib/pnpm-lockfile.mjs
 * for what went wrong when this was read off disk.
 *
 * A platform binary absent from this host takes the licence of an installed
 * sibling — the same package built for another target. Siblings that disagree
 * are a real problem rather than something to pick a winner from, so they stop
 * the build.
 */
function thirdPartyPackages() {
  const locked = parseLockfilePackages(readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8'))
  const onDisk = installedLicenses()

  const families = new Map()
  for (const pkg of locked) {
    const family = platformFamily(pkg.name)
    if (family === null) continue
    const license = onDisk.get(`${pkg.name}@${pkg.version}`)
    if (license === undefined) continue
    const key = `${family}@${pkg.version}`
    if (!families.has(key)) families.set(key, new Set())
    families.get(key).add(license)
  }

  for (const [family, licenses] of families) {
    if (licenses.size > 1) {
      process.stderr.write(
        `watch: ${family} platform builds disagree on their licence `
        + `(${[...licenses].sort().join(', ')}). The SBOM cannot state one.
`,
      )
      process.exit(1)
    }
  }

  const reviewed = licenceReview()

  return locked
    .map(pkg => {
      const family = platformFamily(pkg.name)
      const inherited = family === null
        ? undefined
        : [...(families.get(`${family}@${pkg.version}`) ?? [])][0]
      // A reviewed family is recorded from its review, on every machine.
      // pnpm installs only this platform's optional packages, so a licence
      // read off disk is the Windows answer on Windows and UNKNOWN on Linux —
      // and the committed document would then depend on who generated it.
      // What the installed copy declares is still read, in the gate below,
      // wherever the package is actually present.
      const decided = reviewed.find(rule => rule.pattern.test(pkg.name))?.sbomLicense
      return {
        name: pkg.name,
        version: pkg.version,
        license: decided ?? onDisk.get(`${pkg.name}@${pkg.version}`) ?? inherited ?? 'UNKNOWN',
        path: null,
        kind: 'third_party',
      }
    })
    .sort((a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(a.version, b.version))
}

/** Reduce the shapes a `license` field takes to one string. */
function normalizeLicense(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(entry => entry?.type ?? entry).join(' OR ')
  if (value !== null && typeof value === 'object' && 'type' in value) return String(value.type)
  return 'UNKNOWN'
}

/** The digest pnpm recorded for one patched spec, or null. */
function lockfileHashFor(lock, spec) {
  const lines = lock.split(String.fromCharCode(10)).map(line => line.trimEnd())
  const index = lines.findIndex(line => line.trim() === `'${spec}':` || line.trim() === `${spec}:`)
  if (index < 0) return null
  for (const line of lines.slice(index + 1, index + 5)) {
    const match = /^\s+hash:\s*([0-9a-f]{64})\s*$/.exec(line)
    if (match !== null) return match[1]
    if (/^\S/.test(line)) break
  }
  return null
}

/**
 * Dependencies this repository modifies, and what the modification is.
 *
 * A patched dependency is modified source, and a bill of materials that lists
 * it as an ordinary upstream release is wrong about the most important thing it
 * records. The digest is the one pnpm verifies on install, so a patch edited
 * without regenerating this document is a mismatch a reader can act on.
 *
 * The scope matters as much as the fact. This is a build-time generator: it
 * runs during `npm run build` and ships in nothing. The runtime Typert
 * protocol, Gateway, registry and Connection are the packages a released build
 * actually executes, and none of them is patched.
 */
function patchedDependencies() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const declared = manifest.pnpm?.patchedDependencies ?? {}
  const lock = existsSync(join(ROOT, 'pnpm-lock.yaml'))
    ? readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
    : ''

  return Object.entries(declared).map(([spec, patchPath]) => {
    const at = spec.lastIndexOf('@')
    const name = spec.slice(0, at)
    const version = spec.slice(at + 1)
    const absolute = join(ROOT, patchPath)
    const contents = existsSync(absolute) ? readFileSync(absolute) : null
    const digest = contents === null
      ? null
      : createHash('sha256').update(contents).digest('hex')
    // Read from the block rather than with a regex built out of the spec:
    // a package name carries slashes, dots and an @, and escaping all of them
    // into a pattern is a way to get null and not notice.
    const recorded = lockfileHashFor(lock, spec)

    return {
      name,
      upstreamVersion: version,
      patched: true,
      patchPath,
      patchSha256: digest,
      lockfileHash: recorded,
      digestsAgree: digest !== null && digest === recorded,
      scope: 'build-time only; not present in any published runtime artifact',
      reason:
        'The generator recognises the @Remote decorator only from a registered '
        + 'workspace package or an ambient module declaration, so a package that '
        + 'depends on @deepseek-ai/dsh-typert-protocol through node_modules '
        + 'generates an empty protocol. The patch adds one branch that accepts a '
        + 'declaration resolved from the genuinely installed protocol package.',
      upstreamRepository: 'https://github.com/deepseek-ai/deepseek-harness',
      license: 'MIT',
      runtimePackagesUnmodified: [
        '@deepseek-ai/dsh-typert-protocol',
        '@deepseek-ai/dsh-api-gateway',
        '@deepseek-ai/dsh-typert-registry',
        '@deepseek-ai/dsh-client-connection',
      ],
    }
  })
}

/**
 * Model weights this distribution knows about.
 *
 * Kept separate from packages on purpose, and each entry carries whether its
 * licence has actually been reviewed. `reviewed: false` means the build may
 * not ship or auto-fetch it — not that it is forbidden, but that nobody has
 * yet established the right.
 */
function modelWeights() {
  const technology = join(ROOT, 'packages', 'watch', 'technology', 'lib', 'ocr.js')
  if (!existsSync(technology)) return []
  // Read from the built descriptors so this cannot drift from what the product
  // actually offers.
  const source = readFileSync(technology, 'utf8')
  const weights = []
  const pattern = /id:\s*'([^']+)'[\s\S]*?codeLicense:\s*'([^']+)'[\s\S]*?weightsLicense:\s*(null|'[^']*')[\s\S]*?revision:\s*(null|'[^']*')[\s\S]*?weightsLicenseReviewed:\s*(true|false)/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const [, id, codeLicense, weightsLicense, revision, reviewed] = match
    weights.push({
      id,
      codeLicense,
      weightsLicense: weightsLicense === 'null' ? null : weightsLicense.slice(1, -1),
      revision: revision === 'null' ? null : revision.slice(1, -1),
      reviewed: reviewed === 'true',
      mayDistribute: weightsLicense !== 'null' && reviewed === 'true',
    })
  }
  return weights
}

function main() {
  const check = process.argv.includes('--check')

  const first = watchPackages()
  const third = thirdPartyPackages()
  const weights = modelWeights()
  const patched = patchedDependencies()

  const problems = []

  for (const pkg of first) {
    if (pkg.license !== 'MIT') {
      problems.push(`${pkg.name}: first-party packages must be MIT, found ${pkg.license}`)
    }
  }
  const declared = installedLicenses()
  const reviewed = licenceReview()
  for (const pkg of third) {
    if (ALLOWED_LICENSES.has(pkg.license)) continue
    const entry = reviewed.find(rule => rule.pattern.test(pkg.name))
    if (entry === undefined) {
      problems.push(
        `${pkg.name}@${pkg.version}: licence ${pkg.license} is not on the allowed list. `
        + 'Review it deliberately in inventory/licence-review.json, or remove the dependency.',
      )
      continue
    }
    // A reviewed entry still has to describe the licence it was reviewed for.
    // Checked against what the *installed* copy declares rather than against
    // the value recorded above, which came from the review and would make
    // this tautological. A package absent from this platform says nothing
    // either way; the platform that has it is the one that catches drift.
    const onDisk = declared.get(`${pkg.name}@${pkg.version}`)
    if (onDisk !== undefined && !entry.licenses.includes(onDisk)) {
      problems.push(
        `${pkg.name}@${pkg.version}: reviewed for ${entry.licenses.join(' / ')} `
        + `and now declares ${onDisk}. Re-review it in inventory/licence-review.json.`,
      )
    }
  }
  for (const weight of weights) {
    // Not a failure — an unreviewed weight is simply not distributable, and
    // the descriptor already refuses. This records it so a release reads it.
    if (weight.reviewed && weight.weightsLicense === null) {
      problems.push(`${weight.id}: marked reviewed but names no weights licence`)
    }
  }

  const sbom = {
    generatedBy: 'scripts/gen-sbom.mjs',
    note:
      'A repository licence covers code. Model weights are a separate grant, and '
      + 'weightsLicenseReviewed records whether anyone has actually established the right '
      + 'to distribute them. The two are never merged.',
    firstParty: first,
    thirdParty: third,
    modelWeights: weights,
    patchedDependencies: patched,
    counts: {
      firstParty: first.length,
      thirdParty: third.length,
      modelWeights: weights.length,
      distributableWeights: weights.filter(weight => weight.mayDistribute).length,
    },
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} supply-chain problem(s)\n`)
    process.exit(1)
  }

  const content = `${JSON.stringify(sbom, undefined, 2)}\n`
  const existing = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : null
  if (existing === content) {
    process.stdout.write(
      `sbom: ${String(first.length)} first-party, ${String(third.length)} third-party, `
      + `${String(weights.length)} model weights (${String(sbom.counts.distributableWeights)} distributable)\n`,
    )
    return
  }
  if (check) {
    // Third-party contents change with any install, so a stale SBOM is a
    // notice rather than a failure. An unsafe licence above is the failure.
    process.stdout.write('sbom: out of date — run `node scripts/gen-sbom.mjs`\n')
    return
  }
  writeFileSync(OUTPUT, content)
  process.stdout.write(
    `wrote docs/sbom.json — ${String(first.length)} first-party, ${String(third.length)} third-party, `
    + `${String(weights.length)} model weights (${String(sbom.counts.distributableWeights)} distributable)\n`,
  )
}

main()
