/**
 * The Memory product surfaces.
 *
 * Pure view models over records and events. The ledger lives in
 * `@watchskill/dsh-memory` and stays there — a browser half that could write
 * to it would be a second writer, and a second writer is how a ledger stops
 * being an authority.
 *
 * @module @watchskill/dsh-client-memory
 */

export * from './views.js'
