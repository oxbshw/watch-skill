/**
 * The workspace shell, registered into DeepSeek Harness's own slots.
 *
 * Nothing is patched and nothing is replaced. The shell occupies generic slots
 * upstream already declares — which is what keeps the Agent mode *being* DSH's
 * conversation rather than a reimplementation of it that drifts.
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

  occupy('sidebar.nav', 'watch-sidebar', Sidebar, 10)
  occupy('conversation.header', 'watch-session-header', SessionHeaderBar, 10)
  occupy('conversation.header', 'watch-mode-switcher', ModeSwitcher, 20)
  occupy('conversation.footer', 'watch-sensory-timeline', SensoryTimelineStrip, 30)
  occupy('composer.extra', 'watch-composer', ComposerPanel, 10)
  occupy('inspector.panel', 'watch-inspector', InspectorTabs, 10)
}

export { StatusBadge, WorkspaceShell }
