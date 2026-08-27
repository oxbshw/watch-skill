/**
 * JSON-RPC 2.0 over stdio to a local Watch Core child process.
 *
 * This is the default local transport (ADR-004). stdio was chosen over a
 * loopback port precisely because it has nothing to secure: no port to bind,
 * no CORS to configure, no bootstrap secret to leak between Node and Python.
 * The child's stdin and stdout are the whole attack surface, and they belong
 * to the process that spawned them.
 *
 * Framing is LSP-style `Content-Length` headers rather than newline-delimited
 * JSON: Watch Core streams OCR text and transcripts, which contain newlines,
 * and a length-prefixed frame cannot be split by content.
 *
 * @module @watchskill/dsh-core-bridge/transport/stdio
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Buffer } from 'node:buffer'
import type { JsonRpcResponse, WatchError, WatchResult } from '@watchskill/dsh-contracts'
import { JSON_RPC, watchError } from '@watchskill/dsh-contracts'
import type { Transport, TransportEvent, TransportRequest } from '../transport.js'

/** Everything the transport needs to launch and talk to a Core process. */
export interface StdioTransportOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly env: Readonly<Record<string, string>> | undefined
  /** How long the child has to become writable before the connect fails. */
  readonly startupTimeoutMs: number
}

/** One request awaiting its single terminal outcome. */
interface Pending {
  readonly resolve: (result: WatchResult<never>) => void
  readonly method: string
  readonly correlationId: string
  /** Cleared exactly once, by whichever of deadline/abort/response wins. */
  settle: (() => void) | null
}

const HEADER_TERMINATOR = '\r\n\r\n'

/** Turn an unexpected value into a reportable error without losing its text. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Local child-process Bridge backend. */
export class StdioTransport implements Transport {
  readonly kind = 'stdio' as const

  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<(event: TransportEvent) => void>()
  private readonly failureListeners = new Set<(error: WatchError) => void>()
  private disposed = false
  /** Retained so a late exit can explain itself instead of reporting "null". */
  private lastStderr = ''

  constructor(private readonly options: StdioTransportOptions) {}

  connect(): Promise<WatchResult<void>> {
    if (this.child !== null) return Promise.resolve({ ok: true, value: undefined })

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(this.options.command, [...this.options.args], {
        cwd: this.options.cwd,
        env: this.options.env === undefined ? process.env : { ...process.env, ...this.options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (cause) {
      return Promise.resolve(this.spawnFailure(describe(cause)))
    }

    this.child = child
    child.stdout.on('data', (chunk: Buffer) => { this.receive(chunk) })
    // Core's stderr is diagnostics, never protocol. Keeping the tail lets a
    // non-zero exit report why instead of just reporting that it happened.
    child.stderr.on('data', (chunk: Buffer) => {
      this.lastStderr = (this.lastStderr + chunk.toString('utf8')).slice(-4096)
    })

    return new Promise<WatchResult<void>>((resolve) => {
      const timer = setTimeout(() => {
        finish(this.spawnFailure(
          `Watch Core did not start within ${String(this.options.startupTimeoutMs)}ms.`,
        ))
      }, this.options.startupTimeoutMs)

      let settled = false
      const finish = (result: WatchResult<void>): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      child.once('spawn', () => { finish({ ok: true, value: undefined }) })
      child.once('error', (cause) => { finish(this.spawnFailure(describe(cause))) })
      child.once('exit', (code, signal) => { this.handleExit(code, signal); finish(this.spawnFailure(
        `Watch Core exited during startup (${signal ?? `code ${String(code)}`}).`,
      )) })
    })
  }

  send<T>(request: TransportRequest): Promise<WatchResult<T>> {
    const child = this.child
    if (child === null || this.disposed) {
      return Promise.resolve(watchError(
        'bridge.not_connected',
        'The Bridge is not connected to Watch Core.',
        'Reconnect Watch Core from Settings → Watch, then retry.',
        { retryable: true, correlationId: request.correlationId },
      ))
    }
    if (request.signal.aborted) {
      return Promise.resolve(watchError(
        'bridge.cancelled',
        'The request was cancelled before it was sent.',
        'Reissue the request if you still need the result.',
        { correlationId: request.correlationId },
      ))
    }

    const id = this.nextId++
    return new Promise<WatchResult<T>>((resolve) => {
      const entry: Pending = {
        resolve: resolve as Pending['resolve'],
        method: request.method,
        correlationId: request.correlationId,
        settle: null,
      }

      const timer = setTimeout(() => {
        // A deadline is not evidence that the work did not happen. For a
        // side-effecting method the caller must inspect the receipt; the error
        // says so rather than inviting a blind retry.
        this.settle(id, watchError(
          'bridge.deadline_exceeded',
          `"${request.method}" did not return within ${String(request.deadlineMs)}ms.`,
          'Inspect the operation receipt before retrying; a dispatched side effect may still have run.',
          { details: { method: request.method }, retryable: false, correlationId: request.correlationId },
        ))
      }, request.deadlineMs)

      const onAbort = (): void => {
        // Ask Core to stop, then report *requested*, never "did not happen".
        this.notify('watch.cancel', { correlationId: request.correlationId })
        this.settle(id, watchError(
          'bridge.cancel_requested',
          `Cancellation was requested for "${request.method}".`,
          'Check the operation receipt to see whether the work had already taken effect.',
          { details: { method: request.method }, correlationId: request.correlationId },
        ))
      }
      request.signal.addEventListener('abort', onAbort, { once: true })

      entry.settle = () => {
        clearTimeout(timer)
        request.signal.removeEventListener('abort', onAbort)
      }
      this.pending.set(id, entry)

      const frame = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: request.method,
        params: request.params,
        // Correlation travels in the envelope so Core stamps it onto its own
        // logs, receipts and Trajectory records without the caller restating it.
        correlationId: request.correlationId,
      })
      const body = Buffer.from(frame, 'utf8')
      child.stdin.write(
        `Content-Length: ${String(body.byteLength)}${HEADER_TERMINATOR}`,
        (cause) => {
          if (cause) {
            this.settle(id, watchError(
              'bridge.write_failed',
              `Could not send "${request.method}" to Watch Core: ${describe(cause)}`,
              'Reconnect Watch Core and retry.',
              { retryable: true, correlationId: request.correlationId },
            ))
          }
        },
      )
      child.stdin.write(body)
    })
  }

  subscribe(listener: (event: TransportEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  onFailure(listener: (error: WatchError) => void): () => void {
    this.failureListeners.add(listener)
    return () => { this.failureListeners.delete(listener) }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    this.child = null
    this.eventListeners.clear()

    for (const id of [...this.pending.keys()]) {
      this.settle(id, watchError(
        'bridge.disposed',
        'The Bridge shut down before this request completed.',
        'Reconnect Watch Core and reissue the request.',
        { retryable: true },
      ))
    }
    this.failureListeners.clear()

    if (child === null || child.exitCode !== null) return
    child.stdin.end()
    await new Promise<void>((resolve) => {
      // Give Core a chance to flush receipts before it is killed: an audit
      // record lost at shutdown is the one class of data loss that cannot be
      // reconstructed afterwards.
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 2_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
      child.kill('SIGTERM')
    })
  }

  /** Send a notification. Failure is not reportable, so it is not pretended to be. */
  private notify(method: string, params: unknown): void {
    const child = this.child
    if (child === null || child.stdin.destroyed) return
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }), 'utf8')
    child.stdin.write(`Content-Length: ${String(body.byteLength)}${HEADER_TERMINATOR}`)
    child.stdin.write(body)
  }

  /** Accumulate bytes and drain every complete frame they contain. */
  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_TERMINATOR)
      if (headerEnd < 0) return
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const length = /content-length:\s*(\d+)/i.exec(header)
      if (length === null) {
        // An unframeable stream cannot be resynchronized by guessing where the
        // next frame starts, so the whole transport fails loudly instead.
        this.fail(watchError(
          'bridge.protocol_violation',
          'Watch Core sent a frame without a Content-Length header.',
          'Update Watch Core to a version matching this Workspace, then reconnect.',
          {},
        ).error)
        return
      }
      const bodyStart = headerEnd + HEADER_TERMINATOR.length
      const bodyEnd = bodyStart + Number(length[1])
      if (this.buffer.byteLength < bodyEnd) return
      const body = this.buffer.subarray(bodyStart, bodyEnd).toString('utf8')
      this.buffer = this.buffer.subarray(bodyEnd)
      this.dispatch(body)
    }
  }

  /** Route one decoded frame to its waiting request, or to event subscribers. */
  private dispatch(body: string): void {
    let message: JsonRpcResponse & { method?: string; params?: unknown }
    try {
      message = JSON.parse(body) as typeof message
    } catch (cause) {
      this.fail(watchError(
        'bridge.protocol_violation',
        `Watch Core sent a frame that is not valid JSON: ${describe(cause)}`,
        'Update Watch Core to a version matching this Workspace, then reconnect.',
        {},
      ).error)
      return
    }

    if (typeof message.method === 'string') {
      const event: TransportEvent = { method: message.method, params: message.params }
      for (const listener of this.eventListeners) listener(event)
      return
    }
    if (typeof message.id !== 'number') return
    const id = message.id

    if (message.error !== undefined) {
      const data = message.error.data
      // Core's own structured error is preserved verbatim when it sends one;
      // rewording it here would lose the `fix` the engine is best placed to give.
      const carried = isWatchError(data)
        ? { ok: false as const, error: data }
        : watchError(
          message.error.code === JSON_RPC.METHOD_NOT_FOUND
            ? 'bridge.method_not_found'
            : 'bridge.core_error',
          message.error.message,
          'Check the Watch Core version against this Workspace in Settings → Watch.',
          { details: { code: message.error.code } },
        )
      this.settle(id, carried)
      return
    }
    this.settle(id, { ok: true, value: message.result as never })
  }

  /** Deliver a request's one and only terminal outcome. */
  private settle(id: number, result: WatchResult<never>): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    entry.settle?.()
    entry.resolve(result)
  }

  /** Report a transport-level failure to the service that owns this backend. */
  private fail(error: WatchError): void {
    for (const listener of this.failureListeners) listener(error)
  }

  /** Handle child exit: fail every in-flight request, then report the loss. */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    const detail = signal ?? `exit code ${String(code)}`
    const trailer = this.lastStderr.trim()
    const error = watchError(
      'bridge.core_exited',
      `Watch Core stopped (${detail}).${trailer === '' ? '' : ` Last output: ${trailer}`}`,
      'Check the Watch Core installation with `watch-skill doctor`, then reconnect.',
      { details: { code, signal }, retryable: true },
    ).error
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, error })
    this.fail(error)
  }

  /** Build the connect-time failure result, keeping the spawn detail intact. */
  private spawnFailure(reason: string): WatchResult<never> {
    return watchError(
      'bridge.start_failed',
      reason,
      `Verify that "${this.options.command}" is installed and on PATH, or set the Watch Core command in Settings → Watch.`,
      { details: { command: this.options.command }, retryable: true },
    )
  }
}

/** Whether a JSON-RPC `data` payload is already a Watch error contract. */
function isWatchError(value: unknown): value is WatchError {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['error'] === 'string'
    && typeof candidate['message'] === 'string'
    && typeof candidate['fix'] === 'string'
}
