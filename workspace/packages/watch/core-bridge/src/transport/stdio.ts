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
 * @module @deepwatch/dsh-core-bridge/transport/stdio
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Buffer } from 'node:buffer'
import type { JsonRpcResponse, WatchError, WatchFailure, WatchResult } from '@deepwatch/dsh-contracts'
import { JSON_RPC, watchError } from '@deepwatch/dsh-contracts'
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

/**
 * The largest frame this transport will wait for.
 *
 * Without a bound, a Content-Length of a gigabyte parks the stream forever:
 * the reader correctly waits for a body that never arrives, every request
 * behind it runs out its deadline, and nothing ever reports why. A frame
 * larger than this is not a big message, it is a broken or hostile one, and
 * the difference matters because only one of them can be waited out.
 *
 * 64 MiB is far past any legitimate frame — evidence records carry digests
 * and paths, not the bytes themselves — and is still finite.
 */
const MAX_FRAME_BYTES = 64 * 1024 * 1024

/** Turn an unexpected value into a reportable error without losing its text. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Whether a spawn failure means the command simply is not installed.
 *
 * The distinction matters more than it looks. "Watch Core is not on this
 * machine" is a normal state with a friendly answer; "Watch Core is here and
 * would not start" is a fault that has to be reported. Conflating them either
 * nags people who never installed the engine, or hides a broken one behind a
 * mock.
 */
function isNotInstalled(cause: unknown): boolean {
  const code = (cause as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'EACCES'
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
  /** Set once the stream became unreadable; a broken frame stream cannot be resynchronized. */
  private protocolFailure: WatchError | null = null

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
      return Promise.resolve(this.spawnFailure(describe(cause), isNotInstalled(cause)))
    }

    this.child = child
    child.stdout.on('data', (chunk: Buffer) => { this.receive(chunk) })
    // Core's stderr is diagnostics, never protocol. Keeping the tail lets a
    // non-zero exit report why instead of just reporting that it happened.
    // A pipe can break asynchronously, after every write callback has already
    // run. Without a listener Node raises that as an uncaught exception, which
    // is how a broken pipe became `Error: write EPIPE` in CI rather than a
    // failed request. The write callbacks report; this only stops the throw.
    child.stdin.on('error', () => { /* reported by the write callbacks */ })

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
      child.once('error', (cause) => { finish(this.spawnFailure(describe(cause), isNotInstalled(cause))) })
      // 'close' rather than 'exit', and the difference is load-bearing.
      // 'exit' fires as soon as the process is gone, while its stdio may still
      // have buffered bytes in flight — so an engine that printed
      // "No such command 'bridge'" and quit was diagnosed against an empty
      // stderr and reported as a crash. 'close' waits for the streams, which
      // is the only point at which the engine's own last words are readable.
      child.once('close', (code, signal) => {
        this.handleExit(code, signal)
        // An immediate exit with a CLI usage error is not a crash, it is an
        // older Watch Core that has no `bridge` command. Those need opposite
        // answers — "check the log" versus "upgrade the engine" — and the
        // only place they can be told apart is here, while the exit code and
        // the argument parser's own words are still in hand.
        finish(this.surfaceMissing()
          ?? this.spawnFailure(
            `Watch Core exited during startup (${signal ?? `code ${String(code)}`}).`,
          ))
      })
    })
  }

  send<T>(request: TransportRequest): Promise<WatchResult<T>> {
    if (this.protocolFailure !== null) {
      // Fail fast with the reason, rather than making the caller wait out a
      // second deadline to learn something that is already known.
      return Promise.resolve({
        ok: false,
        error: { ...this.protocolFailure, correlationId: request.correlationId },
      })
    }
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
        resolve: resolve,
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
      // Both writes carry the same handler. The header had one and the body
      // did not, so an EPIPE on the body -- the larger write, and the likelier
      // one to hit a pipe that just closed -- reached the stream as an
      // unhandled 'error' and took the process down with `write EPIPE`
      // instead of failing the request. `settle` removes the pending entry,
      // so being called from both writes reports once.
      const onWriteError = (cause: Error | null | undefined): void => {
        if (cause == null) return
        this.settle(id, watchError(
          'bridge.write_failed',
          `Could not send "${request.method}" to Watch Core: ${describe(cause)}`,
          'Reconnect Watch Core and retry.',
          { retryable: true, correlationId: request.correlationId },
        ))
      }
      child.stdin.write(
        `Content-Length: ${String(body.byteLength)}${HEADER_TERMINATOR}`,
        onWriteError,
      )
      child.stdin.write(body, onWriteError)
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
    // `destroyed` above is checked before the write, and the child can exit in
    // between. A notification's failure is not reportable -- that is why this
    // method exists separately -- so the callback swallows rather than
    // pretending, but it has to be there or the stream throws.
    const swallow = (): void => { /* a notification that did not land is not an error we can raise */ }
    child.stdin.write(`Content-Length: ${String(body.byteLength)}${HEADER_TERMINATOR}`, swallow)
    child.stdin.write(body, swallow)
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
      if (bodyEnd - bodyStart > MAX_FRAME_BYTES) {
        // Refusing here rather than waiting: no further bytes can make a
        // frame this size legitimate, and waiting hides the reason.
        this.fail(watchError(
          'bridge.protocol_violation',
          `Watch Core declared a ${String(bodyEnd - bodyStart)}-byte frame, over the `
          + `${String(MAX_FRAME_BYTES)}-byte limit this Workspace will read.`,
          'Update Watch Core to a version matching this Workspace, then reconnect.',
          {},
        ).error)
        return
      }
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

  /**
   * A transport-level failure: settle everything waiting, and stay failed.
   *
   * This used to only notify the failure listeners, which read as correct and
   * was not. The requests already in flight were left to run out their own
   * deadlines, so a protocol violation — a frame with no Content-Length, a body
   * that is not JSON — reached the caller as `bridge.deadline_exceeded`. That
   * is the wrong diagnosis in the way that costs the most time: it says the
   * engine is slow, and sends someone to look at load and networking, when the
   * truth is that this build and that engine cannot talk to each other and no
   * amount of waiting will change it.
   *
   * A broken stream also cannot be resynchronized by guessing where the next
   * frame begins, so the transport stays failed rather than pretending the next
   * request might land.
   */
  private fail(error: WatchError): void {
    this.protocolFailure = error
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, error })
    for (const listener of this.failureListeners) listener(error)
  }

  /**
   * Handle child exit: fail every in-flight request, then report the loss.
   *
   * The surface-missing check comes first because this is where the *failure
   * listeners* learn what happened, and they publish health. Diagnosing it
   * only in `connect`'s resolution left the listeners publishing
   * `core_crashed` for an engine that had merely rejected an unknown
   * subcommand — a correct-sounding blocker that sends someone to read crash
   * logs for a version mismatch.
   */
  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null
    const detail = signal ?? `exit code ${String(code)}`
    const trailer = this.lastStderr.trim()
    const missing = this.surfaceMissing()
    const error = missing !== null
      ? missing.error
      : watchError(
        'bridge.core_exited',
        `Watch Core stopped (${detail}).${trailer === '' ? '' : ` Last output: ${trailer}`}`,
        'Check the Watch Core installation with `watch-skill doctor`, then reconnect.',
        { details: { code, signal }, retryable: true },
      ).error
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, error })
    this.fail(error)
  }


  /**
   * Whether the engine started and then rejected `bridge` as a command.
   *
   * Recognised from what an argument parser says when it is handed a
   * subcommand it does not have. Matching on the engine's own words is
   * unlovely and is the only signal available: the process is gone, and a
   * usage error and a startup crash are both a non-zero exit.
   *
   * A false negative is the safe direction — it degrades to
   * `bridge.start_failed`, which is a worse message and not a wrong one.
   */
  private surfaceMissing(): WatchFailure | null {
    const text = this.lastStderr.toLowerCase()
    const usage = /no such command|unrecognized arguments|invalid choice|unknown command/.test(text)
    // The subcommands actually requested, not the literal `bridge`.
    //
    // Hardcoding the word meant this only fired when the engine happened to
    // echo it, so a Core configured with different args reported
    // `core_crashed` for a missing surface — the one diagnosis this check
    // exists to prevent. Keying on `args[0]` was no better: when the command
    // is an interpreter the first argument is a script path, not a
    // subcommand.
    //
    // A subcommand is a bare word: no separator, no extension. Anything with
    // either is a path, and a usage error that quotes a path is not this.
    const subcommands = this.options.args
      .filter(argument => !/[\\./]/.test(argument))
      .map(argument => argument.toLowerCase())
    if (!usage || !subcommands.some(name => text.includes(name))) return null
    return watchError(
      'bridge.bridge_surface_missing',
      `"${this.options.command}" is installed but has no "bridge" command, so this `
      + 'Workspace cannot reach it.',
      'Update Watch Core to a version that ships the Bridge surface '
      + '(`pip install --upgrade watch-skill`), then reconnect.',
      { details: { command: this.options.command }, retryable: false },
    )
  }
  /**
   * Build the connect-time failure result, keeping the spawn detail intact.
   *
   * `notInstalled` travels in the details so the service can offer a fresh
   * machine the mock backend without also hiding a Watch Core that is present
   * and failing.
   */
  private spawnFailure(reason: string, notInstalled = false): WatchResult<never> {
    return watchError(
      notInstalled ? 'bridge.core_not_installed' : 'bridge.start_failed',
      reason,
      // Both halves matter, and which one is wrong is not knowable from here:
      // the engine may be missing, or the configured command may be. Naming
      // the command is what lets someone tell those apart at a glance.
      notInstalled
        ? `Install Watch Core with \`pip install watch-skill\`, or correct the command `
          + `"${this.options.command}" in Settings → Watch.`
        : `Verify that "${this.options.command}" is installed and on PATH, or set the Watch Core command in Settings → Watch.`,
      { details: { command: this.options.command, notInstalled }, retryable: true },
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
