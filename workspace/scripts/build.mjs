#!/usr/bin/env node
/**
 * Build every Watch package: the Node halves, then the browser bundles.
 *
 * Both steps run their tool from `node_modules` directly rather than through a
 * package-manager script. A build that depends on which package manager
 * happens to be on `PATH` fails differently on a contributor's machine, in CI,
 * and inside the install smoke test — and each of those failures looks like a
 * problem with the code rather than with the invocation.
 *
 * Usage: node scripts/build.mjs
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(ROOT, 'node_modules', '.bin')

/** Resolve a workspace tool, preferring the platform's shim. */
function tool(name) {
  const shim = process.platform === 'win32' ? `${name}.cmd` : name
  const path = join(BIN, shim)
  if (!existsSync(path)) {
    process.stderr.write(`watch: ${name} is not installed. Run \`pnpm install\` first.\n`)
    process.exit(1)
  }
  return path
}

/** Run one build step, failing the whole build if it fails. */
function step(label, command, args, cwd = ROOT) {
  process.stdout.write(`\n${label}\n`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    // A `.cmd` shim needs a shell on Windows; the paths here contain no
    // spaces we did not create, and every argument is ours.
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.stderr.write(`\nwatch: ${label} failed\n`)
    process.exit(result.status ?? 1)
  }
}

/**
 * Packages that declare a browser half, in dependency order.
 *
 * The order is not cosmetic. A client bundle that imports another package's
 * client entry reads that package's *built* bundle, so building alphabetically
 * had `client-evidence` resolve `@watchskill/dsh-workspace/client` before
 * `workspace` had been bundled — MISSING_EXPORT for a symbol that was plainly
 * in the source. It only stayed hidden while no client package imported
 * another.
 *
 * A topological walk over the first-party dependencies fixes it for every
 * future pairing rather than for this one.
 */
function clientPackages() {
  const root = join(ROOT, 'packages', 'watch')
  const byName = new Map()
  for (const entry of readdirSync(root)) {
    const manifestPath = join(root, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.dsh?.client === undefined) continue
    byName.set(manifest.name, {
      dir: join(root, entry),
      name: manifest.name,
      needs: Object.keys(manifest.dependencies ?? {}),
    })
  }

  const ordered = []
  const done = new Set()
  const visiting = new Set()
  const visit = name => {
    const entry = byName.get(name)
    if (entry === undefined || done.has(name)) return
    if (visiting.has(name)) {
      process.stderr.write(`watch: client bundle dependency cycle at ${name}
`)
      process.exit(1)
    }
    visiting.add(name)
    for (const dependency of entry.needs) visit(dependency)
    visiting.delete(name)
    done.add(name)
    ordered.push(entry)
  }
  for (const name of byName.keys()) visit(name)
  return ordered
}

function main() {
  // The Node halves first: a browser bundle imports the contracts package's
  // emitted types, so building them in the other order fails on a cold tree.
  step('building node halves', tool('tsc'), ['-b'])

  // Between the two compilations, and not beside either. Typert derives the
  // wire protocol from the Host program, so it needs the Host types to exist;
  // the client bundles import the generated Remote declaration, so they need
  // its output to exist. Generating after the bundles would ship a client
  // built against the previous protocol.
  step('generating typert artifacts', process.execPath, [join(ROOT, 'scripts', 'gen-typert.mjs')])

  for (const { dir, name } of clientPackages()) {
    step(`bundling ${name}`, tool('tsdown'), [], dir)
  }

  process.stdout.write('\nbuild complete\n')
}

main()
