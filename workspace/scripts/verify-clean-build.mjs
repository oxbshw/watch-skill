#!/usr/bin/env node
/**
 * Build the Workspace the way a machine that has never built it would.
 *
 * Every other gate runs in the tree it is standing in, and that tree has built
 * before. Build output is ignored by git, so `git status` is clean while the
 * directory is full of it — and a compilation that resolves an ignored file
 * nobody generated in this run passes silently, for everyone who has built
 * once, forever.
 *
 * That is not a hypothesis. `packages/watch/tools/lib/typert.remote-client.d.ts`
 * is generated, ignored, and imported by a client half. On a warm machine the
 * whole solution compiled in one `tsc -b`. On a cold clone the first
 * compilation stopped at
 *
 *     TS2307: Cannot find module '@deepwatch/dsh-tools/remote'
 *
 * and three platform jobs and the gate suite went red at once, while `npm run
 * check` on the author's machine reported 1309 passing tests.
 *
 * So this gate manufactures the cold machine. It copies exactly what git
 * carries — tracked files plus anything untracked that is not ignored, which is
 * what a commit of the current work would produce — into a directory of its
 * own, checks that nothing generated came with it, installs from the frozen
 * lockfile, and runs the documented build command. Then it checks the things a
 * cold build is supposed to establish and a warm one cannot:
 *
 *   - the generated Typert Host and Remote artifacts exist afterwards,
 *   - every browser half emitted its bundle,
 *   - `typert:check` is clean against what the build produced,
 *   - a second build is idempotent and rewrites none of it,
 *   - and the build created nothing but ignored output, so a cold clone plus a
 *     build leaves a clean working tree.
 *
 * It is deliberately not part of `npm run check`. That suite runs inside this
 * tree, and a gate whose whole subject is a *different* tree belongs beside it
 * rather than inside it — the CI job `cold-build` is where it runs.
 *
 * Usage:
 *   node scripts/verify-clean-build.mjs
 *   node scripts/verify-clean-build.mjs --keep     leave the tree for inspection
 *   node scripts/verify-clean-build.mjs --json
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { withPinnedPnpm } from './lib/pnpm-shim.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')
const KEEP = process.argv.includes('--keep')

const problems = []
const steps = []
const fail = (message, fix) => { problems.push({ message, fix }) }
const slash = value => value.replaceAll('\\', '/')

/**
 * Paths that must never arrive with the checkout.
 *
 * Anything matching these is build output. Its presence in a tree that is
 * supposed to be cold means the copy is not a copy of what git carries, and
 * every conclusion below would be about the wrong tree.
 */
const GENERATED = [
  { label: 'compiled output', test: path => /(^|\/)packages\/[^/]+\/[^/]+\/lib(\/|$)/.test(path) },
  { label: 'compiled output', test: path => /(^|\/)apps\/[^/]+\/lib(\/|$)/.test(path) },
  { label: 'generated Typert artifact', test: path => /(^|\/)typert\.(host|remote-client)\./.test(path) },
  { label: 'incremental build cache', test: path => path.endsWith('.tsbuildinfo') },
  { label: 'installed dependencies', test: path => /(^|\/)node_modules(\/|$)/.test(path) },
  { label: 'bundler cache', test: path => /(^|\/)(\.turbo|dist|out)(\/|$)/.test(path) },
]

/**
 * Gates in `npm run check` that cannot run before `npm run build`.
 *
 * Each reads something the build emits, and each fails on a cold tree with a
 * message about its own subject rather than about the ordering:
 *
 *   - `lint` is type-aware. eslint resolves a cross-package type through the
 *     emitted declaration, exactly as `tsc` does, so a missing generated
 *     `.d.ts` becomes `Unsafe argument of type error typed` — a rule violation
 *     naming neither the module nor the build. This is not hypothetical: it is
 *     what CI reported at 224a206 while the same command passed locally.
 *   - `typert:check` compares generated artifacts against the disk.
 *   - `verify:client` reads each browser half's bundle.
 *   - `test` imports `lib/`.
 */
const AFTER_BUILD = ['lint', 'typert:check', 'verify:client', 'test']

/** The generated protocol, by the names `gen-typert.mjs` writes. */
const TYPERT_ARTIFACTS = [
  'packages/watch/tools/lib/typert.host.js',
  'packages/watch/tools/lib/typert.host.d.ts',
  'packages/watch/tools/lib/typert.remote-client.js',
  'packages/watch/tools/lib/typert.remote-client.d.ts',
  'packages/watch/tools/lib/typert.remote-client.d.ts.map',
]

function git(args, cwd = ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  }
  return result.stdout
}

/** Run one command in the clean tree, recording what it cost and whether it worked. */
function run(label, command, args, cwd, env) {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // A `.cmd` shim needs a shell on Windows; every argument here is ours.
    shell: process.platform === 'win32',
  })
  const step = {
    label,
    status: result.status,
    seconds: Math.round((Date.now() - started) / 100) / 10,
  }
  steps.push(step)
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')
    step.tail = output.slice(-20)
  }
  return { ...result, ok: result.status === 0 }
}

/** Everything a commit of the current work would carry, relative to the workspace. */
function carriedFiles() {
  return git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter(entry => entry !== '')
}

/** Copy that file list into a directory of this gate's own. */
function materialize(files) {
  const base = process.env.WATCH_CLEAN_BUILD_DIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  // Short by design: pnpm's store layout is deep, and a long prefix on Windows
  // reaches MAX_PATH inside node_modules rather than in anything we control.
  const dir = mkdtempSync(join(base, 'wcb-'))
  for (const file of files) {
    const target = join(dir, file)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(ROOT, file), target)
  }
  return dir
}

/** Every path in a tree, workspace-relative, skipping node_modules. */
function walk(dir, prefix = '', found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) walk(join(dir, entry.name), relativePath, found)
    else found.push(relativePath)
  }
  return found
}

/** The digests the build produced for the generated protocol. */
function typertDigests(dir) {
  const digests = {}
  for (const file of TYPERT_ARTIFACTS) {
    const path = join(dir, file)
    digests[file] = existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  return digests
}

function main() {
  const carried = carriedFiles()
  if (carried.length < 100) {
    fail(`git reports only ${String(carried.length)} carried file(s)`,
      'Run this from inside the workspace of a git checkout.')
    return report({})
  }

  // ── the gate suite orders itself around the build ────────────────────────
  // Read before anything is copied, because it is a statement about the suite
  // rather than about a tree, and because a wrong order here makes the cold
  // run below fail for a reason that has nothing to do with the build.
  const chain = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts?.check ?? ''
  const position = name => chain.indexOf(`npm run ${name} `) === -1
    ? chain.indexOf(`npm run ${name}`)
    : chain.indexOf(`npm run ${name} `)
  const buildAt = position('build')
  if (buildAt === -1) {
    fail('`npm run check` does not run the build',
      'Every gate below it reads what the build emits.')
  } else {
    for (const name of AFTER_BUILD) {
      const at = position(name)
      if (at !== -1 && at < buildAt) {
        fail(`\`npm run check\` runs ${name} before build`,
          `${name} reads what the build emits, so on a checkout that has never `
          + 'been built it fails about its own subject instead of about the build.')
      }
    }
  }

  // ── the checkout is cold ─────────────────────────────────────────────────
  for (const file of carried) {
    const path = slash(file)
    const generated = GENERATED.find(rule => rule.test(path))
    if (generated !== undefined) {
      fail(`git carries ${path}, which is ${generated.label}`,
        'A tracked build artifact makes every cold-build claim below vacuous. '
        + 'Either it is genuinely a source file, or .gitignore is wrong.')
    }
  }
  if (problems.length > 0) return report({ carried: carried.length })

  const dir = materialize(carried)
  const env = withPinnedPnpm(dir, { ...process.env })

  try {
    for (const path of walk(dir)) {
      const generated = GENERATED.find(rule => rule.test(path))
      if (generated !== undefined) {
        fail(`the clean tree contains ${path} (${generated.label})`,
          'The copy is not cold, so nothing it builds proves anything.')
      }
    }
    if (problems.length > 0) return report({ dir, carried: carried.length })

    // ── install, then build, exactly as documented ──────────────────────────
    const install = run('pnpm install --frozen-lockfile', 'pnpm',
      ['install', '--frozen-lockfile'], dir, env)
    if (!install.ok) {
      fail('the frozen lockfile does not install into a clean checkout',
        'A lockfile that only resolves against an existing node_modules is not a lockfile.')
      return report({ dir, carried: carried.length })
    }
    if (/cyclic workspace dependencies/i.test(`${install.stdout}${install.stderr}`)) {
      fail('pnpm reports a cyclic workspace dependency',
        'Run `node scripts/verify-package-graph.mjs`, which names the cycle.')
    }

    const build = run('pnpm run build', 'pnpm', ['run', 'build'], dir, env)
    if (!build.ok) {
      fail('the documented build command fails on a clean checkout',
        'This is the whole point of the gate: the build must not require a '
        + 'previously generated ignored file. The last lines of the failure are above.')
      return report({ dir, carried: carried.length })
    }

    // ── what the build was supposed to produce ──────────────────────────────
    for (const file of TYPERT_ARTIFACTS) {
      if (!existsSync(join(dir, file))) {
        fail(`the build did not produce ${file}`,
          'The Remote protocol is build output, and the client half imports it.')
      }
    }

    const clientPackages = readdirSync(join(dir, 'packages', 'watch'))
      .filter(entry => {
        const manifest = join(dir, 'packages', 'watch', entry, 'package.json')
        return existsSync(manifest)
          && JSON.parse(readFileSync(manifest, 'utf8')).dsh?.client !== undefined
      })
    for (const entry of clientPackages) {
      const bundle = join(dir, 'packages', 'watch', entry, 'lib', 'client.js')
      if (!existsSync(bundle)) {
        fail(`the build did not bundle packages/watch/${entry}`,
          'A browser half with no bundle boots with the plugin silently absent.')
      }
    }

    // ── the type-aware gates read what the build emitted ────────────────────
    // eslint's type information comes from the same project graph `tsc` uses,
    // so it resolves a cross-package type through the *emitted* declaration and
    // is exactly as cold-sensitive as the compiler. Running it here, after the
    // build and never before it, is what makes that concrete rather than a
    // claim about the ordering in package.json.
    const lint = run('pnpm run lint', 'pnpm', ['run', 'lint'], dir, env)
    if (!lint.ok) {
      fail('type-aware lint fails on a clean checkout that has been built',
        'eslint resolves cross-package types through emitted declarations. If it '
        + 'fails here, the build did not emit something it reads.')
    }

    // ── the freshness gate agrees with what the build produced ──────────────
    const fresh = run('typert:check', process.execPath,
      [join(dir, 'scripts', 'gen-typert.mjs'), '--check'], dir, env)
    if (!fresh.ok) {
      fail('typert:check is not clean immediately after a clean build',
        'The build generated something the same generator does not recognise as current.')
    }

    // ── and building again changes nothing ──────────────────────────────────
    const before = typertDigests(dir)
    const again = run('pnpm run build (second)', 'pnpm', ['run', 'build'], dir, env)
    if (!again.ok) {
      fail('the second build fails where the first succeeded',
        'A build that is not idempotent cannot be trusted to have produced the first result either.')
    }
    const after = typertDigests(dir)
    for (const file of TYPERT_ARTIFACTS) {
      if (before[file] !== after[file]) {
        fail(`${file} changed between two builds of the same source`,
          'Generation must be deterministic, or the freshness gate is a coin toss.')
      }
    }

    // ── the build created only what git would ignore ────────────────────────
    // git's own ignore engine, rather than a second copy of the rules here. A
    // build that leaves an unignored file behind fails `git diff --exit-code`
    // on somebody else's machine, having passed on the author's.
    git(['init', '--quiet'], dir)
    git(['add', '-A'], dir)
    const staged = git(['status', '--porcelain', '--untracked-files=all'], dir)
      .split('\n')
      .filter(line => line.trim() !== '')
      .filter(line => !line.startsWith('A '))
    if (staged.length > 0) {
      fail(`the build left ${String(staged.length)} unignored change(s):\n         `
        + staged.slice(0, 10).map(line => line.trim()).join('\n         '),
      'Build output must be ignored, or the platform jobs fail on `git diff --exit-code`.')
    }

    return report({
      dir,
      carried: carried.length,
      builtFiles: walk(dir).length,
      clientBundles: clientPackages.length,
    })
  } finally {
    if (!KEEP) rmSync(dir, { recursive: true, force: true })
  }
}

function report(summary) {
  const ok = problems.length === 0
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify({ ok, summary, steps, problems }, null, 2)}\n`)
    process.exit(ok ? 0 : 1)
  }

  process.stdout.write('clean build\n\n')
  if (summary.dir !== undefined) {
    process.stdout.write(`  tree             ${KEEP ? summary.dir : `${slash(relative(tmpdir(), summary.dir))} (removed)`}\n`)
  }
  for (const [key, value] of Object.entries(summary)) {
    if (key === 'dir') continue
    process.stdout.write(`  ${key.padEnd(16)} ${String(value)}\n`)
  }
  process.stdout.write('\n')
  for (const step of steps) {
    process.stdout.write(`  ${step.status === 0 ? 'ok  ' : 'FAIL'} ${String(step.seconds).padStart(6)}s  ${step.label}\n`)
    for (const line of step.tail ?? []) process.stdout.write(`         ${line}\n`)
  }
  process.stdout.write('\n')
  for (const problem of problems) {
    process.stdout.write(` FAIL  ${problem.message}\n        ${problem.fix}\n`)
  }
  process.stdout.write(ok
    ? 'A checkout with no build output installs, builds, and builds again unchanged.\n'
    : `\n${String(problems.length)} problem(s).\n`)
  process.exit(ok ? 0 : 1)
}

main()
