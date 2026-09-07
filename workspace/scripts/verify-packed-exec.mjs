#!/usr/bin/env node
/**
 * Run `deepwatch` the ways people actually run it.
 *
 * **This is not a test of `npx @deepwatch/cli` from the registry.** The
 * registry serves the last release; this gate is about the candidate, which
 * has not been published and, if it fails here, will not be. So what it does
 * is *packed-artifact equivalent* testing: the exact tarballs a publish of
 * this commit would upload, installed locally, and then invoked through each
 * runner's own resolution path — `npm exec`, `npx` against an existing
 * install, `pnpm exec`, and a real global install into a prefix this script
 * owns. The published equivalent runs after a publish, in the `smoke` job of
 * release-deepwatch.yml, pinned to the version that was just uploaded.
 *
 * Each runner finds a binary differently, and each has broken this before: a
 * `bin` field that points at a file `files` does not ship, a shim that cannot
 * find its own package, a global install with no dependency closure.
 *
 * The subcommands exercised here are the ones that are safe to exercise
 * anywhere: version, help, doctor, and every side of setup's consent gate
 * that refuses. A setup allowed to proceed fetches a Harness and its closure,
 * so the successful install belongs to a gate with a machine to do it on —
 * `browser-e2e` in workspace-ci.yml composes a profile from these same
 * artifacts and boots it. Booting the desktop shell needs a real Harness too,
 * and belongs to the QA pass that has one.
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

import {
  describeCommand, launchWindowsShim, resolveNodeCli, resolveNpm, resolvePnpm,
} from './lib/process.mjs'
import { installInvocation } from './lib/install.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACTS = join(ROOT, '.release-artifacts')
const VERSION = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'watch', 'cli', 'package.json'), 'utf8')).version

/**
 * Run a command, through the boundary the product uses.
 *
 * No shell. `npm` on Windows is a `.cmd` and Node will not spawn one without
 * an interpreter, so this ran a quoted command line through `cmd.exe`
 * instead — which worked here and was a *second* answer to the question the
 * shipped CLI answered differently and wrongly. `resolveNpm` is the single
 * answer: Node running npm's own `npm-cli.js`, on every platform.
 */
function run(command, args, options = {}) {
  const ran = spawnSync(command, args, {
    encoding: 'utf8', shell: false, timeout: 300_000, ...options,
  })
  return { code: ran.status ?? 1, stdout: ran.stdout ?? '', stderr: ran.stderr ?? '' }
}

/**
 * The one place a Windows shim is started, and the only one that needs to be.
 *
 * A globally installed `deepwatch` *is* a `.cmd` on Windows, and whether that
 * shim works is precisely what this gate checks — so here, and only here, a
 * command interpreter is genuinely required. It is the product's own
 * `launchWindowsShim` rather than a second copy of the same quoting: that
 * function refuses any argument a `cmd.exe` line could reinterpret before a
 * process exists, and getting `cmd`'s quoting subtly right in two places is
 * how one of them ends up subtly wrong.
 */
async function runShim(shim, args) {
  if (process.platform !== 'win32') return run(shim, args)
  const ran = await launchWindowsShim(shim, args, { timeoutMs: 300_000 })
  return { code: ran.code ?? 1, stdout: ran.stdout, stderr: ran.stderr }
}

/**
 * npx's own Node entry, so `npx` is started the way `npm` is.
 *
 * `npx` ships inside the npm package as `bin/npx-cli.js`; resolving it through
 * `resolveNodeCli` keeps this on the same shell-free path as everything else
 * rather than reaching for the `.cmd` beside it.
 */
function npxEntry() {
  const entry = resolveNodeCli('npm', join('bin', 'npx-cli.js'))
  if (entry === null) throw new Error('verify-packed-exec: no npx entry point was found')
  return entry
}

/** npm, as the product resolves it. */
function npm() {
  const found = resolveNpm()
  if (found === null) {
    throw new Error('verify-packed-exec: no npm this tooling can run was found')
  }
  return found
}

const rooms = []
function room(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  rooms.push(dir)
  return dir
}

/**
 * What a failed launch actually was, in enough detail to act on.
 *
 * The three previous call sites reported `stderr.split('\n').slice(-3)`, which
 * is the wrong three lines of a Node stack: the tail of a `MODULE_NOT_FOUND`
 * is `requireStack: []`, `}` and the Node version, and the line that names the
 * missing module is above it. A CI failure that took three runs to characterise
 * and still had to be guessed at is a reporting defect, not a flake.
 *
 * So this reports the launcher it resolved, how (a Node entry point, a
 * `PATH` executable, a shim), the working directory, the exit code, and the
 * whole of both streams up to a bound -- through `describeCommand`, which
 * redacts a secret-shaped argument, and never the environment's values.
 *
 * @param launcher - `{ command, prefix, kind }` from `resolvePnpm`/`resolveNpm`, or null.
 * @param args - the arguments after the launcher's own prefix.
 * @param result - `{ code, stdout, stderr }` from `run`.
 * @param cwd - where it ran.
 * @returns a multi-line description.
 */
function describeLaunchFailure(launcher, args, result, cwd) {
  const bound = text => {
    const trimmed = String(text ?? '').trim()
    return trimmed.length > 4000 ? `…${trimmed.slice(-4000)}` : trimmed
  }
  const described = launcher === null
    ? { executable: '(unresolved)', arguments: [] }
    : describeCommand(launcher.command, [...launcher.prefix, ...args])
  const lines = [
    '',
    `    launcher   ${described.executable}`,
    `    kind       ${launcher?.kind ?? 'none — nothing resolved'}`,
    `    arguments  ${JSON.stringify(described.arguments)}`,
    `    cwd        ${cwd}`,
    `    exit       ${String(result.code)}`,
  ]
  const out = bound(result.stdout)
  const err = bound(result.stderr)
  if (out !== '') lines.push('    stdout', ...out.split('\n').map(line => `      ${line}`))
  if (err !== '') lines.push('    stderr', ...err.split('\n').map(line => `      ${line}`))
  if (out === '' && err === '') lines.push('    (both streams were empty)')
  return lines.join('\n')
}

async function main() {
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

  const project_npm = npm()
  const installed = run(project_npm.command,
    [...project_npm.prefix, ...installInvocation(tarballs)], { cwd: project })
  if (installed.code !== 0) {
    say('install', describeLaunchFailure(
      { command: project_npm.command, prefix: project_npm.prefix, kind: project_npm.kind },
      installInvocation(tarballs), installed, project))
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
  expect('npm exec',
    run(project_npm.command, [...project_npm.prefix, 'exec', '--', 'deepwatch', '--version'],
      { cwd: project }),
    sameVersion)
  expect('npx (against the local install)',
    run(process.execPath, [npxEntry(), '--no-install', 'deepwatch', '--version'],
      { cwd: project }), sameVersion)

  // pnpm needs a different shape, for a reason worth writing down.
  //
  // Handed twenty sibling tarballs, npm satisfies `@deepwatch/dsh-bundle` from
  // the one on its own command line. pnpm does not: it resolves every
  // transitive range by name against the registry, where the candidate's
  // version does not exist yet — a 404 for exactly the version under test,
  // whatever else the scope already serves. That is a fact about a candidate,
  // not a defect in it, and it means the honest pnpm equivalent is a workspace
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
  const pnpm = resolvePnpm()
  const pnpmInstalled = pnpm === null
    ? { code: 1, stdout: '', stderr: 'no pnpm this tooling can run was found' }
    : run(pnpm.command, [...pnpm.prefix, 'install'], { cwd: pnpmRoom })
  if (pnpmInstalled.code !== 0) {
    say('pnpm install',
      describeLaunchFailure(pnpm, ['install'], pnpmInstalled, pnpmRoom))
  } else {
    expect('pnpm exec (workspace of unpacked tarballs)',
      run(pnpm.command, [...pnpm.prefix, 'exec', 'deepwatch', '--version'],
        { cwd: pnpmRoom }), sameVersion)
  }

  // A global install into a prefix this script owns. Never the machine's.
  const prefix = room('deepwatch-global-')
  const runner = npm()
  const global_ = run(runner.command,
    [...runner.prefix, 'install', '--global', '--legacy-peer-deps', '--no-audit', '--no-fund',
      `--prefix=${prefix}`, ...tarballs])
  if (global_.code !== 0) {
    say('global install', describeLaunchFailure(
      { command: runner.command, prefix: runner.prefix, kind: runner.kind },
      ['install', '--global'], global_, prefix))
  } else {
    const shim = process.platform === 'win32'
      ? join(prefix, 'deepwatch.cmd')
      : join(prefix, 'bin', 'deepwatch')
    if (!existsSync(shim)) {
      say('global install', `installed and left no ${shim}`)
    } else {
      expect('global deepwatch --version', await runShim(shim, ['--version']), sameVersion)
      expect('global deepwatch --help', await runShim(shim, ['--help']), result =>
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

  // Each setup case gets a home of its own.
  //
  // They shared one until the scope was published. `setup --yes` with no
  // artifacts used to refuse, so nothing was ever built and the later cases
  // ran against an empty home by luck. It installs from the registry now, and
  // a shared home meant every case after the first was judging a machine that
  // already had a runtime on it -- consent and offline both behave differently
  // once one exists.
  const setupHome = label => {
    const dir = join(room('deepwatch-setup-'), label)
    mkdirSync(dir, { recursive: true })
    return { cwd: project, env: { ...process.env, DEEPWATCH_HOME: dir } }
  }

  // No artifacts, no consent: the registry plan is printed and nothing is
  // fetched. This is the path a new user takes, and the one that would
  // otherwise install five hundred packages inside somebody's CI.
  const registryPlan = setupHome('registry-plan')
  expect('setup with no artifacts, no consent',
    run(process.execPath, [cli, 'setup'], registryPlan), result => {
      if (result.code === 0) return 'reported success without installing anything'
      const said = result.stdout + result.stderr
      if (!said.includes('registry.npmjs.org')) return 'did not name the registry first'
      if (!said.includes('@deepseek-ai/dsh')) return 'did not name the Harness first'
      if (!/from the registry/.test(said)) return 'did not say where the DeepWatch packages come from'
      if (!said.includes('--yes')) return 'did not say how to agree'
      if (existsSync(join(registryPlan.env.DEEPWATCH_HOME, 'harness', 'node_modules'))) {
        return 'downloaded something nobody agreed to'
      }
      return null
    })

  // The sealed-artifact path is a different mode, and it names the directory
  // it would install from. Still no consent, so still nothing fetched.
  const artifactPlan = setupHome('artifact-plan')
  expect('setup --artifacts without consent',
    run(process.execPath, [cli, 'setup', '--artifacts', ARTIFACTS], artifactPlan), result => {
      if (result.code === 0) return 'reported success without installing anything'
      const said = result.stdout + result.stderr
      if (!said.includes('registry.npmjs.org')) return 'did not name the registry first'
      if (!said.includes(ARTIFACTS)) return 'did not name where the local packages come from'
      if (!/verified local artifacts/.test(said)) return 'did not distinguish the artifact mode'
      if (existsSync(join(artifactPlan.env.DEEPWATCH_HOME, 'harness', 'node_modules'))) {
        return 'downloaded something anyway'
      }
      return null
    })

  // Offline wins over consent, in a home of its own so the refusal is about
  // the policy rather than about a runtime that happens to be there already.
  const offline = setupHome('offline')
  expect('setup --offline --yes',
    run(process.execPath, [cli, 'setup', '--offline', '--yes'], offline),
    result => {
      if (result.code === 0) return 'reported success while offline'
      if (!/offline/i.test(result.stdout + result.stderr)) return 'did not say why it refused'
      if (existsSync(join(offline.env.DEEPWATCH_HOME, 'harness', 'node_modules'))) {
        return 'downloaded something anyway'
      }
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
  report = await main()
} finally {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}

if (report.problems.length > 0) {
  for (const problem of report.problems) process.stderr.write(`  ${problem}\n`)
  process.stderr.write(`\npacked-exec: ${report.problems.length} problem(s)\n`)
  process.exitCode = 1
} else {
  process.stdout.write(
    `\npacked-exec: ${report.ran.length} invocations, all from this commit's `
    + 'packed artifacts (a published version is smoked after it is published, '
    + 'not here)\n')
}
