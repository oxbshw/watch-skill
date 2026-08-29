/**
 * Watch records inside the DeepSeek Harness Trajectory.
 *
 * The authority boundaries this package exists to hold:
 *
 * - **DSH owns the session and its event log.** There is no Watch event store.
 *   Every record here is a projection over the events DSH already recorded.
 * - **Watch Core owns evidence and verdicts.** A record carries the ids; the
 *   content is resolved from Core when someone opens it.
 * - **Watch Memory stays separate from evidence.** Memory records show that
 *   memory influenced a turn and which record did it. They are not evidence
 *   and cannot be cited as any.
 *
 * @module @watchskill/dsh-trajectory
 */

export * from './events.js'
export * from './selection.js'
export * from './projection.js'
export * from './selection-store.js'
export * from './definition.js'
export * from './compare.js'
