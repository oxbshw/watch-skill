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

  // Memory is a product mode, registered as one of DSH's views so the session
  // header renders its tab alongside the rest.
  slots.inject('conversation.view', () => {
    slots.register(
      { name: 'conversation.view', id: 'memory', label: 'Memory', order: 40 },
      MemoryWorkbench,
    )
  })
  // The chip goes to the input dock rather than to a chat node.
  //
  // `conversation.chat.node` is a *keyed* slot: it renders a registration for a
  // node kind the conversation actually carries, and a chip is not a node kind.
  // The dock is a list, and it is arguably the better home anyway — the
  // question "why does it think that?" is most useful about the memory being
  // injected into the turn you are composing, where you can still correct it.
  occupy('conversation.input.dock', 'watch-why-remembered', WhyRememberedChip, 40)
}
