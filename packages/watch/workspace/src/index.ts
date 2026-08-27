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
