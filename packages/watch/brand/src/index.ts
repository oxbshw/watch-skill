/**
 * Host loader entry for the Watch brand's browser half.
 *
 * The brand is presentation. There is no host-side behavior to install; the
 * entry exists because the DSH loader mounts a package's node half first and
 * reads its `dsh.client` declaration from there.
 *
 * @module @watchskill/dsh-client-brand
 */

export * from './identity.js'

/** No host-side behavior: the brand occupies browser slots only. */
export function apply(): void {}
