/**
 * The sources Live can offer, and what each one honestly is.
 *
 * A source appears here whether or not this machine can run it, because a
 * catalogue that hid unavailable sources would answer the wrong question: a
 * person wants to know what the product can observe *and* why it cannot observe
 * it here. Hiding the second is how "the feature does not exist" and "your
 * machine cannot do it" become indistinguishable.
 *
 * Two entries deserve their separation. **Browser Observer** watches a page and
 * records what it showed; **Browser Operator** acts on one and returns a
 * receipt for what it did. They are listed apart because they are apart: one
 * capability that covered both would grant the power to act while a person
 * believed they were enabling the power to watch, and no amount of wording in a
 * tooltip fixes a control that does two things.
 *
 * @module @deepwatch/dsh-live/sources-catalogue
 */

import type { SourceAvailability } from './capture.js'

/** How a source is reached, which decides what it needs to run. */
export type SourceRuntime =
  /** Provided by the browser or the Electron shell. */
  | 'shell'
  /** A device attached to this machine. */
  | 'device'
  /** A process this machine starts. */
  | 'process'
  /** Synthetic, for tests. Talks to nothing. */
  | 'fixture'

export interface LiveSource {
  readonly id: string
  readonly name: string
  /** What it observes, in a sentence. */
  readonly what: string
  /** When it would ask, so nobody is surprised by a prompt. */
  readonly asks: string
  readonly runtime: SourceRuntime
  /** Whether using it needs an OS permission at all. */
  readonly needsOsPermission: boolean
  /**
   * Whether it can act on the world rather than only record it.
   *
   * Exactly one source is `true`, and it is the one whose name says so.
   */
  readonly canAct: boolean
}

export const SOURCES: readonly LiveSource[] = [
  {
    id: 'screen',
    name: 'Screen',
    what: 'The whole display, as a continuous observation.',
    asks: 'Asks for screen-capture permission the first time you start it.',
    runtime: 'shell',
    needsOsPermission: true,
    canAct: false,
  },
  {
    id: 'window',
    name: 'Window',
    what: 'One application window rather than the whole display.',
    asks: 'Asks for screen-capture permission the first time you start it.',
    runtime: 'shell',
    needsOsPermission: true,
    canAct: false,
  },
  {
    id: 'camera',
    name: 'Camera',
    what: 'Live visual input from an attached device.',
    asks: 'Asks for camera permission the first time you start it.',
    runtime: 'device',
    needsOsPermission: true,
    canAct: false,
  },
  {
    id: 'microphone',
    name: 'Microphone',
    what: 'Live audio, with timings a citation can point at.',
    asks: 'Asks for microphone permission the first time you start it.',
    runtime: 'device',
    needsOsPermission: true,
    canAct: false,
  },
  {
    id: 'browser-observer',
    name: 'Browser Observer',
    what: 'Watches a page and records what it showed. Takes no action.',
    asks: 'No OS permission. Needs the browser runtime enabled.',
    runtime: 'process',
    needsOsPermission: false,
    canAct: false,
  },
  {
    id: 'browser-operator',
    name: 'Browser Operator',
    what: 'Acts on a page and returns a receipt for what it did. A separate capability from observing.',
    asks: 'No OS permission. Needs the browser runtime enabled, and every side effect carries an idempotency key.',
    runtime: 'process',
    needsOsPermission: false,
    canAct: true,
  },
  {
    id: 'synthetic',
    name: 'Synthetic source',
    what: 'A task-owned page this workspace generates, for exercising capture without touching anything of yours.',
    asks: 'No permission. It observes only content this workspace created.',
    runtime: 'fixture',
    needsOsPermission: false,
    canAct: false,
  },
]

/** One source by id, or undefined. */
export function sourceById(id: string): LiveSource | undefined {
  return SOURCES.find(source => source.id === id)
}

/**
 * A short, honest word for how a source stands right now.
 *
 * Availability is a runtime fact, so the catalogue never claims it. Without an
 * adapter's probe, the truthful answer is that nothing has been started —
 * which is different from unavailable, and different again from broken.
 */
export function describeAvailability(availability?: SourceAvailability): string {
  if (availability === undefined) return 'Not started'
  return availability.available ? 'Available' : availability.reason
}

/**
 * The synthetic adapter's availability.
 *
 * Always available, because it invents its own content and reaches nothing.
 * This is the source the end-to-end capture test uses: exercising the real
 * lifecycle without capturing a single pixel of anybody's actual screen.
 */
export function syntheticAvailability(): SourceAvailability {
  return { available: true, reason: '' }
}
