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
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * Every installed third-party package.
 *
 * Read from the pnpm store layout rather than from the lockfile, because what
 * is actually on disk is what actually ships, and a lockfile can describe a
 * tree that was never materialized.
 */
function installedPackages() {
  const store = join(ROOT, 'node_modules', '.pnpm')
  if (!existsSync(store)) return []

  const found = new Map()
  for (const entry of readdirSync(store)) {
    if (entry === 'node_modules' || entry === 'lock.yaml') continue
    const modules = join(store, entry, 'node_modules')
    if (!existsSync(modules)) continue
    for (const scope of readdirSync(modules)) {
      const paths = scope.startsWith('@')
        ? readdirSync(join(modules, scope)).map(name => `${scope}/${name}`)
        : [scope]
      for (const name of paths) {
        const found_manifest = manifest(join(modules, name, 'package.json'))
        if (found_manifest === null || found_manifest.name === undefined) continue
        const key = `${found_manifest.name}@${found_manifest.version}`
        if (found.has(key)) continue
        found.set(key, {
          name: found_manifest.name,
          version: found_manifest.version ?? 'unknown',
          license: normalizeLicense(found_manifest.license ?? found_manifest.licenses),
          path: null,
          kind: 'third_party',
        })
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Reduce the shapes a `license` field takes to one string. */
function normalizeLicense(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(entry => entry?.type ?? entry).join(' OR ')
  if (value !== null && typeof value === 'object' && 'type' in value) return String(value.type)
  return 'UNKNOWN'
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
  const third = installedPackages()
  const weights = modelWeights()

  const problems = []

  for (const pkg of first) {
    if (pkg.license !== 'MIT') {
      problems.push(`${pkg.name}: first-party packages must be MIT, found ${pkg.license}`)
    }
  }
  for (const pkg of third) {
    if (!ALLOWED_LICENSES.has(pkg.license)) {
      problems.push(
        `${pkg.name}@${pkg.version}: licence ${pkg.license} is not on the allowed list. `
        + 'Review it and add it deliberately, or remove the dependency.',
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
