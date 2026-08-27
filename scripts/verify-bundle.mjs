#!/usr/bin/env node
/**
 * Check that the Watch profile bundle can be applied to stock DeepSeek Harness
 * without disturbing it.
 *
 * A Cordis patch overlay targets rows by id. An `- insert:` row whose id
 * collides with an existing baseline row does not add anything — it silently
 * *replaces* that row's whole config, which is how a distribution accidentally
 * disables an upstream capability while believing it added one. Nothing in the
 * loader warns about it, so this gate does.
 *
 * It also checks the reverse direction of the same promise: every module the
 * bundle names must be a package that actually exists here, so a published
 * bundle cannot reference something that was renamed or never shipped.
 *
 * Usage: node scripts/verify-bundle.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'packages', 'watch', 'bundle')

/**
 * Read the rows out of a Cordis patch overlay.
 *
 * The format allows `!!js` expression tags, which a general YAML parser would
 * need a custom schema for and which this gate must never evaluate. Row ids
 * and module names are plain scalars on their own lines, so a line scanner
 * reads exactly what is needed and nothing that could execute.
 */
function readPatchRows(file) {
  const rows = []
  let current = null
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trimStart().startsWith('#')) continue
    const id = /^\s*-?\s*id:\s*(.+?)\s*$/.exec(line)
    if (id) {
      if (current) rows.push(current)
      current = { id: id[1].replace(/^["']|["']$/g, ''), module: null }
      continue
    }
    if (!current) continue
    const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (name) current.module = name[1].replace(/^["']|["']$/g, '')
  }
  if (current) rows.push(current)
  return rows
}

/** Every workspace package name, for resolving what the bundle references. */
function workspacePackages() {
  const names = new Set()
  const root = join(ROOT, 'packages', 'watch')
  for (const entry of readdirSync(root)) {
    const manifest = join(root, entry, 'package.json')
    if (!existsSync(manifest)) continue
    names.add(JSON.parse(readFileSync(manifest, 'utf8')).name)
  }
  return names
}

/**
 * Check one patch overlay against the same rules as the full bundle.
 *
 * A narrow bundle is where a stale row survives longest, because nobody
 * installs it as often. So the gate treats "Watch Memory" exactly as seriously
 * as "Watch Full".
 */
function checkPatch(label, patchFile, manifest, baseline, packages) {
  const problems = []
  const rows = readPatchRows(patchFile)
  if (rows.length === 0) {
    problems.push(`${label}: the patch declares no rows`)
    return { problems, rows }
  }

  for (const row of rows) {
    if (baseline.has(row.id)) {
      problems.push(
        `${label}: row id "${row.id}" collides with a DSH baseline row — an overlay would replace `
        + "that row's config instead of inserting a new one, silently changing upstream behavior",
      )
    }
  }

  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`${label}: duplicate row id ${row.id}`)
    seen.add(row.id)
  }

  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  for (const row of rows) {
    if (row.module === null) {
      problems.push(`${label}: row "${row.id}" names no module, so the Loader has nothing to import`)
      continue
    }
    if (row.module.startsWith("@watchskill/") && !packages.has(row.module)) {
      problems.push(`${label}: row "${row.id}" names ${row.module}, which is not a package in this workspace`)
    }
    if (row.module.startsWith("@watchskill/") && !dependencies.has(row.module)) {
      problems.push(
        `${label}: row "${row.id}" mounts ${row.module}, but the bundle does not depend on it — `
        + "the profile install would resolve the layer and then fail to import the module",
      )
    }
  }

  return { problems, rows }
}


function main() {
  const problems = []

  const manifest = JSON.parse(readFileSync(join(BUNDLE, 'package.json'), 'utf8'))
  const declared = manifest.dsh?.bundle?.patch
  if (declared === undefined) {
    problems.push('the bundle manifest declares no dsh.bundle.patch, so `dsh plugin add` would install it as a plain dependency')
  }

  const patchFile = join(BUNDLE, declared ?? 'cordis.patch.yml')
  if (!existsSync(patchFile)) {
    process.stderr.write(`watch: bundle patch ${patchFile} does not exist\n`)
    process.exit(1)
  }
  if (!(manifest.files ?? []).some(entry => entry.endsWith('cordis.patch.yml'))) {
    problems.push('cordis.patch.yml is not in the manifest `files` list, so the published tarball would not contain it')
  }

  const rows = readPatchRows(patchFile)
  if (rows.length === 0) problems.push('the bundle patch declares no rows')

  // The collision check. Baseline row ids come from the generated inventory,
  // so this tracks upstream automatically instead of a hand-kept list.
  const composition = JSON.parse(readFileSync(join(ROOT, 'inventory', 'composition.json'), 'utf8'))
  const baseline = new Set(
    composition.rows
      .filter(row => row.source.startsWith('packages/bundle/'))
      .map(row => row.id),
  )
  for (const row of rows) {
    if (baseline.has(row.id)) {
      problems.push(
        `row id "${row.id}" collides with a DSH baseline row — an overlay would replace that row's `
        + 'config instead of inserting a new one, silently changing upstream behavior',
      )
    }
  }

  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.id)) problems.push(`duplicate row id in the bundle patch: ${row.id}`)
    seen.add(row.id)
  }

  const packages = workspacePackages()
  for (const row of rows) {
    if (row.module === null) {
      problems.push(`row "${row.id}" names no module, so the Loader has nothing to import`)
      continue
    }
    if (row.module.startsWith('@watchskill/') && !packages.has(row.module)) {
      problems.push(`row "${row.id}" names ${row.module}, which is not a package in this workspace`)
    }
  }

  // A row the bundle mounts must also be a dependency, or the profile install
  // resolves the layer and then fails to import the module it names.
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  for (const row of rows) {
    if (row.module?.startsWith('@watchskill/') && !dependencies.has(row.module)) {
      problems.push(
        `row "${row.id}" mounts ${row.module}, but the bundle does not depend on it — `
        + 'the profile install would resolve the layer and then fail to import the module',
      )
    }
  }

  // ── the narrow bundles ────────────────────────────────────────────────────
  // Watch ships as five installable shapes, and a deployment that needs only
  // one should not have to accept the others. Each is checked here, so "Watch
  // Memory" cannot quietly reference a package that was renamed.
  const variants = manifest.dsh?.bundle?.variants ?? {}
  const variantSummaries = []
  for (const [name, relative] of Object.entries(variants)) {
    const file = join(BUNDLE, relative)
    if (!existsSync(file)) {
      problems.push(`variant "${name}" names ${relative}, which does not exist`)
      continue
    }
    const checked = checkPatch(`variant ${name}`, file, manifest, baseline, packages)
    problems.push(...checked.problems)
    variantSummaries.push(`  ${name.padEnd(10)} ${String(checked.rows.length)} row(s)`)
  }
  if (variantSummaries.length === 0) {
    problems.push("the bundle declares no variants; Watch ships as five installable shapes")
  }


  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} bundle problem(s)\n`)
    process.exit(1)
  }

  process.stdout.write(
    `bundle: ${rows.length} additive row(s), no collision with ${baseline.size} DSH baseline rows\n`
    + rows.map(row => `  ${row.id.padEnd(20)} ${row.module}\n`).join('')
    + `bundle variants:\n`
    + variantSummaries.map(line => `${line}\n`).join(''),
  )
}

main()
