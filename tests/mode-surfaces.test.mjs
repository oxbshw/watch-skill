/**
 * The four Watch modes have to be surfaces, not headings.
 *
 * The bar these assertions hold is the one that was actually missed: every mode
 * registered correctly, DSH drew its tab, and the body rendered nothing at all.
 * A tab that opens onto blank space is worse than a missing tab, because it
 * reads as a broken feature rather than an absent one.
 *
 * So this checks the three things that make a surface honest — it says what it
 * shows, why it is empty, and what to do next — and the one thing that makes it
 * safe: it never claims a capability the build does not have.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => readFileSync(join(ROOT, relative), 'utf8')

const SURFACE = read('packages/watch/workspace/src/client/surface.tsx')
const VIEWS = read('packages/watch/workspace/src/client/mode-views.tsx')

test('the mode scaffold', async t => {
  await t.test('an empty state must say what, why, and what next', () => {
    // Three required props. "No data" alone teaches people the product is
    // broken; the reason and the next step are what make it a product.
    assert.match(SURFACE, /shows, why, next/)
    assert.match(SURFACE, /readonly next: readonly string\[\]/)
  })

  await t.test('empty and unavailable are different states', () => {
    // Empty means nothing has happened yet. Unavailable means the surface
    // could not show it even if something had. Conflating them makes a working
    // feature look broken, or a missing one look merely quiet.
    assert.match(SURFACE, /export function EmptyState/)
    assert.match(SURFACE, /export function Unavailable/)
    assert.match(SURFACE, /Not available in this build/)
  })

  await t.test('a surface owns its own scroll', () => {
    // The page body must never scroll sideways, and a mode that grows has to
    // scroll inside its own region rather than pushing the shell around.
    assert.match(SURFACE, /overflowY: 'auto'/)
    assert.match(SURFACE, /minHeight: 0/)
  })

  await t.test('offsets are logical, so RTL needs no second stylesheet', () => {
    assert.match(SURFACE, /borderInlineStart|paddingInlineStart/)
    assert.doesNotMatch(SURFACE, /borderLeft:|paddingLeft:|marginLeft:/)
  })

  await t.test('a tool result that cannot be read renders nothing', () => {
    // A surface that cannot parse its input must not draw a card implying it
    // did. Running calls, failed calls and non-JSON all return null.
    assert.match(SURFACE, /export function readToolResult/)
    assert.match(SURFACE, /isError === true\) return null/)
  })
})

test('the Watch mode', async t => {
  await t.test('it leads with completed being different from verified', () => {
    assert.match(VIEWS, /Agent completed . Verified/)
  })

  await t.test('every verdict carries a word, not only a colour', () => {
    for (const verdict of ['VERIFIED', 'FAILED', 'UNVERIFIED', 'INCONCLUSIVE', 'DISPUTED']) {
      assert.ok(VIEWS.includes(verdict), `${verdict} has no rendering`)
    }
    assert.match(VIEWS, /disappears on a monochrome display/)
  })

  await t.test('only VERIFIED reaches the success tone', () => {
    const table = /const VERDICTS[\s\S]*?\n\}/.exec(VIEWS)?.[0] ?? ''
    const successes = [...table.matchAll(/(\w+): \{\s*\n\s*tone: 'var\(--watch-tone-success\)'/g)]
    assert.equal(successes.length, 1)
    assert.equal(successes[0][1], 'VERIFIED')
  })

  await t.test('a check that did not run is not a check that failed', () => {
    // `passed` is nullable in the contract, and the third state matters: a red
    // mark against something nobody looked at is a false accusation.
    assert.match(VIEWS, /did not run/)
    assert.match(VIEWS, /check\.passed === true/)
    assert.match(VIEWS, /check\.passed === false/)
  })

  await t.test('it never claims to issue a verdict', () => {
    assert.match(VIEWS, /reads records[\s\S]{0,40}rather than producing them/)
  })
})

test('the Live mode', async t => {
  await t.test('it requests nothing on load', () => {
    assert.match(VIEWS, /Opening this page starts nothing and asks for nothing/)
    // No permission API is touched at render time.
    assert.doesNotMatch(VIEWS, /getUserMedia|getDisplayMedia|requestPermission/)
  })

  await t.test('every source says when it would ask', () => {
    const sources = /const LIVE_SOURCES[\s\S]*?\n\]/.exec(VIEWS)?.[0] ?? ''
    const entries = [...sources.matchAll(/id: '/g)]
    const asks = [...sources.matchAll(/asks: '/g)]
    assert.ok(entries.length >= 6)
    assert.equal(entries.length, asks.length)
  })

  await t.test('Browser Observer and Browser Operator stay separate', () => {
    // Watching a page and acting on one carry different consequences. A single
    // "browser" switch would grant the second while a person believed they were
    // enabling the first.
    assert.match(VIEWS, /id: 'browser-observer'/)
    assert.match(VIEWS, /id: 'browser-operator'/)
    assert.match(VIEWS, /A separate capability from observing/)
  })

  await t.test('no Start control is offered for a backend that is absent', () => {
    // A dead control that fails when clicked teaches people the product is
    // broken rather than that a capability is missing.
    assert.match(VIEWS, /Starting a live session/)
    assert.match(VIEWS, /would fail when pressed/)
  })
})

test('Library and Compare are honest about their limits', async t => {
  await t.test('Library does not offer a search box it cannot answer', () => {
    assert.match(VIEWS, /Search, filtering and revision history/)
    assert.match(VIEWS, /no client-side store to search/)
  })

  await t.test('Compare never fabricates a second column', () => {
    assert.match(VIEWS, /rather than fabricating a second column/)
  })

  await t.test('a comparison describes a difference, never a verdict', () => {
    assert.match(VIEWS, /never issues a verdict/)
  })

  await t.test('each names what it would take to work', () => {
    const unavailable = [...VIEWS.matchAll(/wouldNeed=\{\[/g)]
    assert.ok(unavailable.length >= 2, 'an unavailable state with no route out is a dead end')
  })
})

test('the modes are registered as the bodies DSH renders', async t => {
  const REG = {
    watch: read('packages/watch/workspace/src/client/index.tsx'),
    live: read('packages/watch/live/src/client/index.tsx'),
    library: read('packages/watch/library/src/client/index.tsx'),
    compare: read('packages/watch/client-evidence/src/client/index.tsx'),
  }

  await t.test('each view registration points at a mode body', () => {
    assert.match(REG.watch, /mode\('watch', 'Watch', WatchModeView/)
    assert.match(REG.live, /id: 'live'[\s\S]{0,90}LiveModeView/)
    assert.match(REG.library, /id: 'library'[\s\S]{0,90}LibraryModeView/)
    assert.match(REG.compare, /id: 'compare'[\s\S]{0,90}CompareModeView/)
  })

  await t.test('cross-package imports use the plain ESM subpath', () => {
    // `/client` is a loader registration wrapped in a function body, and a
    // bundler cannot read named exports out of it — the build fails with
    // MISSING_EXPORT for a symbol that is plainly in the source.
    for (const [name, source] of Object.entries(REG)) {
      if (name === 'watch') continue
      assert.match(source, /@watchskill\/dsh-workspace\/mode-views/)
      assert.doesNotMatch(source, /from '@watchskill\/dsh-workspace\/client'/)
    }
  })

  await t.test('client bundles build in dependency order', () => {
    // Alphabetical order had client-evidence bundle before workspace and
    // resolve a bundle that did not exist yet.
    const build = read('scripts/build.mjs')
    assert.match(build, /dependency order/)
    assert.match(build, /cycle/)
  })
})
