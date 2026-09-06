/**
 * No document in this repository tells anyone to print a credential file.
 *
 * The provider handoff guide did, twice, and both were written in good faith:
 * "confirm the key landed where we said" and "confirm it is gone". Both
 * questions are worth asking and neither of them needs the file's contents.
 * What `cat "$DSH_HOME/.credentials.yaml"` actually does is put a live API key
 * into terminal scrollback, into a screen recording, and into whatever the
 * reader pastes when they ask for help — for an answer that is really about
 * *which store holds it*.
 *
 * So the rule is narrow and absolute: a command that reads a known credential
 * file to standard output does not appear in documentation. Verification uses
 * the credentials service, the UI's own state, a permissions listing, or a
 * redacted provider test.
 *
 * The scan reads Markdown, because that is where instructions live. It does
 * not read source: a program that opens the credential store is how the
 * product works.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Files that hold credentials, by the names this product and its host use. */
const CREDENTIAL_FILES = [
  '.credentials.yaml',
  '.credentials.yml',
  '.env',
  '.netrc',
  'credentials.json',
  'id_rsa',
  '.pem',
]

/** Commands whose whole purpose is to write a file's contents to a stream. */
const PRINTERS = ['cat', 'type', 'less', 'more', 'head', 'tail', 'Get-Content', 'gc', 'bat', 'xxd', 'strings']

/** This file names what it forbids; it would otherwise fail itself. */
const EXEMPT = new Set(['workspace/tests/docs-credential-safety.test.mjs'])

/** Every tracked Markdown file, repository-relative. */
function markdownFiles() {
  const result = spawnSync('git', ['ls-files', '*.md'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  assert.equal(result.status, 0, 'git ls-files failed')
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * Lines in one document that print a credential file.
 *
 * Both halves must be on the same line: a printer, and a credential file it is
 * being pointed at. Requiring both is what keeps prose like "the credentials
 * file lives at ..." from failing, while `cat "$DSH_HOME/.credentials.yaml"`
 * does not survive it.
 */
export function offendingLines(text) {
  const found = []
  for (const [index, line] of text.split('\n').entries()) {
    const names = CREDENTIAL_FILES.some(name => line.includes(name))
    if (!names) continue
    const printer = PRINTERS.find(command => new RegExp(`(^|[\\s|;&(\`$])${command}\\b`).test(line))
    if (printer === undefined) continue
    found.push({ line: index + 1, command: printer })
  }
  return found
}

describe('documentation never prints a credential', () => {
  test('no tracked Markdown file displays a credential file', () => {
    const failures = []
    for (const relative of markdownFiles()) {
      if (EXEMPT.has(relative)) continue
      const text = readFileSync(join(ROOT, relative), 'utf8')
      for (const hit of offendingLines(text)) {
        failures.push(`${relative}:${String(hit.line)} uses \`${hit.command}\` on a credential file`)
      }
    }
    assert.deepEqual(failures, [],
      'verify a credential through the credentials service, the UI, a permissions\n'
      + 'listing, or a redacted provider test — never by printing the file')
  })
})

describe('the scan itself', () => {
  test('it catches the two commands that were actually shipped', () => {
    assert.deepEqual(
      offendingLines('cat "$DSH_HOME/.credentials.yaml"').map(hit => hit.command),
      ['cat'])
    assert.equal(offendingLines('Get-Content $env:DSH_HOME/.credentials.yaml').length, 1)
  })

  test('it catches the other ways of reading the same file', () => {
    for (const line of [
      'less ~/.netrc',
      'head -5 .env',
      'xxd id_rsa',
      'echo hi && cat .env',
      'strings ~/.ssh/id_rsa',
    ]) {
      assert.equal(offendingLines(line).length, 1, `missed: ${line}`)
    }
  })

  test('it leaves prose about credential files alone', () => {
    // Naming the file is how a reader finds it. Only printing it is the defect.
    for (const line of [
      'A key entered through the Models page is written to `$DSH_HOME/.credentials.yaml`.',
      'The credential store is `.credentials.yaml`, which DSH owns.',
      'ls -l "$DSH_HOME/.credentials.yaml"',
      'grep -c apiKey "$DSH_HOME/settings.yaml"',
      'Never display `.credentials.yaml`.',
    ]) {
      assert.deepEqual(offendingLines(line), [], `wrongly refused: ${line}`)
    }
  })

  test('a printer aimed at something harmless is not a finding', () => {
    assert.deepEqual(offendingLines('cat README.md'), [])
    assert.deepEqual(offendingLines('head -20 workspace/package.json'), [])
  })

  test('concatenation is not the word cat', () => {
    assert.deepEqual(offendingLines('the concatenated .env values are validated'), [])
  })
})
