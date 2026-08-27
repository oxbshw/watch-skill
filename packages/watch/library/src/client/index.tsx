/**
 * The Library surface, registered into DSH's slots.
 *
 * @module @watchskill/dsh-library/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { LibrarySurface } from './components.js'

export * from './components.js'
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
  slots.inject('workspace.library', () => {
    slots.register({ name: 'workspace.library', id: 'watch-library-surface', order: 10 }, LibrarySurface)
  })
}
