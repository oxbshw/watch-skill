/**
 * Live mode: the client half of watching something while it happens.
 *
 * @module @deepwatch/dsh-live
 */

export * from './session.js'
export * from './capture.js'
export * from './sources-catalogue.js'
export * from './synthetic-source.js'

export * from './triggers.js'

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
