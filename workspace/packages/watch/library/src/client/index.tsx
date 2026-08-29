/**
 * The Library surface, registered into DSH's slots.
 *
 * @module @watchskill/dsh-library/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { LibraryModeView } from './library-mode.js'

export * from './components.js'
export * from './search-view.js'
export * from './library-mode.js'
export * from '../sources.js'
export * from '../search.js'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/** Register the Library mode body. */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotService }).slots
  // Library is a product mode. See the note in the Live surface: registering as
  // a view means DSH renders the tab, not Watch.
  slots.inject('conversation.view', () => {
    slots.register(
      { name: 'conversation.view', id: 'library', label: 'Library', order: 50 },
      LibraryModeView,
    )
  })
}
