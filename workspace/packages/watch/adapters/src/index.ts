/**
 * Optional adapters.
 *
 * Both are optional in the strong sense: Watch is complete without either, and
 * neither can become an authority for anything. Content that arrives through
 * an adapter is imported at the weakest origin there is.
 *
 * @module @watchskill/dsh-adapters
 */

export * from './obsidian.js'
export * from './llmwiki.js'
