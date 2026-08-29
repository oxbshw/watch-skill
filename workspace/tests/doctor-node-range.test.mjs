/**
 * The doctor's verdict on the running Node, and the difference between
 * "untested" and "unusable".
 *
 * This exists because the doctor got that difference wrong. It read
 * `engines.node` and failed anything outside it, so a machine on `22.18.0`
 * against a declared `^22.19.0` was told its toolchain was unusable -- on a
 * machine that was, at that moment, running the whole suite, both apps and
 * every screenshot capture. The doctor is the first thing a new contributor
 * runs, and its failures are instructions; a false one sends them to install a
 * Node they do not need and teaches them the report is noise.
 *
 * The declared range is what CI installs and tests. It is not a floor below
 * which the code stops working. Those are different claims and the report now
 * makes them separately.
 *
 * What must not regress in the other direction: a genuinely wrong major has to
 * stay a hard failure. A warning there would be the same false report with the
 * sign flipped.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { nodeSatisfies, nodeBelowTestedFloorOnly } from '../scripts/lib/node-range.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DECLARED = '^22.19.0 || >=24.0.0'

test('a version inside the declared range satisfies it', () => {
  for (const version of ['v22.19.0', 'v22.19.4', 'v22.20.0', 'v24.0.0', 'v25.3.1']) {
    assert.equal(nodeSatisfies(DECLARED, version), true, version)
    assert.equal(nodeBelowTestedFloorOnly(DECLARED, version), false,
      `${version} is inside the range and cannot also be below it`)
  }
})

test('same major, below the caret, is untested rather than unusable', () => {
  for (const version of ['v22.18.0', 'v22.0.0', 'v22.18.99']) {
    assert.equal(nodeSatisfies(DECLARED, version), false, version)
    assert.equal(nodeBelowTestedFloorOnly(DECLARED, version), true,
      `${version} shares a major with ^22.19.0 -- the doctor must warn, not fail`)
  }
})

test('an older major stays a hard failure', () => {
  for (const version of ['v20.11.0', 'v18.20.4', 'v21.7.3']) {
    assert.equal(nodeSatisfies(DECLARED, version), false, version)
    assert.equal(nodeBelowTestedFloorOnly(DECLARED, version), false,
      `${version} is a different major -- warning here would hide a real break`)
  }
})

test('a range with no caret clause never softens to a warning', () => {
  // `>=24.0.0` alone states a floor and nothing about a tested band, so there
  // is no "below the tested floor" to report -- only pass or fail.
  assert.equal(nodeBelowTestedFloorOnly('>=24.0.0', 'v22.18.0'), false)
  assert.equal(nodeSatisfies('>=24.0.0', 'v22.18.0'), false)
})

test('the range the doctor reads is the one this workspace declares', () => {
  // If package.json moves to a shape the parser does not understand, the two
  // predicates above are being tested against a range nothing uses.
  const declared = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines?.node
  assert.equal(declared, DECLARED,
    'engines.node changed -- update this suite so it still tests the real range')
})

test('the doctor reports the level the predicates imply for the Node running it', () => {
  // The predicates being right is worth nothing if the report does not use
  // them. This runs the real doctor and checks the one finding whose input --
  // the Node executing this test -- is known here.
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'doctor.mjs'), '--json'],
    { encoding: 'utf8' })
  const node = JSON.parse(out).findings.find(finding => finding.name === 'node')
  assert.ok(node !== undefined, 'the doctor reported no node finding at all')

  const expected = nodeSatisfies(DECLARED, process.version)
    ? 'ok'
    : nodeBelowTestedFloorOnly(DECLARED, process.version) ? 'warn' : 'fail'
  assert.equal(node.level, expected,
    `doctor said "${node.level}" for ${process.version} against ${DECLARED}`)
})
