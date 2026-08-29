#!/usr/bin/env node
/**
 * Check that every Watch browser half is the artifact DeepSeek Harness serves.
 *
 * A client bundle is not an ordinary JavaScript file. It is fetched as a
 * classic script outside the shell's module graph, and the loader executes it
 * expecting exactly one top-level effect: a factory registration. Get the
 * shape wrong and nothing errors at build time — the page simply boots with
 * the plugin silently absent, or throws deep inside materialization with a
 * stack that points at the loader rather than at the mistake.
 *
 * So the artifact is checked here, against the contract read off
 * `@deepseek-ai/dsh-client-modules`:
 *
 * 1. the bundle registers through `window.__ModuleLoader__.load`;
 * 2. its `id` is the package name, matching the boot-graph row DSH composes
 *    from the package's `dsh.client` declaration;
 * 3. the factory is CJS and returns `module.exports`;
 * 4. every surviving `require()` is either a shell baseline module or one of
 *    the package's own `dsh.client.external` requests — anything else is a
 *    guaranteed runtime throw the moment that module is materialized.
 *
 * Usage: node scripts/verify-client-bundles.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages', 'watch')

/**
 * Specifiers the shell seeds into the module table for every bundle.
 * Mirrored from `@deepseek-ai/dsh-client-web`'s platform list; the upstream
 * lock pins the version this was read from.
 */
const BASELINE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

/** Every workspace package that declares a browser half. */
function clientPackages() {
  const found = []
  for (const entry of readdirSync(PACKAGES)) {
    const manifestPath = join(PACKAGES, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.dsh?.client === undefined) continue
    found.push({ dir: join(PACKAGES, entry), manifest })
  }
  return found
}

function main() {
  const problems = []
  const packages = clientPackages()

  for (const { dir, manifest } of packages) {
    const name = manifest.name
    const where = (message) => problems.push(`${name}: ${message}`)

    if (manifest.dsh.client.platform !== 'web') {
      where(`dsh.client.platform is ${JSON.stringify(manifest.dsh.client.platform)}, expected "web"`)
    }
    const clientExport = manifest.exports?.['./client']
    if (clientExport === undefined) {
      where('declares dsh.client but exports no "./client" subpath, so DSH cannot resolve its bundle')
      continue
    }

    const bundlePath = join(dir, 'lib', 'client.js')
    if (!existsSync(bundlePath)) {
      where('lib/client.js is missing — run `npm run build` before this gate')
      continue
    }
    const bundle = readFileSync(bundlePath, 'utf8')

    if (!bundle.startsWith('window.__ModuleLoader__.load(')) {
      where('does not register through window.__ModuleLoader__.load, so the shell never sees it')
    }
    if (!bundle.includes(`id: ${JSON.stringify(name)}`)) {
      where(`the registration id does not match the package name, so its boot-graph row never resolves`)
    }
    if (!bundle.includes('var module = { exports: {} }')) {
      where('has no CJS module scope, so the factory cannot return exports')
    }
    if (!bundle.includes('return module.exports;')) {
      where('does not return module.exports, so materializing it yields nothing')
    }

    const requested = new Set([
      ...BASELINE,
      ...(manifest.dsh.client.external ?? []),
    ])
    const found = new Set()
    const pattern = /require\(\s*["']([^"']+)["']\s*\)/g
    let match
    while ((match = pattern.exec(bundle)) !== null) found.add(match[1])
    for (const specifier of found) {
      if (requested.has(specifier)) continue
      where(
        `requires ${JSON.stringify(specifier)}, which the module table cannot answer. `
        + 'Declare it in dsh.client.external if a package row provides it, or let it inline.',
      )
    }

    // A declared external that the bundle never requires is a stale
    // declaration: harmless at runtime, but it makes the manifest lie about
    // what this plugin depends on, which is what a reviewer reads.
    for (const declared of manifest.dsh.client.external ?? []) {
      if (!found.has(declared)) {
        where(`declares ${JSON.stringify(declared)} as an external but never requires it`)
      }
    }
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`watch: ${problem}\n`)
    process.stderr.write(`\nwatch: ${problems.length} client bundle problem(s)\n`)
    process.exit(1)
  }

  if (packages.length === 0) {
    process.stdout.write('client bundles: none declared\n')
    return
  }
  process.stdout.write(
    `client bundles: ${packages.length} verified against the DSH loader contract\n`
    + packages.map(({ manifest }) => `  ${manifest.name}\n`).join(''),
  )
}

main()
