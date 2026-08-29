/**
 * The transport contract every Bridge backend implements.
 *
 * Keeping this narrow is what lets the mock, the local child process and a
 * future authenticated remote share one set of semantics. Everything the
 * product depends on — deadlines, cancellation, correlation, exactly one
 * terminal state — lives above this line, in the service, so a new backend
 * cannot accidentally weaken it.
 *
 * @module @watchskill/dsh-core-bridge/transport
 */

import type { WatchError, WatchResult } from '@watchskill/dsh-contracts'

/** How a transport identifies itself to the UI. The UI never guesses. */
export type TransportKind = 'stdio' | 'https' | 'mock'

/** One request as the service hands it to a transport. */
export interface TransportRequest {
  readonly method: string
  readonly params: unknown
  /** Milliseconds from dispatch. The transport must reject at this bound. */
  readonly deadlineMs: number
  /** Travels with the request so the same id appears in Core logs and receipts. */
  readonly correlationId: string
  /**
   * Aborting cancels the *wait*, and asks Core to cancel the work.
   *
   * For a side-effecting method that has already been dispatched, this can only
   * ever mean "cancel requested" — the caller must inspect the receipt to learn
   * what actually happened. The transport must never report a cancelled side
   * effect as though it did not run.
   */
  readonly signal: AbortSignal
}

/** A push from Watch Core that was not a response to a request. */
export interface TransportEvent {
  readonly method: string
  readonly params: unknown
}

/** Backend-specific connection behavior. */
export interface Transport {
  readonly kind: TransportKind

  /**
   * Bring the transport up far enough to accept requests.
   *
   * Resolves with an error result rather than throwing: a Core that will not
   * start is an expected, reportable condition, not an exception the Workspace
   * should crash on.
   */
  connect(): Promise<WatchResult<void>>

  /** Issue one request and resolve with its single terminal outcome. */
  send<T>(request: TransportRequest): Promise<WatchResult<T>>

  /** Subscribe to unsolicited events; returns an unsubscribe function. */
  subscribe(listener: (event: TransportEvent) => void): () => void

  /**
   * Observe transport-level failure — a child that exited, a socket that
   * dropped. Reported separately from a request failure so the service can
   * move the whole Bridge to `failed` instead of failing one call.
   */
  onFailure(listener: (error: WatchError) => void): () => void

  /** Release every resource this transport owns. Safe to call twice. */
  dispose(): Promise<void>
}
