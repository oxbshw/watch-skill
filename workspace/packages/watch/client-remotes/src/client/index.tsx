/**
 * Watch's generated Remote, mounted into the Client's `ctx.remote`.
 *
 * This package exists to break a cycle, and the cycle is worth stating because
 * the arrangement only makes sense against it. `@watchskill/dsh-tools` is the
 * Host: it owns `WatchQueryService`, and Typert generates the Remote from that
 * Host program. It reads the Library's index, so tools depends on
 * `@watchskill/dsh-library`. When the Library's browser half also mounted the
 * generated contribution, the Library depended on tools in return — a real
 * cyclic workspace dependency that pnpm warned about, and a build order no
 * staging can honestly satisfy, because the Library's client could not compile
 * until a file generated *from* the Library's own dependent existed.
 *
 * So the mount moved out to a composition boundary. Nothing else lives here.
 * The rule this package holds is one sentence: a package that owns a capability
 * never also owns the transport that carries it.
 *
 * `ctx.remote.$mount` is how a distribution outside upstream's own assembly
 * contributes a namespace — `@deepseek-ai/dsh-api-remotes` imports its seven
 * contributions statically, and anything else mounts its own. What arrives is
 * `@watchskill/dsh-tools/remote`, generated from the Host service by Typert, so
 * a surface calls `ctx.remote.watchQuery.librarySearch` against the same strict
 * codecs the Host validates with.
 *
 * The artifact is client-safe by construction: it imports zod and nothing else,
 * and carries descriptors rather than any Host implementation.
 *
 * @module @watchskill/dsh-client-remotes/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TypertDisposer, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
// The upstream declaration of `ctx.remote`, imported for its module
// augmentation alone. Restating the shape locally is how a mount ends up typed
// against a contract the runtime does not have.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type { WatchQueryRemote } from '@watchskill/dsh-library/read-plane'
import TYPERT_REMOTE from '@watchskill/dsh-tools/remote'

/**
 * The Client Remote service, which the Gateway's browser half installs.
 *
 * Named as a service rather than as a package: `@deepseek-ai/dsh-api-remotes`
 * is what the boot graph must materialise first, and that is declared in
 * `dsh.client.inject`. This is the thing that has to exist before `apply` runs.
 */
export const inject = ['remote']

/** Mutual assignability, so neither side may be wider than the other. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * The Library's declared view of `watchQuery`, checked against the generated one.
 *
 * The Library cannot import the generated declaration — that is the edge this
 * package exists to remove — so it describes the namespace from the shared wire
 * contracts instead. Left unchecked that would be a hand-written copy free to
 * drift the moment a Remote signature changes. Here both types are in scope, so
 * the compiler compares them: regenerate the Remote with a different signature
 * and this assignment stops compiling, naming the file that has to change.
 */
export const LIBRARY_MATCHES_THE_GENERATED_NAMESPACE:
Exact<TypertRemoteNamespaceMap['watchQuery'], WatchQueryRemote> = true

/**
 * Mount the generated contribution, and hand back the disposer that removes it.
 *
 * The disposer is returned rather than registered on an event: cordis unwinds a
 * plugin by awaiting what its `apply` handed back, and a namespace that
 * outlives the plugin that mounted it is a service pointing at a fiber that has
 * gone.
 *
 * Nothing here is defensive about `ctx.remote`. `inject` above means cordis does
 * not call this until the service exists, so a missing Remote parks the plugin
 * instead of reaching `undefined.$mount` — the difference between a plugin that
 * refuses and a mount that fails after the fact.
 */
export async function apply(ctx: Context): Promise<TypertDisposer> {
  return await ctx.remote.$mount(TYPERT_REMOTE)
}
