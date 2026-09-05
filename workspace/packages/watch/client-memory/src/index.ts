/**
 * The Memory product surfaces.
 *
 * Pure view models over records and events. The ledger lives in
 * `@deepwatch/dsh-memory` and stays there — a browser half that could write
 * to it would be a second writer, and a second writer is how a ledger stops
 * being an authority.
 *
 * @module @deepwatch/dsh-client-memory
 */

export * from './views.js'

/**
 * The host-side loader entry.
 *
 * There is no host behaviour to install — this package's product surface is
 * entirely browser-side, under `./client`. The entry exists because the DSH
 * loader mounts a package's node half first and reads its `dsh.client`
 * declaration from there; a row whose module exports no `apply` is refused
 * with "invalid plugin, expect function or object with an apply method", and
 * the whole plugin tree fails to load with it.
 */
export function apply(): void {}
