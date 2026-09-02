/** Current release guides must describe runnable, existing commands only. */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = name => readFileSync(join(ROOT, 'docs', name), 'utf8')

test('unpublished packages are installed only from verified artifacts', () => {
  const docs = [read('getting-started.md'), read('setup.md'), read('releasing.md')].join('\n')
  assert.match(docs, /npm run release:artifacts/)
  assert.match(docs, /manual-profile\.mjs --from-artifacts/)
  assert.ok(!/dsh plugin[^\n]*add @deepwatch\//.test(docs))
  assert.ok(!/^\s*npx @deepwatch\//m.test(docs))
})

test('auto transport and provider testing are described as real operations', () => {
  const setup = read('setup.md')
  const provider = read('provider-handoff.md')
  assert.match(setup, /never falls back to mock/)
  assert.match(provider, /Run provider test/)
  assert.match(provider, /there\s+is no `deepwatch providers test` command/i)
  assert.ok(!/deepwatch providers test openrouter/.test(provider))
})

test('historical evidence and process state cannot masquerade as current', () => {
  assert.match(read('release-candidate-audit.md'), /Immutable historical record/)
  assert.ok(!read('running-the-apps.md').includes('Both apps are running now'))
})

test('the first-publish guide fixes the repository, workflow and environment', () => {
  const releasing = read('releasing.md')
  assert.match(releasing, /oxbshw\/watch-skill/)
  assert.match(releasing, /release-deepwatch\.yml/)
  assert.match(releasing, /environment `npm`/)
  assert.match(releasing, /--publish --confirm-first-publish/)
})
