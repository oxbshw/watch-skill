/** The irreversible first-publish path is held to its offline contract. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { EXPECTED_ORDER } from '../scripts/first-publish.mjs'
import { publishOrder } from '../scripts/publish-order.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = readFileSync(join(ROOT, 'scripts', 'first-publish.mjs'), 'utf8')

test('the bootstrap order is the approved dependency order for all 20 packages', () => {
  assert.equal(EXPECTED_ORDER.length, 20)
  assert.deepEqual(publishOrder().map(entry => entry.name), [...EXPECTED_ORDER])
})

test('dry-run is the default and publishing needs two explicit flags', () => {
  assert.match(SOURCE, /process\.argv\.includes\('--publish'\)/)
  assert.match(SOURCE, /--publish also requires --confirm-first-publish/)
  assert.match(SOURCE, /if \(!publishing\)/)
  assert.ok(SOURCE.indexOf('if (!publishing)') < SOURCE.indexOf("npm(['publish'"))
})

test('the only publish command is public preview publication of a tarball', () => {
  const calls = [...SOURCE.matchAll(/npm\(\['publish',[\s\S]{0,180}?\]\)/g)]
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], /'--access', 'public', '--tag', 'preview'/)
  assert.ok(!SOURCE.includes('shell: true'))
})

test('a partial run records created, skipped, failed and remaining packages', () => {
  for (const field of ['created', 'skipped', 'failed', 'remaining']) {
    assert.match(SOURCE, new RegExp(`${field}:`))
  }
  assert.match(SOURCE, /saveState\(statePath, state\)/)
})

test('access probes do not print an npm identity or configuration', () => {
  assert.match(SOURCE, /'whoami'/)
  assert.match(SOURCE, /'access', 'list', 'packages', '@deepwatch'/)
  assert.ok(!SOURCE.includes('process.stdout.write(identity'))
  assert.ok(!SOURCE.includes('process.stdout.write(access'))
})
