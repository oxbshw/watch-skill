/**
 * A capture source that observes only what this workspace made.
 *
 * The end-to-end capture test needs a real source: something that genuinely
 * starts, genuinely emits timestamped observations, and genuinely releases what
 * it held. Pointing that test at a screen or a camera would capture whatever
 * happened to be in front of the person running it — their email, their
 * terminal, their face — and put it in a fixture directory. That is not a test
 * anyone should run twice.
 *
 * So the source generates its own content on a deterministic clock and observes
 * that. It exercises every state the real adapters do — probe, permission,
 * start, emit, stop, teardown — while reading nothing it did not write.
 *
 * It is not a mock of an adapter. It is an adapter, of a source that happens to
 * be synthetic, which is why the lifecycle it exercises is the real one.
 *
 * @module @deepwatch/dsh-live/synthetic-source
 */

import { observationAt } from './capture.js'
import type { CaptureAdapter, Observation, SourceAvailability } from './capture.js'
import { syntheticAvailability } from './sources-catalogue.js'

export interface SyntheticOptions {
  /** Lines to emit, in order. The content this source will observe. */
  readonly script: readonly string[]
  /** Milliseconds between emissions. Small so tests stay fast. */
  readonly intervalMs?: number
  /** Refuse permission, to exercise the denial path. */
  readonly refusePermission?: boolean
  /** Report unavailable, to exercise the missing-source path. */
  readonly unavailable?: string
  /** Throw on start, to exercise the failure path. */
  readonly failOnStart?: boolean
  /** Never signal started, to exercise the timeout path. */
  readonly hangOnStart?: boolean
  readonly now?: () => Date
}

/**
 * A source that writes its own content and then observes it.
 *
 * `emitted` and `released` are exposed so a test can assert the things that
 * matter most and are hardest to see: that every timer was cleared, and that
 * teardown ran exactly once however the session ended.
 */
export class SyntheticSource implements CaptureAdapter {
  readonly sourceId = 'synthetic'

  #options: SyntheticOptions
  #timer: ReturnType<typeof setInterval> | null = null
  #emitted = 0
  #releases = 0
  #base: Date | null = null
  #now: () => Date

  constructor(options: SyntheticOptions) {
    this.#options = options
    this.#now = options.now ?? (() => new Date())
  }

  /** How many observations it produced. */
  get emitted(): number { return this.#emitted }

  /** How many times teardown ran. Must never exceed one. */
  get releases(): number { return this.#releases }

  /** Whether anything is still scheduled. Must be false after any ending. */
  get running(): boolean { return this.#timer !== null }

  probe(): SourceAvailability {
    if (this.#options.unavailable !== undefined) {
      return { available: false, reason: this.#options.unavailable }
    }
    return syntheticAvailability()
  }

  requestPermission(): boolean {
    // A synthetic source still goes through the permission gate. Skipping it
    // because "it is only a fixture" would mean the lifecycle the test proves
    // is not the lifecycle that ships.
    return this.#options.refusePermission !== true
  }

  async start(emit: (observation: Observation) => void): Promise<void> {
    if (this.#options.failOnStart === true) throw new Error('the synthetic source was asked to fail')
    if (this.#options.hangOnStart === true) {
      // Resolve never. The session's own timeout is what has to save it, and
      // that is precisely what this exercises.
      return new Promise<void>(() => { /* intentionally never settles */ })
    }

    this.#base = this.#now()
    const interval = this.#options.intervalMs ?? 5
    let index = 0

    await new Promise<void>(resolve => {
      this.#timer = setInterval(() => {
        const line = this.#options.script[index]
        if (line === undefined) {
          this.#clear()
          return
        }
        emit(observationAt(this.#base ?? this.#now(), this.#now(), 'text', line, index))
        this.#emitted += 1
        index += 1
      }, interval)
      // Started means "producing", not "finished producing".
      resolve()
    })
  }

  stop(): void {
    this.#clear()
    this.#releases += 1
  }

  #clear(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer)
      this.#timer = null
    }
  }
}
