#!/usr/bin/env node
/**
 * The Typert Host face, and the mappings that let it resolve.
 *
 * Typert generates Host descriptors from a TypeScript program. That program is
 * defined by `tsconfig.host.json`, and two things about it have to stay true or
 * the generated protocol quietly describes something other than the Host.
 *
 * **The face has to be the Host.** The root solution config references every
 * package, including the React ones and the Desktop app. Copying that list into
 * the generation aggregate — which is what a first pass at this did — puts UI
 * components and a React dependency edge inside the program the Host protocol
 * is derived from. Membership is decided by project references and the file
 * inventory they produce, not by the `paths` facade: a path entry teaches the
 * compiler how to resolve a subpath, and admits nothing on its own.
 *
 * **The mappings have to agree with the packages.** Watch compiles with
 * `nodenext` and no `paths`, so a cross-package type resolves into
 * `node_modules` and the analyzer cannot correlate the file back to a declared
 * export. The aggregate therefore maps package subpaths to source — and the
 * mapping must be derived from each package's own `exports`, not written by
 * hand. A wildcard (`pkg/*` -> `src/*`) looks equivalent and is not: it cannot
 * be correlated to a declared subpath, and the failure is a TypeError inside
 * TypeScript's `getSymbolLinks` rather than anything naming the cause. That is
 * the regression this gate exists to convert into a sentence.
 *
 * `--write` regenerates the `paths` block from the referenced packages' own
 * exports. The reference list stays hand-written, because face membership is a
 * decision; the mappings are derived, because a hand-maintained inventory of
 * seventeen subpaths drifts the first time somebody adds an export — which is
 * exactly how `./query/validate` went missing.
 *
 * Usage:
 *   node scripts/verify-typert-face.mjs
 *   node scripts/verify-typert-face.mjs --write
 *   node scripts/verify-typert-face.mjs --json
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const AGGREGATE = 'tsconfig.host.json'
const JSON_OUT = process.argv.includes('--json')
const WRITE = process.argv.includes('--write')

/** Packages that may never enter the Host face, by the edge they would bring. */
const CLIENT_EDGES = ['react', 'react-dom', 'electron', '@deepseek-ai/dsh-client-']

const problems = []
const notes = []
const fail = (message, fix) => { problems.push({ message, fix }) }

/** The TypeScript the generator itself uses, so the gate sees what it sees. */
function generatorTypeScript() {
  const outer = createRequire(join(ROOT, 'package.json'))
  const generator = outer.resolve('@deepseek-ai/dsh-typert-generator')
  return { ts: createRequire(generator)('typescript'), generator }
}

const slash = value => value.replaceAll('\\', '/')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

/**
 * Every export a package declares, paired with the source it should map to.
 *
 * `./lib/x.d.ts` becomes `src/x.ts` or `src/x.tsx`. Generated Typert entries
 * are skipped deliberately: they are build output and must not be redirected
 * to source, or the gate would be asserting that generated files exist before
 * they are generated.
 */
function declaredExports(packageDir) {
  const manifest = readJson(join(packageDir, 'package.json'))
  const found = []
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    if (subpath === './package.json') continue
    const target = typeof entry === 'string' ? entry : entry?.types ?? entry?.default
    if (typeof target !== 'string') continue
    if (target.includes('typert')) { found.push({ subpath, generated: true }); continue }
    const stem = target.replace(/^\.\/lib\//, 'src/').replace(/\.d\.ts$/, '')
    const source = ['.ts', '.tsx']
      .map(extension => join(packageDir, `${stem}${extension}`))
      .find(candidate => existsSync(candidate))
    found.push({
      subpath,
      generated: false,
      key: subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`,
      source: source === undefined ? null : `./${slash(relative(ROOT, source))}`,
      expected: `${stem}.(ts|tsx)`,
    })
  }
  return { name: manifest.name, manifest, exports: found }
}

function main() {
  const aggregatePath = join(ROOT, AGGREGATE)
  if (!existsSync(aggregatePath)) {
    fail(`${AGGREGATE} does not exist`,
      'Generation has no Host face without it; run the aggregate generator.')
    return report({})
  }

  const { ts, generator } = generatorTypeScript()
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  const parsed = ts.getParsedCommandLineOfConfigFile(aggregatePath, {}, host)
  if (parsed === undefined) {
    fail(`${AGGREGATE} could not be parsed`, 'Fix the JSON before anything else.')
    return report({})
  }

  const references = (parsed.projectReferences ?? []).map(reference => slash(reference.path))
  const paths = parsed.options.paths ?? {}

  // ── face membership ──────────────────────────────────────────────────────
  let programFiles = 0
  const uiFiles = []
  const packageDirs = []

  for (const reference of parsed.projectReferences ?? []) {
    const configPath = reference.path.endsWith('.json')
      ? reference.path
      : join(reference.path, 'tsconfig.json')
    if (!existsSync(configPath)) {
      fail(`referenced project ${slash(reference.path)} has no config`,
        'A reference that does not resolve makes the face silently smaller.')
      continue
    }
    const project = ts.getParsedCommandLineOfConfigFile(configPath, {}, host)
    const packageDir = configPath.endsWith('tsconfig.json')
      ? dirname(configPath)
      : dirname(configPath)
    packageDirs.push(packageDir)

    for (const file of project?.fileNames ?? []) {
      programFiles += 1
      if (file.endsWith('.tsx')) uiFiles.push(slash(relative(ROOT, file)))
    }

    // A package in the Host face may not carry a client runtime edge.
    //
    // Unless it is referenced through its own tsconfig.host.json. A dual-face
    // package has one manifest for both halves, so its React dependency belongs
    // to the client half and says nothing about the face referenced here. What
    // governs then is the file inventory, which is checked above and must
    // contain no UI. Referencing such a package through its plain tsconfig.json
    // is the actual mistake, and still fails.
    const declaresHostFace = configPath.endsWith('tsconfig.host.json')
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = readJson(manifestPath)
    const declared = Object.keys({
      ...manifest.dependencies, ...manifest.peerDependencies,
    })
    for (const edge of declared) {
      if (!CLIENT_EDGES.some(banned => edge === banned || edge.startsWith(banned))) continue
      if (declaresHostFace) {
        notes.push(`${manifest.name}: ${edge} is a client-half edge, host face referenced explicitly`)
        continue
      }
      fail(`${manifest.name} is in the Host face and depends on ${edge}`,
        'Give the package a tsconfig.host.json that excludes its client face, '
        + 'and reference that instead.')
    }
  }

  for (const file of uiFiles) {
    fail(`the Host program contains ${file}`,
      'The Host protocol must not be derived from a program containing UI.')
  }

  if (WRITE) {
    const derived = {}
    for (const packageDir of packageDirs) {
      if (!existsSync(join(packageDir, 'package.json'))) continue
      for (const entry of declaredExports(packageDir).exports) {
        if (entry.generated || entry.source === null) continue
        derived[entry.key] = [entry.source]
      }
    }
    const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'))
    aggregate.compilerOptions.paths = Object.fromEntries(
      Object.keys(derived).sort().map(key => [key, derived[key]]))
    writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}
`, 'utf8')
    process.stdout.write(`rewrote ${AGGREGATE} with `
      + `${String(Object.keys(derived).length)} mappings; run without --write to validate.` + String.fromCharCode(10))
    process.exit(0)
  }

  // ── mappings agree with declared exports ─────────────────────────────────
  let checked = 0
  for (const packageDir of packageDirs) {
    const manifestPath = join(packageDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const { name, exports } = declaredExports(packageDir)

    for (const entry of exports) {
      if (entry.generated) {
        const key = entry.subpath === '.' ? name : `${name}${entry.subpath.slice(1)}`
        if (paths[key] !== undefined) {
          fail(`${key} is generated output and is mapped to source`,
            'Generated ./typert and ./remote entries resolve to lib output, never src.')
        }
        continue
      }
      checked += 1
      if (entry.source === null) {
        fail(`${name} declares ${entry.subpath} and no source matches ${entry.expected}`,
          'A declared export with no source makes the analyzer fail inside TypeScript.')
        continue
      }
      const mapped = paths[entry.key]
      if (mapped === undefined) {
        fail(`${entry.key} is exported and unmapped`,
          `Map it to ${entry.source}; an unmapped subpath resolves into node_modules.`)
        continue
      }
      if (mapped.length !== 1 || slash(mapped[0]) !== entry.source) {
        fail(`${entry.key} maps to ${JSON.stringify(mapped)}, expected ["${entry.source}"]`,
          'The mapping must name the source its own package.json export points at.')
      }
    }
  }

  // ── no wildcard may stand in for a declared subpath ──────────────────────
  for (const key of Object.keys(paths)) {
    if (!key.includes('*')) continue
    fail(`${key} is a wildcard mapping`,
      'A wildcard cannot be correlated to a declared export subpath, and the '
      + 'failure surfaces as a TypeError inside TypeScript rather than a message. '
      + 'Map each declared subpath explicitly.')
  }

  // ── no DSH dependency may be redirected to a local substitute ────────────
  for (const [key, targets] of Object.entries(paths)) {
    if (!key.startsWith('@deepseek-ai/')) continue
    fail(`${key} is redirected to ${JSON.stringify(targets)}`,
      'An installed DSH package must resolve to the installed package. A local '
      + 'substitute would let generation validate a protocol the Host never runs.')
  }

  // ── DOM belongs to generation only ───────────────────────────────────────
  const libs = (parsed.options.lib ?? []).map(entry => slash(entry).toLowerCase())
  if (!libs.some(entry => entry.includes('dom'))) {
    fail('the Host aggregate does not include the DOM library',
      'AbortSignal must resolve from a standard library file or cancellation '
      + 'metadata is not recorded.')
  }
  const base = readJson(join(ROOT, 'tsconfig.base.json'))
  const baseLibs = (base.compilerOptions?.lib ?? []).map(entry => String(entry).toLowerCase())
  if (baseLibs.some(entry => entry.includes('dom'))) {
    fail('tsconfig.base.json includes the DOM library',
      'DOM is for the generation aggregate only; the Host runtime project must '
      + 'stay on its Node-oriented configuration.')
  }
  notes.push(`base lib: ${JSON.stringify(base.compilerOptions?.lib ?? [])}`)

  return report({
    typescript: ts.version,
    generator: slash(relative(ROOT, generator)),
    references,
    programFiles,
    uiFiles: uiFiles.length,
    mappings: Object.keys(paths).length,
    exportsChecked: checked,
  })
}

function report(summary) {
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ok: problems.length === 0, summary, problems }, null, 2)}\n`)
  } else {
    process.stdout.write('typert host face\n\n')
    for (const [key, value] of Object.entries(summary)) {
      process.stdout.write(`  ${key.padEnd(16)} ${Array.isArray(value) ? value.length : String(value)}\n`)
    }
    for (const note of notes) process.stdout.write(`  ${note}\n`)
    if (Array.isArray(summary.references)) {
      process.stdout.write('\n  references\n')
      for (const reference of summary.references) {
        process.stdout.write(`    ${slash(relative(ROOT, reference))}\n`)
      }
    }
    process.stdout.write('\n')
    for (const problem of problems) {
      process.stdout.write(` FAIL  ${problem.message}\n        ${problem.fix}\n`)
    }
    process.stdout.write(problems.length === 0
      ? 'The Host face is closed and every declared export is mapped to its own source.\n'
      : `\n${String(problems.length)} problem(s).\n`)
  }
  process.exit(problems.length === 0 ? 0 : 1)
}

main()
