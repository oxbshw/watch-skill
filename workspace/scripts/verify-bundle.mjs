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
import { fileURLToPath, pathToFileURL } from 'node:url'

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
      current = { id: id[1].replace(/^["']|["']$/g, ''), module: null, disabled: false, reconfigures: false }
      continue
    }
    if (!current) continue
    const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (name) current.module = name[1].replace(/^["']|["']$/g, '')
    // A row that only switches an existing one off. It names no module and
    // targets a baseline id on purpose, so the two checks below skip it —
    // and a third one, that it hits something real, applies instead.
    if (/^\s*disabled:\s*true\s*$/.test(line)) current.disabled = true
    // A row that only reconfigures an existing one. Like a disable row it
    // names no module and targets a baseline id on purpose; unlike one, it
    // leaves the row mounted and replaces its config wholesale.
    if (/^\s*config:\s*$/.test(line)) current.reconfigures = true
  }
  if (current) rows.push(current)
  return rows
}

/**
 * Baseline rows this distribution deliberately reconfigures, and why.
 *
 * A patch row that targets a baseline id replaces that row's whole config.
 * Almost always that is an accident — the id was meant to be new and collided
 * — and the check below is what catches it. Occasionally it is the point: the
 * Loader offers no other way to change a composed default, and changing one
 * through the mechanism upstream provides is the opposite of a fork.
 *
 * So the rule is not "never collide" but "collide only on purpose, in
 * writing". An id here is a decision somebody made and can be asked about; an
 * id not here is a bug. A stale entry is a problem too — see the check for a
 * declaration that matches no baseline row — because a reconfiguration that
 * lands on nothing silently restores the upstream default it was written to
 * remove.
 */
const INTENTIONAL_RECONFIGURATIONS = new Map([
  ['agent-default-model', 'empties the inherited DeepSeek default so a fresh profile names no route'],
])

/**
 * Whether a row is a reconfiguration this distribution has declared.
 *
 * All three conditions matter. The id must be declared, so the change is one
 * somebody wrote down. The row must actually carry a `config:`, so a bare id
 * cannot borrow the declaration and disable or re-point something else. And it
 * must name no module, because naming one is how a row stops being a
 * reconfiguration and starts being a replacement — which is a fork by another
 * spelling, and not what this allowance is for.
 */
function declaredReconfiguration(row) {
  return INTENTIONAL_RECONFIGURATIONS.has(row.id) && row.reconfigures && row.module === null
}

/**
 * The workspace package a row's module belongs to, and the export it names.
 *
 * A row may name a subpath — `@deepwatch/dsh-technology/routing` — because the
 * package root is not always the plugin. Splitting the two is what lets the
 * checks below ask the right question of each half: does the *package* exist
 * and is it depended on, and does the *module* actually export an `apply`.
 */
function moduleTarget(name) {
  if (!name.startsWith('@')) return { pkg: name, subpath: '.' }
  const parts = name.split('/')
  const pkg = parts.slice(0, 2).join('/')
  const rest = parts.slice(2).join('/')
  return { pkg, subpath: rest === '' ? '.' : `./${rest}` }
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
    if (row.disabled) {
      // A disable row must land on something. `disabled: true` against an id no
      // baseline carries is accepted by the Loader and does nothing at all —
      // the same silent-no-op shape as registering into a slot that is never
      // rendered, and just as invisible without a check for it.
      if (!baseline.has(row.id)) {
        problems.push(
          `${label}: row "${row.id}" is disabled but matches no DSH baseline row, `
          + 'so it switches nothing off',
        )
      }
      continue
    }
    if (baseline.has(row.id)) {
      if (declaredReconfiguration(row)) continue
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
    if (row.disabled || declaredReconfiguration(row)) continue
    if (row.module === null) {
      problems.push(`${label}: row "${row.id}" names no module, so the Loader has nothing to import`)
      continue
    }
    const { pkg } = moduleTarget(row.module)
    if (pkg.startsWith('@deepwatch/') && !packages.has(pkg)) {
      problems.push(`${label}: row "${row.id}" names ${row.module}, which is not a package in this workspace`)
    }
    if (pkg.startsWith('@deepwatch/') && !dependencies.has(pkg)) {
      problems.push(
        `${label}: row "${row.id}" mounts ${row.module}, but the bundle does not depend on ${pkg} — `
        + 'the profile install would resolve the layer and then fail to import the module',
      )
    }
  }

  return { problems, rows }
}


/**
 * Whether the module a row names actually exports an `apply`.
 *
 * The Loader refuses a row whose module exports none with "invalid plugin" and
 * takes the whole plugin tree down with it — so a profile composes, dumps its
 * config cleanly, and then serves nothing. That failure reads as a composition
 * problem and is three minutes of provisioning away from being seen, which is
 * exactly the shape of thing this gate exists to catch statically.
 *
 * It is a real import of the built module rather than a scan for the word,
 * because the mistake that produced this check was a package whose *root*
 * re-exported everything except the plugin, while a subpath had it.
 *
 * @param specifier - the module a row names.
 * @returns null when it exports `apply`, or a sentence saying what it exports.
 */
async function missingApply(specifier) {
  const { pkg, subpath } = moduleTarget(specifier)
  if (!pkg.startsWith('@deepwatch/')) return null
  const dir = readdirSync(join(ROOT, 'packages', 'watch')).find((entry) => {
    const manifest = join(ROOT, 'packages', 'watch', entry, 'package.json')
    return existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === pkg
  })
  if (dir === undefined) return null
  const manifest = JSON.parse(readFileSync(join(ROOT, 'packages', 'watch', dir, 'package.json'), 'utf8'))
  const target = manifest.exports?.[subpath]
  const file = typeof target === 'string' ? target : target?.default
  if (typeof file !== 'string') return `${specifier} is not an export this package declares`
  const built = join(ROOT, 'packages', 'watch', dir, file)
  if (!existsSync(built)) return `${specifier} resolves to ${file}, which has not been built`
  const loaded = await import(pathToFileURL(built).href)
  // Both shapes the Loader accepts: a functional plugin exporting `apply`, and
  // a Service class exported as default. Checking only the first reported two
  // rows that have always worked, which is how a gate gets switched off.
  if (typeof loaded.apply === 'function') return null
  if (typeof loaded.default === 'function') return null
  const exported = Object.keys(loaded).join(', ')
  return `${specifier} exports neither an \`apply\` nor a default plugin `
    + `(it exports ${exported === '' ? 'nothing' : exported}), so the Loader refuses it `
    + 'as an invalid plugin and the whole plugin tree fails with it'
}

async function main() {
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
    if (row.disabled) {
      // See the note in checkPatch: a disable row targets a baseline id by
      // design, and the failure worth catching is the opposite one — a disable
      // that matches nothing and therefore switches nothing off.
      if (!baseline.has(row.id)) {
        problems.push(`row "${row.id}" is disabled but matches no DSH baseline row, so it switches nothing off`)
      }
      continue
    }
    if (baseline.has(row.id)) {
      if (declaredReconfiguration(row)) continue
      problems.push(
        `row id "${row.id}" collides with a DSH baseline row — an overlay would replace that row's `
        + 'config instead of inserting a new one, silently changing upstream behavior',
      )
    }
  }

  // The other direction. A declaration that lands on nothing is worse than an
  // undeclared collision: the row it was written to change is gone, so the
  // upstream default it removed is quietly back, and the gate that was
  // supposed to notice is the thing saying nothing.
  for (const [id, why] of INTENTIONAL_RECONFIGURATIONS) {
    if (!baseline.has(id)) {
      problems.push(
        `"${id}" is declared as an intentional reconfiguration (${why}), but no DSH baseline row `
        + 'carries that id, so the patch changes nothing and the upstream default stands',
      )
      continue
    }
    if (!rows.some(row => row.id === id && row.reconfigures)) {
      problems.push(
        `"${id}" is declared as an intentional reconfiguration (${why}), and the bundle patch `
        + 'does not reconfigure it',
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
    if (row.disabled || declaredReconfiguration(row)) continue
    if (row.module === null) {
      problems.push(`row "${row.id}" names no module, so the Loader has nothing to import`)
      continue
    }
    const { pkg } = moduleTarget(row.module)
    if (pkg.startsWith('@deepwatch/') && !packages.has(pkg)) {
      problems.push(`row "${row.id}" names ${row.module}, which is not a package in this workspace`)
    }
  }

  // A row the bundle mounts must also be a dependency, or the profile install
  // resolves the layer and then fails to import the module it names.
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}))
  // Every row's module is imported and asked for its `apply`. This is the
  // check that would have caught `@deepwatch/dsh-technology` being named where
  // `@deepwatch/dsh-technology/routing` was meant.
  for (const row of rows) {
    if (row.disabled || row.module === null) continue
    const missing = await missingApply(row.module)
    if (missing !== null) problems.push(`row "${row.id}": ${missing}`)
  }

  for (const row of rows) {
    if (row.module === null) continue
    const { pkg } = moduleTarget(row.module)
    if (pkg.startsWith('@deepwatch/') && !dependencies.has(pkg)) {
      problems.push(
        `row "${row.id}" mounts ${row.module}, but the bundle does not depend on ${pkg} — `
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

  // Reported by kind rather than as one count: "13 additive rows" beside a
  // list containing two rows that add nothing is the sort of summary a reader
  // stops trusting, and this output is the evidence that the distribution
  // touches upstream exactly where it says it does.
  const kindOf = (row) => row.disabled
    ? 'disables'
    : declaredReconfiguration(row) ? 'reconfigures' : 'adds'
  const added = rows.filter(row => kindOf(row) === 'adds')
  const touched = rows.filter(row => kindOf(row) !== 'adds')

  process.stdout.write(
    `bundle: ${added.length} additive row(s), ${touched.length} declared change(s) to ${baseline.size} DSH baseline rows\n`
    + rows.map(row => `  ${kindOf(row).padEnd(12)} ${row.id.padEnd(21)} ${row.module ?? ''}\n`).join('')
    + `bundle variants:\n`
    + variantSummaries.map(line => `${line}\n`).join(''),
  )
}

await main()
