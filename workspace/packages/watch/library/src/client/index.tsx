/**
 * The Library surface, registered into DSH's slots.
 *
 * @module @deepwatch/dsh-library/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'
import type { ModeViewProps } from '@deepwatch/dsh-workspace/surface'
import { LibraryModeView } from './library-mode.js'
import type { WatchQueryRemote } from './read-plane.js'

export * from './components.js'
export * from './search-view.js'
export * from './library-mode.js'
export * from './read-plane.js'
export * from '../sources.js'
export * from '../search.js'

/**
 * Services this half needs before it can register anything.
 *
 * `remote.watchQuery` as well as `remote`. The Gateway installs each mounted
 * namespace as its own cordis service under that key, so naming it is what
 * makes this plugin wait for the mount rather than load beside it: the bare
 * `remote` resolves as soon as the Gateway's browser half exists — which is
 * before any contribution is mounted — and leaves `ctx.remote` with no
 * `watchQuery` on it. Both are listed because both are read, and cordis
 * refuses a property no `inject` entry claims: reaching `ctx.remote.watchQuery`
 * on the strength of the second entry alone fails the fiber with "cannot get
 * property "remote" without inject".
 *
 * The mount itself belongs to `@deepwatch/dsh-client-remotes`. This package
 * owns the Library capability, and a package that owns a capability does not
 * also own the transport that carries it; when it did, the two depended on
 * each other.
 */
export const inject = ['slots', 'remote', 'remote.watchQuery']

// The boot graph reads `dsh.client.inject` from package.json rather than this
// constant, so the package that performs the mount is named there as well.

/** The minimal shape of DSH's slot service this module uses. */
interface SlotService {
  inject(name: string, register: () => void): void
  register(entry: Record<string, unknown>, component: unknown): void
}

/**
 * Register the Library mode body, bound to the read plane it queries.
 *
 * A `conversation.view` entry is handed `{ inspect, onInspectDone }` and
 * nothing else, so a mode body has no way to reach a service on its own. The
 * binding happens here, where the context is: what gets registered is the mode
 * body with the mounted `watchQuery` namespace already supplied.
 *
 * Nothing here is defensive about `ctx.remote.watchQuery`. `inject` above means
 * cordis does not call `apply` until that service exists, so a profile without
 * the mount parks this plugin — no Library tab at all — rather than drawing a
 * tab whose search quietly answers from an empty local index.
 */
export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: SlotService }).slots
  const reads = (ctx as unknown as {
    remote: { watchQuery: WatchQueryRemote }
  }).remote.watchQuery

  /** The Library body, bound to the host that answers for it. */
  const BoundLibraryModeView = (props: ModeViewProps): ReactNode => (
    <LibraryModeView {...props} reads={reads} />
  )

  // Library is a product mode. See the note in the Live surface: registering as
  // a view means DSH renders the tab, not Watch.
  slots.inject('conversation.view', () => {
    slots.register(
      { name: 'conversation.view', id: 'library', label: 'Library', order: 50 },
      BoundLibraryModeView,
    )
  })
}
