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

/**
 * The `.js` a workspace tool's shim would have run.
 *
 * Not the shim. `node_modules/.bin/tsc` is `tsc.cmd` on Windows, Node will not
 * spawn a batch file without a shell, and asking for one made every build
 * print a deprecation warning about arguments being concatenated rather than
 * escaped -- which is exactly the hazard, and exactly the shape of the defect
 * this repository already shipped once at a different boundary.
 *
 * So the bin *entry* is resolved instead, out of the manifest of whichever
 * installed package declares it, and run with the Node already running us.
 * Same program, same arguments, no interpreter in between, and one code path
 * on every platform.
 */
function tool(name) {
  const modules = join(ROOT, 'node_modules')
  const packages = []
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(join(modules, entry))) packages.push(`${entry}/${scoped}`)
      continue
    }
    packages.push(entry)
  }
  // The package named after the bin first, which is the usual case and saves
  // reading four hundred manifests to find `tsc` inside `typescript`.
  for (const pkg of [name, ...packages]) {
    const manifestPath = join(modules, pkg, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const declared = typeof manifest.bin === 'string'
      ? (manifest.name === name ? manifest.bin : undefined)
      : manifest.bin?.[name]
    if (typeof declared !== 'string') continue
    const entry = join(modules, pkg, declared)
    if (existsSync(entry)) return entry
  }
  process.stderr.write(`watch: ${name} is not installed. Run \`pnpm install\` first.\n`)
  process.exit(1)
}

/** Run one build step, failing the whole build if it fails. */
function step(label, command, args, cwd = ROOT) {
  process.stdout.write(`\n${label}\n`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    // Never a shell. Every command here is an executable and an argument
    // array, which is what makes a path containing a space one argument
    // rather than two.
    shell: false,
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
 * had `client-evidence` resolve `@deepwatch/dsh-workspace/client` before
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

/**
 * Five stages, in the only order an empty tree admits.
 *
 * The staging is not a preference. Typert derives the wire protocol from the
 * Host program by reading the *emitted* declarations of the packages the Host
 * imports, and it emits a Remote declaration that the client half of the
 * composition then imports. Those two facts describe a cycle that only an
 * ordering can break, and the ordering has to put the Host graph first.
 *
 * Compiling the whole solution up front does not work, and the way it fails is
 * worth recording, because for a while it did not fail at all: on a machine
 * that had built once, `packages/watch/tools/lib/typert.remote-client.d.ts` was
 * already on disk, ignored by git and invisible to `git status`, and the full
 * `tsc -b` resolved it happily. A cold clone had no such file, so the first
 * compilation stopped at `TS2307: Cannot find module
 * '@deepwatch/dsh-tools/remote'` — a build that passed for everyone who had
 * built before and failed for everyone who had not.
 *
 * So stage 1 builds the Host-face aggregate, which is the graph Typert reads
 * and nothing more, stage 2 generates, and only then does stage 3 compile the
 * complete solution including the client that imports what stage 2 wrote.
 */
function main() {
  // 1. The Host graph, through the aggregate that defines the Host face.
  //    `tsconfig.json` would pull in the client that cannot compile yet.
  step('building the host face', process.execPath, [tool('tsc'), '-b', 'tsconfig.host.json'])

  // 2. The protocol, from the Host types stage 1 emitted.
  step('generating typert artifacts', process.execPath, [join(ROOT, 'scripts', 'gen-typert.mjs')])

  // 3. Everything, now that the generated Remote declaration exists.
  step('building node halves', process.execPath, [tool('tsc'), '-b'])

  // 4. The browser bundles, in dependency order.
  for (const { dir, name } of clientPackages()) {
    step(`bundling ${name}`, process.execPath, [tool('tsdown')], dir)
  }

  // 5. The freshness gate, against the tree the build just produced. Stage 2
  //    generated from pre-solution declarations; if the completed solution
  //    would generate anything different, that difference is a defect and this
  //    is where it surfaces rather than in a reviewer's `git status`.
  step('checking generated artifacts', process.execPath,
    [join(ROOT, 'scripts', 'gen-typert.mjs'), '--check'])

  process.stdout.write('\nbuild complete\n')
}

main()
