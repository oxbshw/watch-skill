#!/usr/bin/env node
/**
 * Run `deepwatch` the ways people actually run it.
 *
 * **This is not a test of `npx @deepwatch/cli`.** Nothing is published, so
 * there is no registry to fetch from and no claim to make about one. What this
 * does is *packed-artifact equivalent* testing: the same tarball a publish
 * would upload, installed locally, and then invoked through each runner's own
 * resolution path — `npm exec`, `npx` against an existing install, `pnpm exec`,
 * and a real global install into a prefix this script owns.
 *
 * Each runner finds a binary differently, and each has broken this before: a
 * `bin` field that points at a file `files` does not ship, a shim that cannot
 * find its own package, a global install with no dependency closure.
 *
 * The subcommands exercised here are the ones that are safe to exercise
 * anywhere: version, help, doctor, and both sides of setup's consent gate.
 * Booting the Web app and the desktop shell needs a real Harness, and belongs
 * to the QA pass that has one.
 *
 * Usage:
 *   node scripts/verify-packed-exec.mjs
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS = join(ROOT, '.release-artifacts')
const VERSION = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'watch', 'cli', 'package.json'), 'utf8')).version

/**
 * Run a command line, on a platform where the runners are all shims.
 *
 * `npm`, `npx` and `pnpm` are `.cmd` files on Windows and Node will not spawn
 * one without a shell. Every argument here is built by this file.
 */
function run(command, args, options = {}) {
  const line = [command, ...args.map(argument => `"${argument}"`)].join(' ')
  const ran = spawnSync(line, [], {
    encoding: 'utf8', shell: true, timeout: 300_000, ...options,
  })
  return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
}

const rooms = []
function room(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  rooms.push(dir)
  return dir
}

function main() {
  const problems = []
  const say = (where, detail) => problems.push(`${where}: ${detail}`)
  const ran = []

  if (!existsSync(ARTIFACTS)) {
    say('artifacts', 'no .release-artifacts — run scripts/pack-release.mjs first')
    return { problems, ran }
  }
  const tarballs = readdirSync(ARTIFACTS).filter(name => name.endsWith('.tgz'))
    .map(name => join(ARTIFACTS, name))

  // A project install, which is what `npm exec`, `npx` and `pnpm exec` all
  // resolve against.
  const project = room('deepwatch-exec-')
  writeFileSync(join(project, 'package.json'), `${JSON.stringify({
    name: 'deepwatch-exec-room', version: '0.0.0', private: true,
  }, null, 2)}\n`)
  writeFileSync(join(project, '.npmrc'), 'audit=false\nfund=false\n')
  const home = join(project, 'home')

  const installed = run('npm', ['install', '--legacy-peer-deps', ...tarballs], { cwd: project })
  if (installed.code !== 0) {
    say('install', installed.stderr.split('\n').filter(Boolean).slice(-3).join(' / '))
    return { problems, ran }
  }

  /** One invocation, and what it was supposed to do. */
  const expect = (label, result, check) => {
    ran.push(label)
    const failure = check(result)
    if (failure !== null) {
      if (process.env.DEEPWATCH_EXEC_DEBUG === '1') {
        process.stderr.write(`DEBUG ${label} code=${result.code}
OUT<${result.stdout.slice(0, 300)}>
ERR<${result.stderr.slice(0, 300)}>
`)
      }
      say(label, failure)
    }
  }
  const sameVersion = result => result.code !== 0
    ? `exited ${result.code}: ${result.stderr.trim().split('\n')[0] ?? ''}`
    : result.stdout.trim() === VERSION ? null : `printed ${result.stdout.trim()}`

  // Each runner, by its own resolution path.
  expect('npm exec', run('npm', ['exec', '--', 'deepwatch', '--version'], { cwd: project }),
    sameVersion)
  expect('npx (against the local install)',
    run('npx', ['--no-install', 'deepwatch', '--version'], { cwd: project }), sameVersion)

  // pnpm needs a different shape, for a reason worth writing down.
  //
  // Handed twenty sibling tarballs, npm satisfies `@deepwatch/dsh-bundle` from
  // the one on its own command line. pnpm does not: it resolves every
  // transitive range by name against the registry, and an unpublished scope is
  // a 404 there. That is a fact about these packages not being published, not
  // a defect in them — and it means the honest pnpm equivalent is a workspace
  // of the *unpacked* tarballs, where pnpm links them by version and its own
  // `exec` resolution is what gets exercised.
  //
  // It also gets its own room because, pointed at an npm-installed
  // `node_modules`, pnpm moves every package it did not install into
  // `node_modules/.ignored` — reasonable of it, and it destroyed the install
  // underneath every check that followed the first time this ran.
  const pnpmRoom = room('deepwatch-pnpm-')
  for (const tarball of tarballs) {
    const into = join(pnpmRoom, 'packages', basename(tarball, '.tgz'))
    mkdirSync(into, { recursive: true })
    const unpacked = run('tar',
      ['-xzf', basename(tarball), '-C', into, '--strip-components=1'],
      { cwd: dirname(tarball) })
    if (unpacked.code !== 0) say('pnpm room', `could not unpack ${basename(tarball)}`)
  }
  writeFileSync(join(pnpmRoom, 'pnpm-workspace.yaml'), [
    'packages:',
    '  - packages/*',
    'linkWorkspacePackages: true',
    // The Harness's closure has install scripts, and pnpm treats an unapproved
    // one as fatal. Nothing here needs a compiled native addon to answer
    // `--version`, so they stay unrun and unblocking.
    'strictDepBuilds: false',
    'verifyDepsBeforeRun: false',
    '',
  ].join('\n'))
  writeFileSync(join(pnpmRoom, 'package.json'), `${JSON.stringify({
    name: 'deepwatch-pnpm-room',
    version: '0.0.0',
    private: true,
    // A consumer, because pnpm links a package's bin for whoever depends on
    // it and not for the package itself.
    dependencies: { '@deepwatch/cli': 'workspace:*' },
  }, null, 2)}\n`)
  const pnpmInstalled = run('pnpm', ['install'], { cwd: pnpmRoom })
  if (pnpmInstalled.code !== 0) {
    say('pnpm install', pnpmInstalled.stderr.split('\n').filter(Boolean).slice(-3).join(' / '))
  } else {
    expect('pnpm exec (workspace of unpacked tarballs)',
      run('pnpm', ['exec', 'deepwatch', '--version'], { cwd: pnpmRoom }), sameVersion)
  }

  // A global install into a prefix this script owns. Never the machine's.
  const prefix = room('deepwatch-global-')
  const global_ = run('npm',
    ['install', '--global', '--legacy-peer-deps', `--prefix=${prefix}`, ...tarballs])
  if (global_.code !== 0) {
    say('global install', global_.stderr.split('\n').filter(Boolean).slice(-3).join(' / '))
  } else {
    const shim = process.platform === 'win32'
      ? join(prefix, 'deepwatch.cmd')
      : join(prefix, 'bin', 'deepwatch')
    if (!existsSync(shim)) {
      say('global install', `installed and left no ${shim}`)
    } else {
      expect('global deepwatch --version', run(shim, ['--version']), sameVersion)
      expect('global deepwatch --help', run(shim, ['--help']), result =>
        result.code === 0 && result.stdout.includes('deepwatch doctor')
          ? null : 'did not print usage')
    }
  }

  // The subcommands, through the project install.
  const cli = join(project, 'node_modules', '@deepwatch', 'cli', 'lib', 'bin.js')
  const withHome = { cwd: project, env: { ...process.env, DEEPWATCH_HOME: home } }

  expect('doctor --json', run('node', [cli, 'doctor', '--json'], withHome), result => {
    try {
      const report = JSON.parse(result.stdout)
      return Array.isArray(report.findings) && report.findings.length > 0
        ? null : 'reported no findings'
    } catch {
      return 'did not print JSON'
    }
  })

  // Setup, refused. Non-interactive and without `--yes`, so the plan is shown
  // and nothing is fetched — the case that would otherwise install four
  // hundred packages inside somebody's CI.
  expect('setup without consent', run('node', [cli, 'setup'], withHome), result => {
    if (result.code === 0) return 'reported success without installing anything'
    const said = result.stdout + result.stderr
    if (!said.includes('registry.npmjs.org')) return 'did not name the registry first'
    if (!said.includes('@deepseek-ai/dsh')) return 'did not name the package first'
    if (existsSync(join(home, 'harness', 'node_modules'))) return 'downloaded something anyway'
    return null
  })

  // Setup, refused for a different reason: offline wins over consent.
  expect('setup --offline --yes', run('node', [cli, 'setup', '--offline', '--yes'], withHome),
    result => {
      if (result.code === 0) return 'reported success while offline'
      if (!/offline/i.test(result.stdout + result.stderr)) return 'did not say why it refused'
      if (existsSync(join(home, 'harness', 'node_modules'))) return 'downloaded something anyway'
      return null
    })

  // Starting the app with nothing composed must refuse rather than hang.
  expect('web with no profile', run('node', [cli, 'web'], withHome), result =>
    result.code === 0 ? 'started something that was never composed'
      : /deepwatch setup/.test(result.stderr) ? null : 'refused without saying what to run')

  return { problems, ran }
}

let report
try {
  report = main()
} finally {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

if (report.problems.length > 0) {
  for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
  process.stderr.write(`\npacked-exec: ${report.problems.length} problem(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `\npacked-exec: ${report.ran.length} invocations, all from packed artifacts `
    + '(nothing is published, so no registry install was tested)\n')
}
