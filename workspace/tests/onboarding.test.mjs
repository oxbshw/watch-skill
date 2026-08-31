/**
 * One first-run surface, not two.
 *
 * A person who installed DeepWatch opened it and was shown an "Internal
 * Testing Notice" about DeepSeek Harness 0.1 and the DSH plugin ecosystem —
 * upstream's notice, about upstream's product, correct in its own context and
 * not what they had installed. They pressed Continue and immediately met a
 * second modal, DeepWatch's own. Two dialogs before the product, and the first
 * one was about something else.
 *
 * The fix is not to disable upstream's notice. It is to *answer* it, in the
 * managed profile's own Harness home, using the same durable field the
 * Continue button writes — so DeepWatch's onboarding is the one a DeepWatch
 * user sees, and a stock DSH profile elsewhere on the machine still shows the
 * notice that belongs to it.
 *
 * The load-bearing test here is the freshness one. The acknowledgement is
 * compared for exact equality against a version string upstream owns, so a
 * baseline bump that changes the notice would silently bring the modal back on
 * every new profile. Reading the pinned Harness source and comparing turns
 * that into a failing gate.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const CLI = join(ROOT, 'packages', 'watch', 'cli')
const UPSTREAM = join(ROOT, 'upstream', 'deepseek-harness')

const { acknowledgeUpstreamNotice } = await import(
  pathToFileURL(join(CLI, 'lib', 'lib', 'compose.js')).href)
const version = await import(pathToFileURL(join(CLI, 'lib', 'version.js')).href)

const rooms = []
test.after(() => {
  for (const dir of rooms) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

function room(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  rooms.push(dir)
  return dir
}

describe('the upstream notice is answered, not disabled', () => {
  test('a fresh managed home is marked handled', () => {
    const home = room('deepwatch-notice-')
    const result = acknowledgeUpstreamNotice(home)

    assert.equal(result, 'marked-handled')
    const settings = readFileSync(join(home, 'settings.yaml'), 'utf8')
    assert.match(settings, /^ui-onboarding:$/m)
    assert.ok(settings.includes(version.UPSTREAM_NOTICE_VERSION))
  })

  test('it is the field upstream compares, spelled the way upstream spells it', () => {
    const home = room('deepwatch-notice-field-')
    acknowledgeUpstreamNotice(home)
    const settings = readFileSync(join(home, 'settings.yaml'), 'utf8')
    assert.match(settings, new RegExp(`${version.UPSTREAM_NOTICE_FIELD}:`))
  })

  test('running setup twice does not write it twice', () => {
    const home = room('deepwatch-notice-twice-')
    acknowledgeUpstreamNotice(home)
    const once = readFileSync(join(home, 'settings.yaml'), 'utf8')

    const second = acknowledgeUpstreamNotice(home)

    assert.equal(second, 'already-answered')
    assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), once)
    assert.equal(once.match(/^ui-onboarding:$/gm).length, 1)
  })

  test('an answer a person already gave is never overwritten', () => {
    // Somebody who pressed Continue, or edited the file, owns that value.
    const home = room('deepwatch-notice-owned-')
    mkdirSync(home, { recursive: true })
    const mine = "ui-onboarding:\n  welcomeNoticeVersion: 'something-i-chose'\n"
    writeFileSync(join(home, 'settings.yaml'), mine)

    assert.equal(acknowledgeUpstreamNotice(home), 'already-answered')
    assert.equal(readFileSync(join(home, 'settings.yaml'), 'utf8'), mine)
  })

  test('other sections of the settings document survive byte for byte', () => {
    // The file is the Harness's and carries its own configuration. A setup
    // step is not entitled to reformat it.
    const home = room('deepwatch-notice-merge-')
    mkdirSync(home, { recursive: true })
    const existing = 'llm-pi-ai:\n  someKey: someValue\n'
    writeFileSync(join(home, 'settings.yaml'), existing)

    acknowledgeUpstreamNotice(home)

    const after = readFileSync(join(home, 'settings.yaml'), 'utf8')
    assert.ok(after.startsWith(existing), 'the existing document was rewritten')
    assert.match(after, /^ui-onboarding:$/m)
  })

  test('nothing upstream is disabled to achieve it', () => {
    // Disabling `ui-settings-models` would take the Models page with it, and
    // suppressing the notice for every profile on the machine is not this
    // product's decision to make.
    const patch = readFileSync(
      join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml'), 'utf8')
    const disabled = [...patch.matchAll(/^- id: (\S+)\n\s+disabled: true/gm)].map(m => m[1])
    assert.deepEqual(disabled, ['ui-brand-official'],
      'the only upstream row DeepWatch disables is the duplicate brand mark')
  })
})

/**
 * The DeepWatch modal is checked as source rather than as rendered markup.
 *
 * It imports `Modal` and `Button` from `@deepseek-ai/dsh-client-ui-primitives`,
 * which is a peer this workspace does not install — the packed profile
 * provides it — so `renderToStaticMarkup` cannot reach it here the way it
 * reaches the Workspace surfaces. What is asserted below is therefore
 * structural: the copy a person reads, the actions offered, the accessible
 * names, and the layout constraints that stop the card being a 420-pixel
 * column again. The rendered result is covered by the browser pass.
 */
const ONBOARDING = readFileSync(
  join(ROOT, 'packages', 'watch', 'client-settings', 'src', 'client', 'onboarding.tsx'), 'utf8')

describe('one DeepWatch onboarding, and it says what to do next', () => {
  test('it is titled as a welcome, not as a bare product name', () => {
    assert.match(ONBOARDING, /Welcome to \$\{PRODUCT_NAME\}/)
  })

  test('it explains the product in one sentence', () => {
    assert.match(ONBOARDING, /watches what happens on your machine/)
  })

  test('it offers the three actions, and exactly one is primary', () => {
    // Two ghost links reading "Set up capabilities" and "Continue" gave a
    // person no way to tell which was the way forward.
    assert.match(ONBOARDING, /Finish setup/)
    assert.match(ONBOARDING, /Explore offline/)
    assert.match(ONBOARDING, /View diagnostics/)

    const ghosts = [...ONBOARDING.matchAll(/variant="ghost"/g)].length
    const buttons = [...ONBOARDING.matchAll(/<Button\b/g)].length
    assert.equal(buttons, 3)
    assert.equal(ghosts, 2, 'exactly one action carries the primary styling')
  })

  test('readiness is two facts, not one fraction', () => {
    // "4 of 12 capabilities are ready" read as a warning about a broken
    // install rather than a description of a local-first product nobody had
    // pointed at a model yet.
    assert.match(ONBOARDING, /Ready now/)
    assert.match(ONBOARDING, /Needs setup/)
    assert.doesNotMatch(ONBOARDING, /of \$\{String\(READINESS\.length\)\} capabilities are ready/)
  })

  test('it distinguishes local readiness from model configuration', () => {
    assert.match(ONBOARDING, /need no provider and no network/)
    assert.match(ONBOARDING, /No provider is\s*\n?\s*configured yet/)
  })

  test('it still says a provider is not a media consent', () => {
    assert.match(ONBOARDING, /separate consent/)
  })

  test('the mark is large enough to be an identity', () => {
    // 40px beside a 17px heading was a thumbnail.
    const size = /width=\{(\d+)\} height=\{\1\}/.exec(ONBOARDING)?.[1]
    assert.ok(Number(size) >= 56, `the orca renders at ${String(size)}px`)
  })

  test('the card is readable and does not overflow a narrow window', () => {
    assert.match(ONBOARDING, /min\(560px, calc\(100vw - 48px\)\)/)
    assert.match(ONBOARDING, /maxWidth: '65ch'/)
  })

  test('the heading is the accessible name of the section', () => {
    assert.match(ONBOARDING, /aria-labelledby="watch-welcome-title"/)
    assert.match(ONBOARDING, /id="watch-welcome-title"/)
  })

  test('the decorative mark is hidden from a screen reader', () => {
    assert.match(ONBOARDING, /alt="" aria-hidden="true"/)
  })

  test('it wraps in DSH\'s own Modal rather than a hand-rolled overlay', () => {
    // A private overlay would duplicate the dimming, the focus trap and the
    // inert root that already exist, and would drift from them.
    assert.match(ONBOARDING, /<Modal open title=/)
    assert.doesNotMatch(ONBOARDING, /position: 'fixed'/)
  })
})

describe('attribution is kept, and stops being furniture', () => {
  const BRAND = readFileSync(
    join(ROOT, 'packages', 'watch', 'brand', 'src', 'client', 'index.tsx'), 'utf8')
  const ABOUT = readFileSync(
    join(ROOT, 'packages', 'watch', 'client-settings', 'src', 'client', 'components.tsx'), 'utf8')

  test('the sidebar footer renders one line', () => {
    // A sentence of legal prose resident in a 256-pixel rail on every screen
    // is read once and then becomes furniture.
    const wide = BRAND.slice(BRAND.indexOf('function WatchAttribution'))
    const body = wide.slice(0, wide.indexOf('\n}\n'))
    assert.match(body, /\{ATTRIBUTION\}/)
    assert.ok(!/\{INDEPENDENCE\}/.test(body.slice(body.indexOf('overflowWrap'))),
      'the independence paragraph must not be resident in the sidebar')
  })

  test('the full statement is still one hover and one click away', () => {
    const wide = BRAND.slice(BRAND.indexOf('function WatchAttribution'))
    assert.match(wide, /const full = `\$\{ATTRIBUTION\}\. \$\{INDEPENDENCE\}`/)
    assert.equal([...wide.matchAll(/aria-label=\{full\}/g)].length, 2,
      'both the collapsed rail and the expanded footer carry the full text')
  })

  test('About carries the independence disclosure in full', () => {
    assert.match(ABOUT, /\{INDEPENDENCE\}/)
    assert.match(ABOUT, /\{ATTRIBUTION\}/)
  })
})

describe('the acknowledgement stays in step with the pinned baseline', () => {
  test('the version, namespace and field match the Harness source', () => {
    // The gate. Upstream compares for exact equality, so a baseline bump that
    // changes any of these brings the modal back on every new profile — and
    // this is what makes that a build failure rather than a surprise.
    const source = join(
      UPSTREAM, 'packages', 'client', 'ui-settings-models', 'src', 'onboarding-copy.ts')
    if (!existsSync(source)) {
      assert.fail(`the pinned Harness source moved; this gate cannot see ${source}`)
    }
    const text = readFileSync(source, 'utf8')

    const pinned = /WELCOME_NOTICE_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1]
    const namespace = /WELCOME_NOTICE_SETTINGS_NAMESPACE\s*=\s*'([^']+)'/.exec(text)?.[1]
    const field = /WELCOME_NOTICE_ACK_FIELD\s*=\s*'([^']+)'/.exec(text)?.[1]

    assert.equal(pinned, version.UPSTREAM_NOTICE_VERSION,
      'the pinned Harness changed its notice version; update UPSTREAM_NOTICE_VERSION')
    assert.equal(namespace, version.UPSTREAM_NOTICE_NAMESPACE)
    assert.equal(field, version.UPSTREAM_NOTICE_FIELD)
  })

  test('the notice this suppresses is the one that was seen', () => {
    // Named so a reader of this file knows exactly which modal is meant.
    const source = readFileSync(join(
      UPSTREAM, 'packages', 'client', 'ui-settings-models', 'src', 'onboarding-copy.ts'), 'utf8')
    assert.match(source, /Internal Testing Notice/)
  })
})
