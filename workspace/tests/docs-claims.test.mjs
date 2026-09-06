/**
 * The documentation's checkable claims, checked.
 *
 * Three of this release's documents cited a file that had been deleted, stated
 * a test total from a build three hundred tests ago, and recorded the process
 * id of a machine nobody still has. None of it was caught, because prose is
 * the one place in this repository where a false statement costs nothing to
 * write and nothing to keep.
 *
 * That is the same failure the product exists to catch — a claim with no
 * mechanism behind it — so the documentation is held to the rule the code is.
 *
 * @module tests/docs-claims
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(WORKSPACE, '..')

/**
 * Every markdown file in the working tree that is not ignored.
 *
 * `--others --exclude-standard` alongside `--cached` is the point. A plain
 * `git ls-files` sees only what is already committed, so a document added in
 * the current change is invisible to every check below — green locally, and
 * checked for the first time after it has been merged. That is backwards: a
 * file being written is exactly when a broken link is cheap to fix.
 *
 * This was not a hypothetical. Written the obvious way, three of the five
 * checks here could not fail, and the only reason that is known is that each
 * one was made to fail on purpose before it was trusted.
 *
 * Ignored paths stay out, so build output and vendored trees are not scanned.
 */
function documentation() {
  return execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
    { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(line => line !== '')
}

const MARKDOWN = documentation()

test('the gate can see the documentation it claims to check', () => {
  // Without this, a `git ls-files` that returned nothing would make every
  // check below vacuously pass — the exact shape of failure this file is about.
  assert.ok(MARKDOWN.length > 100,
    `expected the documentation set, found ${String(MARKDOWN.length)} file(s)`)
})

test('every relative link in the documentation resolves', () => {
  const broken = []
  for (const relative of MARKDOWN) {
    const text = readFileSync(join(REPO, relative), 'utf8')
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = match[1]
      // Anchors and the open web are somebody else's to keep alive.
      if (/^(?:https?:|mailto:|#)/.test(target)) continue
      const absolute = resolve(join(REPO, dirname(relative)), decodeURIComponent(target))
      if (!existsSync(absolute)) broken.push(`${relative} -> ${target}`)
    }
  }
  assert.deepEqual(broken, [], `broken link(s):\n${broken.join('\n')}`)
})

test('every proof the status ledger cites is a file that exists', () => {
  // The ledger marks an item `tested` and names what tests it. A name that no
  // longer resolves is worse than an empty list: it reports coverage that
  // cannot be run, and it reads as evidence to anyone auditing the ledger
  // rather than the tree. One entry here had outlived its file.
  const status = JSON.parse(
    readFileSync(join(WORKSPACE, 'docs', 'implementation-status.json'), 'utf8'))
  assert.ok(status.items.length > 0, 'the ledger has no items')

  const missing = []
  for (const item of status.items) {
    for (const cited of item.tests ?? []) {
      if (!existsSync(join(WORKSPACE, cited))) missing.push(`${item.id} -> ${cited}`)
    }
  }
  assert.deepEqual(missing, [], `cited proof that does not exist:\n${missing.join('\n')}`)
})

test('a stated test count either names its file or is pinned to a commit', () => {
  // Two kinds of number, and only one of them drifts.
  //
  // "`tests/reconnect-policy.test.mjs`, 14 tests" stays true until that file
  // changes, and anybody editing it sees the sentence. A bare "1415 across 231
  // suites" is stale the next time anyone adds a test, and nothing points at
  // it — this repository carried that sentence for three hundred tests.
  //
  // So a count must do one of two things: name the file it counts, or sit in a
  // document that says which commit it measured. Historical records are not
  // the problem; unqualified totals written in the present tense are.
  const counting = /\b\d{2,5}\s+(?:tests|suites|passing|assertions|test files)\b/
  const namesAFile = /`[^`]*\.(?:test\.)?[cm]?[jt]s`|\b[\w./-]+\.test\.[cm]?js\b/
  const pinned = /Measured at `[0-9a-f]{7,40}`/

  const unqualified = []
  for (const relative of MARKDOWN) {
    const text = readFileSync(join(REPO, relative), 'utf8')
    if (pinned.test(text)) continue
    for (const [at, line] of text.split('\n').entries()) {
      if (!counting.test(line)) continue
      if (namesAFile.test(line)) continue
      unqualified.push(`${relative}:${String(at + 1)}: ${line.trim()}`)
    }
  }
  assert.deepEqual(unqualified, [],
    `a count that will go stale and that nothing will catch:\n${unqualified.join('\n')}`)
})

test('no document records a process id from a past run', () => {
  // A pid identifies a process that no longer exists on a machine nobody else
  // has. What the check behind it established — that the application never
  // restarted — survives being written down; the number does not.
  const found = []
  for (const relative of MARKDOWN) {
    const text = readFileSync(join(REPO, relative), 'utf8')
    for (const [at, line] of text.split('\n').entries()) {
      if (/\bpid\s+\d{3,}\b/i.test(line)) found.push(`${relative}:${String(at + 1)}: ${line.trim()}`)
    }
  }
  assert.deepEqual(found, [], `process id recorded as evidence:\n${found.join('\n')}`)
})
