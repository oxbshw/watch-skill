/**
 * The Live surface, registered into DSH's slots.
 *
 * @module @watchskill/dsh-live/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { LiveSurface } from './components.js'

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
  slots.inject('workspace.live', () => {
    slots.register({ name: 'workspace.live', id: 'watch-live-surface', order: 10 }, LiveSurface)
  })
}
