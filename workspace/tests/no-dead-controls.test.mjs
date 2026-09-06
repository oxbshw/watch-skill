/**
 * A control that is drawn is a control that does something.
 *
 * The third option a surface has is the one that keeps this honest: a
 * capability that is not available may be drawn *disabled, with its reason*, or
 * left out — but it may not be drawn as though pressing it would work. That
 * distinction is the whole product. An evidence tool whose buttons are live and
 * inert is worse than one that says the engine is missing, because the first
 * teaches a person to distrust every other control on the screen.
 *
 * `mode-bodies-render.test.mjs` proves each surface draws something.
 * `accessibility.test.mjs` proves an unavailable tab carries its reason. This
 * is the third leg: nothing on any surface is wired to a handler that does
 * nothing, and nothing is disabled without saying why.
 *
 * It reads source rather than rendering, because an empty arrow function is
 * indistinguishable from a working one at runtime — it is exactly the thing
 * that renders fine and does nothing.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages', 'watch')

/** Every browser-half source file this product ships. */
function clientSources() {
  const found = []
  const walk = (at) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name)
      if (statSync(path).isDirectory()) { walk(path); continue }
      if (/\.tsx$/.test(name)) found.push(path)
    }
  }
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, 'src')
    try { if (statSync(src).isDirectory()) walk(src) } catch { /* no browser half */ }
  }
  return found
}

const SOURCES = clientSources().map(path => ({
  file: relative(ROOT, path).split('\\').join('/'),
  text: readFileSync(path, 'utf8'),
}))

/**
 * Handlers that accept the event and do nothing with it.
 *
 * `() => {}` and `() => { }` and `async () => {}`, plus a bare `noop`. Not a
 * handler whose body is a comment explaining a deliberate swallow — there are
 * none of those today, and one would have to be argued for in review rather
 * than slipped past a regex.
 */
const DEAD_HANDLER =
  /\b(?:onClick|onChange|onSubmit|onInput|onKeyDown|onSelect|onBlur|onFocus)=\{\s*(?:async\s*)?\(\s*[^)]*\)\s*=>\s*\{\s*\}\s*\}/

const NOOP_REFERENCE = /\b(?:onClick|onChange|onSubmit)=\{\s*noop\s*\}/

describe('nothing on a surface is drawn live and inert', () => {
  test('the sweep actually reads the browser halves', () => {
    // A walk that found nothing would pass every assertion below.
    assert.ok(SOURCES.length >= 20,
      `only ${String(SOURCES.length)} client sources found; the walk is wrong`)
    assert.ok(SOURCES.some(source => source.file.includes('client-settings')))
    assert.ok(SOURCES.some(source => source.file.includes('workspace/src/client')))
  })

  test('no handler is an empty function', () => {
    const dead = SOURCES
      .filter(source => DEAD_HANDLER.test(source.text) || NOOP_REFERENCE.test(source.text))
      .map(source => source.file)
    assert.deepEqual(dead, [],
      'these draw a control that does nothing when pressed:\n  ' + dead.join('\n  '))
  })

  test('the positive control: an empty handler is caught', () => {
    assert.ok(DEAD_HANDLER.test('<Button onClick={() => {}}>Verify</Button>'))
    assert.ok(DEAD_HANDLER.test('<Button onClick={() => { }}>Verify</Button>'))
    assert.ok(DEAD_HANDLER.test('<input onChange={async (event) => {}} />'))
    assert.ok(NOOP_REFERENCE.test('<Button onClick={noop}>Verify</Button>'))
    // And a real handler is not.
    assert.equal(DEAD_HANDLER.test('<Button onClick={() => { run() }}>Verify</Button>'), false)
    assert.equal(DEAD_HANDLER.test('<Button onClick={finish}>Explore offline</Button>'), false)
  })
})

describe('a control disabled by a missing capability says so', () => {
  /**
   * Only capability-driven disables, and deliberately not the others.
   *
   * A button greyed out because a save is in flight, or because the form has
   * no model chosen yet, explains itself: the reader just did the thing that
   * caused it, and the state clears in a second. Demanding a sentence for
   * those would put noise on every surface and teach the next person to add
   * the exemption rather than the reason.
   *
   * What must be explained is the other kind: disabled because *this
   * installation cannot do it*. That reader did nothing, sees nothing change,
   * and has no way to find out why — which is how three greyed-out buttons on
   * Role Bindings sat behind `snapshot.writable` with no sentence anywhere on
   * the surface saying the profile was read-only.
   */
  const CAPABILITY = /writable|available|unavailable|capable|usable|blocked|missing|health|executable|installed|supported/i

  test('every one of them carries a reason a reader can reach', () => {
    const problems = []
    for (const { file, text } of SOURCES) {
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]
        if (!/\bdisabled=\{/.test(line)) continue
        if (!CAPABILITY.test(line)) continue
        // The element and its surroundings: a reason may be an attribute on
        // the control or a banner the control points at.
        const window = lines.slice(Math.max(0, i - 8), i + 9).join('\n')
        if (!/aria-describedby|aria-label|title=|blockerMessage|reason/i.test(window)) {
          problems.push(`${file}:${String(i + 1)} ${line.trim().slice(0, 90)}`)
        }
      }
    }
    assert.deepEqual(problems, [],
      'disabled because this installation cannot do it, with no reason given:\n  '
      + problems.join('\n  '))
  })

  test('the read-only banner exists and the controls point at it', () => {
    // The regression this found, pinned: the reason has to be on the screen,
    // not only in the condition.
    const bindings = SOURCES.find(
      source => source.file.endsWith('client-settings/src/client/role-bindings.tsx'))
    assert.ok(bindings !== undefined)
    assert.match(bindings.text, /id="watch-bindings-readonly"/)
    assert.match(bindings.text, /Settings are read-only/)
    const pointers = [...bindings.text.matchAll(/'watch-bindings-readonly'/g)]
    assert.ok(pointers.length >= 3,
      `only ${String(pointers.length)} controls name the banner that explains them`)
  })

  test('the positive control: a capability disable with no reason is caught', () => {
    const sample = '<button disabled={!snapshot.writable} onClick={go}>Edit</button>'
    assert.ok(/\bdisabled=\{/.test(sample) && CAPABILITY.test(sample))
    assert.equal(/aria-describedby|aria-label|title=|blockerMessage|reason/i.test(sample), false)
  })

  test('and a transient disable is deliberately not caught', () => {
    const sample = '<button disabled={saving} onClick={go}>Save</button>'
    assert.equal(CAPABILITY.test(sample), false)
  })
})
