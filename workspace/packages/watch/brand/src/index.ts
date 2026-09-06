/**
 * Host loader entry for the Watch brand's browser half.
 *
 * The brand is presentation. There is no host-side behavior to install; the
 * entry exists because the DSH loader mounts a package's node half first and
 * reads its `dsh.client` declaration from there.
 *
 * @module @deepwatch/dsh-client-brand
 */

export * from './identity.js'
// The mark travels with the identity, so a surface that needs both — About,
// the first-run notice — imports one package rather than reaching past it.
export * from './mark.js'

/** No host-side behavior: the brand occupies browser slots only. */
export function apply(): void {}
