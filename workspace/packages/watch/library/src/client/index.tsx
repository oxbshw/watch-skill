/**
 * The Library surface, registered into DSH's slots.
 *
 * @module @watchskill/dsh-library/client
 */

import type { Context } from '@deepseek-ai/cordis'
import TYPERT_REMOTE from '@watchskill/dsh-tools/remote'
import { LibraryModeView } from './library-mode.js'

export * from './components.js'
export * from './search-view.js'
export * from './library-mode.js'
export * from '../sources.js'
export * from '../search.js'

/** Services this half needs before it can register anything. */
export const inject = ['slots', 'remote']

// The boot graph reads `dsh.client.inject` from package.json, not this
// constant, so `@deepseek-ai/dsh-api-remotes` is declared there as well. With
// only the slots entry the module still loaded and `ctx.remote` was undefined,
// which is a mount that fails silently rather than a plugin that refuses.

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/** The client half of `ctx.remote`, as far as this module uses it. */
interface RemoteService {
  $mount(contribution: unknown): Promise<() => Promise<void>>
}

/**
 * Register the Library mode body, and mount the Remote it reads through.
 *
 * `ctx.remote.$mount` is how a package that is not part of upstream's own
 * assembly contributes a namespace: `@deepseek-ai/dsh-api-remotes` imports its
 * seven contributions statically, and a distribution outside that list mounts
 * its own. What arrives is `@watchskill/dsh-tools/remote`, generated from the
 * Host service by Typert, so the client calls
 * `ctx.remote.watchQuery.librarySearch` against the same strict codecs the Host
 * validates with.
 *
 * The artifact is client-safe by construction: it imports zod and nothing else,
 * and carries descriptors rather than any Host implementation.
 *
 * The disposer is kept and run on unload, so the namespace never outlives the
 * plugin that mounted it.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const slots = (ctx as unknown as { slots: SlotService }).slots
  const remote = (ctx as unknown as { remote: RemoteService }).remote

  const unmount = await remote.$mount(TYPERT_REMOTE)
  // Library is a product mode. See the note in the Live surface: registering as
  // a view means DSH renders the tab, not Watch.
  slots.inject('conversation.view', () => {
    slots.register(
      { name: 'conversation.view', id: 'library', label: 'Library', order: 50 },
      LibraryModeView,
    )
  })

  // Returned rather than registered on an event: cordis unwinds a plugin by
  // awaiting what its `apply` handed back, and the namespace must not outlive
  // the plugin that mounted it.
  return async () => { await unmount() }
}
