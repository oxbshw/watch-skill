/**
 * Supervising the two children the desktop owns.
 *
 * The DSH Host and Watch Core are separate processes, and the desktop is
 * responsible for their whole lives: starting them, noticing when they die,
 * restarting them a bounded number of times, and stopping them without
 * orphaning anything.
 *
 * Three rules, and the first is the one that gets violated most often in
 * shipped desktop applications.
 *
 * **A child is identified by its handle, never by its name.** There is no
 * `taskkill /IM python.exe` here and no `pkill -f watch-core`. A supervisor
 * that kills by name will one day kill somebody's unrelated Python process,
 * and the person it happens to will have no way to work out why.
 *
 * **Restarts are bounded and the bound is visible.** A crash loop that retries
 * forever presents as a slow application rather than a broken one. After the
 * budget is spent the supervisor stops, says so, and the app enters safe mode.
 *
 * **Shutdown is cooperative first.** A term signal, a grace period, then a
 * kill — of the handle. A child killed before it could flush is a child that
 * corrupts the thing it was writing.
 *
 * @module @watchskill/watch-desktop/supervisor
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

/**
 * How long to wait for the kernel to reap a child after SIGKILL.
 *
 * SIGKILL cannot be caught, so this is not a grace period -- it is a bound on
 * waiting for a process that is already dying, so `stop()` cannot hang if the
 * exit event never arrives.
 */
const REAP_TIMEOUT_MS = 2_000

/** What a supervised child is. */
export type ChildRole = 'dsh-host' | 'watch-core'

/** Where a child is. */
export type ChildState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'restarting'
  /** The restart budget is spent. Nothing further will be attempted. */
  | 'failed'
  | 'stopping'

/** How to start one child. */
export interface ChildSpec {
  readonly role: ChildRole
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  /** A line on stdout that means the child is up. */
  readonly readyPattern: RegExp
  readonly startTimeoutMs: number
  /** How many times it may be restarted before the app gives up. */
  readonly maxRestarts: number
  /** How long a stop may take before the handle is killed. */
  readonly stopGraceMs: number
}

/** What the supervisor knows about one child. */
export interface ChildStatus {
  readonly role: ChildRole
  readonly state: ChildState
  /**
   * The identity this supervisor minted for this child.
   *
   * Passed to the child in its environment and echoed back in its ready line,
   * so "is this process mine" has an answer that does not involve a name, a
   * port, or a guess.
   */
  readonly ownerToken: string
  readonly pid: number | null
  readonly restarts: number
  readonly detail: string
  readonly lastExit: { readonly code: number | null; readonly signal: string | null } | null
}

/** Events a caller can subscribe to. */
export interface SupervisorEvents {
  readonly onState?: (status: ChildStatus) => void
  readonly onLog?: (role: ChildRole, line: string) => void
}

/**
 * Supervises one child process.
 *
 * One instance per child rather than a pool, for the same reason the OCR
 * worker is one-per-supervisor: when something dies, which one died has to be
 * answerable without inference.
 */
export class SupervisedChild {
  private child: ChildProcess | null = null
  private status: ChildStatus
  private stopping = false
  private buffer = ''

  constructor(
    private readonly spec: ChildSpec,
    private readonly events: SupervisorEvents = {},
  ) {
    this.status = {
      role: spec.role,
      state: 'stopped',
      // Minted here, never derived from anything guessable.
      ownerToken: randomUUID(),
      pid: null,
      restarts: 0,
      detail: '',
      lastExit: null,
    }
  }

  /** Current status. */
  state(): ChildStatus {
    return this.status
  }

  /**
   * Start the child and wait for it to say it is ready.
   *
   * The owner token goes in the environment, not on the command line. A
   * command line is world-readable on every platform this ships on, and a
   * bootstrap secret in `ps` output is a bootstrap secret.
   */
  async start(): Promise<{ readonly ok: boolean; readonly detail: string }> {
    if (this.child !== null) return { ok: true, detail: 'already running' }
    this.stopping = false
    this.setState('starting', '')

    const child = spawn(this.spec.command, [...this.spec.args], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...this.spec.cwd === undefined ? {} : { cwd: this.spec.cwd },
      env: {
        ...process.env,
        ...this.spec.env,
        WATCH_OWNER_TOKEN: this.status.ownerToken,
      },
    })
    this.child = child
    this.status = { ...this.status, pid: child.pid ?? null }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { this.onOut(chunk) })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.events.onLog?.(this.spec.role, chunk.trimEnd())
    })
    child.on('exit', (code, signal) => { this.onExit(code, signal) })
    child.on('error', error => {
      this.setState('failed', `could not be started: ${error.message}`)
    })

    const ready = await this.awaitReady()
    if (!ready) {
      await this.stop()
      this.setState('failed',
        `did not report ready within ${String(this.spec.startTimeoutMs)}ms`)
      return { ok: false, detail: this.status.detail }
    }
    this.setState('ready', '')
    return { ok: true, detail: '' }
  }

  /**
   * Stop the child.
   *
   * Terminate, wait, then kill the handle. Never a name, never a port scan,
   * and never every process that looks similar.
   */
  async stop(): Promise<void> {
    const child = this.child
    if (child === null) return
    this.stopping = true
    this.setState('stopping', '')

    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(grace)
        clearTimeout(reap)
        resolve()
      }

      // The child telling us it is gone is the only reliable signal. Node
      // emits 'exit' once it has reaped the process, so every path below waits
      // for it rather than assuming a signal took effect.
      child.once('exit', finish)

      let reap: ReturnType<typeof setTimeout> | undefined
      const grace = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone between the check and the kill.
          finish()
          return
        }
        // Deliberately not resolving here.
        //
        // SIGKILL is asynchronous on POSIX: the signal is delivered and the
        // kernel reaps the process a moment later. Resolving on send reported
        // the child as stopped while `process.kill(pid, 0)` could still find
        // it -- which passed on Windows, where SIGKILL maps to
        // TerminateProcess and the handle is gone by the time kill() returns,
        // and failed on macOS. Found by the first CI run on another platform.
        reap = setTimeout(finish, REAP_TIMEOUT_MS)
        reap.unref?.()
      }, this.spec.stopGraceMs)
      grace.unref?.()

      try {
        child.kill('SIGTERM')
      } catch {
        finish()
      }
    })

    this.child = null
    this.setState('stopped', '')
  }

  /** Whether a process claiming this identity is one this supervisor owns. */
  owns(token: string): boolean {
    return token === this.status.ownerToken
  }

  private setState(state: ChildState, detail: string): void {
    this.status = { ...this.status, state, detail }
    this.events.onState?.(this.status)
  }

  private onOut(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trimEnd()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') {
        this.events.onLog?.(this.spec.role, line)
        if (this.spec.readyPattern.test(line)) this.readyResolver?.(true)
      }
      index = this.buffer.indexOf('\n')
    }
  }

  private readyResolver: ((ready: boolean) => void) | null = null

  private async awaitReady(): Promise<boolean> {
    const ready = await new Promise<boolean>(resolve => {
      this.readyResolver = value => { resolve(value) }
      const timer = setTimeout(() => { resolve(false) }, this.spec.startTimeoutMs)
      timer.unref?.()
    })
    this.readyResolver = null
    return ready
  }

  private onExit(code: number | null, signal: string | null): void {
    this.child = null
    this.status = { ...this.status, pid: null, lastExit: { code, signal } }
    this.readyResolver?.(false)

    if (this.stopping) {
      this.setState('stopped', '')
      return
    }

    if (this.status.restarts >= this.spec.maxRestarts) {
      this.setState('failed',
        `exited ${String(this.status.restarts)} time(s); the restart budget is spent. `
        + 'Watch will start in safe mode.')
      return
    }

    this.status = { ...this.status, restarts: this.status.restarts + 1 }
    this.setState('restarting',
      `exited (code ${String(code)}, signal ${signal ?? 'none'}); `
      + `restart ${String(this.status.restarts)} of ${String(this.spec.maxRestarts)}`)
  }
}

/**
 * Whether the whole app should fall back to safe mode.
 *
 * Any child whose restart budget is spent takes the app there. Continuing with
 * a dead Host would leave a window that renders and does nothing, which is a
 * worse experience than a window that says what is wrong.
 */
export function shouldEnterSafeMode(children: readonly ChildStatus[]): boolean {
  return children.some(child => child.state === 'failed')
}

/** One sentence describing why safe mode was entered. */
export function safeModeReason(children: readonly ChildStatus[]): string {
  const failed = children.filter(child => child.state === 'failed')
  if (failed.length === 0) return ''
  return failed
    .map(child => `${child.role}: ${child.detail}`)
    .join(' · ')
}
