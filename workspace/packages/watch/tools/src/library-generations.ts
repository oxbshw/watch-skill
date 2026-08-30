/**
 * The Library index, and the only thing allowed to replace it.
 *
 * The host used to build its index once per process. Records written after
 * start were invisible until somebody restarted the application, and the
 * surface's rebuild control could not reach the host's index at all — so it
 * said "Search again", which was honest and useless. This is the capability
 * that makes it a real one.
 *
 * Four properties, and each exists because the obvious implementation gets it
 * wrong.
 *
 * **A rebuild is an explicit operation.** Not a flag on a search. A search that
 * might re-read the corpus is a search whose cost nobody can predict, and it
 * leaves a caller no way to say "answer from what you have".
 *
 * **One rebuild at a time, and callers join it.** Two people pressing Refresh
 * must not read the directory twice. A second caller waits on the first
 * rebuild and receives its outcome, which is also why a repeated request id
 * returns the recorded answer rather than starting anything.
 *
 * **Cancellation is by reference count.** A caller that stops waiting has
 * withdrawn, not cancelled — the work may still be wanted by somebody else.
 * The rebuild is abandoned when the last waiter leaves, and only then.
 *
 * **The swap is atomic and conditional.** The new index is built beside the
 * one in service and installed only when it is complete and healthy. A failed
 * or abandoned rebuild leaves the previous generation searchable, which is the
 * difference between a refresh that did not work and a Library that broke.
 *
 * @module @watchskill/dsh-tools/library-generations
 */

import type { LibraryIndex } from '@watchskill/dsh-library'
import type { LibraryIndexState } from '@watchskill/dsh-contracts/query/wire'

import { buildIndex, buildIndexCancellable } from './library-search.js'

/** One built index, and what is true about it. */
export interface IndexGeneration {
  /** Increments only when a healthy rebuild was swapped into service. */
  readonly generation: number
  readonly startedAt: string
  readonly completedAt: string | null
  readonly sourceCount: number
  readonly recordCount: number
  readonly indexState: LibraryIndexState
  /** By filename, never by path. */
  readonly skipped: readonly string[]
}

/** What a refresh did. Every one of these leaves a searchable Library. */
export type RefreshOutcome =
  | { readonly kind: 'refreshed', readonly index: IndexGeneration }
  | { readonly kind: 'cancelled', readonly index: IndexGeneration }
  | { readonly kind: 'failed', readonly reason: string, readonly index: IndexGeneration }

/** What the service needs to build an index and to timestamp what it built. */
export interface GenerationsConfig {
  readonly roots: readonly string[]
  /** Injected in tests so a generation record is comparable across runs. */
  readonly now?: () => string
  /** Injected in tests to exercise failure and slowness without a filesystem. */
  readonly build?: (
    roots: readonly string[], signal: AbortSignal,
  ) => Promise<{
    readonly index: LibraryIndex | null
    readonly skipped: readonly string[]
    readonly sourceCount: number
  }>
}

/** How many settled request ids are remembered for idempotency. */
const REMEMBERED_REQUESTS = 64

/** A rebuild in progress, and everyone waiting on it. */
interface InFlight {
  readonly promise: Promise<RefreshOutcome>
  readonly controller: AbortController
  /** Callers still waiting. The rebuild is abandoned when this reaches zero. */
  waiters: number
}

/** The index in service, and the one operation that may replace it. */
export class LibraryGenerations {
  readonly #config: GenerationsConfig
  #current: { readonly index: LibraryIndex, readonly meta: IndexGeneration } | null = null
  #inFlight: InFlight | null = null
  #settled = new Map<string, RefreshOutcome>()
  #nextGeneration = 1

  constructor(config: GenerationsConfig) {
    this.#config = config
  }

  /** The clock, injectable so a test can assert on a generation record. */
  #now(): string {
    return this.#config.now?.() ?? new Date().toISOString()
  }

  /**
   * The index searches answer from, built on first use.
   *
   * Lazy rather than eager: a profile that never opens the Library should not
   * pay for reading its evidence roots at boot.
   */
  index(): LibraryIndex {
    if (this.#current === null) {
      const startedAt = this.#now()
      const built = buildIndex(this.#config.roots)
      this.#current = {
        index: built.index,
        meta: this.#describe(this.#nextGeneration, startedAt, built.index, built.skipped),
      }
      this.#nextGeneration += 1
    }
    return this.#current.index
  }

  /** What is in service. Building it first if nothing is. */
  generation(): IndexGeneration {
    this.index()
    // `index()` above installs it, so this cannot be null. Reading through a
    // local keeps that obvious to the compiler as well as to a reader.
    const current = this.#current
    if (current === null) throw new Error('library: the index did not install')
    return current.meta
  }

  #describe(
    generation: number,
    startedAt: string,
    index: LibraryIndex,
    skipped: readonly string[],
  ): IndexGeneration {
    return {
      generation,
      startedAt,
      completedAt: this.#now(),
      sourceCount: this.#config.roots.length,
      recordCount: index.size,
      // The index's own word for its condition, mapped to the wire's. A
      // rebuild that read nothing is empty, not ready: an index nobody has
      // filled is not a complete answer to anything.
      indexState: index.size === 0 ? 'empty' : (index.health === 'ready' ? 'ready' : 'stale'),
      skipped,
    }
  }

  /**
   * Read the roots again and, if that succeeds, put the result into service.
   *
   * `requestId` makes the operation idempotent: a caller that retries after a
   * dropped connection gets the answer its first attempt produced rather than
   * a second read of the corpus. `signal` is that caller's withdrawal, not a
   * cancellation of the work — see the note on reference counting above.
   */
  async refresh(requestId: string, signal: AbortSignal): Promise<RefreshOutcome> {
    const remembered = this.#settled.get(requestId)
    if (remembered !== undefined) return remembered

    const flight = this.#inFlight ?? this.#start()
    flight.waiters += 1

    const withdraw = (): void => {
      flight.waiters -= 1
      // The last waiter leaving is what ends the work. While anybody is still
      // waiting, one caller's deadline is not everybody's.
      if (flight.waiters <= 0) flight.controller.abort()
    }
    if (signal.aborted) withdraw()
    else signal.addEventListener('abort', withdraw, { once: true })

    try {
      const outcome = await flight.promise
      this.#remember(requestId, outcome)
      return outcome
    } finally {
      if (!signal.aborted) signal.removeEventListener('abort', withdraw)
    }
  }

  /** Whether a rebuild is running. Reported to a surface as bounded progress. */
  rebuilding(): boolean {
    return this.#inFlight !== null
  }

  #remember(requestId: string, outcome: RefreshOutcome): void {
    this.#settled.set(requestId, outcome)
    // Bounded: a long-lived host must not accumulate one entry per refresh
    // anybody has ever asked for. Oldest first, which is insertion order.
    while (this.#settled.size > REMEMBERED_REQUESTS) {
      const oldest = this.#settled.keys().next()
      if (oldest.done === true) break
      this.#settled.delete(oldest.value)
    }
  }

  #start(): InFlight {
    const controller = new AbortController()
    const startedAt = this.#now()
    const build = this.#config.build ?? buildIndexCancellable
    // The generation in service before this ran, read now rather than after
    // the await. Every outcome below reports it, so a caller always learns
    // what it can still search.
    const previous = this.generation()

    // Declared before the body so the body can compare against it, and
    // assigned immediately after. `run` reads it only in its `finally`, which
    // cannot be reached before the first await.
    let flight: InFlight | null = null

    const run = async (): Promise<RefreshOutcome> => {
      try {
        const built = await build(this.#config.roots, controller.signal)
        if (built.index === null) return { kind: 'cancelled', index: previous }

        const meta = this.#describe(this.#nextGeneration, startedAt, built.index, built.skipped)
        this.#nextGeneration += 1
        // The swap. One assignment, after the new index is complete, so no
        // search can ever observe a half-built one.
        this.#current = { index: built.index, meta }
        return { kind: 'refreshed', index: meta }
      } catch (cause) {
        return {
          kind: 'failed',
          // The message and nothing else: a stack or an errno string would
          // name the host's directories.
          reason: cause instanceof Error ? cause.message : 'the rebuild failed',
          index: previous,
        }
      } finally {
        // Only if this is still the current flight. A later refresh that has
        // already started must not be cleared by an earlier one finishing.
        if (this.#inFlight === flight) this.#inFlight = null
      }
    }

    flight = { controller, waiters: 0, promise: run() }
    this.#inFlight = flight
    return flight
  }
}
