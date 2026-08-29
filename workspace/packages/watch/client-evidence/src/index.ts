/**
 * Host loader entry for the browser half exported from `./client`.
 *
 * The Watch tool views read what the conversation already carries, so there is
 * no host-side behavior to install. The entry exists because the DSH loader
 * mounts a package's node half first and reads its `dsh.client` declaration
 * from there.
 *
 * @module @watchskill/dsh-client-evidence
 */

export * from './compare-engine.js'

/** No host-side behavior: the views are pure presentation over the turn. */
export function apply(): void {}
