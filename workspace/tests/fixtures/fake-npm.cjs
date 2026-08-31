#!/usr/bin/env node
/**
 * An npm that installs nothing and produces the shape of a finished install.
 *
 * The transaction in `lib/provision.ts` has twelve phases, and each one has to
 * be shown to leave the destination untouched when it fails. Proving that
 * against the real package manager would mean five hundred packages fetched
 * twelve times to watch twelve failures — slow enough that the gate would stop
 * being run, which is the same as not having it. This produces a tree with the
 * properties the phases actually read: a manifest per package, a Harness that
 * answers `--version`, a bundle that declares and ships its layer, and a
 * `dsh` that can initialise and dump a profile.
 *
 * It is not a mock of npm. It is a directory in the shape npm would leave, and
 * every assertion made against it is about DeepWatch's own transaction rather
 * than about npm's behaviour. The real invocation is exercised end to end by
 * `scripts/verify-packed-install.mjs` and by `deepwatch setup` itself.
 *
 * Behaviour is steered by the environment, so one fixture covers the whole
 * counterfactual set:
 *
 * - `FAKE_NPM_EXIT`          exit with this code, installing nothing
 * - `FAKE_NPM_HANG`          never exit, so the caller's deadline is what ends it
 * - `FAKE_NPM_MISSING_PEER`  add a package with an unmet required peer
 * - `FAKE_NPM_NO_HARNESS`    install everything except the Harness entry point
 * - `FAKE_NPM_BAD_VERSION`   install a DeepWatch package at the wrong version
 * - `FAKE_NPM_NO_LICENCE`    install a package that declares no licence
 * - `FAKE_NPM_NO_BUNDLE`     install the bundle package without its layer
 * - `FAKE_NPM_DEAD_DSH`      install a Harness that cannot start
 */

'use strict'

const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const cwd = process.cwd()

if (process.env.FAKE_NPM_HANG === '1') {
  setInterval(() => {}, 1000)
  return
}
const exit = process.env.FAKE_NPM_EXIT
if (exit !== undefined) {
  process.stderr.write('fake npm: refusing on purpose\n')
  process.exit(Number(exit))
}

const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
const modules = join(cwd, 'node_modules')

/** Write one installed package. */
function place(name, fields) {
  const dir = join(modules, ...name.split('/'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'),
    `${JSON.stringify({ name, license: 'MIT', ...fields }, null, 2)}\n`)
  return dir
}

/** The version a `file:` specification points at, read from the fixture bytes. */
function versionOf(spec) {
  if (!spec.startsWith('file:')) return spec
  const tarball = join(cwd, spec.slice('file:'.length))
  if (!existsSync(tarball)) return '0.0.0'
  const match = /@([0-9][^\s]*)\s*$/.exec(readFileSync(tarball, 'utf8').trim())
  return match === null ? '0.0.0' : match[1]
}

const HARNESS = '@deepseek-ai/dsh'
const BUNDLE = '@deepwatch/dsh-bundle'

for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
  const version = process.env.FAKE_NPM_BAD_VERSION === '1' && name === '@deepwatch/dsh-library'
    ? '9.9.9-wrong'
    : versionOf(spec)

  if (name === HARNESS) {
    const dir = place(name, { version, bin: { dsh: 'lib/bin.js' } })
    if (process.env.FAKE_NPM_NO_HARNESS === '1') continue
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'bin.js'), harnessSource(version))
    continue
  }

  if (name === BUNDLE) {
    // Installed at the right version either way, so the integrity check
    // passes and the *bundle* check is what a test is exercising.
    if (process.env.FAKE_NPM_NO_BUNDLE === '1') { place(name, { version }); continue }
    const dir = place(name, { version, dsh: { bundle: { patch: './cordis.patch.yml' } } })
    writeFileSync(join(dir, 'cordis.patch.yml'), '# fixture layer\n')
    continue
  }

  place(name, { version })
}

if (process.env.FAKE_NPM_MISSING_PEER === '1') {
  place('@fixture/needs-a-peer', {
    version: '1.0.0',
    peerDependencies: { '@fixture/absent-peer': '^1.0.0' },
  })
}
if (process.env.FAKE_NPM_NO_LICENCE === '1') {
  const dir = join(modules, '@fixture', 'unlicensed')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'),
    `${JSON.stringify({ name: '@fixture/unlicensed', version: '1.0.0' }, null, 2)}\n`)
}

process.stdout.write('fake npm: wrote a tree\n')

/**
 * A `dsh` that answers the questions composition asks it, and no others.
 *
 * `--version`; `plugin --profile <name> install`, which seeds a profile whose
 * bundle list is `@deepseek-ai/dsh-base` exactly as the real Harness does for
 * a profile not called `web`; `plugin --profile <name> add <files>`, which
 * refuses anything that is not an existing tarball path, because handing a
 * bare `@deepwatch/...` name to pnpm is the failure this whole arrangement
 * exists to avoid; `--dump-config`; and booting, which prints the loopback URL
 * the readiness probe waits for and then stays up until it is stopped.
 *
 * Anything else exits non-zero, so a phase that started asking a new question
 * fails here rather than passing by accident.
 */
function harnessSource(version) {
  if (process.env.FAKE_NPM_DEAD_DSH === '1') return 'process.exit(3)\n'
  return [
    "'use strict'",
    "const { mkdirSync, existsSync, writeFileSync } = require('node:fs')",
    "const { join } = require('node:path')",
    "const { createServer } = require('node:http')",
    'const argv = process.argv.slice(2)',
    `if (argv.includes('--version')) { process.stdout.write('${version}\\n'); process.exit(0) }`,
    "const at = argv.indexOf('--profile')",
    "const profile = at < 0 ? 'deepwatch' : argv[at + 1]",
    "const home = process.env.DSH_HOME",
    "if (typeof home !== 'string' || home === '') process.exit(4)",
    "const dir = join(home, 'profiles', profile)",
    "const manifest = join(dir, 'package.json')",
    "if (argv.includes('install')) {",
    '  mkdirSync(dir, { recursive: true })',
    '  if (!existsSync(manifest)) {',
    "    writeFileSync(manifest, JSON.stringify({",
    "      name: 'dsh-profile-' + profile, private: true, version: '0.0.0',",
    '      dependencies: {},',
    "      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },",
    '    }, null, 2) + \'\\n\')',
    '  }',
    '  process.exit(0)',
    '}',
    "if (argv.includes('add')) {",
    "  const files = argv.slice(argv.indexOf('add') + 1)",
    '  if (files.length === 0) process.exit(6)',
    '  for (const file of files) {',
    '    // A name rather than a path is the 404 this arrangement exists to avoid.',
    "    if (!file.endsWith('.tgz') || !existsSync(file)) process.exit(7)",
    '  }',
    "  const current = JSON.parse(require('node:fs').readFileSync(manifest, 'utf8'))",
    '  current.dependencies = current.dependencies ?? {}',
    '  for (const file of files) {',
    "    const base = file.split(/[\\\\/]/).pop()",
    "    const name = '@deepwatch/' + base.replace(/^deepwatch-/, '').replace(/-\\d.*\\.tgz$/, '')",
    "    current.dependencies[name] = 'file:' + file",
    '  }',
    "  writeFileSync(manifest, JSON.stringify(current, null, 2) + '\\n')",
    '  process.exit(0)',
    '}',
    "if (argv.includes('--dump-config')) {",
    '  if (!existsSync(manifest)) process.exit(5)',
    "  process.stdout.write('{}\\n')",
    '  process.exit(0)',
    '}',
    "if (process.env.FAKE_DSH_NO_SERVE === '1') process.exit(8)",
    '// Booting: bind a loopback port and say which one, the way the Harness does.',
    "const portAt = argv.indexOf('--port')",
    'const asked = portAt < 0 ? 0 : Number(argv[portAt + 1])',
    "const server = createServer((_, response) => {",
    "  response.writeHead(200, { 'content-type': 'text/html' })",
    "  response.end('<!doctype html><title>DeepWatch</title><p>fixture</p>')",
    '})',
    "server.listen(asked, '127.0.0.1', () => {",
    "  process.stdout.write('dsh web: http://127.0.0.1:' + server.address().port + '\\n')",
    '})',
    '',
  ].join('\n')
}
