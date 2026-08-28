/**
 * The Watch Workspace product shell.
 *
 * Everything here is derivation over state DSH and Watch Core already own.
 * There is no workspace store, because a workspace store is how a product
 * ends up with two answers to the same question.
 *
 * @module @watchskill/dsh-workspace
 */

export * from './modes.js'
export * from './shell.js'
export * from './timeline.js'
export * from './composer.js'

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
