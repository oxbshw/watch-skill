/** Current release guides must describe runnable, existing commands only. */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')
const read = name => readFileSync(join(DOCS, name), 'utf8')

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
  // Two halves. A past audit says so in its own first lines *and* is out of
  // the docs index, because the failure is not that somebody cannot find it —
  // it is that somebody finds it, reads a total, and repeats it as current.
  const audit = read('history/release-candidate-audit-02343ca.md')
  assert.match(audit, /Immutable historical record/)
  assert.match(read('history/README.md'), /records? of one run at one commit/i)
  assert.ok(!read('running-the-apps.md').includes('Both apps are running now'))

  for (const name of ['release-candidate-audit.md', 'validation-matrix.md']) {
    assert.equal(existsSync(join(DOCS, name)), false,
      `${name} is back beside the current documents`)
  }
})

test('the first-publish guide fixes the repository, workflow and environment', () => {
  // The three things `npm trust github` will not guess, spelled as the guide
  // spells them to a person running it. This used to assert the literal prose
  // "environment `npm`", which failed the moment the sentence was rewritten to
  // "the GitHub `npm` environment" — same environment, same guidance, better
  // English. An assertion that a document names a deployment environment
  // should not also be an assertion about adjective order, so it now reads the
  // trust parameter itself and the protection the guide asks for around it.
  const releasing = read('releasing.md')
  assert.match(releasing, /oxbshw\/watch-skill/)
  assert.match(releasing, /release-deepwatch\.yml/)
  assert.match(releasing, /--env npm/)
  assert.match(releasing, /`npm` environment with required\n?\s*reviewers/)
  assert.match(releasing, /--publish --confirm-first-publish/)
})
