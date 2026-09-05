/** The irreversible first-publish path is held to its offline contract. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { EXPECTED_ORDER, distTag } from '../scripts/first-publish.mjs'
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
  assert.ok(SOURCE.indexOf('if (!publishing)') < SOURCE.indexOf("'publish',"))
})

/** The single publish call, for the assertions that read its arguments. */
function publishCall() {
  const calls = [...SOURCE.matchAll(/npm\(\[\s*'publish',[\s\S]{0,220}?\]\)/g)]
  assert.equal(calls.length, 1, 'there must be exactly one publish command')
  return calls[0][0]
}

test('the only publish command is a public tarball publication', () => {
  assert.match(publishCall(), /'--access', 'public'/)
  assert.ok(!SOURCE.includes('shell: true'))
})

test('the dist-tag is derived from the version, never hardcoded', () => {
  // It was hardcoded to `preview`, which was right while every version was a
  // preview and silently wrong the moment one was not: a stable release
  // published under `preview` leaves `npm i @deepwatch/cli` resolving nothing,
  // because `latest` would never exist.
  assert.match(publishCall(), /'--tag', distTag\(/)
  assert.doesNotMatch(SOURCE, /'--tag', 'preview'/)

  assert.equal(distTag('0.1.0'), 'latest')
  assert.equal(distTag('1.4.0'), 'latest')
  assert.equal(distTag('0.1.0-preview.0'), 'preview')
  assert.equal(distTag('0.1.0-rc.1'), 'next')
  // A prerelease shape this train has no tag for is a refusal rather than a
  // guess: the release workflow makes the same call, and the two must not
  // disagree about a publication that cannot be taken back.
  assert.throws(() => distTag('0.1.0-beta.1'), /no dist-tag for/)
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
