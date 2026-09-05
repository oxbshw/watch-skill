/**
 * Every mode body must draw something when handed only the props it gets.
 *
 * A `conversation.view` entry is called with `{ inspect, onInspectDone }` and
 * nothing else. The Memory view was registered as `MemoryWorkbench`, which
 * needs `mode`, `view`, `cards` and `events`, so `props.cards.length` threw and
 * React unmounted the subtree. The tab selected correctly and opened onto a
 * blank panel -- which reads as a broken feature rather than an empty one, and
 * is the exact failure the slot work was supposed to have ended.
 *
 * Reading the source would not have caught it, so this renders each body the
 * way DSH does and asserts there is something on the screen.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'

import { WatchModeView } from '@deepwatch/dsh-workspace/mode-views'
import { LiveModeView } from '@deepwatch/dsh-live/live-mode'
import { LibraryModeView } from '@deepwatch/dsh-library/library-mode'
import { CompareModeView } from '@deepwatch/dsh-client-evidence/compare-mode'
import { MemoryModeView } from '@deepwatch/dsh-client-memory/memory-mode'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Exactly what DSH hands a view entry, and nothing more. */
const VIEW_PROPS = { inspect: undefined, onInspectDone: () => {} }

const BODIES = [
  ['Watch', WatchModeView],
  ['Live', LiveModeView],
  ['Library', LibraryModeView],
  ['Compare', CompareModeView],
  ['Memory', MemoryModeView],
]

describe('a mode body renders with only the view props', () => {
  for (const [name, Body] of BODIES) {
    test(`${name} draws something`, () => {
      let markup = ''
      assert.doesNotThrow(
        () => { markup = renderToStaticMarkup(createElement(Body, VIEW_PROPS)) },
        `${name} threw when rendered with only { inspect, onInspectDone }`,
      )

      // Tags alone are not content: an empty wrapper is still a blank panel.
      const text = markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      assert.ok(
        text.length > 40,
        `${name} rendered ${String(text.length)} characters of text, which is a blank panel`,
      )
      assert.ok(
        text.includes(name),
        `${name} does not name itself, so a reader cannot tell which mode they are in`,
      )
    })
  }

  test('each conversation.view registration names a mode body', () => {
    // Rendering the bodies is not enough on its own: the Memory defect was that
    // the slot pointed at `MemoryWorkbench`, a component that needs props a view
    // entry never receives. The body was fine; the wiring was not.
    const registrations = [
      ['workspace', 'packages/watch/workspace/src/client/index.tsx'],
      ['live', 'packages/watch/live/src/client/index.tsx'],
      ['library', 'packages/watch/library/src/client/index.tsx'],
      ['client-evidence', 'packages/watch/client-evidence/src/client/index.tsx'],
      ['client-memory', 'packages/watch/client-memory/src/client/index.tsx'],
    ]
    for (const [pkg, path] of registrations) {
      const source = readFileSync(join(ROOT, path), 'utf8')
      for (const match of source.matchAll(/conversation\.view'[\s\S]{0,220}?\n\s*(\w+),/g)) {
        assert.match(
          match[1],
          /ModeView$/,
          `${pkg} registers ${match[1]} as a conversation.view; a view entry receives `
          + 'only { inspect, onInspectDone }, so it has to be a mode body',
        )
      }
    }
  })

  test('every body says what it shows and what to do next', () => {
    // The empty-state contract: what, why, next. A body that renders only a
    // heading is the placeholder this whole surface was meant to replace.
    for (const [name, Body] of BODIES) {
      const markup = renderToStaticMarkup(createElement(Body, VIEW_PROPS))
      const text = markup.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
      assert.ok(
        text.length > 120,
        `${name} renders ${String(text.length)} characters, too little to explain itself`,
      )
    }
  })

  test('no body claims a verdict it did not receive', () => {
    // Only Watch Core mints verdicts, so a body rendered with no record must
    // not display one.
    //
    // Filter controls are excluded deliberately: Library's verification filter
    // lists VERIFIED as a value you can search for, which is offering a choice
    // rather than asserting a result. Everything outside a <select> is fair.
    for (const [name, Body] of BODIES) {
      const markup = renderToStaticMarkup(createElement(Body, VIEW_PROPS))
      const outsideControls = markup.replace(/<select[\s\S]*?<\/select>/g, '')
      assert.ok(
        !/>\s*(VERIFIED|FAILED)\s*</.test(outsideControls),
        `${name} displayed a verdict with no record to support it`,
      )
    }
  })
})
