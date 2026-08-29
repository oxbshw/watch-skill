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
import { join, dirname, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manualPath } from './lib/manual-paths.mjs'
import { ensureCli } from './lib/dsh-cli.mjs'
import { withPinnedPnpm } from './lib/pnpm-shim.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = manualPath('WATCH_MANUAL_HOME', ['dsh-home'])
/** Windows paths in a YAML overlay read better, and parse safer, as POSIX. */
const posixPath = value => value.split(sep).join('/')

const PACKED = join(HOME, 'packed')
const PROFILE = 'web'
const FIXTURES = join(ROOT, 'fixtures', 'manual')

/** Where Watch Core lives on this machine. */
/**
 * Where Watch Core's executable might be, in preference order.
 *
 * This was two absolute paths into one maintainer's checkout, on a drive and
 * under a directory name nobody else has. Everyone else got the mock backend
 * and a line of output saying so, which reads like a decision rather than a
 * machine that could not find something sitting in its own virtualenv.
 *
 * Core lives in this repository now, so the repository's own venv is the
 * first place to look. WATCH_CORE_BIN overrides for a Core installed
 * elsewhere.
 */
function coreCandidates(env = process.env) {
  const explicit = env.WATCH_CORE_BIN
  const repoRoot = join(ROOT, '..')
  return [
    ...(typeof explicit === 'string' && explicit !== '' ? [explicit] : []),
    join(repoRoot, '.venv', 'Scripts', 'watch-skill.exe'),
    join(repoRoot, '.venv', 'bin', 'watch-skill'),
    join(ROOT, '.venv', 'Scripts', 'watch-skill.exe'),
    join(ROOT, '.venv', 'bin', 'watch-skill'),
  ]
}

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

/**
 * The pinned DSH CLI, installed into the harness's own directory if absent.
 *
 * This used to search two fixed places and, finding neither, print an
 * instruction to create `../watch-smoke` by hand. That made a documented gate
 * depend on an undocumented sibling, and CI -- which has no such directory --
 * never ran it at all.
 */
function findCli() {
  return ensureCli(ROOT)
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
 * Pin the profile to the pnpm this repository builds with.
 *
 * `dsh plugin` forwards to whatever `pnpm` resolves to in the profile
 * directory, and nothing there pinned one. With Corepack installed that means
 * the newest pnpm: 11.24.0 on the machine this was found on, against the
 * 10.29.1 the workspace uses. pnpm 11 no longer reads `pnpm.overrides` from
 * package.json, and `pnpm.overrides` is precisely how the profile points at
 * the packed Watch tarballs -- so every Watch package was silently dropped
 * from the resolution and `plugin add` failed with a libuv assertion rather
 * than anything that named the cause.
 *
 * Stamping `packageManager` into the profile manifest is what makes the
 * profile reproducible: Corepack reads it from the directory the command runs
 * in, so the same version installs the bundle as built it.
 */
function pinProfilePackageManager() {
  const profileDir = join(HOME, 'profiles', PROFILE)
  const manifestPath = join(profileDir, 'package.json')
  const workspace = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const spec = workspace.packageManager
  if (typeof spec !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/.test(spec)) {
    fail('the workspace pins no exact pnpm', `package.json packageManager is ${String(spec)}`)
  }
  // DSH owns this file's shape -- it carries the `dsh.profile.bundles` block
  // that says which layers compose -- so this only ever edits one field of an
  // existing manifest. Writing a minimal one here instead produced a profile
  // that installed all fourteen Watch packages and composed none of them,
  // because the bundle list was not in the file DSH then declined to replace.
  if (!existsSync(manifestPath)) return
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.packageManager === spec) return
  manifest.packageManager = spec
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}
`, 'utf8')
  process.stdout.write(`pinned the profile to ${spec}
`)
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
  if (!existsSync(profileModules)) return false

  // A tree linked by a different pnpm major cannot be reused by this one.
  // pnpm refuses with ERR_PNPM_UNEXPECTED_STORE -- the store is versioned, and
  // v11 links are not v10 links -- so the only repair is to drop the tree and
  // let it be rebuilt. Selectively removing the Watch packages, which is what
  // this did, leaves exactly the linkage pnpm objects to.
  const modulesState = join(profileModules, '.modules.yaml')
  if (existsSync(modulesState)) {
    const state = readFileSync(modulesState, 'utf8')
    const linkedStore = /store[\\/]+v(\d+)/.exec(state)?.[1]
    const wanted = /^pnpm@(\d+)\./.exec(
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).packageManager ?? '')?.[1]
    if (linkedStore !== undefined && wanted !== undefined && linkedStore !== wanted) {
      process.stdout.write(
        `profile node_modules was linked from store v${linkedStore}; `
        + `this pnpm uses v${wanted}. Rebuilding it.\n`,
      )
      removeTree(profileModules)
      return true
    }
  }

  removeTree(join(profileModules, '@watchskill'))
  const store = join(profileModules, '.pnpm')
  if (!existsSync(store)) return false
  for (const entry of readdirSync(store)) {
    if (entry.startsWith('file+')) removeTree(join(store, entry))
  }
  return false
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

/**
 * Install the layers the profile declares.
 *
 * `dsh plugin install` writes a manifest naming `@deepseek-ai/dsh-base` and
 * `@deepseek-ai/dsh-web-app` under `dsh.profile.bundles`, with `dependencies`
 * empty, and installs neither. The bundle list is a declaration of what
 * composes; it is not a dependency graph, and nothing else turns one into the
 * other.
 *
 * Skipping this produced the worst available failure. Composition passed --
 * `--dump-config` reads the declaration, so every gate that asks "are the rows
 * there" said yes -- and the application then died at boot on
 * ERR_MODULE_NOT_FOUND for a dozen packages, because module resolution starts
 * at the profile directory and the profile had none of them.
 *
 * Pinned to the same DSH the CLI and the parity baseline are pinned to, so the
 * profile cannot be composed against one version and measured against another.
 */
function installDeclaredBundles(cli, env) {
  const manifestPath = join(HOME, 'profiles', PROFILE, 'package.json')
  if (!existsSync(manifestPath)) fail(`the profile manifest was not created at ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const declared = manifest.dsh?.profile?.bundles ?? []
  const installed = Object.keys(manifest.dependencies ?? {})

  // Watch's own bundle arrives as a packed tarball a few lines later.
  const wanted = declared.filter(name =>
    name.startsWith('@deepseek-ai/') && !installed.includes(name))
  if (wanted.length === 0) return

  const version = pinnedDshVersion()
  process.stdout.write(`installing the profile's declared layers (${wanted.join(', ')})
`)
  const added = run(
    process.execPath,
    [cli.entry, 'plugin', '--profile', PROFILE, 'add',
      ...wanted.map(name => `${name}@${version}`)],
    { env, cwd: ROOT },
  )
  if (added.status !== 0) fail('installing the declared layers failed', added.stderr || added.stdout)
}

/** The DSH version upstream/deepseek-harness.lock pins. */
function pinnedDshVersion() {
  const lock = readFileSync(join(ROOT, 'upstream', 'deepseek-harness.lock'), 'utf8')
  const version = /^version:\s*(.+)$/m.exec(lock)?.[1]?.trim()
  if (version === undefined || version === '') {
    fail('upstream/deepseek-harness.lock names no version')
  }
  return version
}

/** The package a plugin reference names, without any subpath export. */
function packageOf(reference) {
  const parts = reference.split('/')
  return reference.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/**
 * Install every package the composed profile imports, as a direct dependency.
 *
 * Three facts about a DSH profile have to hold at once, and missing any one of
 * them produces a profile that composes and cannot boot.
 *
 * `dsh.profile.bundles` names layers, not packages. The base layer's patch
 * list names plugins -- `dsh-fs`, `dsh-sandbox`, `dsh-scope`, `dsh-timeout`
 * and a dozen more -- that are not dependencies of `@deepseek-ai/dsh-base`,
 * because a bundle declares what composes rather than what to fetch.
 *
 * So those plugins are not transitive dependencies of anything, and pnpm
 * prunes what nothing depends on. Installing them and then running any further
 * `pnpm add` removed them again: the profile lost fifty-odd packages per
 * install, and each attempt to fix it by adding one more package removed
 * more. They have to be direct dependencies.
 *
 * And they have to be added together. One `add` with the whole set computes
 * one graph; several adds compute several, and every one after the first
 * prunes what the previous one installed.
 *
 * The set comes from `dsh --dump-config`, which is DSH's own answer to what
 * the profile consists of, so it follows the baseline instead of being a list
 * here that a later version outgrows. The peers are read from the Watch
 * packages that declare them, for the same reason.
 */
function installComposedPlugins(cli, env, overlay) {
  const args = [cli.entry, '--profile', PROFILE]
  if (overlay !== null) args.push('--patch', overlay)
  args.push('--dump-config')
  const dumped = run(process.execPath, args, { env, cwd: ROOT })
  if (dumped.status !== 0) {
    fail('`dsh --dump-config` failed, so the composed plugin set is unknown',
      dumped.stderr || dumped.stdout)
  }

  const version = pinnedDshVersion()
  const specs = new Set()
  for (const match of (dumped.stdout ?? '').matchAll(/name:\s*'([^']+)'/g)) {
    // A plugin may be named by a subpath export --
    // `@deepseek-ai/dsh-tool-subagent-control/list-agents` is one entry in the
    // composed tree -- and a subpath is not something a registry can resolve.
    // Installing it verbatim fails the whole batch with
    // ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER, naming one entry out of a
    // hundred and thirty.
    const name = packageOf(match[1])
    if (!name.startsWith('@deepseek-ai/')) continue
    // Only `dsh-*` follows the DSH release line. The cordis plugins in the
    // same scope are versioned on their own -- cordis-plugin-timer is at 1.1.3
    // where DSH is at 0.1.1-rc.2 -- so pinning the whole scope to the baseline
    // version asks the registry for releases that do not exist, and the
    // install fails naming none of them.
    specs.add(name.startsWith('@deepseek-ai/dsh-') ? `${name}@${version}` : name)
  }
  if (specs.size === 0) fail('the composed profile named no plugin packages')

  for (const [name, range] of Object.entries(composedPeers())) specs.add(`${name}@${range}`)

  process.stdout.write(`installing ${String(specs.size)} composed package(s)
`)
  const added = run(
    process.execPath, [cli.entry, 'plugin', '--profile', PROFILE, 'add', ...specs],
    { env, cwd: ROOT },
  )
  if (added.status !== 0) {
    fail('installing the composed packages failed', added.stderr || added.stdout)
  }

  installPeerClosure(cli, env, version)
}

/**
 * Install what the installed plugins declare as peers, until nothing is left.
 *
 * DSH's plugin packages name their siblings in `peerDependencies` --
 * `dsh-session-telemetry-otel` peers on `dsh-session-telemetry`, and so on
 * down. In DSH's own repository every one of those resolves because the whole
 * workspace is present. A profile is not a workspace: pnpm does not
 * materialise an unsatisfied peer, and the first thing that imports one dies
 * at boot with ERR_MODULE_NOT_FOUND naming a package nothing asked for
 * directly.
 *
 * So the peers become direct dependencies too. It is a fixpoint rather than
 * one pass, because the peers have peers; it converges quickly and the loop is
 * bounded so a cycle cannot hang a build.
 */
function installPeerClosure(cli, env, version) {
  const modules = join(HOME, 'profiles', PROFILE, 'node_modules')

  for (let round = 0; round < 6; round += 1) {
    const missing = new Set()
    for (const scope of ['@deepseek-ai', '@watchskill']) {
      const dir = join(modules, scope)
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        const manifestPath = join(dir, name, 'package.json')
        if (!existsSync(manifestPath)) continue
        let manifest
        try {
          manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        } catch {
          continue
        }
        const optional = manifest.peerDependenciesMeta ?? {}
        for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
          if (!peer.startsWith('@deepseek-ai/')) continue
          if (optional[peer]?.optional === true) continue
          if (existsSync(join(modules, ...peer.split('/')))) continue
          missing.add(peer.startsWith('@deepseek-ai/dsh-') ? `${peer}@${version}` : peer)
        }
      }
    }
    if (missing.size === 0) return

    process.stdout.write(
      `  round ${String(round + 1)}: ${String(missing.size)} unsatisfied peer(s)
`)
    const added = run(
      process.execPath, [cli.entry, 'plugin', '--profile', PROFILE, 'add', ...missing],
      { env, cwd: ROOT },
    )
    if (added.status !== 0) fail('installing peer packages failed', added.stderr || added.stdout)
  }
  fail('the peer closure did not settle', 'six rounds of peer installation still found more')
}

/**
 * Peer dependencies the Watch packages need the profile to provide.
 *
 * Read from the workspace catalog rather than restated, so a catalog bump
 * moves the profile with it.
 */
function composedPeers() {
  const catalog = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
  const cordis = /"@deepseek-ai\/cordis":\s*(\S+)/.exec(catalog)?.[1]
  if (cordis === undefined) fail('pnpm-workspace.yaml declares no @deepseek-ai/cordis catalog entry')
  // React is a peer of every client package and is not in the catalog: the
  // workspace takes it from its own devDependencies.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const react = manifest.devDependencies?.react ?? manifest.dependencies?.react
  if (react === undefined) fail('the workspace declares no react version for the profile to match')
  return {
    '@deepseek-ai/cordis': cordis,
    react,
    'react-dom': react,
  }
}

function main() {
  const cli = findCli()
  if (cli === null) fail('the DSH CLI is not installed')

  const core = coreCandidates().find(candidate => existsSync(candidate))
  if (core === undefined) {
    process.stderr.write(
      'watch: Watch Core was not found; the profile will fall back to the mock backend\n',
    )
  }

  if (process.argv.includes('--rebuild')) removeTree(HOME)
  mkdirSync(HOME, { recursive: true })
  const env = {
    ...withPinnedPnpm(ROOT),
    DSH_HOME: HOME,
    // `dsh plugin` forwards to pnpm, and pnpm asks before removing a
    // node_modules whose store layout it does not recognise -- then aborts with
    // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when there is nobody to ask.
    // The stale layout it has to purge is what a previously unpinned pnpm left
    // behind; see pinProfilePackageManager above.
    //
    // This answers that one question and nothing else. Setting CI=true would
    // also have answered it, and would have turned on frozen-lockfile with it:
    // the profile manifest is rewritten by this script on every run, so a
    // frozen lockfile is guaranteed to be out of date and the install fails
    // with ERR_PNPM_OUTDATED_LOCKFILE. A generated profile is not a
    // reproducible build, and must not be treated as one.
    npm_config_confirm_modules_purge: 'false',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  }

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

  // Recorded once the manifest exists, so a person running pnpm in the profile
  // by hand gets the same version the shim gave DSH.
  pinProfilePackageManager()
  installDeclaredBundles(cli, env)

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

  // Before composition is checked, and before anything tries to boot: the
  // declared bundles are not the whole package set the composition imports.
  installComposedPlugins(cli, env, overlay)

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
