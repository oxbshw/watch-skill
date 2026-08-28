/**
 * The workspace shell, registered into DeepSeek Harness's own slots.
 *
 * Nothing is patched and nothing is replaced. The shell occupies generic slots
 * upstream already declares — which is what keeps the Agent mode *being* DSH's
 * conversation rather than a reimplementation of it that drifts.
 *
 * The slot names here are not free-form. A registration into a name that no
 * DSH component renders is accepted silently: the plugin loads, its tests
 * pass, and nothing is ever drawn. `scripts/verify-slots.mjs` checks every
 * name in this file against `inventory/dsh-slots.json`, extracted from the
 * pinned packages' own `renderSlot` call sites.
 *
 * @module @watchskill/dsh-workspace/client
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ComposerPanel,
  InspectorTabs,
  ModeSwitcher,
  SensoryTimelineStrip,
  SessionHeaderBar,
  Sidebar,
  StatusBadge,
  WorkspaceShell,
} from './components.js'

export * from './components.js'
export * from '../modes.js'
export * from '../shell.js'
export * from '../timeline.js'
export * from '../composer.js'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/**
 * Register the shell's regions.
 *
 * Each region goes into the slot upstream provides for it, at an order that
 * leaves room above and below for other plugins. A distribution that took
 * order 0 everywhere would be a distribution no third-party capability could
 * sit alongside, which is the opposite of what the ecosystem path needs.
 */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotService }).slots

  const occupy = (name: string, id: string, component: unknown, order = 20): void => {
    slots.inject(name, () => { slots.register({ name, id, order }, component) })
  }

  /**
   * A product mode.
   *
   * `conversation.view` is DSH's view ledger, not merely a region: it renders
   * `{ only: activeId }`, and the session header builds a real `role="tablist"`
   * from the registered set whenever more than one view exists. So a mode is
   * declared by registering here, and it arrives with upstream's keyboard
   * handling, `aria-selected` and persisted selection already correct.
   *
   * This is why Watch ships no mode switcher of its own. `ModeSwitcher` stays
   * exported for embedding and for its tests, but registering it would put a
   * second control beside DSH's — a duplicate navigation system, which is
   * precisely what this distribution may not build.
   */
  const mode = (id: string, label: string, component: unknown, order: number): void => {
    slots.inject('conversation.view', () => {
      slots.register({ name: 'conversation.view', id, label, order }, component)
    })
  }

  // Agent is upstream's `chat` view and Trajectory is upstream's `trajectory`
  // view; both are left exactly as they are. Watch contributes the rest, and
  // the seven together are the product's modes. Live, Library, Memory and
  // Compare are registered by the packages that own them.
  mode('watch', 'Watch', WorkspaceShell, 20)

  occupy('sidebar.workspaces', 'watch-sidebar', Sidebar, 10)
  // The status strip goes in the header's utility region rather than beside
  // the title: it is ambient state and must not crowd the session name.
  occupy('conversation.session.header.utilities', 'watch-session-header', SessionHeaderBar, 10)
  occupy('conversation.composer.dock', 'watch-sensory-timeline', SensoryTimelineStrip, 30)
  occupy('conversation.composer.bar', 'watch-composer', ComposerPanel, 10)
  // The inspector is an overlay rather than a permanent third column: DSH's
  // layout owns the columns it has, and taking another would be a layout fork.
  occupy('shell.overlay', 'watch-inspector', InspectorTabs, 10)
}

export { ModeSwitcher, StatusBadge, WorkspaceShell }
