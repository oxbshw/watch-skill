#!/usr/bin/env node
/**
 * Build the profile a person can actually click around in.
 *
 * This is the real thing, not a demo harness: a stock DeepSeek Harness `web`
 * profile with the Watch bundle installed as a layer, served by DSH's own Web
 * Host. §39.5 point 10 is explicit that the Web UI must not build duplicate
 * session, settings or plugin systems, so there is nothing here that stands in
 * for one — the shell, the sessions, the settings and the Trajectory are all
 * upstream's, and Watch arrives as rows in the composed tree.
 *
 * Two accommodations are made for a local manual-test run, and both are the
 * kind a user would make themselves:
 *
 * - the Bridge row is pinned to an absolute `watch-skill` path, because the
 *   engine lives in a virtualenv rather than on `PATH`. The published default
 *   is `transport: auto` with the bare command, which is right for somebody
 *   who installed it normally.
 * - memory is switched to `local_personal`, because the shipped default is
 *   `off` and a Memory surface with nothing in it is not something you can
 *   test. That is a setting change, not a policy change: the admission rules,
 *   the scopes and the forget semantics are untouched.
 *
 * Everything the profile is seeded with is marked as demo data. None of it is
 * a provider result and none of it is machine-tested anything.
 *
 * Usage:
 *   node scripts/manual-profile.mjs             build it
 *   node scripts/manual-profile.mjs --rebuild   tear down and build again
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, copyFileSync,
} from 'node:fs'
import { join, dirname, resolve, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manualPath } from './lib/manual-paths.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = manualPath('WATCH_MANUAL_HOME', ['dsh-home'])
/** Windows paths in a YAML overlay read better, and parse safer, as POSIX. */
const posixPath = value => value.split(sep).join('/')

const PACKED = join(HOME, 'packed')
const PROFILE = 'web'
const FIXTURES = join(ROOT, 'fixtures', 'manual')

/** Where Watch Core lives on this machine. */
const CORE_CANDIDATES = [
  'F:/New folder (5)/local project/.venv/Scripts/watch-skill.exe',
  'F:/New folder (5)/local project/.venv/bin/watch-skill',
]

function fail(message, detail) {
  process.stderr.write(`\nwatch: ${message}\n`)
  if (detail) process.stderr.write(`${String(detail).trim()}\n`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const { shell = false, ...rest } = options
  const result = spawnSync(command, args, { encoding: 'utf8', shell, ...rest })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * Every Watch row the bundle declares, read from the patch itself.
 *
 * `- insert:` adds a row and a bare `- id:` targets one, so the ids that
 * matter are the ones nested under the bundle's own plugin list. Deriving
 * them means a row added to the bundle is checked without anyone
 * remembering to update a list here.
 */
function watchRowIds() {
  const patch = readFileSync(join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml'), 'utf8')
  const ids = []
  for (const line of patch.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue
    const match = /^\s+-\s+id:\s*(watch-[a-z-]+)\s*$/.exec(line)
    if (match !== null && !ids.includes(match[1])) ids.push(match[1])
  }
  if (ids.length === 0) throw new Error('watch: the bundle declares no Watch rows')
  return ids
}

function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      return
    } catch (cause) {
      if (attempt === 9) fail(`could not clear ${target}`, String(cause))
    }
  }
}

function findCli() {
  // `WATCH_DSH_CLI` first, then the workspace's own install, then a
  // `watch-smoke` checkout beside either the workspace or the repository.
  //
  // The two-levels-up entry is not redundant: the workspace used to be the
  // repository root, so one level up reached its siblings. It is a
  // subdirectory now, and the sibling it wants is a level further out.
  const candidates = [
    process.env.WATCH_DSH_CLI,
    join(ROOT, 'node_modules', '@deepseek-ai', 'dsh'),
    join(ROOT, '..', 'watch-smoke', 'node_modules', '@deepseek-ai', 'dsh'),
    join(ROOT, '..', '..', 'watch-smoke', 'node_modules', '@deepseek-ai', 'dsh'),
  ].filter(path => path !== undefined)

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

/** The bundle's transitive first-party dependencies, deepest first. */
function bundlePackages() {
  const root = join(ROOT, 'packages', 'watch')
  const byName = new Map()
  for (const entry of readdirSync(root)) {
    const path = join(root, entry, 'package.json')
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, 'utf8'))
    byName.set(manifest.name, { dir: `packages/watch/${entry}`, manifest })
  }
  const seen = new Set()
  const order = []
  const visit = name => {
    const found = byName.get(name)
    if (found === undefined || seen.has(name)) return
    seen.add(name)
    for (const dependency of Object.keys(found.manifest.dependencies ?? {})) visit(dependency)
    order.push(found.dir)
  }
  for (const dependency of Object.keys(byName.get('@watchskill/dsh-bundle')?.manifest.dependencies ?? {})) {
    visit(dependency)
  }
  order.push('packages/watch/bundle')
  return order
}

/**
 * Drop the profile's copies of the Watch packages before reinstalling.
 *
 * pnpm keys a `file:` dependency on its path and version, and neither changes
 * between runs — the tarball is rewritten in place at the same version every
 * time. So a second run happily reuses the cached copy and installs the
 * *previous* bundle, which composes the previous rows, while every timestamp
 * on disk says the build is current. That is a full run of the product built
 * from source nobody is looking at.
 *
 * Removing the installed copies and the `file:` store entries first costs
 * under a second and makes the profile actually reflect the working tree.
 */
function clearStaleInstalls() {
  const profileModules = join(HOME, 'profiles', PROFILE, 'node_modules')
  if (!existsSync(profileModules)) return
  removeTree(join(profileModules, '@watchskill'))
  const store = join(profileModules, '.pnpm')
  if (!existsSync(store)) return
  for (const entry of readdirSync(store)) {
    if (entry.startsWith('file+')) removeTree(join(store, entry))
  }
}

function packAll() {
  mkdirSync(PACKED, { recursive: true })
  const tarballs = []
  for (const relative of bundlePackages()) {
    const result = run('pnpm', ['pack', '--pack-destination', PACKED], {
      shell: process.platform === 'win32',
      cwd: join(ROOT, relative),
    })
    if (result.status !== 0) fail(`packing ${relative} failed`, result.stderr)
    const produced = result.stdout.trim().split(/\r?\n/).pop() ?? ''
    const tarball = existsSync(produced) ? produced : join(PACKED, basename(produced))
    if (!existsSync(tarball)) fail(`pnpm pack produced no tarball for ${relative}`)
    tarballs.push(tarball)
  }
  return tarballs
}

function linkTarballs(tarballs) {
  const manifestPath = join(HOME, 'profiles', PROFILE, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const overrides = {}
  for (const tarball of tarballs) {
    const name = basename(tarball).replace(/-\d+\.\d+\.\d+.*\.tgz$/, '')
    overrides[`@${name.replace(/^watchskill-/, 'watchskill/')}`] =
      `file:${tarball.replace(/\\/g, '/')}`
  }
  manifest.pnpm = { ...manifest.pnpm, overrides: { ...manifest.pnpm?.overrides, ...overrides } }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

/**
 * The overlay that makes this a manual-test profile.
 *
 * A patch replaces the targeted row's whole `config`, so every key that should
 * survive is restated — which is exactly what the bundle's own comment warns
 * about, and the reason it is written out in full here rather than diffed.
 */
function writeOverlay(corePath, memoryDir, evidenceRoot) {
  const overlay = `# Watch manual-test overlay — DEVELOPMENT / MANUAL TEST ONLY.
#
# Applied after the Watch bundle layer. It changes two things and nothing else:
#
#   1. the Bridge command, because Watch Core lives in a virtualenv on this
#      machine rather than on PATH. A normal install needs none of this.
#   2. the memory mode, because the shipped default is 'off' and a Memory
#      surface with nothing in it cannot be tested. This is a setting, not a
#      policy: admission rules, scopes and forget semantics are untouched.
#
# Two things about the format, both learned the hard way.
#
# These are bare targeted rows, NOT wrapped in \`- insert:\`. \`insert\` adds a new
# row, so reusing an existing id under it composes the row twice and the loader
# refuses to boot with "duplicate loader entry id". Targeting an id patches the
# row that is already there, which is what an override is.
#
# And a patch replaces the targeted row's whole \`config\`, so every key that
# should survive is restated below rather than diffed.

- id: watch-tools
  config:
    queryTimeoutMs: 120000
    verifyTimeoutMs: 60000
    readTimeoutMs: 30000
    liveStartTimeoutMs: 30000
    actTimeoutMs: 60000
    observeTimeoutMs: 30000
    libraryRoots:
      - ${evidenceRoot}

- id: watch-core-bridge
  config:
    transport: auto
    command: ${JSON.stringify(corePath)}
    args: [bridge]
    cwd: ''
    startupTimeoutMs: 20000
    requestTimeoutMs: 60000
    autoConnect: true

- id: watch-memory
  config:
    mode: 'local_personal'
    directory: ${JSON.stringify(memoryDir)}
    inferredThreshold: 0.8
    tokenBudget: 600
    writeProjections: true
`
  const path = join(HOME, 'watch-manual.patch.yml')
  writeFileSync(path, overlay, 'utf8')
  return path
}

function main() {
  const cli = findCli()
  if (cli === null) fail('the DSH CLI is not installed')

  const core = CORE_CANDIDATES.find(candidate => existsSync(candidate))
  if (core === undefined) {
    process.stderr.write(
      'watch: Watch Core was not found; the profile will fall back to the mock backend\n',
    )
  }

  if (process.argv.includes('--rebuild')) removeTree(HOME)
  mkdirSync(HOME, { recursive: true })
  const env = { ...process.env, DSH_HOME: HOME }

  process.stdout.write(`dsh ${cli.version}\n`)
  process.stdout.write('packing workspace packages\n')
  const tarballs = packAll()

  process.stdout.write(`initializing profile "${PROFILE}"\n`)
  // The overrides have to exist before pnpm resolves anything.
  //
  // `plugin install` runs pnpm over the profile manifest. On a re-run that
  // manifest already carries the previous Watch bundle, and a bundle that has
  // gained a dependency since then names a package with no `file:` override
  // yet — so pnpm goes to the registry and returns 404 for a package sitting
  // in the packed directory a few lines above. Writing the overrides first is
  // the whole fix; the original order only looked right while the dependency
  // set never grew.
  const profileManifest = join(HOME, 'profiles', PROFILE, 'package.json')
  if (existsSync(profileManifest)) linkTarballs(tarballs)
  clearStaleInstalls()

  const init = run(process.execPath, [cli.entry, 'plugin', '--profile', PROFILE, 'install'], { env, cwd: ROOT })
  if (init.status !== 0) fail('`dsh plugin install` failed', init.stderr || init.stdout)

  linkTarballs(tarballs)

  process.stdout.write('installing the Watch bundle\n')
  const add = run(
    process.execPath, [cli.entry, 'plugin', '--profile', PROFILE, 'add', ...tarballs],
    { env, cwd: ROOT },
  )
  if (add.status !== 0) fail('`dsh plugin add` failed', add.stderr || add.stdout)

  const memoryDir = join(HOME, 'watch-memory').replace(/\\/g, '/')
  mkdirSync(memoryDir, { recursive: true })
  // The fixture directory has to exist before the overlay names it, because
  // the overlay is what tells the library index where to read.
  const seedDir = posixPath(join(HOME, 'watch-fixtures'))
  mkdirSync(seedDir, { recursive: true })

  const overlay = core === undefined ? null : writeOverlay(core, memoryDir, seedDir)

  // Seed the deterministic demo fixtures where the profile can reach them.
  if (existsSync(FIXTURES)) {
    for (const entry of readdirSync(FIXTURES)) {
      copyFileSync(join(FIXTURES, entry), join(seedDir, entry))
    }
  }

  const dump = run(
    process.execPath,
    [cli.entry, '--profile', PROFILE, ...(overlay === null ? [] : ['--patch', overlay]), '--dump-config'],
    { env, cwd: ROOT },
  )
  if (dump.status !== 0) fail('the composed profile did not resolve', dump.stderr || dump.stdout)

  // Read out of the bundle rather than typed here.
  //
  // This was a hand-written list of four, and the bundle has ten. It would
  // therefore have passed while five client packages were absent from the
  // composed tree — which is exactly what happened once already, and is why
  // a running Workspace looked like stock DSH with every gate green.
  const rows = watchRowIds()
  const missing = rows.filter(row => !dump.stdout.includes(row))
  if (missing.length > 0) fail(`the composed profile is missing ${missing.join(', ')}`)

  const upstream = ['api-gateway', 'client-runtime', 'ui-conversation', 'ui-trajectory']
  const lost = upstream.filter(row => !dump.stdout.includes(row))
  if (lost.length > 0) fail(`the composed profile lost upstream rows: ${lost.join(', ')}`)

  const summary = {
    dshHome: HOME,
    profile: PROFILE,
    dshVersion: cli.version,
    cliEntry: cli.entry,
    overlay,
    watchCore: core ?? null,
    memoryDirectory: memoryDir,
    fixtures: seedDir,
    watchRows: rows,
    upstreamRows: upstream,
    builtAt: new Date().toISOString(),
  }
  writeFileSync(join(HOME, 'manual-profile.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

  process.stdout.write(
    '\nMANUAL TEST PROFILE READY\n'
    + `  DSH_HOME:     ${HOME}\n`
    + `  profile:      ${PROFILE}\n`
    + `  DSH:          ${cli.version}\n`
    + `  Watch Core:   ${core ?? 'not found — mock backend'}\n`
    + `  overlay:      ${overlay ?? 'none'}\n`
    + `  memory:       local_personal at ${memoryDir}\n`
    + `  fixtures:     ${seedDir}\n`
    + `  Watch rows:   ${rows.join(', ')}\n`
    + `  upstream:     ${upstream.join(', ')} intact\n`
    + '\nServe with:\n'
    + `  DSH_HOME=${HOME} node ${cli.entry} --profile ${PROFILE}`
    + `${overlay === null ? '' : ` --patch ${overlay}`} --no-open --host 127.0.0.1 --port <port>\n`,
  )
}

main()
