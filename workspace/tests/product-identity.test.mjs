/**
 * The product is Watch Workspace, and DeepSeek Harness is what it is built on.
 *
 * Every assertion here exists because the opposite was true at some point in
 * this pass, and none of it was caught by a component test. The product looked
 * like stock DSH while every unit test passed, because the failures were all in
 * the seams: a name that lived in two places, a registration into a slot that
 * is never rendered, a client package that was never composed, an official row
 * left enabled beside its replacement.
 *
 * So this file tests the seams. It reads the shipped sources rather than
 * importing behaviour, because what is being checked is what a built profile
 * will actually compose.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as decoderModule from '../scripts/brand-assets.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = relative => readFileSync(join(ROOT, relative), 'utf8')

const BRAND = read('packages/watch/brand/src/identity.ts')
const BRAND_CLIENT = read('packages/watch/brand/src/client/index.tsx')
const BUNDLE = read('packages/watch/bundle/cordis.patch.yml')
const DESKTOP = read('apps/desktop/main.mjs')
const SETTINGS = read('packages/watch/client-settings/src/client/index.tsx')
const SLOTS = JSON.parse(read('inventory/dsh-slots.json'))

test('the product identity', async t => {
  await t.test('the product is named Watch Workspace', () => {
    assert.match(BRAND, /export const PRODUCT_NAME = 'Watch Workspace'/)
  })

  await t.test('the desktop window uses the same name, character for character', () => {
    // main.mjs runs in the Electron main process, before any workspace package
    // is resolvable, so it restates the name instead of importing it. Two
    // copies of a product name drift; this is what stops them.
    const brandName = /export const PRODUCT_NAME = '([^']+)'/.exec(BRAND)?.[1]
    const desktopName = /^const PRODUCT_NAME = '([^']+)'$/m.exec(DESKTOP)?.[1]
    assert.equal(desktopName, brandName)
    assert.equal(desktopName, 'Watch Workspace')
  })

  await t.test('the desktop window refuses a title the page proposes', () => {
    // Without this the window is titled "DeepSeek Harness" for as long as the
    // built HTML shell takes to hand over to the brand plugin.
    assert.match(DESKTOP, /page-title-updated/)
    assert.match(DESKTOP, /window\.setTitle\(PRODUCT_NAME\)/)
  })

  await t.test('the desktop package carries the Watch identity', () => {
    const manifest = JSON.parse(read('apps/desktop/package.json'))
    assert.equal(manifest.productName, 'Watch Workspace')
  })

  await t.test('the document title and favicon are claimed at runtime', () => {
    // The `<title>` and icon live in DSH's built HTML, which is a published
    // artifact this distribution does not fork. The product takes its name
    // when the brand plugin loads, and re-asserts it on mutation because DSH's
    // session layer writes the title too.
    assert.match(BRAND_CLIENT, /document\.title = .*PRODUCT_NAME/s)
    assert.match(BRAND_CLIENT, /MutationObserver/)
    assert.match(BRAND_CLIENT, /rel~="icon"/)
  })
})

test('DeepSeek Harness attribution', async t => {
  await t.test('the attribution line is exact', () => {
    assert.match(
      BRAND,
      /export const ATTRIBUTION = 'Built on DeepSeek Harness · Extended by Watch Skill'/,
    )
  })

  await t.test('the independence disclosure is present and unambiguous', () => {
    const disclosure = /export const INDEPENDENCE\s*=\s*\n?\s*'([^']+)'/.exec(BRAND)?.[1]
    assert.ok(disclosure !== undefined)
    assert.match(disclosure, /independent project/)
    assert.match(disclosure, /not affiliated with or endorsed by DeepSeek/)
  })

  await t.test('both lines render together, on every screen', () => {
    // They are a legal statement, not a design element, and a legal statement
    // that depends on being remembered eventually is not.
    assert.match(BRAND_CLIENT, /sidebar\.footer\.action/)
    assert.match(BRAND_CLIENT, /\{ATTRIBUTION\}/)
    assert.match(BRAND_CLIENT, /\{INDEPENDENCE\}/)
  })

  await t.test('the collapsed rail keeps the attribution reachable', () => {
    // DSH passes `wide`. Ignoring it reflowed sixty words of legal text into a
    // 40px column, which is not attribution — it is noise shaped like it.
    assert.match(BRAND_CLIENT, /wide/)
    assert.match(BRAND_CLIENT, /aria-label=\{full\}/)
  })

  await t.test('the About section states the foundation and its exact version', () => {
    const components = read('packages/watch/client-settings/src/client/components.tsx')
    assert.match(components, /DeepSeek Harness 0\.1\.1-rc\.2/)
    assert.match(components, /b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/)
    assert.match(components, /\{ATTRIBUTION\}/)
    assert.match(components, /\{INDEPENDENCE\}/)
  })
})

test('the bundle composes the whole product', async t => {
  const CLIENT_ROWS = [
    ['watch-brand', '@watchskill/dsh-client-brand'],
    ['watch-client-evidence', '@watchskill/dsh-client-evidence'],
    ['watch-workspace', '@watchskill/dsh-workspace'],
    ['watch-live', '@watchskill/dsh-live'],
    ['watch-library', '@watchskill/dsh-library'],
    ['watch-client-memory', '@watchskill/dsh-client-memory'],
    ['watch-client-settings', '@watchskill/dsh-client-settings'],
  ]

  for (const [id, module] of CLIENT_ROWS) {
    await t.test(`${id} is composed`, () => {
      // Five of these existed, were tested, and were never in the bundle — so
      // none of them loaded, and the product rendered as stock DSH.
      assert.match(BUNDLE, new RegExp(`- id: ${id}\\n\\s+name: '${module.replace('/', '\\/')}'`))
    })
  }

  await t.test('every composed client package is a declared dependency', () => {
    // A row that names a module the bundle does not depend on resolves the
    // layer and then fails to import it.
    const manifest = JSON.parse(read('packages/watch/bundle/package.json'))
    for (const [, module] of CLIENT_ROWS) {
      assert.ok(
        module in manifest.dependencies,
        `${module} is composed but not depended on`,
      )
    }
  })

  await t.test('every composed client package ships the files its entry imports', () => {
    // The brand tarball listed `lib/index.js` explicitly and not the
    // `lib/identity.js` it imports, so the profile installed a package that
    // could not be loaded. The glob is what every other package uses.
    for (const [, module] of CLIENT_ROWS) {
      const directory = module.replace('@watchskill/dsh-', '')
      const path = `packages/watch/${directory === 'client-brand' ? 'brand' : directory}/package.json`
      if (!existsSync(join(ROOT, path))) continue
      const manifest = JSON.parse(read(path))
      assert.ok(
        manifest.files.includes('lib/**/*.js'),
        `${module} does not ship lib/**/*.js, so a transitive import can be missing`,
      )
    }
  })

  await t.test('the official brand row is disabled, not merely shadowed', () => {
    // `renderSlot(…, { fallback })` draws DeepSeek's mark when nothing is
    // registered, and ui-brand-official registers into the same slots. Both
    // halves are needed: register Watch, and switch the official row off.
    assert.match(BUNDLE, /- id: ui-brand-official\n\s+disabled: true/)
  })

  await t.test('nothing upstream is removed beyond that one row', () => {
    const disabled = [...BUNDLE.matchAll(/^- id: (\S+)\n\s+disabled: true/gm)].map(m => m[1])
    assert.deepEqual(disabled, ['ui-brand-official'])
  })
})

test('the product modes are DSH views', async t => {
  const WORKSPACE = read('packages/watch/workspace/src/client/index.tsx')
  const EVIDENCE = read('packages/watch/client-evidence/src/client/index.tsx')
  const LIVE = read('packages/watch/live/src/client/index.tsx')
  const LIBRARY = read('packages/watch/library/src/client/index.tsx')
  const MEMORY = read('packages/watch/client-memory/src/client/index.tsx')

  // The workspace shell declares its view through the shared `mode` helper
  // rather than inline, so it is matched by the call rather than the literal.
  const MODES = [
    ['watch', WORKSPACE, /mode\('watch', 'Watch'/],
    ['live', LIVE, /name: 'conversation\.view', id: 'live'/],
    ['library', LIBRARY, /name: 'conversation\.view', id: 'library'/],
    ['memory', MEMORY, /name: 'conversation\.view', id: 'memory'/],
    ['compare', EVIDENCE, /name: 'conversation\.view', id: 'compare'/],
  ]

  for (const [id, source, pattern] of MODES) {
    await t.test(`${id} registers as a conversation view`, () => {
      assert.match(source, /conversation\.view/)
      assert.match(source, pattern)
    })
  }

  await t.test('Agent and Trajectory are upstream views, left alone', () => {
    // `chat` and `trajectory` are DSH's. Registering our own would be a
    // duplicate, and shadowing them would remove an official capability.
    for (const [, source] of MODES) {
      assert.doesNotMatch(source, /id: 'chat'/)
      assert.doesNotMatch(source, /id: 'trajectory'/)
    }
  })

  await t.test('Watch ships no mode switcher of its own', () => {
    // DSH builds a real role="tablist" from the registered views. A second
    // control beside it would be a duplicate navigation system.
    assert.doesNotMatch(WORKSPACE, /occupy\([^)]*ModeSwitcher/)
    assert.match(WORKSPACE, /export \{[^}]*ModeSwitcher/)
  })

  await t.test('conversation.view is a list, so the modes sit beside upstream', () => {
    assert.equal(SLOTS.slots['conversation.view'].kind, 'list')
  })
})

test('slot discipline', async t => {
  await t.test('the inventory carries a kind and a source for every slot', () => {
    for (const [name, entry] of Object.entries(SLOTS.slots)) {
      assert.ok(
        ['single', 'list', 'keyed', 'unknown'].includes(entry.kind),
        `${name} has no usable kind (${entry.kind})`,
      )
      assert.ok(
        ['contract', 'call-site'].includes(entry.source),
        `${name} does not say where it came from`,
      )
      // Only a call-site slot may be unknown: the contract always states a kind.
      if (entry.kind === 'unknown') assert.equal(entry.source, 'call-site')
    }
  })

  await t.test('the inventory was read from the pinned DSH', () => {
    assert.equal(SLOTS.dshVersion, '0.1.1-rc.2')
  })

  await t.test('Watch never takes a single seat DSH already fills', () => {
    // sidebar.workspaces holds DSH's workspace switcher and
    // conversation.composer.bar holds the composer. Taking either would replace
    // an official capability rather than add a Watch one.
    const WORKSPACE = read('packages/watch/workspace/src/client/index.tsx')
    assert.doesNotMatch(WORKSPACE, /occupy\('sidebar\.workspaces'/)
    assert.doesNotMatch(WORKSPACE, /occupy\('conversation\.composer\.bar'/)
    assert.equal(SLOTS.slots['sidebar.workspaces'].kind, 'single')
    // `conversation.composer.bar` is absent from DSH's contract catalogue, so
    // its kind cannot be read — but the runtime proves it is single, and the
    // gate treats an unprovable seat exactly as strictly as a proven one.
    assert.ok(['single', 'unknown'].includes(SLOTS.slots['conversation.composer.bar'].kind))
  })

  await t.test('the inventory is the union of both sources, not either alone', () => {
    // The catalogue omits two slots DSH renders; the call sites omit three
    // container seats. Taking one source only would leave a real slot
    // unguarded, which is how a shadow gets through.
    const bySource = {}
    for (const entry of Object.values(SLOTS.slots)) {
      bySource[entry.source] = (bySource[entry.source] ?? 0) + 1
    }
    assert.ok(bySource.contract > 0 && bySource['call-site'] > 0)
    assert.ok(Object.keys(SLOTS.slots).length > bySource.contract)
  })

  await t.test('an unprovable seat is as protected as a single one', () => {
    const gate = read('scripts/verify-slots.mjs')
    assert.match(gate, /kind === 'single' \|\| kind === 'unknown'/)
  })

  await t.test('the only single seats Watch takes are the brand ones', () => {
    const gate = read('scripts/verify-slots.mjs')
    const shadows = [...gate.matchAll(/\['([a-z][a-zA-Z0-9.]+)', '[^']*'\]/g)].map(m => m[1])
    assert.deepEqual(shadows.sort(), [
      'conversation.hero.brand.mark',
      'sidebar.brand.mark',
      'sidebar.brand.name',
    ])
  })
})

test('the Technology & Capability Center', async t => {
  const SECTIONS = [
    ['watch-roles', 'Role Bindings'],
    ['watch-engines', 'Perception'],
    ['watch-sources', 'Sources'],
    ['watch-memory', 'Memory'],
    ['watch-verification', 'Verification'],
    ['watch-diagnostics', 'Diagnostics'],
    ['watch-about', 'About'],
  ]

  for (const [id, label] of SECTIONS) {
    await t.test(`${label} is registered`, () => {
      assert.match(SETTINGS, new RegExp(`section\\('${id}', '${label.replace('&', '&')}'`))
    })
  }

  await t.test('every section label fits the nav that has to show it', () => {
    // Measured in the running settings nav: the label slot is 112px, and it
    // ellipsises. "Perception Engines" (118px), "Sources & Devices" (114px)
    // and "Memory & Retrieval" (124px) all overflowed, so three of the eight
    // Watch sections read as "Perception Engi…", "Sources & Devic…" and
    // "Memory & Retri…" in every screenshot taken.
    //
    // Character count is a proxy for pixels and an imperfect one — the real
    // check is a screenshot. It is used here because a unit test has no font
    // to measure with, and 13 is the longest label observed to fit ("Role
    // Bindings", 84px). Anything longer needs measuring before it ships.
    const BUDGET = 13
    for (const [, label] of SECTIONS) {
      assert.ok(
        label.length <= BUDGET,
        `"${label}" is ${String(label.length)} characters; the nav ellipsises past about ${String(BUDGET)}`,
      )
    }
  })
  await t.test('upstream sections keep the top of the list', () => {
    // DSH's General is 0 and Models is 10. Everything Watch adds starts at 20.
    const orders = [...SETTINGS.matchAll(/section\('[^']+', '[^']+', (\d+)/g)]
      .map(m => Number(m[1]))
    assert.ok(orders.length === SECTIONS.length)
    assert.ok(Math.min(...orders) >= 20, 'a Watch section would displace an upstream one')
  })

  await t.test('settings.section is a list, so nothing upstream is replaced', () => {
    assert.equal(SLOTS.slots['settings.section'].kind, 'list')
  })
})

test('capability truth in the product surfaces', async t => {
  const COMPONENTS = read('packages/watch/client-settings/src/client/components.tsx')
  const ONBOARDING = read('packages/watch/client-settings/src/client/onboarding.tsx')

  await t.test('a quality number appears only when it was measured', () => {
    // This assertion used to read "no number anywhere", which was true while
    // nothing had been measured and became false the moment something was. The
    // property that survives is narrower and more useful: every figure on the
    // screen must come from a real run, and the screen must still say nothing
    // was measured when that is the case.
    assert.match(COMPONENTS, /Not measured on this machine/)
    assert.match(COMPONENTS, /OCR_MEASURED/)
    // No figure is typed into the component. Every one is read from the
    // generated module, so a number cannot outlive the run that produced it.
    assert.doesNotMatch(COMPONENTS, /\d+(\.\d+)?\s*%\s*accuracy/i)
    assert.doesNotMatch(COMPONENTS, /\bCER\s+0\.\d/)
  })

  await t.test('the benchmark is judged against thresholds it did not choose', () => {
    // A threshold picked after seeing a result is a description of the result,
    // not a threshold. These live in the qualification module and predate the
    // run, and the report records where they came from.
    const measured = JSON.parse(read('docs/ocr-benchmark.json'))
    assert.equal(measured.measured, true)
    assert.match(read('packages/watch/technology/src/ocr-qualification.ts'), /DEFAULT_THRESHOLDS/)
    assert.match(String(measured.thresholdsSetBefore), /ocr-qualification\.ts/)
    assert.equal(measured.thresholds.maxCer, 0.05)
    assert.equal(measured.thresholds.minWordAccuracy, 0.95)
  })

  await t.test('an unqualified workload is reported, not averaged away', () => {
    // One overall number would let a workload the engine cannot do at all hide
    // behind the ones it can. Both outcomes have to be present, or the corpus
    // is too easy to be evidence of anything.
    const measured = JSON.parse(read('docs/ocr-benchmark.json'))
    const workloads = Object.values(measured.byWorkload)
    assert.ok(workloads.length >= 3, 'the results were collapsed into a single number')
    assert.ok(
      workloads.some(workload => workload.passesThresholds === false),
      'every workload passed, which means nothing hard was measured',
    )
    assert.ok(workloads.some(workload => workload.passesThresholds === true))
  })

  await t.test('the engines section names how a check would be run', () => {
    assert.match(COMPONENTS, /How it would be checked/)
  })

  await t.test('memory does not claim encryption it does not have', () => {
    assert.match(COMPONENTS, /Not encrypted/)
    assert.doesNotMatch(COMPONENTS, /Encrypted at rest<|>Encrypted</)
  })

  await t.test('no settings chip can be green', () => {
    // Green belongs to a VERIFIED verdict. Nothing on a settings page is a
    // verdict, and the exclusion is at the type level rather than by habit.
    assert.match(COMPONENTS, /export type ChipTone = Exclude<BrandTone, 'success'>/)
  })

  await t.test('the surfaces use semantic tones, never raw colour', () => {
    assert.doesNotMatch(COMPONENTS, /#[0-9A-Fa-f]{6}/)
    assert.doesNotMatch(ONBOARDING, /#[0-9A-Fa-f]{6}/)
    assert.match(COMPONENTS, /tokenFor\(/)
  })

  await t.test('verification states that completion is not proof', () => {
    assert.match(COMPONENTS, /Agent completed ≠ Verified/)
  })
})

test('the first run does not require DeepSeek', async t => {
  const ONBOARDING = read('packages/watch/client-settings/src/client/onboarding.tsx')
  const READINESS = read('packages/watch/client-settings/src/client/readiness.tsx')

  await t.test('the Watch step is registered ahead of the DeepSeek one', () => {
    // Upstream registers `deepseek-official` at order 0.
    const order = /id: 'watch-welcome', order: (-?\d+)/.exec(SETTINGS)?.[1]
    assert.ok(order !== undefined, 'the Watch onboarding step is not registered')
    assert.ok(Number(order) < 0, 'the Watch step would not come first')
  })

  await t.test('upstream’s onboarding step is not removed', () => {
    // DeepSeek stays a good provider choice. What changed is that it is no
    // longer the price of entry.
    assert.doesNotMatch(BUNDLE, /deepseek-official/)
  })

  await t.test('there is a way into the workspace without configuring anything', () => {
    assert.match(ONBOARDING, />Continue</)
    assert.match(ONBOARDING, /complete\?\.\(\)/)
  })

  await t.test('the notice is a modal, and DSH’s own', () => {
    // `settings.onboarding` is not a modal seat. It renders in the sidebar's
    // foot area at 256px, and the content is expected to wrap itself the way
    // upstream's WelcomeNotice does. Rendering into it raw spilled 2400px out
    // of a clipped column and destroyed the sidebar.
    assert.match(ONBOARDING, /from '@deepseek-ai\/dsh-client-ui-primitives'/)
    assert.match(ONBOARDING, /<Modal open/)
    // And not a hand-rolled one, which would duplicate the dimming, the focus
    // handling and the inert root that already exist.
    assert.doesNotMatch(ONBOARDING, /position: 'fixed'/)
  })

  await t.test('the readiness list is not in the onboarding seat', () => {
    // It belongs in Diagnostics, which has the settings panel's width. Twelve
    // rows with descriptions do not fit a first-run notice at any styling.
    assert.doesNotMatch(ONBOARDING, /READINESS\.map/)
    assert.match(READINESS, /export function ReadinessList/)
    const components = read('packages/watch/client-settings/src/client/components.tsx')
    assert.match(components, /<ReadinessList/)
  })

  await t.test('the notice and the list cannot disagree', () => {
    // The count on the notice is derived from the table Diagnostics renders,
    // rather than written out a second time.
    assert.match(ONBOARDING, /READINESS\.filter\(item => item\.tone === 'active'\)/)
    assert.match(ONBOARDING, /READINESS\.length/)
  })

  await t.test('readiness is truthful, not a column of ticks', () => {
    // Four capabilities are genuinely local and working; the rest are not
    // configured or not tested, and say which.
    const statuses = [...READINESS.matchAll(/status: '([^']+)'/g)].map(m => m[1])
    assert.ok(statuses.length >= 12, 'the readiness list is too short to be the product')
    assert.ok(statuses.includes('Not configured'))
    assert.ok(statuses.includes('Not tested'))
    assert.ok(
      statuses.filter(status => status === 'Ready' || status === 'Local').length < statuses.length,
      'every capability claims to be ready, which cannot be true here',
    )
  })

  await t.test('a provider key is not media consent, and the screen says so', () => {
    // The sentence is wrapped in the source, so whitespace is normalised
    // before matching rather than the assertion being loosened.
    const flat = ONBOARDING.replace(/\s+/g, ' ')
    assert.match(flat, /does not permit uploading frames/)
  })

  await t.test('the agent model is one role among nine', () => {
    assert.match(ONBOARDING, /one role among nine/)
  })
})

test('the orca is the product mark', async t => {
  const MARK = read('packages/watch/brand/src/mark.ts')
  const ASSETS = 'packages/watch/brand/assets'

  await t.test('the master is present and unmodified', () => {
    // The supplied artwork is the brand source of truth. It is stored as it
    // arrived, and every other asset is derived from it — not redrawn beside it.
    const master = readFileSync(join(ROOT, ASSETS, 'watch-orca-master.png'))
    assert.equal(master.slice(1, 4).toString(), 'PNG')
    assert.equal(master.readUInt32BE(16), 1254)
    assert.equal(master.readUInt32BE(20), 1254)
  })

  await t.test('every derived size exists and is square', () => {
    for (const size of [512, 256, 128, 64, 48, 32, 16]) {
      const png = readFileSync(join(ROOT, ASSETS, `watch-orca-${String(size)}.png`))
      assert.equal(png.readUInt32BE(16), size, `${String(size)}px is not ${String(size)} wide`)
      assert.equal(png.readUInt32BE(20), size, `${String(size)}px is not square`)
      // Colour type 6 is RGBA. The master has no alpha channel — what looks
      // like transparency in it is a painted chequerboard — so a derived asset
      // without an alpha channel would carry that grey chequer onto every
      // surface it appears on.
      assert.equal(png[25], 6, `${String(size)}px has no alpha channel`)
    }
  })

  await t.test('the derived assets are actually transparent at the corners', () => {
    // The recovery finds the background by reachability from the border, so a
    // fully opaque corner would mean the flood fill never ran.
    const { decodePng } = requireDecoder()
    for (const size of [256, 64]) {
      const { px, ch } = decodePng(join(ROOT, ASSETS, `watch-orca-${String(size)}.png`))
      assert.equal(ch, 4)
      assert.equal(px[3], 0, `${String(size)}px corner is not transparent`)
    }
  })

  await t.test('the inlined mark is generated, not hand-written', () => {
    assert.match(MARK, /Generated by `scripts\/brand-assets\.mjs`/)
    assert.match(MARK, /export const WATCH_MARK_PNG = 'data:image\/png;base64,/)
    // The master's own blue, measured from the artwork rather than chosen.
    assert.match(MARK, /export const MASTER_BLUE = '#[0-9a-f]{6}'/)
  })

  await t.test('the mark is used for the tab icon too', () => {
    // One asset, not a second drawing: a favicon that diverges from the product
    // mark is how a brand ends up with two slightly different logos.
    assert.match(BRAND_CLIENT, /const FAVICON = WATCH_MARK_PNG/)
    assert.match(BRAND_CLIENT, /'type', 'image\/png'/)
  })

  await t.test('the mark never stretches and never upscales', () => {
    // `objectFit: contain` on a square box, and the source is 64px so a 44px
    // render still has detail to spare.
    assert.match(BRAND_CLIENT, /objectFit: 'contain'/)
    assert.doesNotMatch(BRAND_CLIENT, /width: '100%'[^}]*height: '100%'/)
  })

  await t.test('the mark is decorative where the name is already beside it', () => {
    // The sidebar sets mark and name in adjacent slots. Announcing "Watch
    // Workspace" twice is worse than announcing it once.
    assert.match(BRAND_CLIENT, /decorative \? '' : PRODUCT_NAME/)
    assert.match(BRAND_CLIENT, /WatchSidebarMark[\s\S]{0,240}decorative/)
  })

  await t.test('the desktop window takes its icon from the same master', () => {
    assert.match(DESKTOP, /watch-orca\.ico/)
    assert.match(DESKTOP, /icon: WINDOW_ICON/)
    const manifest = JSON.parse(read('apps/desktop/package.json'))
    assert.match(manifest.build.win.icon, /watch-orca\.ico$/)
  })

  await t.test('no DeepSeek mark is used as the Watch product logo', () => {
    // `FishLogo` and `BrandWordmark` are upstream's own marks, and they stay
    // upstream's. Watch attributes the foundation in words, not by wearing it.
    for (const source of [BRAND_CLIENT, read('packages/watch/client-settings/src/client/components.tsx')]) {
      assert.doesNotMatch(source, /FishLogo|BrandWordmark/)
    }
  })
})

/** Load the PNG decoder the asset generator exports, without a second copy. */
function requireDecoder() {
  return decoderModule
}

test('the provider catalogue is not narrowed', async t => {
  const PROVIDERS = JSON.parse(read('inventory/dsh-providers.json'))
  const SUMMARY = read('packages/watch/client-settings/src/providers.ts')

  await t.test('the whole pinned catalogue is inventoried', () => {
    // Watch is a layer. A layer that quietly reduced the provider choice to
    // whichever one its author used would be a regression nothing else notices.
    assert.ok(PROVIDERS.total >= 30, `only ${String(PROVIDERS.total)} routes found`)
    const ids = PROVIDERS.providers.map(provider => provider.id)
    for (const expected of ['openai', 'anthropic', 'google', 'deepseek', 'amazon-bedrock', 'mistral']) {
      assert.ok(ids.includes(expected), `${expected} is missing from the inventory`)
    }
  })

  await t.test('DeepSeek is one route among many', () => {
    assert.equal(PROVIDERS.deepseekIsOptional, true)
    assert.match(SUMMARY, /export const DEEPSEEK_IS_OPTIONAL = true/)
  })

  await t.test('a self-hosted or custom endpoint is reachable', () => {
    // This is the same mechanism a local model uses: an OpenAI-compatible
    // server you run is a base URL you supply, not a separate feature.
    const selfHosted = PROVIDERS.providers.filter(p => p.classification === 'self_hosted')
    assert.ok(selfHosted.length > 0, 'no route accepts a user-supplied endpoint')
  })

  await t.test('no provider claims to work', () => {
    // A descriptor existing means the route is shipped, not that anyone has a
    // credential for it or that it has ever answered.
    for (const provider of PROVIDERS.providers) {
      assert.equal(provider.checked, 'never', `${provider.id} claims a check`)
    }
  })

  await t.test('the inventory records variable names, never values', () => {
    // A leaked key in a committed inventory would be the worst possible bug in
    // a file whose whole purpose is to be read.
    const text = read('inventory/dsh-providers.json')
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{16,}/)
    assert.doesNotMatch(text, /"apiKey"\s*:\s*"[^"]{8,}"/)
    for (const provider of PROVIDERS.providers) {
      for (const name of provider.credentialEnv) {
        assert.match(name, /^[A-Z0-9_]+$/, `${name} does not look like a variable name`)
      }
    }
  })

  await t.test('the count on screen is generated, not typed', () => {
    // Hardcoding "37 providers" in a component is how a UI ends up confidently
    // stating last quarter's catalogue.
    assert.match(SUMMARY, /Generated by `scripts\/gen-provider-inventory\.mjs`/)
    const components = read('packages/watch/client-settings/src/client/components.tsx')
    assert.match(components, /PROVIDER_COUNT/)
    assert.doesNotMatch(components, /\b3[0-9] (?:routes|providers)\b/)
  })
})
