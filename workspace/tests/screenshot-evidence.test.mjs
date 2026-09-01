/**
 * The screenshots, held to what a screenshot is for.
 *
 * The capture harness already computes everything needed to catch a bad run —
 * which shots were reached, which files were written, which images are
 * byte-identical to each other — and then writes the numbers into a manifest
 * that nothing reads. A run that photographed the same dialog twice reported
 * two duplicate groups, exactly as designed, and shipped.
 *
 * A number that is only printed is a number nobody checks. These are the
 * assertions that make the manifest mean something.
 *
 * @module tests/screenshot-evidence
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(WORKSPACE, 'docs', 'screenshot-manifest.json')

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))

test('the manifest describes a real set of shots', () => {
  // Guards every assertion below: an empty manifest would satisfy all of them.
  assert.ok(manifest.shots.length > 30,
    `expected the full shot list, found ${String(manifest.shots.length)}`)
  assert.equal(manifest.totals.shots, manifest.shots.length)
})

test('no two screenshots are the same image', () => {
  // Two identical files under two names is the signature of a capture that
  // did not reach the second state: a dialog that was never dismissed, a tab
  // that never changed, a mode nobody opened. Both files look like evidence
  // in a directory listing, and one of them is evidence for a claim it does
  // not show.
  assert.deepEqual(manifest.duplicates, [],
    `identical image(s) under different names:\n`
    + manifest.duplicates.map(group => group.join(' = ')).join('\n'))
  assert.equal(manifest.totals.duplicateGroups, 0)
})

test('every shot the manifest calls captured is a file on disk', () => {
  const missing = []
  for (const shot of manifest.shots) {
    if (shot.state !== 'captured') continue
    if (shot.file === null || !existsSync(join(WORKSPACE, shot.file))) {
      missing.push(`${shot.name} -> ${String(shot.file)}`)
    }
  }
  assert.deepEqual(missing, [], `captured shot with no file:\n${missing.join('\n')}`)
})

test('a shot that was not captured claims no file and says why', () => {
  // The harness deliberately writes no PNG when it did not reach the state,
  // because a missing file cannot be mistaken for evidence and a duplicate one
  // can. That contract only holds if the manifest keeps the two apart.
  for (const shot of manifest.shots) {
    if (shot.state === 'captured') continue
    assert.equal(shot.file, null, `${shot.name} is not captured but names a file`)
    // `reason` is the manifest's field; the capture harness's own index calls
    // it `note` and the generator renames it. Asserting on the raw name was
    // this test's own first bug.
    assert.ok(typeof shot.reason === 'string' && shot.reason.length > 0,
      `${shot.name} is not captured and does not say why`)
  }
})

test('the totals are the shots, not a number typed beside them', () => {
  const captured = manifest.shots.filter(shot => shot.state === 'captured').length
  assert.equal(manifest.totals.captured, captured)
  assert.equal(manifest.totals.notCaptured, manifest.shots.length - captured)
})
