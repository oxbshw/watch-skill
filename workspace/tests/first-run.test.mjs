/**
 * The first screen, and the one thing on it this distribution cannot own.
 *
 * A blank session is the most-read screen in any conversational product. In a
 * DeepWatch profile it was reading as somebody else's: a fish, the headline
 * "Into the Unknown", and a "Preview" badge explaining nothing. Correct for the
 * Harness, and not what a person had installed.
 *
 * Half of this file asserts what DeepWatch now says there. The other half is
 * unusual and deliberate: it asserts that the upstream headline *is still
 * there*, and pins the three reasons it cannot be replaced from a plugin. That
 * is not an endorsement of the state — it is a record, executable, so that
 * whichever of the three stops being true (an upstream slot, a locale-override
 * API, an exported skeleton) fails this file and tells the next person the seam
 * they were waiting for has arrived.
 *
 * A test that simply omitted the subject would let the constraint be forgotten
 * and rediscovered. A test that asserted the headline was gone would be a test
 * that had to be written against a fix nobody could make.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const UPSTREAM = join(ROOT, 'upstream', 'deepseek-harness')
const read = relative => readFileSync(join(ROOT, relative), 'utf8')
const upstream = relative => readFileSync(join(UPSTREAM, relative), 'utf8')

const { EMPTY_STATE_LINE, OFFLINE_CAPABILITIES, WatchEmptyState } = await import(
  pathToFileURL(join(ROOT, 'packages', 'watch', 'workspace', 'lib', 'client', 'empty-state.js')).href)

const WORKSPACE_CLIENT = read('packages/watch/workspace/src/client/index.tsx')
const EMPTY_STATE_SOURCE = read('packages/watch/workspace/src/client/empty-state.tsx')

const render = phase =>
  renderToStaticMarkup(createElement(WatchEmptyState, { session: { composerPhase: phase } }))

describe('DeepWatch says what it is for on the blank screen', () => {
  test('the line is the product, not a feature list', () => {
    assert.equal(EMPTY_STATE_LINE, 'See what happened. Remember why. Verify what worked.')
    assert.ok(render('blank').includes(EMPTY_STATE_LINE))
  })

  test('it names what actually runs before anything is configured', () => {
    // A local-first product whose first screen lists nothing it can do looks
    // unfinished; one that lists everything it could do looks configured when
    // it is not. These four need no provider and no credential.
    const markup = render('blank')
    for (const capability of OFFLINE_CAPABILITIES) {
      assert.ok(markup.includes(capability), `${capability} is not named`)
    }
    assert.ok(markup.includes('without a model'))
  })

  test('it is an empty state, not an advertisement', () => {
    // Left rendered after the conversation starts it would sit above the
    // composer forever.
    assert.equal(render('active'), '')
    assert.equal(render('engaging'), '')
    assert.equal(renderToStaticMarkup(createElement(WatchEmptyState, {})), '')
  })

  test('it has an accessible name and is not a heading competing with the hero', () => {
    const markup = render('blank')
    assert.ok(markup.includes('aria-label="What DeepWatch is for"'))
    assert.equal(/<h1|<h2/.test(markup), false, 'the empty state claims to be the title')
  })

  test('it offers no control it cannot honour', () => {
    // Switching the active conversation view belongs to the chat store, not to
    // a dock component, so "Open Library" here would be a button that does
    // nothing. A dead control teaches people the product is broken faster than
    // a missing one teaches them anything.
    assert.equal(render('blank').includes('<button'), false)
  })

  test('it takes the one hero seat that is a list', () => {
    assert.match(
      WORKSPACE_CLIENT,
      /occupy\('conversation\.input\.dock', 'watch-empty-state', WatchEmptyState, 1\)/)
  })
})

describe('the upstream headline, and why it is still there', () => {
  test('it is one dictionary entry with a single owner', () => {
    // `LocaleService.register` throws on a duplicate (namespace, locale) pair,
    // so no second dictionary can shadow it. If that ever becomes an override
    // API, this assertion is the one that should fail.
    const locales = upstream('packages/client/ui-conversation/src/client/locales.ts')
    assert.match(locales, /'hero\.headline': 'Into the Unknown'/)
    const service = upstream('packages/client/locale/src/client/index.ts')
    assert.match(service, /already has locale/)
  })

  test('no hero slot carries the text', () => {
    // The extracted inventory is the authority here rather than a reading of
    // the source: it is generated from upstream's own `renderSlot` call sites.
    const slots = JSON.parse(read('inventory/dsh-slots.json'))
    const hero = Object.keys(slots.slots)
      .filter(name => name.startsWith('conversation.hero'))
    assert.deepEqual(hero.sort(), [
      'conversation.hero.agentPreset',
      'conversation.hero.brand.mark',
      'conversation.hero.workspace',
      'conversation.hero.workspace.directoryFlow',
    ])
  })

  test('the two hero seats that exist are somebody else’s capability', () => {
    // Taking `conversation.hero.workspace` would displace the workspace
    // picker, and `conversation.hero.agentPreset` the preset chip. This
    // distribution is only ever allowed to add.
    const root = upstream('packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx')
    assert.match(root, /renderSlot\('conversation\.hero\.workspace', \{\s*open: pickerOpen/)
    assert.match(root, /<WorkspaceChip/)
  })

  test('the skeleton that renders it is not exported', () => {
    // Owning `conversation` means reimplementing the whole conversation, and
    // the component cannot even be imported to delegate to.
    const index = upstream('packages/client/ui-conversation/src/client/index.ts')
    assert.equal(index.includes('ConversationRoot'), false)
    const layout = upstream('packages/client/ui-layout/src/client/index.ts')
    assert.match(layout, /'conversation': \{ kind: 'single'/)
  })

  test('the constraint is recorded where somebody will read it', () => {
    // A limitation nobody wrote down is a limitation that gets rediscovered.
    assert.match(EMPTY_STATE_SOURCE, /hero\.headline/)
    assert.match(EMPTY_STATE_SOURCE, /conversation\.hero\.headline/)
    assert.match(EMPTY_STATE_SOURCE, /neither is something a distribution may fake/)
  })

  test('nothing tries to hide it with a stylesheet', () => {
    // The tempting workaround, and the one that breaks silently on any
    // upstream markup change while looking like a fix.
    for (const source of [EMPTY_STATE_SOURCE, WORKSPACE_CLIENT]) {
      assert.equal(/display:\s*none/.test(source), false)
      assert.equal(/visibility:\s*hidden/.test(source), false)
    }
  })
})
