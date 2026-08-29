/**
 * Find the pinned DeepSeek Harness CLI, and install it if it is not there.
 *
 * The smoke tests need a real `dsh` binary: they build a profile from its own
 * shipped template, install the bundle with the real `dsh plugin add`, and ask
 * DSH to compose the tree. Nothing in this workspace depends on that package,
 * so `pnpm install` does not bring it in.
 *
 * What used to fill the gap was an instruction in the failure message telling
 * the reader to `mkdir ../watch-smoke` and npm install into it. That made a
 * documented gate depend on an undocumented directory beside the checkout,
 * created by hand, at a version nobody re-checked -- and CI, which has no such
 * sibling, simply never ran those gates.
 *
 * The harness provisions its own copy instead, beside the other manual-QA
 * material, so nothing is written into the repository at all. The version
 * comes from
 * `upstream/deepseek-harness.lock`, which is the same statement of the pinned
 * baseline every other gate reads, so the CLI cannot drift from what parity
 * was measured against.
 *
 * @module scripts/lib/dsh-cli
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { manualRoot } from './manual-paths.mjs'

/** The DSH version `upstream/deepseek-harness.lock` pins. */
export function pinnedVersion(root) {
  const lock = readFileSync(join(root, 'upstream', 'deepseek-harness.lock'), 'utf8')
  const version = /^version:\s*(.+)$/m.exec(lock)?.[1]?.trim()
  if (version === undefined || version === '') {
    throw new Error('upstream/deepseek-harness.lock names no version')
  }
  return version
}

/**
 * The exact pnpm the workspace pins, validated before it is interpolated.
 *
 * The same spec the bootstrap runs, so the CLI these gates measure against is
 * fetched by the resolver that built everything else.
 */
export function pinnedPackageManager(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const spec = manifest.packageManager
  if (typeof spec !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/.test(spec)) {
    throw new Error(`package.json packageManager must pin an exact pnpm, got ${String(spec)}`)
  }
  return spec
}

/**
 * Where the harness keeps the copy it installed itself.
 *
 * Beside the rest of the manual-QA material rather than inside the
 * repository's `node_modules`: npm will not treat a directory nested under a
 * `node_modules` as a project root, so installing there produced a manifest
 * and no packages, silently. Outside the tree it is also not something a
 * `pnpm install` can remove halfway through a smoke run.
 */
export function cacheDir() {
  return join(manualRoot(), 'dsh-cli')
}

/**
 * Locate a `dsh` entry point, in preference order.
 *
 * `WATCH_DSH_CLI` first, so a maintainer can point the gates at a local build.
 * The hand-made `../watch-smoke` sibling is still consulted last: it stopped
 * being required, and breaking it for anyone who already has one would be
 * gratuitous.
 */
export function findCli(root, env = process.env) {
  const candidates = [
    env.WATCH_DSH_CLI,
    join(root, 'node_modules', '@deepseek-ai', 'dsh'),
    join(cacheDir(), 'node_modules', '@deepseek-ai', 'dsh'),
    join(root, '..', 'watch-smoke', 'node_modules', '@deepseek-ai', 'dsh'),
    join(root, '..', '..', 'watch-smoke', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(entry => typeof entry === 'string' && entry !== '')

  for (const dir of candidates) {
    if (!existsSync(join(dir, 'package.json'))) continue
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (bin === undefined) continue
    const entry = resolve(dir, bin)
    if (existsSync(entry)) return { entry, version: manifest.version, dir }
  }
  return null
}

/**
 * Return the pinned CLI, installing it into the cache if it is absent.
 *
 * Returns null rather than throwing when the install fails, so a caller
 * offline can still say which gate it skipped and why. Set
 * `WATCH_DSH_CLI_OFFLINE=1` to refuse the install outright.
 */
export function ensureCli(root, env = process.env) {
  const found = findCli(root, env)
  const wanted = pinnedVersion(root)
  if (found !== null && found.version === wanted) return found
  if (env.WATCH_DSH_CLI_OFFLINE === '1') return found

  const dir = cacheDir()
  mkdirSync(dir, { recursive: true })
  // A manifest of its own, so the installer treats this as a project
  // rather than walking up and installing into the workspace.
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'watch-dsh-cli', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  )
  process.stdout.write(`watch: installing @deepseek-ai/dsh@${wanted} for the smoke gates\n`)
  const result = spawnSync(
    // pnpm, through the same pinned Corepack spec the bootstrap uses. Not a
    // preference: npm spent thirty minutes resolving this tree and wrote
    // nothing, where pnpm's content-addressed store finished in under two.
    `corepack ${pinnedPackageManager(root)} add @deepseek-ai/dsh@${wanted}`,
    { cwd: dir,
      stdio: 'inherit',
      shell: true,
      env: {
        ...env,
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        // A flat node_modules, which is not a preference here but a
        // requirement of DSH's own profile design. A profile resolves bare
        // plugin names through `$DSH_HOME/profiles/node_modules`, a directory
        // DSH heals on every launch with one junction per package in the
        // installation's `node_modules/<scope>/<name>`. pnpm's default
        // isolated layout puts one entry there and the other four hundred in
        // `.pnpm`, so healing finds almost nothing to link and the profile
        // boots into ERR_MODULE_NOT_FOUND. npm produces the same flat shape
        // and is what getting-started documents; it took thirty minutes to
        // resolve this graph where pnpm takes eleven seconds.
        npm_config_node_linker: 'hoisted',
      } },
  )
  if (result.status !== 0) return findCli(root, env)
  return findCli(root, env)
}
