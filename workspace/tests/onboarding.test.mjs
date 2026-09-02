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

  test('the notice itself is answered, and nothing is disabled to answer it', () => {
    // Disabling `ui-settings-models` would take the Models page with it, and
    // suppressing the notice for every profile on the machine is not this
    // product's decision to make. Two rows are switched off, and neither is
    // how the notice is handled -- it is answered in the profile's own
    // Harness home, through the field upstream's own Continue button writes.
    const patch = readFileSync(
      join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml'), 'utf8')
    const disabled = [...patch.matchAll(/^- id: (\S+)\n\s+disabled: true/gm)].map(m => m[1])
    assert.deepEqual(disabled.sort(), ['llm-deepseek', 'ui-brand-official'])
    assert.equal(disabled.includes('ui-settings-models'), false,
      'the Models page was switched off, taking provider configuration with it')
  })

  test('each disabled row is one this distribution can account for', () => {
    // `ui-brand-official` draws a second brand mark beside DeepWatch's own.
    // `llm-deepseek` registered a route at load with no credential, which
    // made DeepSeek the one provider that configured itself -- and produced
    // the second first-run modal asking for a key nobody had chosen to give.
    const patch = readFileSync(
      join(ROOT, 'packages', 'watch', 'bundle', 'cordis.patch.yml'), 'utf8')
    for (const [row, why] of [
      ['ui-brand-official', /both marks would be drawn/],
      ['llm-deepseek', /did not have to be chosen/],
    ]) {
      // The comment block immediately above the row, rather than a fixed
      // window: the reasons differ in length, and a character count would make
      // this test about formatting instead of about whether a reason is there.
      const before = patch.slice(0, patch.indexOf(`- id: ${row}`))
      const block = before.split(/\n\s*\n/).pop() ?? ''
      // Comment markers stripped and whitespace collapsed, so a reason that
      // rewraps across lines still reads as the sentence it is.
      const reason = block.replace(/^#/gm, '').replace(/\s+/g, ' ').trim()
      assert.match(reason, why, `${row} is disabled with no reason beside it`)
    }
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
const ONBOARDING_CSS = readFileSync(
  join(ROOT, 'packages', 'watch', 'client-settings', 'src', 'client', 'onboarding.module.css'),
  'utf8')

describe('one DeepWatch onboarding, and it says what to do next', () => {
  test('it is titled as a welcome, not as a bare product name', () => {
    assert.match(ONBOARDING, /title=\{'Welcome to ' \+ PRODUCT_NAME\}/)
  })

  test('it explains the product in one sentence', () => {
    assert.match(ONBOARDING, /local evidence workspace is ready to begin/)
  })

  test('it offers the three actions, and exactly one is primary', () => {
    // Two ghost links reading "Set up capabilities" and "Continue" gave a
    // person no way to tell which was the way forward.
    assert.match(ONBOARDING, /Finish setup/)
    assert.match(ONBOARDING, /Explore offline/)
    assert.match(ONBOARDING, /View diagnostics/)

    const buttons = [...ONBOARDING.matchAll(/<Button\b/g)].length
    assert.equal(buttons, 3)
    assert.equal([...ONBOARDING.matchAll(/variant="primary"/g)].length, 1)
    assert.equal([...ONBOARDING.matchAll(/variant="outline"/g)].length, 1)
    assert.equal([...ONBOARDING.matchAll(/variant="ghost"/g)].length, 1)
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
    assert.match(ONBOARDING, /need no provider\s+and no network/)
    assert.match(ONBOARDING, /Saved is\s*\n?\s*never presented as tested/)
  })

  test('it still says a provider is not a media consent', () => {
    assert.match(ONBOARDING, /Media access is separate and stays off/)
  })

  test('the mark is large enough to be an identity', () => {
    // 40px beside a 17px heading was a thumbnail.
    const size = /width=\{(\d+)\} height=\{\1\}/.exec(ONBOARDING)?.[1]
    assert.ok(Number(size) >= 56, `the orca renders at ${String(size)}px`)
  })

  test('the card is readable and does not overflow a narrow window', () => {
    assert.match(ONBOARDING_CSS, /min\(720px, calc\(100vw - 40px\)\)/)
    assert.match(ONBOARDING_CSS, /@media \(max-width: 620px\)/)
    assert.match(ONBOARDING_CSS, /grid-template-columns: 1fr;/)
  })

  test('the heading is the accessible name of the section', () => {
    assert.match(ONBOARDING, /aria-labelledby="watch-welcome-title"/)
    assert.match(ONBOARDING, /id="watch-welcome-title"/)
  })

  test('the decorative mark is hidden from a screen reader', () => {
    assert.match(ONBOARDING, /className=\{css\.markFrame\} aria-hidden="true"/)
    assert.match(ONBOARDING, /alt="" className=\{css\.mark\}/)
  })

  test('it wraps in DSH\'s own Modal rather than a hand-rolled overlay', () => {
    // A private overlay would duplicate the dimming, the focus trap and the
    // inert root that already exist, and would drift from them.
    assert.match(ONBOARDING, /<Modal\s+[\s\S]*?\bopen\b[\s\S]*?\btitle=/)
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
  // The lock is the tracked statement of what this distribution is built
  // against; the source checkout under `upstream/deepseek-harness/` is
  // gitignored and exists only on a machine that has run the bootstrap. So the
  // always-on comparison is against the lock, exactly as `tests/cli.test.mjs`
  // pins the Harness version, and the checkout is used as a second opinion
  // wherever it happens to be present.
  const LOCK = readFileSync(join(ROOT, 'upstream', 'deepseek-harness.lock'), 'utf8')
  // Doubled escapes: this is a template literal, so `\s` in the source would
  // reach RegExp as a bare `s` and match the wrong thing quietly.
  const locked = field => new RegExp(
    `^[ \\t]+${field}:[ \\t]*"?([^"\\r\\n]+?)"?[ \\t]*$`, 'm').exec(LOCK)?.[1]?.trim()

  test('the CLI answers the notice the lock describes', () => {
    // Compared for exact equality by upstream, so a drift here is a modal
    // returning on every new profile rather than a cosmetic mismatch.
    assert.equal(version.UPSTREAM_NOTICE_VERSION, locked('version'))
    assert.equal(version.UPSTREAM_NOTICE_NAMESPACE, locked('settings_namespace'))
    assert.equal(version.UPSTREAM_NOTICE_FIELD, locked('ack_field'))
  })

  test('the lock records what the pinned source actually says', () => {
    // Only where the audit checkout is present. Skipping it on a machine
    // without the checkout is not a weakened gate: the assertion above runs
    // everywhere, and this one is what catches a baseline bump at the moment
    // somebody syncs it.
    const source = join(
      UPSTREAM, 'packages', 'client', 'ui-settings-models', 'src', 'onboarding-copy.ts')
    if (!existsSync(source)) return

    const text = readFileSync(source, 'utf8')
    assert.equal(/WELCOME_NOTICE_VERSION\s*=\s*'([^']+)'/.exec(text)?.[1], locked('version'),
      'the pinned Harness changed its notice version; update the lock and the CLI')
    assert.equal(
      /WELCOME_NOTICE_SETTINGS_NAMESPACE\s*=\s*'([^']+)'/.exec(text)?.[1],
      locked('settings_namespace'))
    assert.equal(/WELCOME_NOTICE_ACK_FIELD\s*=\s*'([^']+)'/.exec(text)?.[1], locked('ack_field'))
    // Named so a reader knows exactly which modal is meant.
    assert.match(text, /Internal Testing Notice/)
  })
})
