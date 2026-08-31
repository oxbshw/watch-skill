/**
 * A fresh DeepWatch profile points at no model, and says so.
 *
 * A person installed DeepWatch, opened Settings, saved an OpenRouter
 * credential, and went back to the conversation. The composer read
 * `DeepSeek-V4-Flash High`. They had never chosen that, never been offered it,
 * and had no DeepSeek credential — so their first prompt was routed to
 * `deepseek-official`, failed on a missing `DEEPSEEK_API_KEY`, and left a
 * failed turn and a page of internal detail in their session.
 *
 * Nothing was broken. The Harness composes `agent-default-model` with
 * DeepSeek, which is the correct default for the Harness, and DeepWatch had
 * simply inherited it. Inheriting it is the bug: a distribution that ships a
 * model nobody selected has made a routing decision on the user's behalf, and
 * every downstream failure follows from that one.
 *
 * The fix uses the Loader's own patch mechanism to empty that row's config.
 * The tests below hold the three facts that makes it a fix rather than a
 * coincidence:
 *
 *   - the row this distribution patches is the row the pinned baseline
 *     actually composes, so a bump that renames or removes it fails here
 *     rather than silently restoring the default;
 *   - the patch names no module, because a patch that names one is compared
 *     for equality and *skipped with a warning* when it differs — which is the
 *     one failure mode that would put DeepSeek back without any test noticing;
 *   - DeepSeek is still selectable, because removing a provider is not what was
 *     wrong. Choosing it for somebody was. The dedicated adapter is switched
 *     off -- it was the one provider that registered a route without being
 *     configured -- and DeepSeek is reached through the same catalogue as the
 *     other thirty-six, which is what makes it a provider rather than a
 *     default.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const UPSTREAM = join(ROOT, 'upstream', 'deepseek-harness')
const BUNDLE_PATCH = join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml')
const BASE_PATCH = join(UPSTREAM, 'packages', 'bundle', 'base', 'cordis.patch.yml')

const bundle = readFileSync(BUNDLE_PATCH, 'utf8')
const base = readFileSync(BASE_PATCH, 'utf8')

/**
 * The rows of a Cordis patch overlay, read the way the release gate reads them.
 *
 * A line scanner rather than a YAML parser, for the same reason
 * `scripts/verify-bundle.mjs` uses one: the dialect carries `!!js` expression
 * tags, and a test is the last place that should be evaluating them.
 */
function rows(source) {
  const found = []
  let current = null
  let configIndent = null
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.trimStart().startsWith('#')) continue
    const id = /^(\s*)-?\s*id:\s*(.+?)\s*$/.exec(line)
    if (id) {
      if (current) found.push(current)
      current = { id: id[2].replace(/^["']|["']$/g, ''), module: null, config: {}, indent: id[1].length }
      configIndent = null
      continue
    }
    if (!current) continue
    const name = /^\s*name:\s*(.+?)\s*$/.exec(line)
    if (name) { current.module = name[1].replace(/^["']|["']$/g, ''); continue }
    if (/^\s*config:\s*$/.test(line)) { configIndent = line.search(/\S/); continue }
    if (configIndent === null) continue
    const entry = /^(\s*)([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (entry && entry[1].length > configIndent) {
      current.config[entry[2]] = entry[3].replace(/^["']|["']$/g, '')
    }
  }
  if (current) found.push(current)
  return found
}

const bundleRows = rows(bundle)
const baseRows = rows(base)
const patched = bundleRows.find(row => row.id === 'agent-default-model')
const composed = baseRows.find(row => row.id === 'agent-default-model')

describe('the inherited DeepSeek default is gone from a fresh profile', () => {
  test('the baseline still composes the row this distribution patches', () => {
    // The anchor for everything else here. If upstream renames or drops this
    // row, the patch below lands on nothing, the Loader warns into a log
    // nobody reads, and the DeepSeek default is quietly back.
    assert.ok(composed, 'the pinned baseline no longer composes an `agent-default-model` row')
    assert.equal(composed.module, '@deepseek-ai/dsh-agent-default-model')
  })

  test('the baseline default is the DeepSeek pair this bug came from', () => {
    assert.equal(composed.config.provider, 'deepseek-official')
    assert.equal(composed.config.model, 'deepseek-v4-flash')
  })

  test('the bundle empties it', () => {
    assert.ok(patched, 'the DeepWatch bundle does not patch `agent-default-model`')
    assert.equal(patched.config.provider, '')
    assert.equal(patched.config.model, '')
  })

  test('the patch names no module, so it can never be skipped', () => {
    // `applyEntryPatches` treats `name` on a non-insert patch as an assertion:
    // "patch: name mismatch for %C (expected %C, got %C), skipping". A skipped
    // patch is the failure this whole file exists to prevent, and the only way
    // to make it unreachable is to give the matcher nothing to disagree with.
    assert.equal(patched.module, null)
  })

  test('the patch is a top-level row, not one nested in an insert list', () => {
    // A row inside `- insert:` adds a *second* `agent-default-model` and the
    // Loader refuses to boot on a duplicate id. The reconfiguration has to sit
    // at the top level, where it targets the row the base layer already put
    // there.
    assert.equal(patched.indent, 0)
  })
})

describe('DeepSeek stays available; it just stops being chosen', () => {
  test('the baseline composes the dedicated adapter this bundle switches off', () => {
    const adapter = baseRows.find(row => row.module === '@deepseek-ai/dsh-llm-deepseek')
    assert.ok(adapter, 'the pinned baseline no longer composes the DeepSeek adapter')
    assert.equal(adapter.id, 'llm-deepseek')
  })

  test('the dedicated adapter is switched off, and only that one', () => {
    // It registered `deepseek-official` at load with no credential, which made
    // DeepSeek the one provider that configured itself: a route nobody chose
    // that the pre-turn admission check accepted, and a second first-run modal
    // asking for a key to a provider the person had not picked.
    const off = bundleRows.filter(row => row.module === null && row.config.provider === undefined)
    assert.ok(off.some(row => row.id === 'llm-deepseek'))
    assert.equal(/^-\s*id:\s*llm-pi-ai\s*$/m.test(bundle), false,
      'the multi-provider adapter was switched off too, which would remove DeepSeek entirely')
  })

  test('DeepSeek is still in the catalogue every other provider comes from', () => {
    // `llm-pi-ai` declares its whole installed catalogue as configurable from
    // the moment it mounts, so switching off the dedicated adapter changes how
    // DeepSeek is reached, not whether it can be.
    const providers = JSON.parse(readFileSync(join(ROOT, 'inventory', 'dsh-providers.json'), 'utf8'))
    const deepseek = providers.providers.find(entry => entry.id === 'deepseek')
    assert.ok(deepseek, 'DeepSeek is no longer offered by the pinned catalogue')
    assert.equal(deepseek.reachableFromUi, true)
    assert.equal(deepseek.configuredVia, 'DSH Settings → Models & Providers')
  })

  test('nothing in the bundle names a DeepSeek route as a value', () => {
    // The distinction the copy in this file keeps making: `deepseek-official`
    // may appear in the catalogue a person picks from, and must not appear as
    // a value this distribution writes into a profile.
    for (const row of bundleRows) {
      for (const [key, value] of Object.entries(row.config)) {
        assert.equal(
          /deepseek/i.test(value), false,
          `bundle row "${row.id}" sets ${key} to a DeepSeek value (${value})`)
      }
    }
  })
})

describe('what an emptied default means downstream', () => {
  test('an empty provider is a route no adapter serves', () => {
    // `turnAgentFor` in the API proxy refuses a turn whose provider is not in
    // `llm.listProviders()`, *before* `agent.followup(message)` — so an
    // unconfigured Chat is refused before a durable turn exists. An empty
    // string cannot be a registered route id, which is what makes the emptied
    // default land on that boundary rather than sailing past it.
    const proxy = readFileSync(
      join(UPSTREAM, 'packages', 'host', 'apiproxy', 'src', 'api-proxy.ts'), 'utf8')
    assert.match(proxy, /function routeServed\(provider: string\): boolean/)
    assert.match(proxy, /llm\.listProviders\(\)\.some\(entry => entry\.id === provider\)/)
    // The refusal has to happen inside the same helper the prompt path calls,
    // and it has to happen before admission. Both are read from the source
    // rather than assumed, because the whole design rests on them.
    const refusal = proxy.slice(proxy.indexOf('async function turnAgentFor'))
    assert.ok(refusal.indexOf("code: 'model-unavailable'") > 0)
    const prompt = proxy.slice(proxy.indexOf('      async prompt(request) {'))
    assert.ok(
      prompt.indexOf('turnAgentFor') < prompt.indexOf('agent.followup'),
      'the prompt path admits the message before it checks the route')
  })

  test('an empty selection is a value the row’s own schema accepts', () => {
    // `provider` and `model` are `z.string().required()`, which rejects a
    // *missing* key and accepts an empty one. If that ever changes, the
    // profile fails to compose rather than falling back — and this test is
    // where that shows up.
    const source = readFileSync(
      join(UPSTREAM, 'packages', 'core', 'agent-default-model', 'src', 'index.ts'), 'utf8')
    assert.match(source, /static Config: z<Config> = z\.object\(\{\s*provider: z\.string\(\)\.required\(\),\s*model: z\.string\(\)\.required\(\),/)
  })
})
