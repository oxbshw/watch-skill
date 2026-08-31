/**
 * `D:\Em` and every other place this machine keeps things.
 *
 * A workspace was selected and its absolute path then appeared in the Context
 * panel, in the session log, and in the text handed to the model. None of
 * those needed it. The panel needed a name, the log needed something stable to
 * group by, and the model needed files relative to a root it never has to know
 * the name of.
 *
 * The literal `D:\Em` is used throughout on purpose: it is the path a real
 * person saw on a real screen, and a test that only exercised `/tmp/x` would
 * have missed the drive-letter and separator handling that made it leak.
 *
 * The other half of this file guards the opposite failure. Redaction that
 * rewrites substrings across arbitrary text corrupts the evidence this product
 * exists to preserve, so the structured helpers are checked to leave content
 * alone even when the content itself looks like a path.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CONTRACTS = join(ROOT, 'packages', 'watch', 'contracts')

const {
  redactPath, relativeToRoot, redactFields, redactDiagnosticText,
  findAbsolutePaths, assertNoLocalPath, isAbsoluteLocalPath, isInsideRoot, normalisePath,
} = await import(pathToFileURL(join(CONTRACTS, 'lib', 'paths.js')).href)

/** The roots a running profile actually has. */
const ROOTS = [
  { kind: 'workspace', path: 'D:\\Em' },
  { kind: 'profile', path: 'D:\\watch-qa-20260831-050308\\home' },
  { kind: 'dsh-home', path: 'D:\\watch-qa-20260831-050308\\home\\dsh-home' },
  { kind: 'home', path: 'C:\\Users\\someone' },
  { kind: 'temp', path: 'C:\\Users\\someone\\AppData\\Local\\Temp' },
]

describe('the workspace path a person actually saw', () => {
  test('D:\\Em becomes a name', () => {
    assert.equal(redactPath('D:\\Em', ROOTS), '<workspace>')
  })

  test('a file inside it keeps its relative shape', () => {
    assert.equal(redactPath('D:\\Em\\src\\index.ts', ROOTS), '<workspace>/src/index.ts')
  })

  test('either separator spelling is recognised', () => {
    // By the time Node and a shell have both handled a path, both appear.
    assert.equal(redactPath('D:/Em/src', ROOTS), '<workspace>/src')
    assert.equal(redactPath('D:\\Em/src', ROOTS), '<workspace>/src')
  })

  test('the drive letter case does not decide whether it leaks', () => {
    assert.equal(redactPath('d:\\Em\\notes.md', ROOTS), '<workspace>/notes.md')
  })

  test('a neighbouring directory with the same prefix is left alone', () => {
    // Without a separator check, `D:\Employment` reads as inside `D:\Em`, and
    // the reader is handed a path that never existed.
    assert.equal(redactPath('D:\\Employment\\x', ROOTS), 'D:\\Employment\\x')
    assert.ok(!isInsideRoot('D:\\Em', 'D:\\Employment'))
  })

  test('the most specific root wins', () => {
    // dsh-home is inside the profile; naming it `<profile>/dsh-home` would be
    // true and less useful.
    assert.match(
      redactPath('D:\\watch-qa-20260831-050308\\home\\dsh-home\\settings.yaml', ROOTS),
      /^<dsh-home>\/settings\.yaml$/)
  })

  test('a model is given a relative path and no root at all', () => {
    assert.equal(relativeToRoot('D:\\Em\\src\\index.ts', 'D:\\Em'), 'src/index.ts')
    assert.equal(relativeToRoot('D:\\Em', 'D:\\Em'), '.')
  })

  test('a path outside the root converts to null rather than to itself', () => {
    // A caller that treated a failed conversion as a success would send the
    // absolute path onward, which is the leak this exists to stop.
    assert.equal(relativeToRoot('C:\\elsewhere\\x', 'D:\\Em'), null)
  })
})

describe('the three path shapes, and the one that is not a path', () => {
  test('drive, UNC and POSIX absolutes are all recognised', () => {
    assert.ok(isAbsoluteLocalPath('D:\\Em'))
    assert.ok(isAbsoluteLocalPath('D:/Em'))
    assert.ok(isAbsoluteLocalPath('\\\\server\\share\\dir'))
    assert.ok(isAbsoluteLocalPath('/home/someone/src'))
  })

  test('a relative path is not an absolute one', () => {
    for (const value of ['src/index.ts', './notes.md', '..\\up', 'Em', '']) {
      assert.ok(!isAbsoluteLocalPath(value), `${value} was read as absolute`)
    }
  })

  test('a UNC root redacts without losing its leading pair', () => {
    const roots = [{ kind: 'workspace', path: '\\\\nas\\team\\project' }]
    assert.equal(redactPath('\\\\nas\\team\\project\\a.txt', roots), '<workspace>/a.txt')
  })

  test('normalising is idempotent and drops a trailing separator', () => {
    assert.equal(normalisePath('D:\\Em\\'), 'D:/Em')
    assert.equal(normalisePath(normalisePath('D:\\Em\\')), 'D:/Em')
  })
})

describe('redaction is structured, and never rewrites content', () => {
  test('only the named fields are touched', () => {
    const record = {
      workspacePath: 'D:\\Em',
      label: 'Em',
      // Evidence content that legitimately contains a path-shaped string. This
      // is the case a blanket replace would corrupt.
      transcript: 'the user typed D:\\Em into the terminal and pressed enter',
    }
    const out = redactFields(record, ['workspacePath'], ROOTS)

    assert.equal(out.workspacePath, '<workspace>')
    assert.equal(out.label, 'Em')
    assert.equal(out.transcript, record.transcript,
      'evidence content must survive redaction byte for byte')
  })

  test('the original record is not mutated', () => {
    const record = { workspacePath: 'D:\\Em' }
    redactFields(record, ['workspacePath'], ROOTS)
    assert.equal(record.workspacePath, 'D:\\Em')
  })

  test('a non-string field is left as it is', () => {
    const out = redactFields({ workspacePath: 42 }, ['workspacePath'], ROOTS)
    assert.equal(out.workspacePath, 42)
  })

  test('there is no function here that scrubs a whole document', async () => {
    // The API shape is the safety property: a caller must name the field or
    // the bounded diagnostic string. Anything that took a document and
    // scrubbed it would be reachable by accident from a render path.
    const module = await import(pathToFileURL(join(CONTRACTS, 'lib', 'paths.js')).href)
    for (const name of Object.keys(module)) {
      assert.doesNotMatch(name, /^(scrub|sanitiseAll|redactAll|redactDocument)$/,
        `${name} invites blanket replacement over content`)
    }
  })
})

describe('bounded diagnostic redaction', () => {
  test('a log line loses the root and keeps the rest', () => {
    const line = 'workspace resolved to D:\\Em\\src, 42 files indexed'
    const out = redactDiagnosticText(line, ROOTS)
    assert.equal(out, 'workspace resolved to <workspace>/src, 42 files indexed')
  })

  test('both separator spellings are caught in one pass', () => {
    const out = redactDiagnosticText('a=D:/Em/x b=D:\\Em\\y', ROOTS)
    assert.ok(!out.includes('D:/Em'))
    assert.ok(!out.includes('D:\\Em'))
  })

  test('a longer neighbouring path is not partly rewritten', () => {
    const out = redactDiagnosticText('D:\\Employment\\notes', ROOTS)
    assert.equal(out, 'D:\\Employment\\notes')
  })
})

describe('the assertions a leaking surface fails on', () => {
  test('findAbsolutePaths reports the offending token, not a bare false', () => {
    const found = findAbsolutePaths('context: D:\\Em\\src and /home/someone/x')
    assert.equal(found.length, 2)
    assert.ok(found[0].startsWith('D:\\Em'))
  })

  test('a clean string finds nothing', () => {
    assert.deepEqual(findAbsolutePaths('<workspace>/src/index.ts — 42 files'), [])
  })

  test('assertNoLocalPath names where the leak was', () => {
    assert.throws(
      () => { assertNoLocalPath('provider payload', 'cwd is D:\\Em') },
      error => {
        assert.match(error.message, /provider payload/)
        assert.match(error.message, /D:\\Em/)
        assert.match(error.message, /redactPath|relativeToRoot/)
        return true
      })
  })

  test('a redacted payload passes the same assertion', () => {
    const payload = JSON.stringify({
      workspace: redactPath('D:\\Em', ROOTS),
      file: relativeToRoot('D:\\Em\\src\\index.ts', 'D:\\Em'),
    })
    assert.doesNotThrow(() => { assertNoLocalPath('provider payload', payload) })
    assert.ok(!payload.includes('D:\\Em'))
    assert.ok(!payload.includes('D:/Em'))
  })

  test('an ordinary URL is not a local path', () => {
    // A drive letter is one letter and a colon, and `https:` ends in exactly
    // that shape -- so every URL in a diagnostic was reported as a local path
    // and `assertNoLocalPath` threw on honest text like "failed to reach
    // https://...". A guard that fires on the normal case is a guard somebody
    // switches off, which would have cost the real leaks it was written for.
    for (const url of [
      'failed to reach https://api.example.com/v1/models',
      'served at http://127.0.0.1:8930/api',
      'see https://github.com/oxbshw/watch-skill/issues',
      'ws://127.0.0.1:8930/socket',
    ]) {
      assert.deepEqual(findAbsolutePaths(url), [], `${url} was read as a local path`)
      assert.doesNotThrow(() => { assertNoLocalPath('provider payload', url) })
    }
  })

  test('a file URL still carries a local path, and is still caught', () => {
    // The `D:` in `file:///D:/Em` is preceded by a separator rather than by a
    // scheme, which is what separates it from `https:`.
    assert.notDeepEqual(findAbsolutePaths('file:///D:/Em/node_modules/x'), [])
    assert.throws(() => { assertNoLocalPath('export', 'file:///D:/Em/node_modules/x') })
  })

  test('a UNC path is still caught', () => {
    const unc = 'copied from \\\\server\\share\\a'
    assert.notDeepEqual(findAbsolutePaths(unc), [])
  })
})
