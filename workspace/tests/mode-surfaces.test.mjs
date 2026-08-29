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
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => readFileSync(join(ROOT, relative), 'utf8')

const SURFACE = read('packages/watch/workspace/src/client/surface.tsx')
// The Watch mode body stayed in workspace; the other three moved into the
// packages that own their capability, because a mode view and the engine
// behind it belonging to different packages is what created the circular
// project reference. Each mode is now read from where it actually lives.
const VIEWS = read('packages/watch/workspace/src/client/mode-views.tsx')
const LIVE = read('packages/watch/live/src/client/live-mode.tsx')
const CAPTURE = read('packages/watch/live/src/capture.ts')
const SOURCES = read('packages/watch/live/src/sources-catalogue.ts')
const LIBRARY = read('packages/watch/library/src/client/library-mode.tsx')
const SEARCH_VIEW = read('packages/watch/library/src/client/search-view.tsx')
const INDEX = read('packages/watch/library/src/index-store.ts')
const COMPARE = read('packages/watch/client-evidence/src/client/compare-mode.tsx')
const COMPARE_ENGINE = read('packages/watch/client-evidence/src/compare-engine.ts')
/** The three bodies that live outside workspace and reach back into it. */
const BODIES = { live: LIVE, library: LIBRARY, compare: COMPARE }

/** Every shipped TypeScript source, so a rule can be held repo-wide. */
function shippedSources(dir = 'packages', found = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) shippedSources(relative, found)
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(relative)
  }
  return found
}

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
    // The property that has to survive implementation. Live now really
    // captures, which makes this assertion more important than it was when
    // there was nothing behind the button: a page that asks for the camera
    // because someone opened a tab has already lost the argument.
    assert.match(LIVE, /Opening this page starts nothing and asks for nothing/)
    assert.doesNotMatch(LIVE, /getUserMedia|getDisplayMedia|requestPermission/)
  })

  await t.test('permission is requested by the session, never by the view', () => {
    // The capture state machine owns the request, and it is reachable only
    // from an explicit start. The view renders state; it cannot originate one.
    assert.match(CAPTURE, /requesting_permission/)
    assert.match(CAPTURE, /requestPermission/)
    assert.doesNotMatch(LIVE, /new CaptureSession/)
  })

  await t.test('every source says when it would ask', () => {
    const entries = [...SOURCES.matchAll(/\n {4}id: '/g)]
    const asks = [...SOURCES.matchAll(/\n {4}asks: '/g)]
    assert.ok(entries.length >= 6, `only ${String(entries.length)} source(s)`)
    assert.equal(entries.length, asks.length, 'a source with no permission sentence')
  })

  await t.test('Browser Observer and Browser Operator stay separate', () => {
    // Watching a page and acting on one carry different consequences. A single
    // "browser" switch would grant the second while a person believed they
    // were enabling the first, so exactly one source may act.
    assert.match(SOURCES, /id: 'browser-observer'/)
    assert.match(SOURCES, /id: 'browser-operator'/)
    const acting = [...SOURCES.matchAll(/canAct: true/g)]
    assert.equal(acting.length, 1, 'more than one source can act on the world')
    assert.match(SOURCES, /idempotency key/)
  })

  await t.test('a session that is cancelled while starting still releases', () => {
    // The leak this covers: cancel ran teardown before the adapter had
    // allocated anything, so the once-guard then blocked the cleanup that
    // mattered. The late-start path stops the adapter directly.
    assert.match(CAPTURE, /if \(this\.finished\)/)
    assert.match(CAPTURE, /await this\.#adapter\.stop\(\)/)
  })

  await t.test('no Start control is offered for a backend that is absent', () => {
    // A dead control that fails when clicked teaches people the product is
    // broken rather than that a capability is missing.
    assert.match(LIVE, /wouldNeed=\{\[/)
  })
})

test('Library searches what it has, and says how much that is', async t => {
  await t.test('the search box is wired to a real index', () => {
    // This assertion used to read "Library does not offer a search box it
    // cannot answer", which was the right rule while there was no index. The
    // rule did not change; the answer did. There is an index now, so the box
    // is present and must be connected to it.
    assert.match(LIBRARY, /import \{ LibrarySearch \}/)
    assert.match(SEARCH_VIEW, /export function LibrarySearch/)
    assert.match(INDEX, /export class LibraryIndex/)
  })

  await t.test('the index reports its own health rather than guessing', () => {
    // 'ready' and 'empty' are different answers, and so are 'stale' and
    // 'corrupt'. A search that silently returns nothing from a broken index is
    // indistinguishable from one that correctly found nothing.
    for (const health of ['empty', 'ready', 'indexing', 'stale', 'corrupt']) {
      assert.ok(INDEX.includes(`'${health}'`), `${health} is not a reportable state`)
    }
    assert.match(SEARCH_VIEW, /Rebuild index/)
  })

  await t.test('a match is highlighted as elements, never as markup', () => {
    // Highlighting by building an HTML string would make every indexed record
    // a script injection vector, and records come from tool output.
    assert.match(SEARCH_VIEW, /function Highlighted/)
    assert.doesNotMatch(SEARCH_VIEW, /dangerouslySetInnerHTML/)
  })

  await t.test('a slow query cannot overwrite a newer one', () => {
    assert.match(SEARCH_VIEW, /AbortController/)
  })
})

test('Compare describes a difference, and never issues a verdict', async t => {
  await t.test('it compares records it was given, and fabricates no column', () => {
    assert.match(COMPARE, /export function CompareModeView/)
    assert.match(COMPARE_ENGINE, /export function compare/)
  })

  await t.test('output differences stay separate from verification differences', () => {
    // Merging them lets a changed sentence read as a changed verdict. They are
    // different findings and are rendered in different sections.
    assert.match(COMPARE, /Verification differences/)
    assert.match(COMPARE, /differences kept separate from verification differences/)
    assert.match(COMPARE_ENGINE, /readonly claims/)
    assert.match(COMPARE_ENGINE, /readonly output/)
  })

  await t.test('a disposition names what changed, not whether it is good', () => {
    // ADR-002: only Watch Core mints a verdict. Compare may observe that one
    // changed; it may never decide which side is right.
    for (const disposition of ['matching', 'changed', 'verdict_changed', 'contradictory', 'unverifiable']) {
      assert.ok(COMPARE_ENGINE.includes(disposition), `${disposition} has no disposition`)
    }
    assert.doesNotMatch(COMPARE_ENGINE, /VERDICT|mintVerdict|issueVerdict/)
  })

  await t.test('the comparison is deterministic', () => {
    // Two runs over the same pair must produce the same answer, or a
    // difference report is not evidence of anything.
    assert.doesNotMatch(COMPARE_ENGINE, /Math\.random|Date\.now\(\)/)
  })

  await t.test('an unavailable state still names a route out', () => {
    const unavailable = [...(LIVE + LIBRARY + COMPARE).matchAll(/wouldNeed=\{\[/g)]
    assert.ok(unavailable.length >= 1, 'an unavailable state with no route out is a dead end')
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
    // MISSING_EXPORT for a symbol that is plainly in the source. The shared
    // scaffold is therefore reached through `/surface`, a plain ESM entry.
    //
    // The import moved when the mode bodies moved: the registration files now
    // import their own view locally, and it is the view that reaches across.
    for (const [name, source] of Object.entries(BODIES)) {
      assert.match(
        source, /@watchskill\/dsh-workspace\/surface/,
        `the ${name} body does not use the plain ESM scaffold entry`,
      )
    }
    // And the rule holds everywhere, not only in the files this test names.
    const offenders = []
    for (const file of shippedSources()) {
      if (/from '@watchskill\/dsh-[a-z-]+\/client'/.test(read(file))) offenders.push(file)
    }
    assert.deepEqual(offenders, [], 'a shipped source imports a loader-wrapped bundle')
  })

  await t.test('client bundles build in dependency order', () => {
    // Alphabetical order had client-evidence bundle before workspace and
    // resolve a bundle that did not exist yet.
    const build = read('scripts/build.mjs')
    assert.match(build, /dependency order/)
    assert.match(build, /cycle/)
  })
})
