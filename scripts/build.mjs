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

/** Packages that declare a browser half and therefore need a bundle. */
function clientPackages() {
  const root = join(ROOT, 'packages', 'watch')
  const found = []
  for (const entry of readdirSync(root)) {
    const manifestPath = join(root, entry, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.dsh?.client === undefined) continue
    found.push({ dir: join(root, entry), name: manifest.name })
  }
  return found
}

function main() {
  // The Node halves first: a browser bundle imports the contracts package's
  // emitted types, so building them in the other order fails on a cold tree.
  step('building node halves', tool('tsc'), ['-b'])

  for (const { dir, name } of clientPackages()) {
    step(`bundling ${name}`, tool('tsdown'), [], dir)
  }

  process.stdout.write('\nbuild complete\n')
}

main()
