#!/usr/bin/env node
/**
 * Install the packed tarballs into a project that has never seen this
 * repository, and use what comes out.
 *
 * Everything else in this workspace is measured from inside it, where a
 * `workspace:` link, a `tsconfig` path alias or a stale `node_modules` can
 * make a broken package look whole. This is the one check taken from outside:
 * a clean directory, the twenty tarballs, and nothing else.
 *
 * What it proves, in the order the failures actually happen:
 *
 * 1. the first-party closure **resolves** — twenty packages that reference
 *    each other by version, with no `workspace:` range left to resolve and no
 *    dependency npm cannot find;
 * 2. every `exports` subpath **is really there**, and the generated Typert
 *    Remote declarations along with it, which is the entry that has silently
 *    gone missing before;
 * 3. every Node-importable entry **imports**, and the browser bundles satisfy
 *    the loader contract they are fetched under;
 * 4. the **CLI runs** — version, help and doctor — from an installed package
 *    rather than from source;
 * 5. nothing **resolves back into this workspace**. A path that escapes the
 *    clean room means the install proved nothing at all.
 *
 * This is not a test of `npx @deepwatch/cli`. Nothing here is published, so
 * what it exercises is the packed artifact that a publish would upload —
 * equivalent in content, and honestly a different thing from a registry
 * install.
 *
 * Usage:
 *   node scripts/verify-packed-install.mjs
 *   node scripts/verify-packed-install.mjs --keep
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS = join(ROOT, '.release-artifacts')

/**
 * Peers a Node import needs, kept off the machine otherwise.
 *
 * Not `@deepseek-ai/dsh`: that is the four-hundred-package Harness, it is an
 * *optional* peer, and pulling it in here would turn a two-minute check into a
 * ten-minute one to prove something `tests/harness-provisioning.test.mjs`
 * already proves without the network.
 */
const PEERS = [
  'react@^18.2.0',
  'zod@^4.5.2',
  '@deepseek-ai/cordis@4.0.1',
  '@deepseek-ai/schemastery@^3.18.1',
]

/**
 * The one browser artifact that has a contract worth checking.
 *
 * `lib/client.js` is the rolldown bundle the shell fetches, and it must
 * register a factory and do nothing else at script level. Everything under
 * `lib/client/` is ordinary React source that the bundle inlines — a browser
 * module, so Node cannot import it, and not a bundle, so it registers nothing.
 */
const BUNDLE = './lib/client.js'
const BROWSER_SOURCE = './lib/client/'

function run(command, args, options = {}) {
  const shell = process.platform === 'win32' && !command.endsWith('.exe')
  const ran = shell
    ? spawnSync(`${command} ${args.map(a => `"${a}"`).join(' ')}`, [],
      { encoding: 'utf8', shell: true, ...options })
    : spawnSync(command, args, { encoding: 'utf8', ...options })
  return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
}

/** Every file an `exports` map points at, however deeply it nests. */
function exportTargets(map) {
  const out = []
  const walk = (key, value) => {
    if (typeof value === 'string') { out.push([key, value]); return }
    if (value === null || typeof value !== 'object') return
    for (const nested of Object.values(value)) walk(key, nested)
  }
  for (const [key, value] of Object.entries(map)) walk(key, value)
  return out
}

async function main() {
  const problems = []
  const say = (where, detail) => problems.push(`${where}: ${detail}`)

  if (!existsSync(ARTIFACTS)) {
    say('artifacts', 'no .release-artifacts — run scripts/pack-release.mjs first')
    return { problems, checked: 0 }
  }
  const tarballs = readdirSync(ARTIFACTS).filter(name => name.endsWith('.tgz'))
    .map(name => join(ARTIFACTS, name))
  if (tarballs.length !== 20) say('artifacts', `${tarballs.length} tarballs, expected 20`)

  const room = mkdtempSync(join(tmpdir(), 'deepwatch-install-'))
  const keep = process.argv.includes('--keep')
  try {
    writeFileSync(join(room, 'package.json'), `${JSON.stringify({
      name: 'deepwatch-clean-room',
      version: '0.0.0',
      private: true,
      type: 'module',
    }, null, 2)}\n`)
    // No `.npmrc` is written, and none is inherited from this repository: the
    // point is a project that knows nothing but the public registry.
    writeFileSync(join(room, '.npmrc'), 'audit=false\nfund=false\n')

    process.stdout.write(`  installing 20 tarballs into ${room}\n`)
    const installed = run('npm', ['install', '--legacy-peer-deps', ...tarballs, ...PEERS],
      { cwd: room, timeout: 900_000 })
    if (installed.code !== 0) {
      say('install', installed.stderr.split('\n').filter(Boolean).slice(-4).join(' / '))
      return { problems, checked: 0 }
    }

    const scope = join(room, 'node_modules', '@deepwatch')
    const installedNames = existsSync(scope) ? readdirSync(scope) : []
    if (installedNames.length !== 20) {
      say('resolve', `${installedNames.length} @deepwatch packages installed, expected 20`)
    }

    // Peers are declared across the closure rather than per package: a module
    // reached through `@deepwatch/dsh-wiki` can fail on a peer of
    // `@deepwatch/dsh-memory`, and that is the host's dependency to provide.
    const declaredPeers = new Set()
    for (const name of installedNames) {
      const manifest = JSON.parse(readFileSync(join(scope, name, 'package.json'), 'utf8'))
      for (const peer of Object.keys(manifest.peerDependencies ?? {})) declaredPeers.add(peer)
    }

    // 1. The closure resolves, by npm's own reckoning rather than ours.
    const listed = run('npm', ['ls', '--all', '--json'], { cwd: room, timeout: 300_000 })
    const tree = JSON.parse(listed.stdout || '{}')
    const walkTree = node => {
      for (const [name, child] of Object.entries(node.dependencies ?? {})) {
        // A peer nobody installed is a peer, not a hole in the closure. A
        // *dependency* that is missing is the failure this looks for.
        if (child.missing === true && !declaredPeers.has(name)) {
          say('resolve', `${name} is missing from the closure`)
        }
        if (child.invalid !== undefined && child.invalid !== false) {
          say('resolve', `${name} does not satisfy the range that asked for it`)
        }
        walkTree(child)
      }
    }
    walkTree(tree)

    // 2 and 5. Everything promised is present, and nothing points home.
    let checked = 0
    for (const name of installedNames) {
      const dir = join(scope, name)
      if (lstatSync(dir).isSymbolicLink()) {
        say(`@deepwatch/${name}`, 'is a link, so this install proves nothing')
        continue
      }
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      for (const [subpath, target] of exportTargets(manifest.exports ?? {})) {
        const file = resolve(dir, target)
        if (!existsSync(file)) {
          say(manifest.name, `${subpath} points at ${target}, which is not installed`)
          continue
        }
        if (!realpathSync(file).startsWith(realpathSync(room))) {
          say(manifest.name, `${subpath} resolves back outside the clean room`)
        }
        checked += 1
      }
      for (const [, target] of Object.entries(manifest.bin ?? {})) {
        if (!existsSync(resolve(dir, target))) say(manifest.name, `bin ${target} is not installed`)
      }
    }

    // The generated Remote declarations, named rather than assumed: they are
    // build output, and build output is what goes missing from a tarball.
    const remotes = join(scope, 'dsh-client-remotes')
    for (const wanted of ['lib/index.d.ts', 'lib/index.js']) {
      if (!existsSync(join(remotes, wanted))) {
        say('@deepwatch/dsh-client-remotes', `${wanted} is missing from the installed package`)
      }
    }
    const remoteDeclarations = existsSync(join(remotes, 'lib'))
      ? readdirSync(join(remotes, 'lib')).filter(name => name.endsWith('.d.ts'))
      : []
    if (remoteDeclarations.length === 0) {
      say('@deepwatch/dsh-client-remotes', 'ships no generated Typert declarations')
    }

    // 3. Node entries import; browser bundles satisfy the loader contract.
    for (const name of installedNames) {
      const dir = join(scope, name)
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      for (const [subpath, target] of exportTargets(manifest.exports ?? {})) {
        if (subpath === './package.json' || !target.endsWith('.js')) continue
        const file = resolve(dir, target)
        if (!existsSync(file)) continue
        if (target === BUNDLE) {
          const source = readFileSync(file, 'utf8')
          if (!source.includes('window.__ModuleLoader__.load(')) {
            say(manifest.name, `${subpath} is a client bundle that registers no factory`)
          }
          continue
        }
        if (target.startsWith(BROWSER_SOURCE)) continue
        try {
          const loaded = await import(pathToFileURL(file).href)
          if (typeof loaded !== 'object') say(manifest.name, `${subpath} imported to nothing`)
        } catch (error) {
          // A peer that was deliberately not installed is not a broken
          // package. Anything else is.
          const missing = /Cannot find package '([^']+)'/.exec(error.message)?.[1]
          if (missing !== undefined && declaredPeers.has(missing)) continue
          say(manifest.name, `${subpath} does not import: ${error.message.split('\n')[0]}`)
        }
      }
    }

    // 4. The CLI runs, from the installed package.
    const cli = join(scope, 'cli', 'lib', 'bin.js')
    const version = run('node', [cli, '--version'], { cwd: room, timeout: 120_000 })
    const expected = JSON.parse(readFileSync(join(scope, 'cli', 'package.json'), 'utf8')).version
    if (version.stdout.trim() !== expected) {
      say('cli', `--version said ${version.stdout.trim()}, package says ${expected}`)
    }
    const help = run('node', [cli, '--help'], { cwd: room, timeout: 120_000 })
    if (help.code !== 0 || !help.stdout.includes('deepwatch setup')) {
      say('cli', '--help did not print usage')
    }
    const doctor = run('node', [cli, 'doctor', '--json'],
      { cwd: room, timeout: 300_000, env: { ...process.env, DEEPWATCH_HOME: join(room, 'home') } })
    try {
      const report = JSON.parse(doctor.stdout)
      if (!Array.isArray(report.findings) || report.findings.length === 0) {
        say('cli', 'doctor --json reported no findings')
      }
    } catch {
      say('cli', 'doctor --json did not print JSON')
    }

    return { problems, checked, room }
  } finally {
    if (!keep) rmSync(room, { recursive: true, force: true, maxRetries: 5 })
  }
}

const report = await main()
if (report.problems.length > 0) {
  for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
  process.stderr.write(`\npacked-install: ${report.problems.length} problem(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `\npacked-install: 20 packages installed from tarballs, ${report.checked} export `
    + 'targets present, CLI ran\n')
}
