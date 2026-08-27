/**
 * The Watch capability SDK.
 *
 * A developer should be able to add a sense to Watch without forking DSH,
 * patching Watch Core, or asking anyone. What they cannot do — by shape and by
 * runtime sanitization, because either alone would fail — is assert that their
 * own output was observed, current or proven.
 *
 * @module @watchskill/dsh-sdk
 */

export * from './capability.js'
export * from './example.js'
