/**
 * The process-launch boundary, and the defect that made it worth testing.
 *
 * `@deepwatch/cli@0.1.0-preview.0` could not provision the Harness on Windows
 * at all. `ensureHarness` chose `npm.cmd` and spawned it with `shell: false`;
 * Node has refused to start a batch shim that way since the CVE-2024-27980
 * hardening, and every Node version this CLI declares support for enforces it.
 * The result was `spawn EINVAL` after the consent prompt, on every Windows
 * machine, with nothing in the message pointing at the cause.
 *
 * What makes it a *process-boundary* test rather than an npm test: the release
 * tooling already knew about this and worked around it in a local helper. Two
 * implementations of one boundary, and the half a user runs was the broken
 * one. So the property under test is not only "npm runs" but "there is one
 * boundary, it is shell-free, and the shape that failed is refused loudly
 * rather than reaching `spawn`".
 *
 * Everything here runs on every platform. The batch-shim guard is deliberately
 * not platform-conditional — a POSIX CI job that skipped it would have let the
 * Windows regression back in unseen, which is precisely how it shipped.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'packages', 'watch', 'cli')
const exec = await import(pathToFileURL(join(CLI, 'lib', 'lib', 'exec.js')).href)

const rooms = []
test.after(() => {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

/** A scratch directory, optionally with a space in its name. */
function room(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  rooms.push(dir)
  return dir
}

describe('the batch shim that broke Windows', () => {
  test('run refuses a .cmd rather than letting spawn fail with EINVAL', async () => {
    // The exact call `ensureHarness` used to make.
    await assert.rejects(
      () => exec.run('npm.cmd', ['--version'], { timeoutMs: 5_000 }),
      error => {
        assert.equal(error.name, 'UnsafeCommandError')
        assert.equal(error.failure, 'unsafe-argument')
        assert.match(error.message, /npm\.cmd/)
        // A refusal that does not say what to do instead is a dead end.
        assert.match(error.fix, /resolveNodeCli/)
        return true
      },
    )
  })

  test('a .bat is refused the same way', async () => {
    await assert.rejects(
      () => exec.run('something.bat', [], { timeoutMs: 5_000 }),
      { name: 'UnsafeCommandError' },
    )
  })

  test('the guard is not platform-conditional', () => {
    // Read as source rather than behaviour: the point is that no future edit
    // can make this Windows-only, because a POSIX-only CI job would then stop
    // seeing the regression.
    const source = readFileSync(join(CLI, 'src', 'lib', 'exec.ts'), 'utf8')
    const guard = /BATCH_SHIM\s*=\s*\/\\\.\(cmd\|bat\)\$\/i/
    assert.match(source, guard, 'the batch-shim pattern should be a plain constant')
    assert.doesNotMatch(
      source.slice(source.indexOf('export function run(')),
      /platform === 'win32'[\s\S]{0,200}BATCH_SHIM/,
      'the refusal must not be gated on the platform',
    )
  })
})

describe('resolving a package manager', () => {
  test('npm resolves to a Node entry point, never to a shim', () => {
    const npm = exec.resolveNpm()
    assert.notEqual(npm, null, 'npm should be resolvable wherever this suite runs')
    if (npm.kind === 'node-entry') {
      assert.equal(npm.command, process.execPath)
      assert.match(npm.prefix[0], /npm-cli\.js$/)
    } else {
      // Only ever a real executable, and only off Windows.
      assert.equal(npm.kind, 'executable')
      assert.notEqual(process.platform, 'win32')
    }
    for (const part of [npm.command, ...npm.prefix]) {
      assert.doesNotMatch(part, /\.(cmd|bat)$/i, 'nothing resolved may be a batch shim')
    }
  })

  test('on Windows npm is always the Node entry, because a shim cannot be run', () => {
    if (process.platform !== 'win32') return
    const npm = exec.resolveNpm()
    assert.equal(npm.kind, 'node-entry')
  })

  test('the resolved npm actually runs and answers', async () => {
    const npm = exec.resolveNpm()
    const ran = await exec.run(npm.command, [...npm.prefix, '--version'], { timeoutMs: 120_000 })
    assert.equal(ran.failure, undefined, `npm did not start: ${ran.stderr}`)
    assert.equal(ran.code, 0)
    assert.match(ran.stdout.trim(), /^\d+\.\d+\.\d+/)
  })

  test('pnpm resolves the same way', () => {
    const pnpm = exec.resolvePnpm()
    if (pnpm === null) return // a machine with no pnpm is allowed
    for (const part of [pnpm.command, ...pnpm.prefix]) {
      assert.doesNotMatch(part, /\.(cmd|bat)$/i)
    }
  })

  test('the bundled Node layout beside bin is discoverable', () => {
    const source = readFileSync(join(CLI, 'src', 'lib', 'exec.ts'), 'utf8')
    assert.match(
      source,
      /join\(dirname\(nodeDir\), 'node_modules', tool, relative\)/,
      'embedded runtimes place pnpm at <node>/node_modules while node.exe is at <node>/bin',
    )
  })
})

describe('paths and arguments', () => {
  test('a destination path containing spaces is an argument, not a parse problem', async () => {
    const dir = room('deepwatch boundary ')
    const script = join(dir, 'where am i.cjs')
    writeFileSync(script, 'process.stdout.write(process.argv[2])\n')
    const payload = join(dir, 'a directory with spaces')
    const ran = await exec.run(process.execPath, [script, payload], { timeoutMs: 30_000 })
    assert.equal(ran.code, 0)
    // Whole and unsplit, which is the thing a shell would have got wrong.
    assert.equal(ran.stdout, payload)
  })

  test('shell metacharacters reach the child verbatim and are never interpreted', async () => {
    const dir = room('deepwatch-meta-')
    const script = join(dir, 'echo.cjs')
    writeFileSync(script, 'process.stdout.write(process.argv[2])\n')
    // If any of this were interpreted, the marker file would exist and the
    // output would be truncated at the metacharacter.
    const hostile = 'a & echo pwned > pwned.txt | b ^ c "d" %PATH% $(id) `id`'
    const ran = await exec.run(process.execPath, [script, hostile], { cwd: dir, timeoutMs: 30_000 })
    assert.equal(ran.code, 0)
    assert.equal(ran.stdout, hostile)
  })

  test('the shim path refuses a metacharacter rather than escaping it', () => {
    assert.throws(() => exec.assertSafeShimArgument('a & b'), { name: 'UnsafeCommandError' })
    assert.throws(() => exec.assertSafeShimArgument('has a space'), { name: 'UnsafeCommandError' })
    assert.throws(() => exec.assertSafeShimArgument('x | y'), { name: 'UnsafeCommandError' })
    assert.throws(() => exec.assertSafeShimArgument('%PATH%'), { name: 'UnsafeCommandError' })
    assert.throws(() => exec.assertSafeShimArgument('a\nb'), { name: 'UnsafeCommandError' })
  })

  test('the shim path accepts the shapes a real package spec has', () => {
    for (const safe of [
      '@deepseek-ai/dsh@0.1.1-rc.2',
      '--registry=https://registry.npmjs.org',
      'C:\\Users\\someone\\AppData\\Local\\deepwatch\\harness',
      '/home/someone/.local/state/deepwatch',
      '--no-audit',
    ]) {
      assert.doesNotThrow(() => exec.assertSafeShimArgument(safe), safe)
    }
  })

  test('launchWindowsShim refuses before it creates a process', async () => {
    await assert.rejects(
      () => exec.launchWindowsShim('npm.cmd', ['install', 'a & b'], { timeoutMs: 5_000 }),
      { name: 'UnsafeCommandError' },
    )
  })

  test('a shim at a quoted path actually runs, rather than being mis-parsed', async () => {
    // The quoting rule that has to be exactly right and looks fine when it is
    // not. `cmd /d /s /c` strips one leading and one trailing quote from what
    // follows it, so a command line whose *whole* text is a quoted path
    // arrives unquoted and `cmd` reports that it is not recognised. The fix is
    // one more pair of quotes around the lot, plus verbatim arguments so Node
    // does not add quoting of its own on top. Only running a real shim catches
    // getting either half wrong -- the global-install gate did, once this
    // stopped going through a shell.
    if (process.platform !== 'win32') return
    const dir = room('deepwatch-shim-')
    const shim = join(dir, 'answer.cmd')
    writeFileSync(shim, '@echo off\r\necho shim-ran %1\r\n')

    const ran = await exec.launchWindowsShim(shim, ['--version'], { timeoutMs: 30_000 })

    assert.equal(ran.code, 0, `${ran.stdout}${ran.stderr}`)
    // `cmd` hands `%1` through with its quotes, which is `cmd`'s business;
    // what matters is that the shim was found, started, and saw the argument.
    assert.match(ran.stdout, /shim-ran "?--version"?/)
    assert.doesNotMatch(`${ran.stdout}${ran.stderr}`, /is not recognized/)
  })
})

describe('telling failures apart', () => {
  test('a missing executable is a spawn failure, not an exit code', async () => {
    const ran = await exec.run('deepwatch-no-such-program', [], { timeoutMs: 30_000 })
    assert.equal(ran.failure, 'spawn-failed')
    assert.equal(ran.code, null)
    assert.equal(ran.timedOut, false)
  })

  test('a non-zero exit is an answer, with no failure attached', async () => {
    const ran = await exec.run(process.execPath, ['-e', 'process.exit(3)'], { timeoutMs: 30_000 })
    assert.equal(ran.code, 3)
    assert.equal(ran.failure, undefined)
  })

  test('a deadline stops the child and says so', async () => {
    const ran = await exec.run(
      process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { timeoutMs: 500 })
    assert.equal(ran.timedOut, true)
    assert.equal(ran.failure, 'timeout')
  })

  test('an abort cancels, and is not reported as a timeout', async () => {
    const controller = new AbortController()
    const running = exec.run(
      process.execPath, ['-e', 'setTimeout(() => {}, 120000)'],
      { timeoutMs: 120_000, signal: controller.signal })
    setTimeout(() => { controller.abort() }, 200)
    const ran = await running
    assert.equal(ran.failure, 'cancelled')
    assert.equal(ran.timedOut, false)
  })

  test('an already-aborted signal never starts a process', async () => {
    const ran = await exec.run(process.execPath, ['-e', 'process.exit(0)'],
      { timeoutMs: 30_000, signal: AbortSignal.abort() })
    assert.equal(ran.failure, 'cancelled')
    assert.equal(ran.code, null)
  })

  test('stdout and stderr are captured separately', async () => {
    const ran = await exec.run(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      { timeoutMs: 30_000 })
    assert.equal(ran.stdout, 'out')
    assert.equal(ran.stderr, 'err')
  })
})

describe('diagnostics never publish a credential', () => {
  test('the executable and its arguments stay separate values', () => {
    const described = exec.describeCommand('/usr/bin/node', ['install', '--no-audit'])
    assert.equal(described.executable, '/usr/bin/node')
    assert.deepEqual(described.arguments, ['install', '--no-audit'])
    assert.equal(typeof described.arguments, 'object', 'never a joined command line')
  })

  test('a credential-shaped argument is redacted', () => {
    const secrets = [
      '--//registry.npmjs.org/:_authToken=npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '--token=abcdefghijklmnop',
      'api_key=0123456789abcdef',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
    ]
    for (const secret of secrets) {
      const described = exec.describeCommand('npm', ['install', secret])
      assert.deepEqual(described.arguments, ['install', '«redacted»'], secret)
    }
  })

  test('an ordinary argument survives intact, so the log stays useful', () => {
    const described = exec.describeCommand('npm', [
      'install', '--registry=https://registry.npmjs.org', '@deepseek-ai/dsh@0.1.1-rc.2',
    ])
    assert.deepEqual(described.arguments, [
      'install', '--registry=https://registry.npmjs.org', '@deepseek-ai/dsh@0.1.1-rc.2',
    ])
  })

  test('credential-shaped environment values are redacted and their names are not', () => {
    const described = exec.describeEnv({
      PATH: '/usr/bin',
      OPENROUTER_API_KEY: 'must-never-appear',
      WATCHSKILL_OPENROUTER_API_KEY: 'must-never-appear',
      NPM_TOKEN: 'must-never-appear',
      GITHUB_AUTH: 'must-never-appear',
      DSH_HOME: '/home/someone/.local/state/deepwatch/dsh-home',
    })
    assert.equal(described.PATH, '/usr/bin')
    assert.equal(described.DSH_HOME, '/home/someone/.local/state/deepwatch/dsh-home')
    for (const name of [
      'OPENROUTER_API_KEY', 'WATCHSKILL_OPENROUTER_API_KEY', 'NPM_TOKEN', 'GITHUB_AUTH',
    ]) {
      assert.equal(described[name], '«redacted»', name)
      assert.ok(name in described, 'the name is kept; only the value goes')
    }
    assert.doesNotMatch(JSON.stringify(described), /must-never-appear/)
  })
})

describe('one boundary, shared', () => {
  test('the release tooling imports the product boundary rather than copying it', () => {
    const shared = readFileSync(join(ROOT, 'scripts', 'lib', 'process.mjs'), 'utf8')
    assert.match(shared, /packages\/watch\/cli\/lib\/lib\/exec\.js/)
    // It must re-export, not reimplement: a `spawn` here is a second boundary.
    assert.doesNotMatch(shared, /from 'node:child_process'/)
  })

  test('no release script builds its own shell command line for a package manager', () => {
    const source = readFileSync(join(ROOT, 'scripts', 'pack-release.mjs'), 'utf8')
    assert.doesNotMatch(source, /shell:\s*true/, 'pack-release must not ask for a shell')
    assert.match(source, /resolvePnpm/, 'it should resolve pnpm through the shared boundary')
  })

  test('bootstrap is the only script that asks for a shell, and says why', () => {
    // Every other script resolves a tool's Node entry and runs it directly.
    // `bootstrap.mjs` cannot: the shared boundary is the built CLI, and
    // bootstrap is what runs before anything is built. That is a real
    // exception with a real reason, and it has to stay the only one.
    const scripts = join(ROOT, 'scripts')
    const asking = []
    const walk = at => {
      for (const name of readdirSync(at)) {
        const full = join(at, name)
        if (statSync(full).isDirectory()) { walk(full); continue }
        if (!name.endsWith('.mjs')) continue
        const source = readFileSync(full, 'utf8')
        if (/shell:\s*true/.test(source)) asking.push(relative(ROOT, full).split(sep).join('/'))
      }
    }
    walk(scripts)
    assert.deepEqual(asking, ['scripts/bootstrap.mjs'])
    const bootstrap = readFileSync(join(scripts, 'bootstrap.mjs'), 'utf8')
    assert.match(bootstrap, /runs \*before\* anything is built/,
      'the exception must carry the reason it is one')
  })

  test('the install invocation is the product\'s, wherever it is used', () => {
    // `--legacy-peer-deps` is a decision with a documented cost, so there is
    // one place that makes it. A second `install` argument list anywhere in
    // the release tooling is a second place that can decide differently.
    for (const name of ['verify-packed-install.mjs', 'verify-packed-exec.mjs']) {
      const source = readFileSync(join(ROOT, 'scripts', name), 'utf8')
      assert.match(source, /installInvocation/,
        `${name} must build its install through the product's builder`)
      assert.doesNotMatch(source, /'install',\s*'--legacy-peer-deps'/,
        `${name} must not assemble its own install arguments`)
    }
  })

  test('the CLI never names a batch shim', () => {
    for (const file of ['harness.ts', 'exec.ts']) {
      const source = readFileSync(join(CLI, 'src', 'lib', file), 'utf8')
      // `exec.ts` names the extensions in its guard and its documentation,
      // which is the point; what may not exist anywhere is a command literal.
      assert.doesNotMatch(source, /'npm\.cmd'/, `${file} must not name npm.cmd as a command`)
      assert.doesNotMatch(source, /'pnpm\.cmd'/, `${file} must not name pnpm.cmd as a command`)
    }
  })

  test('every Node this CLI supports enforces the restriction being worked around', () => {
    const engines = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).engines.node
    // The batch-shim refusal landed in 18.20.2 / 20.12.2 / 21.7.3. This CLI's
    // floor is well above all three, so there is no supported Node on which
    // spawning a shim would have worked and none on which the fix is unneeded.
    assert.equal(engines, '^22.19.0 || >=24.0.0')
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22)
  })
})
