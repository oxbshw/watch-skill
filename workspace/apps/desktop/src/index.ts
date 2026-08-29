/**
 * Watch Desktop, as testable modules.
 *
 * `main.ts` is the Electron entry point and is deliberately thin: everything
 * it decides is decided here, where it can be exercised without a display
 * server. That split is what makes the security posture assertable rather than
 * reviewable.
 *
 * @module @watchskill/watch-desktop
 */

export * from './security.js'
export * from './supervisor.js'
export * from './startup.js'
export * from './vault.js'
export * from './updates.js'
export * from './capabilities.js'
