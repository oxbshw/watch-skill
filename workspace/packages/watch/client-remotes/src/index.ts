/**
 * Host loader entry for the Remote mount's browser half.
 *
 * Mounting a Typert Remote is a browser-side act: the contribution installs
 * `ctx.remote.<namespace>` on the Client fiber, and the Host already owns the
 * other end through `@watchskill/dsh-tools`. There is no host-side behaviour to
 * install here; the entry exists because the DSH loader mounts a package's node
 * half first and reads its `dsh.client` declaration from there.
 *
 * @module @watchskill/dsh-client-remotes
 */

/** No host-side behaviour: this package composes the browser's Remote only. */
export function apply(): void {}
