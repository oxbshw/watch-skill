/**
 * How Compare gets mounted, kept apart from what Compare draws.
 *
 * Two reasons, and the second is the one that matters.
 *
 * The mounting decision is load-bearing and was wrong: the mode was registered
 * bare, with no records and no way to obtain any, so the shipped product drew
 * Compare's empty state forever while every test that rendered the component
 * with fixtures passed. A registration that is a side effect of a large plugin
 * is a registration nobody asserts on.
 *
 * And it has to be assertable without a DOM. The package's client entry pulls in
 * CSS modules for the tool-call rows, so it cannot be imported by a test runner
 * at all; the bundled entry needs `window`. Neither can answer "does the shipped
 * plugin give Compare a source of records". This module can, because it imports
 * the mode and nothing else.
 *
 * @module @deepwatch/dsh-client-evidence/client/compare-registration
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type { ModeViewProps } from '@deepwatch/dsh-workspace/surface'
import { CompareModeView } from './compare-mode.js'
import type { CompareReads } from './compare-mode.js'

/** The minimal shape of DSH's slot service this module uses. */
export interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/**
 * What Compare needs from cordis, declared where only Compare pays for it.
 *
 * Cordis refuses a property no `inject` entry claims, so reaching
 * `ctx.remote.watchQuery` has to be declared. Declared on the whole package it
 * would park the tool-call views too, on any profile that mounts no query
 * gateway — and those views need no Host round-trip, so they would be lost for
 * a reason that has nothing to do with them. Nested, the dependency parks only
 * the tab that has it: no Compare tab, rather than a Compare tab whose picker is
 * permanently empty and cannot say why.
 */
export const COMPARE_INJECT = ['slots', 'remote', 'remote.watchQuery']

/** Mount Compare as a conversation view, bound to the host that answers for it. */
export function registerCompare(ctx: Context): void {
  ;(ctx as unknown as { plugin(definition: unknown): void }).plugin({
    inject: COMPARE_INJECT,
    apply(scope: Context): void {
      const slots = (scope as unknown as { slots: SlotService }).slots
      const reads = (scope as unknown as {
        remote: { watchQuery: CompareReads }
      }).remote.watchQuery

      const BoundCompareModeView = (props: ModeViewProps): ReactNode => (
        <CompareModeView {...props} reads={reads} />
      )

      // Compare is a product mode. It lives in this package rather than in the
      // workspace shell because the thing it compares is evidence, and the rules
      // about what a difference may and may not assert are already here: a
      // comparison describes a divergence, it never mints a verdict of its own.
      slots.inject('conversation.view', () => {
        slots.register(
          { name: 'conversation.view', id: 'compare', label: 'Compare', order: 60 },
          BoundCompareModeView,
        )
      })
    },
  })
}
