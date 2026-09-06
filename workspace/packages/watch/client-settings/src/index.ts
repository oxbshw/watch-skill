/**
 * Host loader entry for the Watch Technology & Capability Center.
 *
 * There is no host behaviour to install — the Center is entirely browser-side,
 * under `./client`. This entry exists because the DSH loader mounts a
 * package's node half first and reads its `dsh.client` declaration from there;
 * a row whose module exports no `apply` is refused with "invalid plugin", and
 * the whole plugin tree fails to load with it.
 *
 * @module @deepwatch/dsh-client-settings
 */

export function apply(): void {}
