#!/usr/bin/env node
/**
 * Prove that the Watch bundle installs into **stock** DeepSeek Harness.
 *
 * This is Phase 1's exit criterion, and it is the claim most worth testing
 * mechanically: everything else in the repository is written on the assumption
 * that Watch needs no fork and no upstream patch. If that assumption is wrong,
 * it should fail here rather than in someone's install.
 *
 * The run is hermetic. It packs the workspace packages, installs them into a
 * throwaway `$DSH_HOME` with the real `dsh plugin` command, and then asks DSH
 * itself to compose the profile and print the tree. Nothing is asserted about
 * Watch that DSH did not actually produce.
 *
 * Usage:
 *   node scripts/install-smoke.mjs            run against ./ .dsh-home
 *   node scripts/install-smoke.mjs --keep     leave the profile for inspection
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = join(ROOT, '.dsh-home')
const PACKED = join(HOME, 'packed')
/**
 * The profile a real user installs into.
 *
 * `web` rather than an invented name on purpose: DSH auto-initializes it from
 * the shipped template (dsh-base + dsh-web-app), which is the layer stack the
 * bundle actually has to coexist with. A profile with no template gets
 * dsh-base alone, and passing against that would prove nothing about the
 * client rows Watch sits beside. `$DSH_HOME` is a throwaway directory, so this
 * cannot touch anyone's real profile.
 */
const PROFILE = 'web'

/** Packages that must be installed together: the bundle plus what it mounts. */
const PACKAGES = [
  'packages/watch/contracts',
  'packages/watch/core-bridge',
  'packages/watch/tools',
  'packages/watch/client-evidence',
  'packages/watch/memory',
  'packages/watch/trajectory',
  'packages/watch/bundle',
]

/** Rows the composed profile must contain for the bundle to have worked. */
const EXPECTED_ROWS = ['watch-core-bridge', 'watch-tools', 'watch-client-evidence', 'watch-memory']

/**
 * Remove a directory, tolerating a Windows handle that has not closed yet.
 *
 * A package manager that just exited can still hold the tree for a moment, and
 * a hermetic run that dies on EBUSY is not hermetic — it is flaky.
 */
function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      return
    } catch (cause) {
      if (attempt === 9) {
        fail(
          `could not clear ${target}: ${String(cause)}`,
          'A process is still holding it. Close any shell open in that directory and re-run.',
        )
      }
    }
  }
}

/** Fail with a message the reader can act on rather than a stack trace. */
function fail(message, detail) {
  process.stderr.write(`\nwatch: ${message}\n`)
  if (detail) process.stderr.write(`${detail.trim()}\n`)
  process.exit(1)
}

/** Locate the `dsh` CLI entry, whichever tree it was installed into. */
function findCli() {
  const candidates = [
    join(ROOT, 'node_modules', '@deepseek-ai', 'dsh'),
    join(ROOT, '..', 'watch-smoke', 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'package.json'))) continue
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
    if (bin === undefined) continue
    const entry = resolve(dir, bin)
    if (existsSync(entry)) return { entry, version: manifest.version }
  }
  return null
}

/**
 * Run a command, returning its output and never throwing on a non-zero exit.
 *
 * `shell` is opt-in per call rather than "on for Windows". Windows needs a
 * shell to resolve a `.cmd` shim such as pnpm, but running an absolute path
 * through cmd.exe re-splits it on spaces — and `process.execPath` is normally
 * under `C:\Program Files`.
 */
function run(command, args, options = {}) {
  const { shell = false, ...rest } = options
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell,
    ...rest,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** Pack one workspace package into the throwaway directory. */
function pack(relativeDir) {
  // `pnpm pack` resolves the `workspace:` protocol to a real version range,
  // which is what makes the tarballs installable outside this workspace.
  const result = run('pnpm', ['pack', '--pack-destination', PACKED], {
    shell: process.platform === 'win32',
    cwd: join(ROOT, relativeDir),
  })
  if (result.status !== 0) fail(`could not pack ${relativeDir}`, result.stderr || result.stdout)
  const tarball = result.stdout.trim().split(/\r?\n/).at(-1)
  if (!tarball || !existsSync(tarball)) {
    fail(`pnpm pack did not report a tarball for ${relativeDir}`, result.stdout)
  }
  return tarball
}

/**
 * Point the profile's package manager at the packed tarballs.
 *
 * The bundle depends on `@watchskill/dsh-core-bridge` and
 * `@watchskill/dsh-tools` by version range, which is correct: once published,
 * that is exactly how a user's `dsh plugin add @watchskill/dsh-bundle`
 * resolves them. Passing sibling tarballs on the command line does not satisfy
 * a registry range, so this run needs overrides to close the loop locally.
 *
 * This is the one accommodation the smoke test makes for being local, and it
 * is deliberately narrow: it redirects resolution, and changes nothing about
 * the layer stack, the patch, or the composition — which is what is under
 * test.
 */
function linkLocalTarballs(tarballs) {
  const manifestPath = join(HOME, 'profiles', PROFILE, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const overrides = {}
  for (const tarball of tarballs) {
    const name = basename(tarball).replace(/-\d.*$/, '').replace(/^watchskill-/, '@watchskill/')
    overrides[name] = `file:${tarball.split('\\').join('/')}`
  }
  manifest.pnpm = { ...manifest.pnpm, overrides }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

function main() {
  const keep = process.argv.includes('--keep')

  const cli = findCli()
  if (cli === null) {
    fail(
      'the DeepSeek Harness CLI is not installed, so the install path cannot be proven.',
      'Install it next to this repository and re-run:\n'
      + '  mkdir ../watch-smoke && cd ../watch-smoke\n'
      + '  npm install @deepseek-ai/dsh@0.1.1-rc.2',
    )
  }

  const lock = readFileSync(join(ROOT, 'upstream', 'deepseek-harness.lock'), 'utf8')
  const pinned = /^version:\s*(.+)$/m.exec(lock)?.[1]?.trim()
  if (pinned !== cli.version) {
    fail(
      `the installed CLI is ${cli.version}, but the lock pins ${pinned}.`,
      'The smoke test must run against the pinned baseline or it proves nothing.',
    )
  }

  process.stdout.write(`dsh ${cli.version} at ${cli.entry}\n`)

  removeTree(HOME)
  mkdirSync(PACKED, { recursive: true })

  process.stdout.write('packing workspace packages\n')
  const tarballs = PACKAGES.map(pack)

  // A throwaway home so the run cannot touch a real profile, and so a failure
  // leaves nothing behind that the next run would silently inherit.
  const env = { ...process.env, DSH_HOME: HOME }

  // Let DSH create the profile itself — the init path is part of what is
  // being tested — before anything is written into its manifest.
  process.stdout.write(`initializing profile "${PROFILE}"\n`)
  const init = run(
    process.execPath,
    [cli.entry, 'plugin', '--profile', PROFILE, 'install'],
    { env, cwd: ROOT },
  )
  if (init.status !== 0) fail('`dsh plugin install` failed', init.stderr || init.stdout)

  linkLocalTarballs(tarballs)

  process.stdout.write('installing the bundle\n')
  const install = run(
    process.execPath,
    [cli.entry, 'plugin', '--profile', PROFILE, 'add', ...tarballs],
    { env, cwd: ROOT },
  )
  if (install.status !== 0) {
    fail('`dsh plugin add` failed', install.stderr || install.stdout)
  }

  const manifestPath = join(HOME, 'profiles', PROFILE, 'package.json')
  if (!existsSync(manifestPath)) fail(`the profile manifest was not created at ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (!bundles.includes('@watchskill/dsh-bundle')) {
    fail(
      'DSH did not reconcile the Watch bundle into the profile layer stack.',
      `dsh.profile.bundles = ${JSON.stringify(bundles)}`,
    )
  }
  process.stdout.write(`  layers: ${bundles.join(' → ')}\n`)

  process.stdout.write('composing the profile\n')
  const dump = run(
    process.execPath,
    [cli.entry, '--profile', PROFILE, '--dump-config'],
    { env, cwd: ROOT },
  )
  if (dump.status !== 0) fail('`dsh --dump-config` failed', dump.stderr || dump.stdout)

  const missing = EXPECTED_ROWS.filter(row => !dump.stdout.includes(row))
  if (missing.length > 0) {
    fail(
      `the composed profile is missing ${missing.join(', ')}`,
      dump.stdout.slice(0, 2000),
    )
  }

  // The other half of the promise: composing Watch in must not have removed
  // anything. A few load-bearing upstream rows stand in for the whole tree,
  // which the parity golden journeys cover in full.
  const upstreamRows = ['api-gateway', 'client-runtime', 'ui-conversation', 'ui-trajectory']
  const lost = upstreamRows.filter(row => !dump.stdout.includes(row))
  if (lost.length > 0) {
    fail(
      `installing Watch removed upstream rows: ${lost.join(', ')}`,
      'The bundle patch must be purely additive.',
    )
  }

  // The other half of "additive": removing it must leave the profile as it
  // was. A bundle that installs cleanly and cannot be removed cleanly is not
  // additive — it is a one-way change someone discovers later.
  process.stdout.write('removing the bundle\n')
  const removal = run(
    process.execPath,
    [cli.entry, 'plugin', '--profile', PROFILE, 'remove', '@watchskill/dsh-bundle'],
    { env, cwd: ROOT },
  )
  if (removal.status !== 0) {
    fail('`dsh plugin remove` failed', removal.stderr || removal.stdout)
  }

  const afterRemoval = run(
    process.execPath,
    [cli.entry, '--profile', PROFILE, '--dump-config'],
    { env, cwd: ROOT },
  )
  if (afterRemoval.status !== 0) {
    fail('the profile no longer composes after Watch was removed', afterRemoval.stderr)
  }
  const lingering = EXPECTED_ROWS.filter(row => afterRemoval.stdout.includes(row))
  if (lingering.length > 0) {
    fail(`removing the bundle left rows behind: ${lingering.join(', ')}`)
  }
  const lostOnRemoval = upstreamRows.filter(row => !afterRemoval.stdout.includes(row))
  if (lostOnRemoval.length > 0) {
    fail(`removing Watch took upstream rows with it: ${lostOnRemoval.join(', ')}`)
  }

  process.stdout.write(
    `\nPASS  the Watch bundle composes into stock DSH ${cli.version}\n`
    + `      Watch rows present:    ${EXPECTED_ROWS.join(', ')}\n`
    + `      upstream rows intact:  ${upstreamRows.join(', ')}\n`
    + '      uninstall:             clean, upstream untouched\n',
  )

  if (keep) {
    process.stdout.write(`\nprofile kept at ${join(HOME, 'profiles', PROFILE)}\n`)
    return
  }
  removeTree(HOME)
}

main()
