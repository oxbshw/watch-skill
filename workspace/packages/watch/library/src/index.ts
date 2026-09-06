/**
 * The Library: sources and evidence, kept apart from memory.
 *
 * @module @deepwatch/dsh-library
 */

export * from './sources.js'
export * from './search.js'
export * from './index-store.js'

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
