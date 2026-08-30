/**
 * The live capture lifecycle.
 *
 * A session is a small state machine, and writing it as one is the point: every
 * way a capture can end — stopped, cancelled, timed out, denied, failed, the
 * source disappearing underneath it — is a named state with a named transition
 * rather than an early return somewhere. The states that get skipped in ad-hoc
 * implementations are exactly the ones that leak: a cancel during startup, a
 * source vanishing mid-stream, a stop arriving twice.
 *
 * Three rules hold the design together.
 *
 * **Permission is never implied.** A session moves `idle → requested →
 * granted` only through an explicit call that a user action caused. Nothing in
 * construction, discovery or rendering asks for anything; a prompt on page load
 * teaches people to allow without reading, and after that the prompt means
 * nothing.
 *
 * **Observing is not operating.** The browser appears twice in the source
 * catalogue because watching a page and acting on one carry different
 * consequences. A single capability would grant the second while a person
 * believed they were enabling the first.
 *
 * **Stopping always releases.** `stop`, `cancel`, `fail` and `timeout` all run
 * the same teardown, exactly once, whatever order they arrive in. A capture
 * that leaks a handle on the unhappy path leaks it on the path that actually
 * happens.
 *
 * @module @deepwatch/dsh-live/capture
 */

/** Where a session is. Every terminal state is reachable and named. */
export type CaptureState =
  | 'idle'
  | 'requesting_permission'
  | 'starting'
  | 'active'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'cancelled'
  | 'denied'
  | 'unavailable'
  | 'timed_out'
  | 'failed'

/** Whether the person has agreed, and whether they were ever asked. */
export type PermissionState = 'not_requested' | 'requested' | 'granted' | 'denied'

/** One thing the source produced, with the clock that makes it citable. */
export interface Observation {
  readonly observationId: string
  /** ISO-8601. An observation without a time cannot be cited. */
  readonly at: string
  readonly kind: 'frame' | 'audio' | 'text' | 'event'
  /** What was observed. Verbatim; never a summary. */
  readonly text: string
  /** Milliseconds from the session's start, for a relative timeline. */
  readonly offsetMs: number
}

/** The receipt a finished session leaves behind. */
export interface CaptureReceipt {
  readonly sessionId: string
  readonly sourceId: string
  readonly runId: string | null
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly finalState: CaptureState
  readonly observationCount: number
  /** Why it ended, in words. Empty for an ordinary stop. */
  readonly reason: string
  /**
   * Evidence minted from this session, if any.
   *
   * Always empty here. A capture produces observations; only Watch Core turns
   * an observation into evidence, and this module cannot and must not.
   */
  readonly evidenceIds: readonly string[]
}

/** A source's own view of itself, before anything has been started. */
export interface SourceAvailability {
  readonly available: boolean
  /** Why not, when not. Shown to a person, so it has to be actionable. */
  readonly reason: string
}

/**
 * What a real source has to provide.
 *
 * Deliberately tiny. An adapter that can be described in four methods can be
 * tested deterministically with a fake, which is what lets the lifecycle above
 * be exercised on a machine that has no camera.
 */
export interface CaptureAdapter {
  readonly sourceId: string
  /** Can this run here, now? Must not prompt and must not open anything. */
  probe(): Promise<SourceAvailability> | SourceAvailability
  /** Ask the person. Called only from an explicit user action. */
  requestPermission(): Promise<boolean> | boolean
  /** Begin producing. `emit` may be called until `stop` resolves. */
  start(emit: (observation: Observation) => void): Promise<void> | void
  /** Release everything. Must be safe to call more than once. */
  stop(): Promise<void> | void
}

export interface CaptureOptions {
  readonly sessionId: string
  readonly runId?: string | null
  /** Give up if the source has not started within this long. */
  readonly startTimeoutMs?: number
  /** Injected so tests are not slow and not flaky. */
  readonly now?: () => Date
}

const DEFAULT_START_TIMEOUT = 10_000

/** One live capture, from nothing to a receipt. */
export class CaptureSession {
  readonly sessionId: string
  readonly sourceId: string
  readonly runId: string | null

  #adapter: CaptureAdapter
  #state: CaptureState = 'idle'
  #permission: PermissionState = 'not_requested'
  #observations: Observation[] = []
  #startedAt: Date | null = null
  #endedAt: Date | null = null
  #reason = ''
  #now: () => Date
  #startTimeout: number
  #torndown = false
  #timer: ReturnType<typeof setTimeout> | null = null
  #listeners = new Set<(session: CaptureSession) => void>()

  constructor(adapter: CaptureAdapter, options: CaptureOptions) {
    this.#adapter = adapter
    this.sessionId = options.sessionId
    this.sourceId = adapter.sourceId
    this.runId = options.runId ?? null
    this.#now = options.now ?? (() => new Date())
    this.#startTimeout = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT
  }

  get state(): CaptureState { return this.#state }
  get permission(): PermissionState { return this.#permission }
  get observations(): readonly Observation[] { return this.#observations }
  get startedAt(): string | null { return this.#startedAt?.toISOString() ?? null }
  get reason(): string { return this.#reason }

  /** True once the session can no longer change state. */
  get finished(): boolean {
    return ['stopped', 'cancelled', 'denied', 'unavailable', 'timed_out', 'failed'].includes(this.#state)
  }

  subscribe(listener: (session: CaptureSession) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #announce(): void {
    for (const listener of this.#listeners) listener(this)
  }

  #settle(state: CaptureState, reason: string): void {
    if (this.finished) return
    this.#state = state
    this.#reason = reason
    this.#endedAt = this.#now()
    this.#announce()
  }

  /**
   * Ask whether the source can run here.
   *
   * Explicitly not a permission request. Probing must be safe to do while
   * rendering a list of sources, so an adapter that prompted here would make
   * merely opening the tab ask for the camera.
   */
  async probe(): Promise<SourceAvailability> {
    const availability = await this.#adapter.probe()
    if (!availability.available && this.#state === 'idle') {
      this.#state = 'unavailable'
      this.#reason = availability.reason
      this.#announce()
    }
    return availability
  }

  /**
   * Ask the person for permission.
   *
   * Called only from an explicit user action — that is the contract, and the
   * reason `start` refuses to do it implicitly.
   */
  async requestPermission(): Promise<boolean> {
    if (this.finished) return this.#permission === 'granted'
    this.#state = 'requesting_permission'
    this.#permission = 'requested'
    this.#announce()

    let granted = false
    try {
      granted = await this.#adapter.requestPermission()
    } catch (error) {
      this.#permission = 'denied'
      this.#settle('failed', `The permission request failed: ${String(error)}`)
      return false
    }

    if (!granted) {
      this.#permission = 'denied'
      this.#settle('denied', 'Permission was refused. Nothing was captured.')
      return false
    }
    this.#permission = 'granted'
    this.#state = 'idle'
    this.#announce()
    return true
  }

  /**
   * Begin capturing.
   *
   * Refuses without permission rather than requesting it. A start that silently
   * prompts is a start that can be triggered by something other than a person,
   * and the whole point of the boundary is that it cannot.
   */
  async start(): Promise<boolean> {
    if (this.finished) return false
    if (this.#permission !== 'granted') {
      this.#settle('denied', 'Start needs permission, and permission is only ever asked for by an explicit action.')
      return false
    }

    const availability = await this.#adapter.probe()
    if (!availability.available) {
      this.#settle('unavailable', availability.reason)
      return false
    }

    this.#state = 'starting'
    this.#startedAt = this.#now()
    this.#announce()

    // A source that never starts must not hold the session open forever.
    const timedOut = new Promise<'timeout'>(resolve => {
      this.#timer = setTimeout(() => { resolve('timeout') }, this.#startTimeout)
    })

    try {
      const outcome = await Promise.race([
        Promise.resolve(this.#adapter.start(observation => { this.#record(observation) })).then(() => 'started' as const),
        timedOut,
      ])
      this.#clearTimer()

      // A cancel that arrived while we were starting wins. Without this check
      // the session would come back to life after the user stopped it.
      //
      // The adapter is stopped directly rather than through `#teardown`, and
      // that distinction is the whole fix for a real leak: the cancel already
      // ran teardown, so the once-guard is set — but it ran *before* the
      // adapter allocated anything, so it stopped nothing. Whatever `start`
      // just created would have been left running forever. The adapter
      // contract requires `stop` to be safe more than once precisely so this
      // case can be handled without tracking who allocated what.
      if (this.finished) {
        try {
          await this.#adapter.stop()
        } catch {
          // Nothing left to do: the session has already ended.
        }
        return false
      }
      if (outcome === 'timeout') {
        await this.#teardown()
        this.#settle('timed_out', `The source did not start within ${String(this.#startTimeout)}ms.`)
        return false
      }
    } catch (error) {
      this.#clearTimer()
      await this.#teardown()
      this.#settle('failed', `The source failed to start: ${String(error)}`)
      return false
    }

    this.#state = 'active'
    this.#announce()
    return true
  }

  /** Record an observation. Ignored unless the session is actually running. */
  #record(observation: Observation): void {
    if (this.#state !== 'active') return
    this.#observations.push(observation)
    this.#announce()
  }

  /** Stop producing without ending the session. */
  pause(): boolean {
    if (this.#state !== 'active') return false
    this.#state = 'paused'
    this.#announce()
    return true
  }

  resume(): boolean {
    if (this.#state !== 'paused') return false
    this.#state = 'active'
    this.#announce()
    return true
  }

  /** End normally. Safe to call twice; the second call is a no-op. */
  async stop(): Promise<CaptureReceipt> {
    if (!this.finished) {
      this.#state = 'stopping'
      this.#announce()
      await this.#teardown()
      this.#settle('stopped', '')
    }
    return this.receipt()
  }

  /**
   * End before it began, or during startup.
   *
   * Distinct from `stop` because the states differ for a person: a cancelled
   * capture produced nothing on purpose, a stopped one produced what it
   * produced.
   */
  async cancel(reason = 'Cancelled.'): Promise<CaptureReceipt> {
    if (!this.finished) {
      await this.#teardown()
      this.#settle('cancelled', reason)
    }
    return this.receipt()
  }

  /** The source went away underneath us. */
  async sourceLost(reason: string): Promise<CaptureReceipt> {
    if (!this.finished) {
      await this.#teardown()
      this.#settle('unavailable', reason)
    }
    return this.receipt()
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
  }

  /**
   * Release everything, exactly once.
   *
   * Every ending routes through here, and the guard is what makes that safe: a
   * stop racing a timeout would otherwise call the adapter's `stop` twice, and
   * an adapter is entitled to assume it is torn down once.
   */
  async #teardown(): Promise<void> {
    this.#clearTimer()
    if (this.#torndown) return
    this.#torndown = true
    try {
      await this.#adapter.stop()
    } catch {
      // A teardown that throws must not prevent the session from ending; the
      // alternative is a session stuck in `stopping` forever.
    }
  }

  /** What happened, in a form that outlives the session object. */
  receipt(): CaptureReceipt {
    return {
      sessionId: this.sessionId,
      sourceId: this.sourceId,
      runId: this.runId,
      startedAt: this.#startedAt?.toISOString() ?? null,
      endedAt: this.#endedAt?.toISOString() ?? null,
      finalState: this.#state,
      observationCount: this.#observations.length,
      reason: this.#reason,
      evidenceIds: [],
    }
  }
}

/** Build an observation with a clock, so it can be cited. */
export function observationAt(
  base: Date,
  now: Date,
  kind: Observation['kind'],
  text: string,
  index: number,
): Observation {
  return {
    observationId: `obs-${String(index)}`,
    at: now.toISOString(),
    kind,
    text,
    offsetMs: Math.max(0, now.getTime() - base.getTime()),
  }
}
