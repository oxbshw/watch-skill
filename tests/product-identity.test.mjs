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
  await t.test('the inventory carries a kind for every slot', () => {
    for (const [name, entry] of Object.entries(SLOTS.slots)) {
      assert.ok(
        ['single', 'list', 'keyed'].includes(entry.kind),
        `${name} has no usable kind (${entry.kind})`,
      )
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
    assert.equal(SLOTS.slots['conversation.composer.bar'].kind, 'single')
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
    ['watch-engines', 'Perception Engines'],
    ['watch-sources', 'Sources & Devices'],
    ['watch-memory', 'Memory & Retrieval'],
    ['watch-verification', 'Verification'],
    ['watch-diagnostics', 'Diagnostics'],
    ['watch-about', 'About'],
  ]

  for (const [id, label] of SECTIONS) {
    await t.test(`${label} is registered`, () => {
      assert.match(SETTINGS, new RegExp(`section\\('${id}', '${label.replace('&', '&')}'`))
    })
  }

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

  await t.test('no engine is shown with a quality or speed number', () => {
    // Nothing has been measured on this machine, so any figure would be
    // invented. The row says so, and names the check that would produce one.
    assert.match(COMPONENTS, /Not measured on this machine/)
    assert.doesNotMatch(COMPONENTS, /\d+(\.\d+)?\s*%\s*accuracy/i)
    assert.doesNotMatch(COMPONENTS, /\bWER\b|\bCER\b/)
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
