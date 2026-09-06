/**
 * The pinned package manager, and the two ways it used to escape the pin.
 *
 * `scripts/bootstrap.mjs` ran a bare `pnpm`. With `shell: true` that resolves
 * whatever is first on PATH, so a machine with pnpm 11 installed globally
 * bootstrapped this repository with pnpm 11 -- which writes `allowBuilds` into
 * `pnpm-workspace.yaml`. A command documented as taking a fresh clone to a
 * working state left a tracked file modified, and the release gate then failed
 * on a dirty tree for a reason nothing in the output explained.
 *
 * The doctor was supposed to catch that and did not. It compared only the
 * major, so a pinned 10.29.1 was satisfied by 10.0.0, and it reported even a
 * whole-major mismatch as a warning -- a note beside the one condition that
 * actually breaks the build.
 *
 * Both are covered here: the classifier by its own table, and the bootstrap by
 * reading what it will actually execute. The second matters because the first
 * cannot see a regression that reintroduces a bare `pnpm` at the call site.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyPnpm, pinnedPnpmVersion } from '../scripts/lib/package-manager.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('the repository pins an exact pnpm version', () => {
  const pinned = pinnedPnpmVersion(MANIFEST.packageManager)
  assert.notEqual(pinned, '',
    `package.json packageManager must pin an exact pnpm, got ${String(MANIFEST.packageManager)}`)
  assert.match(pinned, /^\d+\.\d+\.\d+$/)
})

test('only the exact pinned version is ok', () => {
  const pinned = pinnedPnpmVersion(MANIFEST.packageManager)
  assert.equal(classifyPnpm(MANIFEST.packageManager, pinned).level, 'ok')
})

test('the pinned major but a different patch is a warning, not silence', () => {
  const verdict = classifyPnpm('pnpm@10.29.1', '10.0.0')
  assert.equal(verdict.level, 'warn',
    'comparing majors alone called 10.0.0 an exact match for 10.29.1')
  assert.match(verdict.fix, /corepack/)
})

test('a different major is a failure, because it rewrites a tracked file', () => {
  for (const version of ['11.0.0', '11.2.3', '9.15.0']) {
    assert.equal(classifyPnpm('pnpm@10.29.1', version).level, 'fail', version)
  }
})

test('a malformed or absent pin is not treated as a pin', () => {
  for (const spec of [undefined, null, '', 'pnpm', 'pnpm@10', 'npm@10.29.1', 42]) {
    assert.equal(pinnedPnpmVersion(spec), '', String(spec))
    assert.equal(classifyPnpm(spec, '11.0.0').level, 'ok',
      'nothing is pinned, so there is nothing to contradict')
  }
})

test('bootstrap runs the pinned pnpm through corepack, never a bare pnpm', () => {
  const source = readFileSync(join(ROOT, 'scripts', 'bootstrap.mjs'), 'utf8')

  assert.doesNotMatch(source, /command:\s*'pnpm'/,
    'a bare `pnpm` command resolves from PATH and defeats the pin')
  assert.match(source, /corepack \$\{PNPM\} install --frozen-lockfile/,
    'the dependency step must name the pinned version explicitly')
  assert.match(source, /packageManager/,
    'the pinned version must be read from package.json, not written twice')
})
