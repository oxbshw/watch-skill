/**
 * `watchCore` — the Host-side Cordis service that owns the Bridge to Watch Core.
 *
 * Everything Watch can perceive, prove or remember reaches DeepSeek Harness
 * through this one service. It owns connection lifecycle, protocol
 * negotiation, capability truth, deadlines, cancellation and correlation; it
 * deliberately owns no domain knowledge, because the Bridge must never become
 * a second store of truth (ADR-004).
 *
 * The failure posture matters as much as the happy path: a Watch Core that
 * will not start leaves the Workspace fully usable with Watch features
 * disabled and a stated fix. It never blocks boot.
 *
 * @module @watchskill/dsh-core-bridge
 */

import { randomUUID } from 'node:crypto'
import { type Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import type {
  BridgePhase,
  CapabilityTruth,
  HandshakeResult,
  WatchCoreHealth,
  WatchError,
  WatchResult,
} from '@watchskill/dsh-contracts'
import {
  WATCH_PROTOCOL_VERSION,
  detectSchemaDrift,
  isContractUnverified,
  watchError,
} from '@watchskill/dsh-contracts'
import type { Transport } from './transport.js'
import { MockTransport } from './transport/mock.js'
import { StdioTransport } from './transport/stdio.js'

export type * from './transport.js'
export { MockTransport } from './transport/mock.js'
export { StdioTransport } from './transport/stdio.js'

/** Deployment configuration for the Bridge. */
export interface Config {
  /**
   * How to reach Watch Core.
   *
   * `auto` (the default) tries the local engine and falls back to the mock
   * backend only when the command is genuinely not installed. That is the
   * difference that makes an automatic default acceptable: a machine without
   * Watch Core gets a working Workspace and an invitation to install it, while
   * a Watch Core that *is* present and fails is reported as a fault rather
   * than hidden behind a mock that answers nothing.
   *
   * `stdio` and `mock` pin the choice for a deployment that has already made
   * it.
   */
  readonly transport: 'auto' | 'stdio' | 'mock'
  /** Executable that starts Watch Core in Bridge mode. */
  readonly command: string
  readonly args: string[]
  /** Working directory for the child. Empty inherits the Host's. */
  readonly cwd: string
  readonly startupTimeoutMs: number
  /** Deadline applied to a request that does not carry its own. */
  readonly requestTimeoutMs: number
  /** Connect during plugin activation rather than on first use. */
  readonly autoConnect: boolean
  /**
   * Consecutive connection failures before the Bridge stops trying.
   *
   * Reaching this opens the circuit: further requests fail immediately with
   * `bridge.unavailable` and a `retryAfterMs`, and no Watch Core process is
   * started until the cooldown elapses.
   */
  readonly failuresBeforeOpen: number
  /** First cooldown after the circuit opens. Doubles on each further failure. */
  readonly initialCooldownMs: number
  /** Ceiling for the cooldown, so backoff cannot grow without bound. */
  readonly maxCooldownMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Bridge to Watch Core: perception, evidence and verification. */
    watchCore: WatchCoreService
  }
}

/** Options a caller may attach to one Bridge request. */
export interface RequestOptions {
  /** Overrides the configured default deadline. */
  readonly deadlineMs?: number
  /** Reuses an existing correlation id instead of minting one. */
  readonly correlationId?: string
  /** Cancels the wait, and asks Core to stop the work. */
  readonly signal?: AbortSignal
}

/** Extra fields every side-effecting Bridge command must carry (ADR-004). */
export interface SideEffectEnvelope {
  readonly operationId: string
  readonly idempotencyKey: string
  readonly inputDigest: string
  readonly expectedResourceVersion?: string
  readonly approvalId?: string
}

/** Health of a Bridge that has not been connected. */
const DISCONNECTED: WatchCoreHealth = Object.freeze({
  phase: 'disconnected',
  transport: null,
  handshake: null,
  error: null,
  changedAt: new Date(0).toISOString(),
})

/** The Bridge between DeepSeek Harness and Watch Core. */
export class WatchCoreService extends Service {
  /** Loader validation for the Bridge's deployment-varying values. */
  static Config: s<Config> = s.object({
    transport: s.union(['auto', 'stdio', 'mock'] as const).default('auto'),
    command: s.string().default('watch-skill'),
    args: s.array(s.string()).default(['bridge']),
    cwd: s.string().default(''),
    startupTimeoutMs: s.number().step(1).min(100).default(10_000),
    requestTimeoutMs: s.number().step(1).min(100).default(30_000),
    autoConnect: s.boolean().default(true),
    failuresBeforeOpen: s.number().step(1).min(1).default(3),
    initialCooldownMs: s.number().step(1).min(1).default(1_000),
    maxCooldownMs: s.number().step(1).min(1).default(30_000),
  })

  private transport: Transport | null = null
  private state: WatchCoreHealth = DISCONNECTED
  /** In flight so concurrent callers share one attempt instead of racing. */
  private connecting: Promise<WatchResult<HandshakeResult>> | null = null
  private readonly healthListeners = new Set<(health: WatchCoreHealth) => void>()
  private admitting = true
  /**
   * Capabilities withheld because their contract family drifted.
   *
   * Held separately from the handshake so {@link isCapable} can refuse one
   * capability without every caller re-deriving which families it needs.
   */
  private driftAffected = new Set<string>()

  /**
   * The reconnect breaker.
   *
   * Every request made while the Bridge is not ready reconnects, so an engine
   * that fails on contact used to mean a fresh Watch Core process per request.
   * Disposing the abandoned transport stopped them accumulating; it did not
   * stop the churn. Counting consecutive failures and refusing to spawn during
   * the cooldown does.
   */
  private consecutiveFailures = 0
  /** When the cooldown ends, on the injected clock. Null while closed. */
  private openUntilMs: number | null = null
  /** The cooldown the next failure will apply, doubling to the ceiling. */
  private cooldownMs = 0
  /** True while the one probe a cooldown expiry allows is in flight. */
  private probing = false
  /** Injected so tests do not sleep. */
  private readonly now: () => number

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'watchCore')

    // A clock the tests can drive. `WATCH_BRIDGE_CLOCK` is read only when a
    // test installs one; production always gets `Date.now`.
    const injected = (globalThis as { __watchBridgeClock__?: () => number }).__watchBridgeClock__
    this.now = typeof injected === 'function' ? injected : () => Date.now()

    // Teardown is registered up front so an activation that fails partway
    // still releases the child process it may have spawned.
    ctx.effect(() => async () => {
      this.admitting = false
      this.healthListeners.clear()
      const transport = this.transport
      this.transport = null
      this.connecting = null
      await transport?.dispose()
    }, 'watch-core-bridge: transport lifecycle')

    if (config.autoConnect) {
      // Boot is not blocked on Watch Core. A failure is recorded in health and
      // rendered as a disabled capability with a fix, never as a boot error.
      void this.connect()
    }
  }

  /** Current Bridge health. Always safe to read, including before connect. */
  health(): WatchCoreHealth {
    return this.state
  }

  /** Capability truth from the last successful handshake. */
  capabilities(): readonly CapabilityTruth[] {
    return this.state.handshake?.capabilities ?? []
  }

  /**
   * Whether one capability is usable right now.
   *
   * `probed` is deliberately excluded: a reachable endpoint is not a
   * successful request, and a surface that treats it as one will eventually
   * offer a button that fails.
   */
  isCapable(capabilityId: string): boolean {
    if (this.state.phase !== 'ready' && this.state.phase !== 'degraded') return false
    // A capability whose contract family drifted is not usable, whatever
    // the engine says about it: the two sides disagree on what its payload
    // means, so a successful call would return something unreadable.
    if (this.driftAffected.has(capabilityId)) return false
    const truth = this.capabilities().find(entry => entry.capabilityId === capabilityId)
    return truth?.status === 'machine_tested' || truth?.status === 'implemented'
  }

  /** Subscribe to health changes; returns an unsubscribe function. */
  onHealthChange(listener: (health: WatchCoreHealth) => void): () => void {
    this.healthListeners.add(listener)
    return () => { this.healthListeners.delete(listener) }
  }

  /**
   * Connect and negotiate, or return the outcome of the attempt already
   * running. Repeated calls never spawn a second Core.
   */
  connect(): Promise<WatchResult<HandshakeResult>> {
    if (!this.admitting) {
      return Promise.resolve(watchError(
        'bridge.disposed',
        'The Bridge is shutting down.',
        'Reload the Workspace to reconnect Watch Core.',
      ))
    }
    if (this.state.phase === 'ready' && this.state.handshake !== null) {
      return Promise.resolve({ ok: true, value: this.state.handshake })
    }
    // Refuse during the cooldown rather than starting another engine. The
    // caller gets the reason and when to try again, not a timeout.
    if (this.openUntilMs !== null && this.connecting === null) {
      const remaining = this.openUntilMs - this.now()
      if (remaining > 0) {
        return Promise.resolve(this.unavailable(remaining))
      }
      // Cooldown elapsed: exactly one probe is allowed through, and the
      // single-flight below is what keeps it to one.
      this.probing = true
    }

    this.connecting ??= this.runConnect()
      .then((result) => {
        if (result.ok) this.onConnected()
        else this.onConnectFailed()
        return result
      }, (error: unknown) => {
        this.onConnectFailed()
        throw error
      })
      .finally(() => { this.connecting = null; this.probing = false })
    return this.connecting
  }

  /**
   * Issue one read-only Bridge request.
   *
   * A read is idempotent by definition, so this path may be retried by the
   * caller. Side effects must go through {@link command}, which will not let
   * that happen by accident.
   */
  async request<T>(
    method: string,
    params: unknown = {},
    options: RequestOptions = {},
  ): Promise<WatchResult<T>> {
    const ready = await this.ensureReady()
    if (!ready.ok) return ready
    const transport = this.transport
    if (transport === null) {
      return watchError(
        'bridge.not_connected',
        'The Bridge lost its connection to Watch Core.',
        'Reconnect Watch Core from Settings → Watch, then retry.',
        { retryable: true },
      )
    }
    const result = await transport.send<T>({
      method,
      params,
      deadlineMs: options.deadlineMs ?? this.config.requestTimeoutMs,
      correlationId: options.correlationId ?? randomUUID(),
      signal: options.signal ?? new AbortController().signal,
    })
    // A completed request is the only proof the engine works, so it is what
    // clears the reconnect backoff.
    if (result.ok) this.onHealthy()
    return result
  }

  /**
   * Issue one side-effecting Bridge command.
   *
   * The envelope is required rather than optional because the reconnect path
   * needs it: on reconnection Core replays the same receipt for a known
   * `idempotencyKey`, or reports a conflict. A command without one could only
   * be recovered by reissuing it, which is exactly the blind retry the product
   * forbids.
   */
  command<T>(
    method: string,
    params: Record<string, unknown>,
    envelope: SideEffectEnvelope,
    options: RequestOptions = {},
  ): Promise<WatchResult<T>> {
    return this.request<T>(method, { ...params, ...envelope }, options)
  }

  /** Bring the Bridge up, negotiate the protocol, and record the outcome. */
  private async runConnect(): Promise<WatchResult<HandshakeResult>> {
    // Release the previous backend before replacing it.
    //
    // Reconnecting is reached from `ensureReady`, so any request issued
    // while the Bridge is not ready comes through here. Overwriting
    // `this.transport` without disposing the old one orphaned a live Watch
    // Core process — and against an engine that fails on contact, that is
    // one orphaned process per request, growing without bound. The teardown
    // effect only ever sees the newest one.
    const previous = this.transport
    this.transport = null
    if (previous !== null) await previous.dispose()

    let transport = this.createTransport()
    this.transport = transport
    this.publish({ phase: 'connecting', transport: transport.kind, handshake: null, error: null })

    transport.onFailure((error) => {
      this.publish({ phase: 'failed', error })
      this.onTransportFailure(error)
    })

    let connected = await transport.connect()
    let notInstalled: WatchError | null = null

    if (!connected.ok
      && this.config.transport === 'auto'
      && connected.error.error === 'bridge.core_not_installed') {
      // The engine is genuinely absent, not broken. Fall back so the Workspace
      // is fully usable, and carry the reason forward so the UI can say what
      // to install rather than showing capabilities that quietly do nothing.
      notInstalled = connected.error
      await transport.dispose()
      transport = new MockTransport()
      this.transport = transport
      this.publish({ phase: 'connecting', transport: transport.kind, error: null })
      connected = await transport.connect()
    }

    if (!connected.ok) {
      this.publish({ phase: 'failed', error: connected.error })
      return connected
    }

    const handshake = await transport.send<HandshakeResult>({
      method: 'watch.handshake',
      params: { protocolVersion: WATCH_PROTOCOL_VERSION },
      deadlineMs: this.config.startupTimeoutMs,
      correlationId: randomUUID(),
      signal: new AbortController().signal,
    })
    if (!handshake.ok) {
      this.publish({ phase: 'failed', error: handshake.error })
      return handshake
    }

    const negotiated = handshake.value.protocolVersion
    if (negotiated > WATCH_PROTOCOL_VERSION || negotiated < 1) {
      // Only the Watch features are lost. DSH itself stays fully usable, which
      // is why this is a degraded phase and not a failure.
      const error: WatchError = {
        error: 'bridge.protocol_mismatch',
        message:
          `Watch Core negotiated protocol ${String(negotiated)}, but this Workspace speaks `
          + `${String(WATCH_PROTOCOL_VERSION)}.`,
        fix: 'Update Watch Core or the Workspace so their protocol versions match.',
        details: { coreProtocol: negotiated, workspaceProtocol: WATCH_PROTOCOL_VERSION },
        retryable: false,
        correlationId: null,
      }
      this.publish({ phase: 'degraded', handshake: handshake.value, error })
      return { ok: false, error }
    }

    // Contract drift is checked after the protocol, because a matching
    // protocol version says only that both sides speak the same *shape* of
    // conversation, not that they agree on what is in it.
    //
    // The "published nothing" case is checked first, and it has to be: an
    // empty map drifts against every family, so testing for drift first would
    // report a Watch Core older than this check as six mismatches and take
    // every capability offline — breaking a working setup to enforce a check
    // that version predates.
    this.driftAffected = new Set()

    if (notInstalled !== null) {
      // Ready on the mock backend: the Workspace works, every capability
      // honestly reports `not_tested`, and the error carries the install step.
      this.publish({ phase: 'ready', handshake: handshake.value, error: notInstalled })
      return handshake
    }

    if (isContractUnverified(handshake.value.schemaDigests)) {
      this.publish({
        phase: 'ready',
        handshake: handshake.value,
        error: {
          error: 'bridge.contract_unverified',
          message:
            'Watch Core published no contract digests, so its wire could not be checked '
            + 'against this build.',
          fix: 'Update Watch Core to a version that publishes schemas/bridge/manifest.json.',
          details: {},
          retryable: false,
          correlationId: null,
        },
      })
      return handshake
    }

    const drift = detectSchemaDrift(handshake.value.schemaDigests)
    if (drift.length > 0) {
      const families = drift.map(entry => entry.family).join(', ')
      const affected = [...new Set(drift.flatMap(entry => entry.affects))]
      const error: WatchError = {
        error: 'bridge.schema_drift',
        message:
          `Watch Core's contract differs from this Workspace's build for: ${families}. `
          + `${affected.length} capability(ies) are unavailable until they match.`,
        fix: 'Update Watch Core or the Workspace so their contract versions match.',
        details: {
          drift: drift.map(entry => ({
            family: entry.family,
            expected: entry.expected,
            actual: entry.actual,
          })),
          affectedCapabilities: affected,
        },
        retryable: false,
        correlationId: null,
      }
      this.driftAffected = new Set(affected)
      // Degraded, not failed: the families that still agree keep working, and
      // the Workspace itself is entirely unaffected.
      this.publish({ phase: 'degraded', handshake: handshake.value, error })
      return handshake
    }

    this.publish({ phase: 'ready', handshake: handshake.value, error: null })
    return handshake
  }

  /**
   * A refusal that names when the Bridge will try again.
   *
   * `retryAfterMs` is what makes this different from a timeout: the caller
   * can wait the stated time instead of retrying into a closed door, and a UI
   * can say when rather than only that.
   */
  private unavailable(retryAfterMs: number): WatchResult<never> {
    return watchError(
      'bridge.unavailable',
      `Watch Core failed to start ${String(this.consecutiveFailures)} time(s) in a row, `
      + 'so the Bridge has stopped trying for now.',
      'Check the Watch Core installation with `watch-skill doctor`. '
      + 'The Bridge will try again on its own.',
      { retryable: true, details: { retryAfterMs: Math.ceil(retryAfterMs) } },
    )
  }

  /**
   * A handshake succeeded, so let this session proceed.
   *
   * The counters are deliberately not cleared here. A handshake proves the
   * engine started, not that it works: an engine that handshakes cleanly and
   * then fails every request would reset the backoff on each reconnect and
   * spawn once per request forever, which is the churn this exists to stop.
   * Clearing is left to `onHealthy`, which a completed request calls.
   */
  private onConnected(): void {
    this.openUntilMs = null
  }

  /** A request completed, so the engine is working. Forget the outage. */
  private onHealthy(): void {
    this.consecutiveFailures = 0
    this.openUntilMs = null
    this.cooldownMs = 0
  }

  /**
   * A connection attempt failed.
   *
   * A failure during the half-open probe re-opens the circuit immediately and
   * doubles the wait, so an engine that is still broken is not probed at the
   * same rate the caller happens to be asking.
   */
  /**
   * The transport failed after a handshake had already succeeded.
   *
   * This is the case the breaker exists for. A protocol violation is marked
   * non-retryable because it is: the engine and this Workspace cannot talk to
   * each other, and starting the same engine again produces the same frame.
   * Counting it toward a threshold would still spawn twice more first, so it
   * opens the circuit on the spot. A crash is different -- the engine may
   * come back -- so that one counts.
   */
  private onTransportFailure(error: WatchError): void {
    if (error.retryable) {
      this.onConnectFailed()
      return
    }
    this.consecutiveFailures = Math.max(this.consecutiveFailures + 1, this.config.failuresBeforeOpen)
    this.cooldownMs = this.cooldownMs === 0
      ? this.config.initialCooldownMs
      : Math.min(this.cooldownMs * 2, this.config.maxCooldownMs)
    this.openUntilMs = this.now() + this.cooldownMs
  }

  private onConnectFailed(): void {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures < this.config.failuresBeforeOpen && !this.probing) return
    this.cooldownMs = this.cooldownMs === 0
      ? this.config.initialCooldownMs
      : Math.min(this.cooldownMs * 2, this.config.maxCooldownMs)
    this.openUntilMs = this.now() + this.cooldownMs
  }

  /**
   * What the breaker is doing, for Diagnostics.
   *
   * Counts and timings only. Nothing here carries a command line, a path or
   * an environment value, so it is safe to render and safe to log.
   */
  get reconnectState(): {
    readonly consecutiveFailures: number
    readonly circuitOpen: boolean
    readonly retryAfterMs: number
    readonly cooldownMs: number
  } {
    const remaining = this.openUntilMs === null ? 0 : Math.max(0, this.openUntilMs - this.now())
    return {
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: remaining > 0,
      retryAfterMs: Math.ceil(remaining),
      cooldownMs: this.cooldownMs,
    }
  }

  /** Connect on demand for callers that did not wait for auto-connect. */
  private async ensureReady(): Promise<WatchResult<HandshakeResult>> {
    if (this.state.phase === 'ready' && this.state.handshake !== null) {
      return { ok: true, value: this.state.handshake }
    }
    return this.connect()
  }

  /** Build the configured backend. */
  private createTransport(): Transport {
    if (this.config.transport === 'mock') return new MockTransport()
    // 'auto' optimistically attempts the real engine; runConnect falls back
    // to the mock only when the command turns out not to be installed.
    return new StdioTransport({
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd === '' ? undefined : this.config.cwd,
      env: undefined,
      startupTimeoutMs: this.config.startupTimeoutMs,
    })
  }

  /** Apply a health change and notify subscribers exactly once. */
  private publish(patch: Partial<Omit<WatchCoreHealth, 'changedAt'>> & { phase: BridgePhase }): void {
    this.state = Object.freeze({
      phase: patch.phase,
      transport: patch.transport ?? this.state.transport,
      handshake: patch.handshake === undefined ? this.state.handshake : patch.handshake,
      error: patch.error === undefined ? this.state.error : patch.error,
      changedAt: new Date().toISOString(),
    })
    for (const listener of this.healthListeners) listener(this.state)
  }
}

export default WatchCoreService
