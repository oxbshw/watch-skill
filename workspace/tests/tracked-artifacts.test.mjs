/**
 * The tracked-artifacts gate, shown firing.
 *
 * A gate that has only ever passed is indistinguishable from a gate that
 * cannot fail, and this one guards three things that are invisible in review:
 * a packed tarball (a diff shows "binary file changed"), a stale package
 * scope, and an absolute build-machine path inside a bundle.
 *
 * So every rule gets a positive control. Each test writes a file that must be
 * refused into a scratch checkout, runs the real gate against it, and asserts
 * the exit status and the named rule. Nothing here touches the repository's
 * own tree.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = join(ROOT, 'scripts', 'verify-tracked-artifacts.mjs')

/**
 * A throwaway git repository with the gate copied in at its real path.
 *
 * The gate resolves the repository root two levels above itself and asks git
 * what is tracked, so a scratch checkout has to reproduce that layout rather
 * than be pointed at with a flag. Copying it is what lets a positive control
 * run without committing a forbidden file anywhere real.
 */
function scratchRepo(files) {
  const root = mkdtempSync(join(tmpdir(), 'watch-artifacts-'))
  mkdirSync(join(root, 'workspace', 'scripts'), { recursive: true })
  cpSync(GATE, join(root, 'workspace', 'scripts', 'verify-tracked-artifacts.mjs'))

  for (const [relative, contents] of Object.entries(files)) {
    const absolute = join(root, relative)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents)
  }

  for (const args of [
    ['init', '--quiet'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['add', '-A'],
    ['commit', '--quiet', '-m', 'chore: fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args[0]} failed: ${result.stderr}`)
  }
  return root
}

/** Run the gate inside a scratch repo and return its JSON verdict. */
function runGate(root) {
  const result = spawnSync(
    process.execPath,
    [join(root, 'workspace', 'scripts', 'verify-tracked-artifacts.mjs'), '--json'],
    { cwd: root, encoding: 'utf8' },
  )
  return { status: result.status, report: JSON.parse(result.stdout) }
}

/** Build a scratch repo, assert against it, and always clean it up. */
function withRepo(files, body) {
  const root = scratchRepo(files)
  try {
    body(runGate(root))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** The rules one report names. */
function rules(report) {
  return [...new Set(report.problems.map(problem => problem.rule))].sort()
}

describe('positive controls: every rule can fail', () => {
  test('a tracked packed tarball is refused', () => {
    withRepo({ 'workspace/packages/thing-1.0.0.tgz': 'not really a tarball' }, ({ status, report }) => {
      assert.equal(status, 1)
      assert.ok(rules(report).includes('packed tarball'))
    })
  })

  test('a tracked dist-artifacts directory is refused', () => {
    withRepo({ 'workspace/dist-artifacts/notes.md': 'anything at all' }, ({ status, report }) => {
      assert.equal(status, 1)
      assert.ok(rules(report).includes('generated artifact directory'))
    })
  })

  test('a tracked build output is refused', () => {
    withRepo({ 'workspace/packages/a/b/lib/client.js': 'export const x = 1' }, ({ status, report }) => {
      assert.equal(status, 1)
      assert.ok(rules(report).includes('build output'))
    })
  })

  test('the pre-rename package scope is refused', () => {
    withRepo({ 'workspace/packages/a/package.json': '{"name":"@watchskill/thing"}' },
      ({ status, report }) => {
        assert.equal(status, 1)
        assert.ok(rules(report).includes('stale package scope'))
      })
  })

  test('an absolute build-machine path is refused', () => {
    // The two shapes that actually leaked: a Windows build root inside a
    // source map, and a home directory inside a bundle.
    withRepo({ 'workspace/packages/a/lib.map': '{"sources":["G:\\\\watch-workspace\\\\src\\\\a.ts"]}' },
      ({ status, report }) => {
        assert.equal(status, 1)
        assert.ok(rules(report).includes('build-machine path'))
      })
    withRepo({ 'workspace/docs/notes.md': 'built from C:\\Users\\someone\\repo' },
      ({ status, report }) => {
        assert.equal(status, 1)
        assert.ok(rules(report).includes('build-machine path'))
      })
  })

  test('a discovered path is named by its root and never in full', () => {
    // The gate reports where a path started, not where it went. Printing the
    // whole thing would make the report itself the disclosure.
    withRepo({ 'workspace/docs/notes.md': 'built from C:\\Users\\a-real-person\\secret-project' },
      ({ report }) => {
        const detail = report.problems.map(problem => problem.detail).join(' ')
        assert.ok(!detail.includes('a-real-person'), 'the gate leaked the path it found')
        assert.ok(!detail.includes('secret-project'))
      })
  })
})

describe('what must not be refused', () => {
  test('an ordinary source tree passes', () => {
    withRepo({
      'workspace/packages/a/package.json': '{"name":"@deepwatch/thing"}',
      'workspace/packages/a/src/index.ts': 'export const answer = 42\n',
      'workspace/docs/guide.md': 'Paths are written as <workspace>/src, never absolutely.\n',
    }, ({ status, report }) => {
      assert.equal(status, 0, JSON.stringify(report.problems))
      assert.deepEqual(report.problems, [])
    })
  })

  test('scripts/lib is source, not a build output', () => {
    // `lib/` is anchored under a package, because `workspace/scripts/lib/` is
    // hand-written source and an unanchored rule dropped it from a commit once
    // already — leaving doctor.mjs importing a module that was not there.
    withRepo({ 'workspace/scripts/lib/paths.mjs': 'export const x = 1' }, ({ status }) => {
      assert.equal(status, 0)
    })
  })

  test('a relative path is not a machine path', () => {
    withRepo({ 'workspace/docs/a.md': 'see ./packages/watch/core-bridge/src/index.ts' },
      ({ status }) => { assert.equal(status, 0) })
  })

  test('a URL is not a drive letter', () => {
    withRepo({ 'workspace/docs/a.md': 'https://example.com/Users/docs' },
      ({ status }) => { assert.equal(status, 0) })
  })
})
