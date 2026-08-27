/**
 * The Memory surfaces, registered into DSH's slots.
 *
 * @module @watchskill/dsh-client-memory/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { MemoryWorkbench, WhyRememberedChip } from './components.js'

export * from './components.js'
export * from '../views.js'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/**
 * Register the Memory workbench and the conversation chip.
 *
 * The chip goes into the message footer rather than into the Memory surface,
 * because the question it answers — "why does it think that?" — is asked while
 * reading a reply, not while browsing a list.
 */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotService }).slots
  const occupy = (name: string, id: string, component: unknown, order = 20): void => {
    slots.inject(name, () => { slots.register({ name, id, order }, component) })
  }

  occupy('workspace.memory', 'watch-memory-workbench', MemoryWorkbench, 10)
  occupy('message.footer', 'watch-why-remembered', WhyRememberedChip, 40)
}
