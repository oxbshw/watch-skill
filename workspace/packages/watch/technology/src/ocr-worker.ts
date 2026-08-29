/**
 * Running an OCR engine that is not allowed anywhere near the workspace.
 *
 * DeepSeek-OCR's published inference path uses `trust_remote_code=True`. That
 * means loading the model executes Python fetched from a model repository, and
 * the only responsible place to do that is a process whose death costs
 * nothing. Not the DSH Host. Not the Watch Core main process. A worker.
 *
 * Isolation is therefore not a configuration option here, it is the shape of
 * the module: there is no in-process path, and no flag that produces one.
 *
 * Four things follow from that, and each is a rule rather than a nicety.
 *
 * **The pinned revision is checked, not assumed.** A worker announces the
 * model and revision it actually loaded, and a mismatch is a refusal. Pinning
 * a revision in a descriptor and never verifying it is a pin that documents an
 * intention rather than enforcing one — and "the model repository changed
 * under us" is exactly the failure that pinning exists to catch.
 *
 * **A crash is a crash, and it is not retried.** OCR has no side effects, so a
 * retry would be safe in the narrow sense; it is refused anyway, because a
 * worker that OOMs on a page will OOM on the same page again, and an automatic
 * retry turns one failure into a loop that looks like slowness. The state goes
 * to `degraded`, the reason says which signal or exit code, and routing takes
 * a different engine.
 *
 * **Cancellation is cooperative first and forcible second.** A cancel is sent,
 * a grace period passes, and then the process is killed by its own handle —
 * never by name. Killing by process name is how a supervisor takes down
 * somebody else's Python.
 *
 * **Nothing is downloaded.** The supervisor can describe an install plan; it
 * cannot perform one. Fetching multi-gigabyte weights on a user's behalf is a
 * decision they make, and the weight licence gate in `ocr.ts` has to clear
 * before it is even offerable.
 *
 * @module @watchskill/dsh-technology/ocr-worker
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { TechnologyDescriptor } from './descriptor.js'

/**
 * Where an engine is, in a vocabulary that keeps eight different things apart.
 *
 * The temptation is to collapse these into "works" and "does not work". Every
 * collapse loses something a person needs: `not_installed` and `unavailable`
 * differ in whether there is anything to do about it; `probed` and
 * `machine_tested` differ in whether anything has actually run; `degraded` and
 * `unavailable` differ in whether the next request might succeed.
 */
export type EngineState =
  /** Nothing on disk. */
  | 'not_installed'
  /** On disk, never started. */
  | 'installed'
  /** A cheap check passed — the binary answers, the import resolves. */
  | 'probed'
  /** A real recognition ran here and produced output. */
  | 'machine_tested'
  /** A worker is up and answering. */
  | 'ready'
  /** Up, but something is wrong: a crash, an OOM, a revision mismatch. */
  | 'degraded'
  /** Cannot work on this machine, with a reason. */
  | 'unavailable'
  /** Never checked. Not the same as any of the above. */
  | 'not_tested'

/** An engine's state, and why it is in it. */
export interface EngineHealth {
  readonly engineId: string
  readonly state: EngineState
  /** One sentence. Empty only for `ready`. */
  readonly detail: string
  /** What the person can do. Empty when there is nothing. */
  readonly fix: string
  /** The revision the worker reported, once one has. */
  readonly loadedRevision: string | null
  /** ISO-8601 of the last state change. */
  readonly changedAt: string
  /** Whether routing may select this engine. */
  readonly usable: boolean
}

/** An engine that has never been looked at. */
export function untestedHealth(engineId: string, at: string): EngineHealth {
  return {
    engineId,
    state: 'not_tested',
    detail: 'This engine has never been checked on this machine.',
    fix: 'Run a capability check from Settings.',
    loadedRevision: null,
    changedAt: at,
    usable: false,
  }
}

/** Whether a state permits routing to select the engine. */
export function isEngineUsable(state: EngineState): boolean {
  return state === 'ready' || state === 'machine_tested'
}

// ── the worker protocol ─────────────────────────────────────────────────────

/**
 * What a worker says when it comes up.
 *
 * `revision` is the load-bearing field. Everything else is diagnostics.
 */
export interface WorkerHello {
  readonly protocol: number
  readonly model: string
  readonly revision: string
  readonly device: string
  readonly vramGb: number | null
}

/** One recognition request, as it crosses the process boundary. */
export interface WorkerRequest {
  readonly id: string
  readonly method: 'recognize' | 'cancel' | 'shutdown'
  readonly params: Readonly<Record<string, unknown>>
}

/** One response. */
export interface WorkerResponse {
  readonly id: string
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code: string; readonly message: string }
}

/** The protocol version this supervisor speaks. */
export const WORKER_PROTOCOL = 1

/** How a worker is launched. */
export interface WorkerSpawn {
  readonly command: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
}

/** Deployment policy for one worker. */
export interface WorkerOptions {
  readonly descriptor: TechnologyDescriptor
  readonly spawn: WorkerSpawn
  /** How long to wait for the hello. */
  readonly startTimeoutMs: number
  /** How long one recognition may take. */
  readonly requestTimeoutMs: number
  /** How long a cancelled request has to stop before the process is killed. */
  readonly cancelGraceMs: number
  /** Clock, injectable so tests are not timing-dependent. */
  readonly now?: () => string
}

/** Why a worker call failed. */
export interface WorkerFailure {
  readonly code:
    | 'not_started'
    | 'start_timeout'
    | 'revision_mismatch'
    | 'protocol_mismatch'
    | 'timeout'
    | 'cancelled'
    | 'crashed'
    | 'out_of_memory'
    | 'worker_error'
  readonly message: string
  readonly fix: string
  /** Whether trying the same request again could plausibly work. */
  readonly retryable: boolean
}

/** The result of a worker call. */
export type WorkerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WorkerFailure }

/**
 * Exit signals that mean the kernel killed the process for memory.
 *
 * SIGKILL is what the Linux OOM killer sends, and 137 is how a shell reports
 * it. Distinguished from an ordinary crash because the fix is different: an
 * OOM is answered by a smaller batch or a bigger machine, and a crash is
 * answered by looking at the worker's stderr.
 */
function isOomExit(code: number | null, signal: string | null): boolean {
  return signal === 'SIGKILL' || code === 137
}

/**
 * Supervises one OCR worker process.
 *
 * Deliberately owns exactly one child. A pool would be more efficient and
 * would also mean a crash takes down several in-flight requests whose failure
 * modes then have to be untangled; one process per supervisor keeps "which
 * request killed it" answerable.
 */
export class OcrWorker {
  private child: ChildProcessWithoutNullStreams | null = null
  private hello: WorkerHello | null = null
  private buffer = ''
  private health: EngineHealth
  private readonly pending = new Map<string, (response: WorkerResponse) => void>()
  private nextId = 1
  private stderr = ''

  constructor(private readonly options: WorkerOptions) {
    this.health = untestedHealth(options.descriptor.id, this.now())
  }

  /** The current health, including why. */
  status(): EngineHealth {
    return this.health
  }

  /** The revision the running worker actually loaded. */
  loadedRevision(): string | null {
    return this.hello?.revision ?? null
  }

  /**
   * Start the worker and verify what it loaded.
   *
   * Three ways this refuses, and all three leave the process stopped:
   *
   * - it never says hello inside the start timeout;
   * - it speaks a different protocol;
   * - it loaded a revision other than the pinned one.
   *
   * The third is the one that matters most. A descriptor that pins a revision
   * and a supervisor that does not check it is a pin that records an intention
   * rather than enforcing one.
   */
  async start(): Promise<WorkerResult<WorkerHello>> {
    if (this.child !== null) {
      return this.hello === null
        ? this.fail('not_started', 'The worker is starting.', 'Wait for it to come up.', true)
        : { ok: true, value: this.hello }
    }

    const child = spawn(this.options.spawn.command, [...this.options.spawn.args], {
      // Isolation is the point of this module: a separate process, its own
      // environment, and no shell to interpret anything.
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...this.options.spawn.cwd === undefined ? {} : { cwd: this.options.spawn.cwd },
      env: { ...process.env, ...this.options.spawn.env },
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.onData(chunk) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // Bounded: a worker that logs a stack trace per frame must not become
      // the reason the supervisor runs out of memory.
      this.stderr = `${this.stderr}${chunk}`.slice(-8192)
    })
    child.on('exit', (code, signal) => { this.onExit(code, signal) })
    child.on('error', error => {
      this.setHealth('unavailable', `The worker could not be started: ${error.message}`,
        'Check the command in the engine descriptor.')
    })

    const hello = await this.awaitHello()
    if (!hello.ok) {
      this.terminate()
      return hello
    }

    if (hello.value.protocol !== WORKER_PROTOCOL) {
      this.terminate()
      this.setHealth('unavailable',
        `The worker speaks protocol ${String(hello.value.protocol)}; this build speaks ${String(WORKER_PROTOCOL)}.`,
        'Install a worker matching this build.')
      return this.fail('protocol_mismatch', this.health.detail, this.health.fix, false)
    }

    const pinned = this.options.descriptor.provenance.revision
    if (pinned !== null && hello.value.revision !== pinned) {
      this.terminate()
      this.setHealth('unavailable',
        `The worker loaded revision ${hello.value.revision}; this build is pinned to ${pinned}.`,
        'Install the pinned revision, or update the descriptor deliberately.')
      return this.fail('revision_mismatch', this.health.detail, this.health.fix, false)
    }

    this.hello = hello.value
    this.setHealth('ready', '', '', hello.value.revision)
    return hello
  }

  /**
   * Recognize one image.
   *
   * On a crash the state goes to `degraded` and the failure says so; it is not
   * retried here, and `retryable` is false. A worker that ran out of memory on
   * a page will run out of memory on the same page, and an automatic retry
   * converts one visible failure into a loop that looks like slowness.
   */
  async recognize(
    params: Readonly<Record<string, unknown>>,
    exec: { readonly signal?: AbortSignal } = {},
  ): Promise<WorkerResult<unknown>> {
    if (this.child === null || this.hello === null) {
      return this.fail('not_started', 'The worker is not running.', 'Start the engine first.', true)
    }
    if (exec.signal?.aborted === true) {
      return this.fail('cancelled', 'Cancelled before dispatch.', '', true)
    }

    const id = `r${String(this.nextId)}`
    this.nextId += 1

    const settled = new Promise<WorkerResponse | null>(resolve => {
      this.pending.set(id, response => { resolve(response) })
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve(null)
      }, this.options.requestTimeoutMs)
      // Do not hold the event loop open on account of a deadline.
      timer.unref?.()
      exec.signal?.addEventListener('abort', () => {
        this.send({ id, method: 'cancel', params: {} })
        // Cooperative first. If the worker has not answered by the grace
        // period, the handle is killed — by handle, never by name.
        const grace = setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id)
            this.terminate()
            resolve(null)
          }
        }, this.options.cancelGraceMs)
        grace.unref?.()
      }, { once: true })
    })

    this.send({ id, method: 'recognize', params })
    const response = await settled

    if (response === null) {
      // Read through the handle rather than the narrowed local: the signal was
      // not aborted when the request was dispatched, and the whole reason this
      // branch exists is that it may have become so while we waited.
      const aborted: boolean = exec.signal?.aborted ?? false
      if (aborted) {
        return this.fail('cancelled', 'The request was cancelled.', '', true)
      }
      return this.fail(
        'timeout',
        `The worker did not answer within ${String(this.options.requestTimeoutMs)}ms.`,
        'Raise the timeout, or use a lighter engine for this workload.',
        false,
      )
    }
    if (response.ok) {
      // A real recognition completed on this machine. That is the only thing
      // that earns `machine_tested`, and it is recorded here rather than
      // claimed by a settings screen.
      this.setHealth('machine_tested', '', '', this.hello.revision)
      return { ok: true, value: response.value }
    }
    return this.fail(
      'worker_error',
      response.error?.message ?? 'The worker refused the request.',
      'Check the worker log for the underlying error.',
      false,
    )
  }

  /** Stop the worker, cooperatively if it will. */
  async stop(): Promise<void> {
    if (this.child === null) return
    this.send({ id: 's0', method: 'shutdown', params: {} })
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.terminate(); resolve() }, this.options.cancelGraceMs)
      timer.unref?.()
      this.child?.once('exit', () => { clearTimeout(timer); resolve() })
    })
    this.child = null
    this.hello = null
  }

  /** The worker's recent stderr, for a diagnostic panel. Bounded. */
  log(): string {
    return this.stderr
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString()
  }

  private setHealth(
    state: EngineState,
    detail: string,
    fix: string,
    loadedRevision: string | null = this.health.loadedRevision,
  ): void {
    this.health = {
      engineId: this.options.descriptor.id,
      state,
      detail,
      fix,
      loadedRevision,
      changedAt: this.now(),
      usable: isEngineUsable(state),
    }
  }

  private fail(
    code: WorkerFailure['code'],
    message: string,
    fix: string,
    retryable: boolean,
  ): WorkerResult<never> {
    return { ok: false, error: { code, message, fix, retryable } }
  }

  private send(request: WorkerRequest): void {
    this.child?.stdin.write(`${JSON.stringify(request)}\n`)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A worker writing non-JSON to stdout is a worker whose library is
      // printing. Keep it as a diagnostic rather than treating it as a reply.
      this.stderr = `${this.stderr}${line}\n`.slice(-8192)
      return
    }
    if (message['method'] === 'hello') {
      this.helloResolver?.(message['params'] as WorkerHello)
      return
    }
    const id = typeof message['id'] === 'string' ? message['id'] : null
    if (id === null) return
    const waiting = this.pending.get(id)
    if (waiting === undefined) return
    this.pending.delete(id)
    waiting(message as unknown as WorkerResponse)
  }

  private helloResolver: ((hello: WorkerHello) => void) | null = null

  private async awaitHello(): Promise<WorkerResult<WorkerHello>> {
    const hello = await new Promise<WorkerHello | null>(resolve => {
      this.helloResolver = hello => { resolve(hello) }
      const timer = setTimeout(() => { resolve(null) }, this.options.startTimeoutMs)
      timer.unref?.()
    })
    this.helloResolver = null
    if (hello === null) {
      this.setHealth('unavailable',
        `The worker did not announce itself within ${String(this.options.startTimeoutMs)}ms.`,
        'Check that the engine is installed and its command is correct.')
      return this.fail('start_timeout', this.health.detail, this.health.fix, true)
    }
    return { ok: true, value: hello }
  }

  private onExit(code: number | null, signal: string | null): void {
    const wasRunning = this.child !== null
    this.child = null
    this.hello = null

    // Every in-flight request fails with the same reason, rather than hanging
    // until its deadline. A caller waiting 300 seconds for a process that died
    // two seconds ago is a caller who cannot tell the two apart.
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const resolve of waiting) {
      resolve({
        id: '',
        ok: false,
        error: {
          code: isOomExit(code, signal) ? 'out_of_memory' : 'crashed',
          message: isOomExit(code, signal)
            ? 'The worker was killed for memory.'
            : `The worker exited (code ${String(code)}, signal ${signal ?? 'none'}).`,
        },
      })
    }

    if (!wasRunning) return
    if (isOomExit(code, signal)) {
      this.setHealth('degraded',
        'The worker was killed for memory. Routing will avoid this engine.',
        'Use a lighter engine, reduce the image size, or run on a machine with more memory.')
      return
    }
    if (code === 0) {
      this.setHealth('installed', 'The worker stopped.', '')
      return
    }
    this.setHealth('degraded',
      `The worker exited with code ${String(code)}${signal === null ? '' : ` (${signal})`}.`,
      'Check the worker log. Routing will avoid this engine until it is restarted.')
  }

  /** Kill by handle. Never by name — that is somebody else's Python. */
  private terminate(): void {
    const child = this.child
    if (child === null) return
    try {
      child.kill('SIGTERM')
    } catch {
      // Already gone. The exit handler has done, or will do, the bookkeeping.
    }
  }
}

// ── install plans ───────────────────────────────────────────────────────────

/** One step a person would have to take. */
export interface InstallStep {
  readonly description: string
  /** The exact command, when there is one. Never run automatically. */
  readonly command: string | null
  /** Bytes this step downloads, when known. */
  readonly downloadBytes: number | null
}

/** What installing an engine would involve. */
export interface InstallPlan {
  readonly engineId: string
  readonly steps: readonly InstallStep[]
  /** Refusals that must clear before this plan may even be offered. */
  readonly blockers: readonly string[]
  /** Whether anything here may be performed automatically. Always false. */
  readonly automatic: false
}

/**
 * Describe what installing an engine would take.
 *
 * Describes; never performs. `automatic` is typed as the literal `false` so a
 * caller cannot branch on it becoming true one day without the type changing —
 * fetching multi-gigabyte weights on somebody's behalf is their decision, and
 * the weight-licence gate has to clear before it is even offerable.
 */
export function installPlan(
  descriptor: TechnologyDescriptor,
  environment: { readonly hasGpu: boolean; readonly vramGb: number | null },
): InstallPlan {
  const blockers: string[] = []

  if (descriptor.provenance.weightsLicense === null
    || !descriptor.provenance.weightsLicenseReviewed) {
    blockers.push(
      'The weight licence for this model has not been reviewed, so Watch will not '
      + 'fetch or redistribute its weights. Obtain them yourself from '
      + `${descriptor.provenance.sourceUrl}.`,
    )
  }
  if (descriptor.hardware.gpu === 'required' && !environment.hasGpu) {
    blockers.push('This engine requires a GPU and none was detected on this machine.')
  }
  if (descriptor.hardware.minVramGb !== null
    && environment.vramGb !== null
    && environment.vramGb < descriptor.hardware.minVramGb) {
    blockers.push(
      `This engine needs ${String(descriptor.hardware.minVramGb)}GB of VRAM; `
      + `${String(environment.vramGb)}GB was detected.`,
    )
  }

  const steps: InstallStep[] = []
  if (descriptor.install.method === 'package_manager') {
    steps.push({
      description: `Install ${descriptor.displayName} through your package manager.`,
      command: null,
      downloadBytes: descriptor.install.downloadBytes,
    })
  } else {
    steps.push({
      description: `Obtain ${descriptor.displayName} weights at revision `
        + `${descriptor.provenance.revision ?? 'unpinned'} from ${descriptor.provenance.sourceUrl}.`,
      command: null,
      downloadBytes: descriptor.install.downloadBytes,
    })
  }
  steps.push({
    description: 'Point the engine at the installed worker in Settings, then run a capability check.',
    command: null,
    downloadBytes: null,
  })

  return { engineId: descriptor.id, steps, blockers, automatic: false }
}
