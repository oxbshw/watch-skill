/**
 * The Live surface, registered into DSH's slots.
 *
 * @module @watchskill/dsh-live/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { LiveModeView } from '@watchskill/dsh-workspace/mode-views'
// `/mode-views` rather than `/client`: the `/client` entry is a loader
// registration wrapped in `window.__ModuleLoader__.load(...)`, and a bundler
// cannot read named exports out of a function body. The subpath is ordinary
// ESM, so it inlines cleanly.

export * from './components.js'
export * from '../session.js'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/** Register the Live mode body. */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotService }).slots
  // Live is a product mode, so it registers as one of DSH's views. The session
  // header turns the registered set into its own tab strip, which is why this
  // is a view rather than a panel Watch would have to place and style itself.
  slots.inject('conversation.view', () => {
    slots.register({ name: 'conversation.view', id: 'live', label: 'Live', order: 30 }, LiveModeView)
  })
}
