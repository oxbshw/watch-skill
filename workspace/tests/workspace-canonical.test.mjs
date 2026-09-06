/**
 * One workspace, shared by everything that resolves a relative path.
 *
 * The defect this holds shut was found by a real owner session, not by a
 * review. The agent was asked to create `owner-test/totals.json`, and it did:
 * the bytes were exact and the arithmetic was right. The file was then
 * unverifiable, because three layers disagreed about which directory that
 * relative path named —
 *
 * - the agent's filesystem tools resolved against the Harness session
 *   workspace, which the Harness derives from the host process's cwd;
 * - Watch Core was spawned with `cwd: ''` and inherited whatever the Host had;
 * - the verifier, handed no `workingDir`, fell back to `Path(".")`.
 *
 * Each default is defensible alone. Together they are a product that writes a
 * file it cannot find, and reports `INCONCLUSIVE` about its own work — an
 * honest answer that is worth nothing to the person who asked.
 *
 * So the tests here are not about path arithmetic. They are about *agreement*:
 * that one root is chosen once, that every consumer is told rather than left
 * to derive, and that a layer which cannot be told stops instead of guessing.
 * The counterfactuals matter as much as the happy paths — a suite that only
 * proves the boundary holds where it is pointed proves nothing about the case
 * that shipped.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  WORKSPACE_ENV,
  WorkspaceEscape,
  WorkspaceNotEstablished,
  establishWorkspace,
  insideWorkspace,
  requireWorkspace,
  resolveInWorkspace,
  sameWorkspace,
  workspaceFromEnvironment,
  workspaceRelative,
} from '@deepwatch/dsh-contracts'

// Reached by path rather than by export: `chooseWorkspace` is the launcher's
// own decision, not part of the CLI's published surface, and adding an export
// target to ship it would be a worse trade than a test that knows where it is.
import {
  WORKSPACE_ENV as CLI_WORKSPACE_ENV, chooseWorkspace,
} from '../packages/watch/cli/lib/launch.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A real directory, resolved the way the launcher resolves one. */
function scratch(...children) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dw-ws-')))
  const path = children.length === 0 ? base : join(base, ...children)
  if (children.length > 0) mkdirSync(path, { recursive: true })
  return path
}

describe('choosing the one root', () => {
  test('a named workspace is the workspace', () => {
    const dir = scratch()
    const chosen = chooseWorkspace({ workspace: dir }, {}, tmpdir())
    assert.equal(chosen.ok, true)
    assert.equal(chosen.origin, 'flag')
    assert.ok(sameWorkspace(chosen.root, dir))
  })

  test('the flag beats an inherited value, because a person said it', () => {
    const named = scratch()
    const inherited = scratch()
    const chosen = chooseWorkspace(
      { workspace: named }, { [WORKSPACE_ENV]: inherited }, tmpdir())
    assert.equal(chosen.ok, true)
    assert.ok(sameWorkspace(chosen.root, named))
  })

  test('an inherited absolute value is adopted, and says so', () => {
    const dir = scratch()
    const chosen = chooseWorkspace({ workspace: null }, { [WORKSPACE_ENV]: dir }, tmpdir())
    assert.equal(chosen.ok, true)
    assert.equal(chosen.origin, 'environment')
    assert.ok(sameWorkspace(chosen.root, dir))
  })

  test('the invoking directory is adopted deliberately, not by accident', () => {
    const dir = scratch()
    const chosen = chooseWorkspace({ workspace: null }, {}, dir)
    assert.equal(chosen.ok, true)
    assert.equal(chosen.origin, 'invocation')
    assert.ok(sameWorkspace(chosen.root, dir))
  })

  test('a relative inherited value is a configuration error, never resolved', () => {
    // The one place resolving against this process's cwd would reintroduce the
    // ambiguity the whole contract exists to remove.
    const chosen = chooseWorkspace({ workspace: null }, { [WORKSPACE_ENV]: 'owner-test' }, tmpdir())
    assert.equal(chosen.ok, false)
    assert.match(chosen.detail, /not an absolute path/)
  })

  test('a workspace that is not there is refused, never created', () => {
    const missing = join(scratch(), 'no-such-dir')
    const chosen = chooseWorkspace({ workspace: missing }, {}, tmpdir())
    assert.equal(chosen.ok, false)
    assert.match(chosen.detail, /no directory at/)
  })

  test('a file is not a workspace', () => {
    const base = scratch()
    const file = join(base, 'notes.md')
    writeFileSync(file, 'not a directory', 'utf8')
    const chosen = chooseWorkspace({ workspace: file }, {}, tmpdir())
    assert.equal(chosen.ok, false)
    assert.match(chosen.detail, /not a directory/)
  })

  test('the CLI and the contracts spell the variable the same way', () => {
    // Restated rather than imported, to keep the CLI's shipped dependency
    // closure at one package. This is the test that holds the pair together.
    assert.equal(CLI_WORKSPACE_ENV, WORKSPACE_ENV)
  })
})

describe('one relative path, one answer', () => {
  test('write, read and verify resolve owner-test/totals.json identically', () => {
    // The exact path from the owner session, and the point of the whole
    // contract: three consumers, one resolution.
    const root = scratch()
    const context = establishWorkspace(root, 'flag')
    const written = resolveInWorkspace(context, 'owner-test/totals.json')
    const readBack = resolveInWorkspace(context, 'owner-test/totals.json')
    const verified = resolveInWorkspace(context, 'owner-test/totals.json')
    assert.equal(written, readBack)
    assert.equal(readBack, verified)
    assert.ok(sameWorkspace(dirname(dirname(written)), root))
  })

  test('a backslash spelling resolves where the forward-slash one does', () => {
    // A path reaches these layers through Node, a shell and a Windows API in
    // turn, and the spelling changes on the way. The directory must not.
    const root = scratch()
    const context = establishWorkspace(root, 'flag')
    assert.equal(
      resolveInWorkspace(context, 'owner-test/totals.json'),
      resolveInWorkspace(context, 'owner-test\\totals.json'))
  })

  test('an absolute path inside the workspace is accepted', () => {
    const root = scratch()
    const context = establishWorkspace(root, 'flag')
    const inside = join(root, 'owner-test', 'totals.json')
    assert.equal(resolveInWorkspace(context, inside), resolveInWorkspace(context, 'owner-test/totals.json'))
  })

  test('a relative path may not climb out', () => {
    const root = scratch()
    const context = establishWorkspace(root, 'flag')
    assert.throws(() => resolveInWorkspace(context, '../escape.txt'), WorkspaceEscape)
    assert.throws(() => resolveInWorkspace(context, 'owner-test/../../escape.txt'), WorkspaceEscape)
  })

  test('an absolute path outside is refused rather than smuggled through', () => {
    const root = scratch()
    const outside = scratch()
    const context = establishWorkspace(root, 'flag')
    assert.throws(
      () => resolveInWorkspace(context, join(outside, 'canary.txt')), WorkspaceEscape)
  })

  test('a sibling with a shared prefix is outside', () => {
    // `D:\Wsuite` is not inside `D:\Ws`, and a prefix comparison without a
    // boundary check says it is.
    const base = scratch()
    const inside = join(base, 'Ws')
    const sibling = join(base, 'Wsuite')
    mkdirSync(inside, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    const context = establishWorkspace(inside, 'flag')
    assert.equal(insideWorkspace(context, join(sibling, 'notes.md')), false)
  })
})

describe('what a receipt, the Library and the verifier carry', () => {
  test('one normalised, workspace-relative, forward-slashed string', () => {
    const root = scratch()
    const context = establishWorkspace(root, 'flag')
    const absolute = resolveInWorkspace(context, 'owner-test/totals.json')
    assert.equal(workspaceRelative(context, absolute), 'owner-test/totals.json')
  })

  test('the projection never carries a separator this machine chose', () => {
    const root = scratch()
    const context = establishWorkspace(root, 'flag')
    const projected = workspaceRelative(context, resolveInWorkspace(context, 'a/b/c.json'))
    assert.equal(projected.includes('\\'), false)
    if (sep === '\\') assert.equal(projected.includes(sep), false)
  })

  test('a path outside converts to null rather than to an absolute path', () => {
    // So a caller cannot treat a failed conversion as a success and leak the
    // directory names this projection exists to remove.
    const root = scratch()
    const outside = scratch()
    const context = establishWorkspace(root, 'flag')
    assert.equal(workspaceRelative(context, join(outside, 'canary.txt')), null)
  })

  test('the workspace root is registered for redaction', () => {
    const root = scratch()
    const context = establishWorkspace(root, 'flag')
    assert.ok(context.roots.some(entry => entry.kind === 'workspace' && sameWorkspace(entry.path, root)))
  })
})

describe('failing closed', () => {
  test('no established workspace is a stop, with the fix in the message', () => {
    assert.throws(() => requireWorkspace(null, 'watch.verification.run'), error => {
      assert.ok(error instanceof WorkspaceNotEstablished)
      assert.match(error.message, /--workspace/)
      assert.match(error.message, new RegExp(WORKSPACE_ENV))
      return true
    })
  })

  test('an unusable inherited value reads as absent rather than as a root', () => {
    assert.equal(workspaceFromEnvironment({}), null)
    assert.equal(workspaceFromEnvironment({ [WORKSPACE_ENV]: '' }), null)
    assert.equal(workspaceFromEnvironment({ [WORKSPACE_ENV]: 'owner-test' }), null)
  })

  test('a relative candidate is refused where the directory is not known', () => {
    // This module has no cwd of its own on purpose: resolving here is exactly
    // what produced three roots from one relative path.
    assert.throws(() => establishWorkspace('owner-test', 'flag'), /absolute path/)
    assert.throws(() => establishWorkspace('', 'flag'), /absolute path/)
  })
})

describe('the counterfactual that shipped', () => {
  test('a verifier pointed at a different root does not find the file', () => {
    // `D:\Em\owner-test\totals.json` written, `dsh-home` verified. The file was
    // real and the verdict was INCONCLUSIVE. This is that shape, and it must
    // keep failing — a suite that cannot reproduce the defect cannot prove the
    // fix.
    const workspace = scratch()
    const elsewhere = scratch()
    const written = resolveInWorkspace(establishWorkspace(workspace, 'flag'), 'owner-test/totals.json')
    const verifier = establishWorkspace(elsewhere, 'flag')
    assert.equal(insideWorkspace(verifier, written), false)
    assert.equal(workspaceRelative(verifier, written), null)
  })

  test('the same file under the agreed root is found', () => {
    const workspace = scratch()
    const context = establishWorkspace(workspace, 'flag')
    const written = resolveInWorkspace(context, 'owner-test/totals.json')
    assert.equal(insideWorkspace(context, written), true)
    assert.equal(workspaceRelative(context, written), 'owner-test/totals.json')
  })
})

describe('platform path behaviour', () => {
  test('a drive letter differing in case is one directory', { skip: sep !== '\\' }, () => {
    const root = scratch()
    const lowered = `${root[0].toLowerCase()}${root.slice(1)}`
    assert.equal(sameWorkspace(root, lowered), true)
  })

  test('a trailing separator does not make a second workspace', () => {
    const root = scratch()
    assert.equal(sameWorkspace(root, `${root}${sep}`), true)
  })

  test('a link to the workspace resolves to the workspace', () => {
    // A junction on Windows and a symlink elsewhere are two spellings of one
    // directory. A containment check comparing an unresolved spelling against
    // a resolved one reports a file outside a workspace it is plainly inside,
    // which is why the launcher resolves before anything else sees the value.
    const base = scratch()
    const real = join(base, 'real')
    const link = join(base, 'link')
    mkdirSync(real, { recursive: true })
    try {
      symlinkSync(real, link, 'junction')
    } catch {
      return // unprivileged Windows, or a filesystem without links: nothing to prove
    }
    const chosen = chooseWorkspace({ workspace: link }, {}, tmpdir())
    assert.equal(chosen.ok, true)
    assert.ok(sameWorkspace(chosen.root, realpathSync.native(real)))
  })
})

describe('Core agrees with the launcher', () => {
  /** The interpreter that would run Core, whether or not it is there. */
  const python = process.platform === 'win32'
    ? join(ROOT, '..', '.venv', 'Scripts', 'python.exe')
    : join(ROOT, '..', '.venv', 'bin', 'python')

  /** Run a snippet against the Python contract. Never interprets the result. */
  function run(snippet, env = {}) {
    return spawnSync(python, ['-c', snippet], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 120_000,
    })
  }

  /**
   * Is Core importable here, and if not, exactly why?
   *
   * Asked once, before any test runs, and separately from the checks
   * themselves. That separation is the whole point of this rewrite: these
   * three tests used to end with `if (run.status !== 0) return`, which is
   * green for a missing virtualenv, an `ImportError`, a crash, a timeout —
   * and for Core answering the wrong thing. A check that cannot fail is worse
   * than no check, because the row is there and it is reassuring.
   *
   * Now a missing prerequisite is a *skip*, named, and anything else is a
   * failure carrying the interpreter's own stderr.
   */
  const availability = (() => {
    if (!existsSync(python)) {
      return { skip: `no interpreter at ${python} — run \`uv sync --all-extras\`` }
    }
    const probe = run('import watch_skill.workspace_root as m; print(m.__file__)')
    if (probe.error !== undefined && probe.error.code === 'ETIMEDOUT') {
      return { fail: `importing watch_skill timed out after 120s` }
    }
    if (probe.status !== 0) {
      const why = `${probe.stderr ?? ''}`.trim().split('\n').slice(-1)[0] ?? ''
      // An ImportError for the package itself is "Core is not installed here",
      // which is a legitimate skip. An ImportError for something Core depends
      // on is Core being broken, and that is a failure.
      return /No module named ['"]?watch_skill/.test(why)
        ? { skip: `watch_skill is not importable by ${python}: ${why}` }
        : { fail: `watch_skill failed to import: ${why}` }
    }
    return {}
  })()

  const options = availability.skip === undefined ? {} : { skip: availability.skip }

  /** Assert the interpreter ran and answered, with its own words on failure. */
  function answered(result, what) {
    if (result.error !== undefined) {
      assert.fail(`${what}: the interpreter did not run — ${result.error.code ?? result.error.message}`)
    }
    assert.equal(result.status, 0,
      `${what}: python exited ${String(result.status)}\n`
      + `stdout: ${(result.stdout ?? '').trim()}\n`
      + `stderr: ${(result.stderr ?? '').trim()}`)
    return result.stdout.trim()
  }

  test('the Python contract is importable, or says why it is not', () => {
    // The prerequisite probe is itself a result worth asserting: a `fail`
    // verdict from it must not be reported as a skip further down.
    assert.equal(availability.fail, undefined, availability.fail)
  })

  test('Core spells the variable the way the launcher writes it', options, () => {
    const out = answered(
      run('from watch_skill.workspace_root import WORKSPACE_ENV; print(WORKSPACE_ENV)'),
      'reading WORKSPACE_ENV')
    assert.equal(out, WORKSPACE_ENV)
  })

  test('Core resolves the launcher\'s root to the same absolute file', options, () => {
    const root = scratch()
    const out = answered(run(
      'from watch_skill.workspace_root import require_workspace, resolve_in_workspace\n'
      + 'print(resolve_in_workspace(require_workspace("test"), "owner-test/totals.json"))',
      { [WORKSPACE_ENV]: root }), 'resolving inside the workspace')
    const context = establishWorkspace(root, 'flag')
    assert.ok(sameWorkspace(out, resolveInWorkspace(context, 'owner-test/totals.json')),
      `Core resolved ${out}, the launcher resolves `
      + `${resolveInWorkspace(context, 'owner-test/totals.json')}`)
  })

  test('Core fails closed when the launcher established nothing', options, () => {
    const out = answered(run(
      'from watch_skill.workspace_root import require_workspace, WorkspaceNotEstablished\n'
      + 'try:\n'
      + '    require_workspace("watch.verification.run")\n'
      + '    print("GUESSED")\n'
      + 'except WorkspaceNotEstablished:\n'
      + '    print("REFUSED")',
      { [WORKSPACE_ENV]: '' }), 'asking with no workspace established')
    assert.equal(out, 'REFUSED')
  })

  test('a broken contract turns these red rather than green', options, () => {
    // The counterfactual. Each check above compares Core's answer to the
    // launcher's; this proves the comparison is load-bearing by running a
    // snippet that answers wrongly, and by running one that fails outright.
    //
    // Before this rewrite both of these produced a passing test.
    const wrong = run('print("WATCHSKILL_WORKSPACE_BUT_NOT_REALLY")')
    assert.equal(wrong.status, 0, 'the control snippet should itself run')
    assert.notEqual(wrong.stdout.trim(), WORKSPACE_ENV,
      'the control did not actually differ, so it proves nothing')

    const broken = run('from watch_skill.workspace_root import no_such_symbol')
    assert.notEqual(broken.status, 0, 'a broken import should exit nonzero')
    assert.throws(() => answered(broken, 'a deliberately broken import'),
      /python exited/,
      'a nonzero exit must fail the check instead of returning quietly')
  })
})
