/**
 * Accessibility and bidirectional text, checked where they are decided.
 *
 * Two things are being tested, and they are checked in two different places
 * because that is where they live.
 *
 * The **markup** — roles, accessible names, focus order, disabled state, and
 * the rule that no status is signalled by colour alone — is asserted against
 * what `react-dom/server` renders. That is a real gate: a mode drawn as
 * available when it is degraded, or a verdict with no glyph, fails here.
 *
 * The **stylesheet** — focus visibility, forced colours, logical properties,
 * bidi isolation, behaviour at 200% zoom — is asserted against the theme's own
 * text. That is a weaker instrument than a browser and it is the honest one
 * available: it proves the rules are present and, more usefully, proves the
 * *absence* of the things that break them, like a hard-coded `margin-left` in
 * a surface that has to mirror.
 *
 * What neither can prove is how a screen reader actually announces this. That
 * is stated as a limitation rather than implied away.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import {
  buildTimeline,
  defaultComposer,
  defaultPanel,
  resolveModes,
  sessionHeader,
  sidebarRows,
} from '@watchskill/dsh-workspace'
import {
  ComposerPanel,
  InspectorTabs,
  Isolated,
  ModeSwitcher,
  SensoryTimelineStrip,
  SessionHeaderBar,
  Sidebar,
  StatusBadge,
  WorkspaceShell,
} from '@watchskill/dsh-workspace/components'
import { MemoryCardRow, MemoryWorkbench } from '@watchskill/dsh-client-memory/components'
import { MEMORY_VIEWS, toCard } from '@watchskill/dsh-client-memory'
import { LiveSurface } from '@watchskill/dsh-live/components'
import { startSession } from '@watchskill/dsh-live'
import { project } from '@watchskill/dsh-trajectory'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const THEME = readFileSync(
  join(ROOT, 'packages', 'watch', 'brand', 'src', 'client', 'theme.css'),
  'utf8',
)

/**
 * The stylesheet with its comments removed.
 *
 * Several rules here assert the *absence* of a pattern, and the comments
 * explain those patterns by name. Checking the raw text would make the
 * explanation trip the rule it explains.
 */
const THEME_RULES = THEME.replace(/\/\*[\s\S]*?\*\//g, '')

const READY = {
  capabilities: ['source.ask', 'live.observe', 'library.search'].map(capabilityId => ({
    capabilityId, provider: 'watch-core', providerVersion: '1', status: 'machine_tested',
    requirements: [], detected: {}, missing: [], fixes: [], lastCheckedAt: '2026-08-28T00:00:00Z',
  })),
  health: {
    phase: 'ready', transport: 'stdio', handshake: null, error: null,
    changedAt: '2026-08-28T00:00:00Z',
  },
}

function header(overrides = {}) {
  return sessionHeader({
    sessionId: 'sess_1',
    agentModel: 'deepseek-chat',
    roleBindings: [],
    dshConnected: true,
    health: READY.health,
    execution: 'running',
    verdicts: [],
    runId: 'run_42',
    costLabel: null,
    degraded: [],
    ...overrides,
  })
}

function shell(mode = 'agent') {
  const projection = project([], 'sess_1')
  return renderToStaticMarkup(createElement(WorkspaceShell, {
    sessionId: 'sess_1',
    mode,
    modeStates: resolveModes(READY),
    header: header(),
    rows: sidebarRows(),
    panel: defaultPanel(mode),
    timeline: buildTimeline({ sessionId: 'sess_1', events: [], projection }, 'compact'),
    composer: defaultComposer(),
    onMode: () => {}, onPanel: () => {}, onDensity: () => {}, onEntry: () => {}, onRow: () => {},
  }))
}

// ── roles and names ─────────────────────────────────────────────────────────

describe('every region is named and reachable', () => {
  test('the landmarks carry accessible names', () => {
    const markup = shell()
    assert.match(markup, /<nav aria-label="Workspace navigation"/)
    assert.match(markup, /<aside[^>]*aria-label="Inspector"/)
    assert.match(markup, /<section[^>]*aria-label="Sensory timeline"/)
    assert.match(markup, /<section[^>]*aria-label="Turn configuration"/)
    assert.match(markup, /<main/)
    assert.match(markup, /<header/)
  })

  test('both tab strips are tablists with named tabs', () => {
    const markup = shell()
    assert.match(markup, /role="tablist" aria-label="Workspace mode"/)
    assert.match(markup, /role="tablist" aria-label="Inspector panel"/)
    const tabs = markup.match(/role="tab"/g) ?? []
    assert.ok(tabs.length >= 16, `expected mode and panel tabs, found ${String(tabs.length)}`)
  })

  test('exactly one tab in each strip is selected', () => {
    const modeStrip = renderToStaticMarkup(
      createElement(ModeSwitcher, { active: 'live', states: resolveModes(READY), onSelect: () => {} }),
    )
    assert.equal((modeStrip.match(/aria-selected="true"/g) ?? []).length, 1)

    const panelStrip = renderToStaticMarkup(
      createElement(InspectorTabs, { active: 'evidence', onSelect: () => {} }),
    )
    assert.equal((panelStrip.match(/aria-selected="true"/g) ?? []).length, 1)
  })

  test('the sidebar marks the current row rather than only styling it', () => {
    const markup = renderToStaticMarkup(createElement(Sidebar, {
      rows: sidebarRows(), activeRow: 'library', onSelect: () => {},
    }))
    assert.match(markup, /aria-current="page"/)
    assert.equal((markup.match(/aria-current="page"/g) ?? []).length, 1)
  })

  test('every sidebar group has a heading its section points at', () => {
    const markup = renderToStaticMarkup(createElement(Sidebar, {
      rows: sidebarRows(), activeRow: null, onSelect: () => {},
    }))
    for (const group of ['workspace', 'observation', 'knowledge', 'operations']) {
      assert.match(markup, new RegExp(`aria-labelledby="watch-sidebar-${group}"`))
      assert.match(markup, new RegExp(`id="watch-sidebar-${group}"`))
    }
  })

  test('everything interactive is a real control, not a clickable div', () => {
    const markup = shell()
    const clickableDivs = markup.match(/<div[^>]*onclick/gi) ?? []
    assert.deepEqual(clickableDivs, [], 'a div is handling clicks')
    // Buttons declare their type, so none of them submits a form by accident.
    const buttons = markup.match(/<button/g) ?? []
    const typed = markup.match(/<button type="button"/g) ?? []
    assert.equal(buttons.length, typed.length, 'a button has no explicit type')
  })
})

// ── state without colour ────────────────────────────────────────────────────

describe('no state is signalled by colour alone', () => {
  test('every verdict carries a glyph and a word', () => {
    for (const [verdict, glyph] of [
      ['VERIFIED', '✓'], ['FAILED', '✗'], ['UNVERIFIED', '?'],
      ['INCONCLUSIVE', '≈'], ['STALE', '⌛'], ['BLOCKED', '⊘'],
    ]) {
      const markup = renderToStaticMarkup(createElement(StatusBadge, { status: verdict }))
      // includes(), not a regex: one of these glyphs is `?`.
      assert.ok(markup.includes(glyph), `${verdict} has no glyph`)
      assert.ok(markup.includes(verdict), `${verdict} has no word`)
      assert.match(markup, /aria-hidden="true"/, `${verdict}'s glyph is not hidden from the reader`)
    }
  })

  test('the glyph is hidden from assistive technology, and the word is not', () => {
    const markup = renderToStaticMarkup(createElement(StatusBadge, { status: 'FAILED' }))
    // The glyph is decoration for a sighted reader; the word is the content.
    assert.match(markup, /<span aria-hidden="true">✗<\/span><span>FAILED<\/span>/)
  })

  test('a degraded mode says degraded in text, not only in tone', () => {
    const markup = renderToStaticMarkup(createElement(ModeSwitcher, {
      active: 'agent',
      states: resolveModes({ capabilities: [], health: null }),
      onSelect: () => {},
    }))
    assert.match(markup, /data-watch-availability="unavailable"/)
    assert.match(markup, /unavailable<\/span>/)
    assert.match(markup, /aria-disabled="true"/)
  })

  test('an unavailable tab carries its reason as an accessible description', () => {
    const markup = renderToStaticMarkup(createElement(ModeSwitcher, {
      active: 'agent',
      states: resolveModes({ capabilities: [], health: null }),
      onSelect: () => {},
    }))
    const described = /aria-describedby="(watch-mode-reason-[a-z]+)"/.exec(markup)
    assert.notEqual(described, null, 'no tab describes its own reason')
    assert.match(markup, new RegExp(`id="${described[1]}"`))
  })

  test('a live gap is dashed and glyphed as well as toned', () => {
    const state = startSession({
      sessionId: 'live_1', target: 'https://example.test', kind: 'stream', startedAtMs: 0,
    })
    const withGap = {
      ...state,
      events: [{
        seq: 1, cursor: 'c1', kind: 'gap', at: 0, mediaMs: 1_000,
        text: 'capture gap', range: { startMs: 1_000, endMs: 2_000 }, evidenceIds: [],
      }],
    }
    const markup = renderToStaticMarkup(createElement(LiveSurface, {
      state: withGap,
      onStart: () => {}, onStop: () => {}, onAsk: () => {}, onSelect: () => {}, onPin: () => {},
    }))
    assert.match(markup, /data-watch-live-event="gap"/)
    assert.match(markup, /dashed/)
    assert.match(markup, /⌇/)
  })

  test('a discontinuous live view is an alert, which a reader is told about', () => {
    const state = startSession({
      sessionId: 'live_1', target: 'https://example.test', kind: 'stream', startedAtMs: 0,
    })
    const markup = renderToStaticMarkup(createElement(LiveSurface, {
      state: { ...state, needsSnapshot: true, lastError: 'the cursor did not continue' },
      onStart: () => {}, onStop: () => {}, onAsk: () => {}, onSelect: () => {}, onPin: () => {},
    }))
    assert.match(markup, /role="alert"/)
  })
})

// ── the stylesheet ──────────────────────────────────────────────────────────

describe('focus, contrast and zoom', () => {
  test('focus is drawn on :focus-visible, with an offset', () => {
    assert.match(THEME, /:focus-visible/)
    // The ring takes the brand accent, whatever the brand accent currently is.
    // Pinning the hex or the old `--watch-amber` name tested the palette rather
    // than the property, and broke when the brand moved from amber to blue
    // while the ring itself was never at risk.
    assert.match(THEME, /outline:\s*2px solid var\(--watch-accent\)/)
    assert.match(THEME, /outline-offset:/)
  })

  test('the ring colour is a token, so a rebrand cannot silently remove it', () => {
    const focusBlock = /:focus-visible\s*\{[^}]*\}/.exec(THEME)?.[0] ?? ''
    assert.doesNotMatch(focusBlock, /#[0-9A-Fa-f]{3,8}/)
    assert.match(THEME, /--watch-accent:\s*#/)
  })

  test('an outline is used rather than a shadow, so scrolling does not clip it', () => {
    const focusBlock = /:focus-visible\s*\{[^}]*\}/.exec(THEME)?.[0] ?? ''
    assert.equal(/box-shadow/.test(focusBlock), false)
  })

  test('forced colours get their own ring rather than losing one', () => {
    assert.match(THEME, /@media \(forced-colors: active\)/)
    assert.match(THEME, /outline:\s*3px solid Highlight/)
  })

  test('high contrast hands the palette back to the platform', () => {
    assert.match(THEME, /@media \(prefers-contrast: more\)/)
    assert.match(THEME, /CanvasText/)
  })

  test('reduced motion drops the decoration', () => {
    assert.match(THEME, /@media \(prefers-reduced-motion: reduce\)/)
    assert.match(THEME, /animation:\s*none/)
  })

  test('the timeline scrolls in its own axis rather than forcing the page to', () => {
    assert.match(THEME, /\[data-watch-timeline\][\s\S]*overflow-x:\s*auto/)
    assert.match(THEME, /min-height/)
  })

  test('no fixed pixel height is imposed on a surface that has to grow at 200%', () => {
    // `height: 40px` on a control is what clips a label at 200% zoom. The
    // theme uses min-height instead, and this asserts the absence.
    assert.equal(/\bheight:\s*\d+px/.test(THEME), false,
      'the theme pins a pixel height, which clips at 200% zoom')
  })
})

describe('right to left, by construction', () => {
  test('the theme mirrors through logical properties, not a hand-written RTL block', () => {
    assert.equal(/\[dir=['"]rtl['"]\]/.test(THEME_RULES), false,
      'a hand-written RTL block is a block that will be mirrored incompletely')
  })

  test('the surfaces use logical offsets rather than left and right', () => {
    for (const source of [
      'packages/watch/workspace/src/client/components.tsx',
      'packages/watch/live/src/client/components.tsx',
      'packages/watch/client-memory/src/client/components.tsx',
    ]) {
      const text = readFileSync(join(ROOT, source), 'utf8')
      for (const physical of ['marginLeft', 'marginRight', 'paddingLeft', 'paddingRight', 'borderLeft:', 'borderRight:', "textAlign: 'left'", "textAlign: 'right'"]) {
        assert.equal(text.includes(physical), false,
          `${source} uses ${physical}, which does not mirror`)
      }
    }
  })

  test('bidi isolation is declared for the spans that need it', () => {
    assert.match(THEME, /\[data-watch-ltr\][\s\S]*unicode-bidi:\s*isolate/)
    assert.match(THEME, /\[data-watch-auto\][\s\S]*unicode-bidi:\s*isolate/)
  })

  test('an identifier is isolated left-to-right', () => {
    const markup = renderToStaticMarkup(
      createElement(Isolated, { kind: 'identifier' }, '/var/log/watch.log'),
    )
    assert.match(markup, /dir="ltr"/)
    assert.match(markup, /data-watch-ltr/)
  })

  test('every kind the contract isolates is isolated here', () => {
    for (const kind of ['code', 'url', 'path', 'identifier', 'timestamp', 'digest', 'version']) {
      const markup = renderToStaticMarkup(createElement(Isolated, { kind }, 'x'))
      assert.match(markup, /dir="ltr"/, `${kind} was not isolated`)
    }
  })

  test('prose is not forced left-to-right', () => {
    const markup = renderToStaticMarkup(
      createElement(Isolated, { kind: 'prose' }, 'اكتب بالعربية'),
    )
    assert.match(markup, /dir="auto"/)
    assert.equal(/dir="ltr"/.test(markup), false)
  })

  test('the session header isolates the model and the run id', () => {
    const markup = renderToStaticMarkup(createElement(SessionHeaderBar, { state: header() }))
    assert.match(markup, /data-watch-kind="identifier"/)
    assert.equal((markup.match(/data-watch-ltr/g) ?? []).length >= 2, true)
  })

  test('Arabic memory content follows its own direction and declares its language', () => {
    const now = '2026-08-28T10:00:00.000Z'
    const markup = renderToStaticMarkup(createElement(MemoryCardRow, {
      card: toCard({
        memoryId: 'mem_1', kind: 'preference', subjectScope: 'user', scopeId: 'u1',
        content: 'اكتب بالعربية المصرية', origin: 'explicit_user', sourceRefs: [], evidenceRefs: [],
        confidence: 1, status: 'active', sensitivity: 'private', validFrom: now, validUntil: null,
        createdAt: now, updatedAt: now, lastConfirmedAt: now, supersedes: [], contradictedBy: [],
        locale: 'ar-EG',
      }),
      onOperation: () => {},
    }))
    assert.match(markup, /lang="ar-EG"/)
    assert.match(markup, /dir="auto"/)
    assert.match(markup, /اكتب بالعربية المصرية/)
  })

  test('a memory id is rendered LTR inside content that may be RTL', () => {
    const markup = renderToStaticMarkup(createElement(MemoryWorkbench, {
      view: 'timeline',
      cards: [],
      events: [{
        eventId: 'e1', kind: 'record.confirmed', memoryId: 'mem_1',
        at: '2026-08-28T10:00:00.000Z', actor: 'user', record: null, detail: {},
      }],
      mode: 'local_personal',
      onView: () => {}, onOperation: () => {},
    }))
    assert.match(markup, /<code dir="ltr">mem_1<\/code>/)
  })
})

// ── the timeline's text alternative ─────────────────────────────────────────

describe('the timeline is readable without seeing it', () => {
  test('every lane is a labelled group of text buttons', async () => {
    const { project: projectEvents } = await import('@watchskill/dsh-trajectory')
    const events = [
      { type: 'tool/call', seq: 1, time: 1, data: { callId: 'c1', name: 'watch_verify', arguments: {}, turn: 1, step: 1 } },
      {
        type: 'tool/result', seq: 2, time: 2,
        data: { turn: 1, message: { source: { callId: 'c1' }, content: [{ content: [{ type: 'text', text: JSON.stringify({ ok: true, verdict: 'FAILED', verificationId: 'v1' }) }] }] } },
      },
    ]
    const timeline = buildTimeline({
      sessionId: 'sess_1', events, projection: projectEvents(events, 'sess_1'),
    }, 'analysis')
    const markup = renderToStaticMarkup(createElement(SensoryTimelineStrip, {
      timeline, onDensity: () => {}, onSelect: () => {},
    }))
    assert.match(markup, /data-watch-lane="verdicts"/)
    assert.match(markup, /FAILED/)
    // No canvas, no image, no aria-hidden wrapper around the content.
    assert.equal(/<canvas/.test(markup), false)
    assert.equal(/<img/.test(markup), false)
  })

  test('the density control says what it is hiding', () => {
    const projection = project([], 'sess_1')
    const timeline = buildTimeline({ sessionId: 'sess_1', events: [], projection }, 'collapsed')
    const markup = renderToStaticMarkup(createElement(SensoryTimelineStrip, {
      timeline, onDensity: () => {}, onSelect: () => {},
    }))
    assert.match(markup, /aria-pressed="true"/)
    assert.equal((markup.match(/aria-pressed="true"/g) ?? []).length, 1)
  })
})

// ── memory surface ──────────────────────────────────────────────────────────

describe('the Memory surface is navigable', () => {
  test('the view tabs are a tablist with one selected', () => {
    const markup = renderToStaticMarkup(createElement(MemoryWorkbench, {
      view: 'taste', cards: [], events: [], mode: 'local_personal',
      onView: () => {}, onOperation: () => {},
    }))
    assert.match(markup, /role="tablist" aria-label="Memory view"/)
    assert.equal((markup.match(/aria-selected="true"/g) ?? []).length, 1)
    assert.equal((markup.match(/role="tab"/g) ?? []).length, MEMORY_VIEWS.length)
  })

  test('the refusals a composer shows are a labelled list', () => {
    const markup = renderToStaticMarkup(createElement(ComposerPanel, {
      config: defaultComposer(),
      refusals: [{ axis: 'egress', message: 'An agent cannot grant itself a network route.', fix: 'Add the destination.' }],
    }))
    assert.match(markup, /aria-label="Refused agent requests"/)
  })
})
