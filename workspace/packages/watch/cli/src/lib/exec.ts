/**
 * Running other programs, without the two mistakes that make it dangerous.
 *
 * **No shell.** Every command here is an executable and an argument array.
 * Building a command string and handing it to a shell is how a path with a
 * space becomes two arguments and how a filename becomes an injection, and
 * neither failure is visible until somebody's directory is named wrong.
 *
 * **No unbounded wait.** Every call carries a deadline. A CLI that hangs
 * because a child never wrote to a pipe is indistinguishable from one that is
 * working, and the person waiting has no way to tell which.
 *
 * @module @deepwatch/cli/lib/exec
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

/** What a finished command left behind. */
export interface Ran {
  /** Null when the process was killed rather than exiting on its own. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** True when the deadline elapsed and the child was stopped. */
  readonly timedOut: boolean
}

/** How to run one command. */
export interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Milliseconds. Required: a command with no deadline is a hang waiting. */
  readonly timeoutMs: number
}

/**
 * Run a command to completion, capturing what it said.
 *
 * Resolves rather than rejects on a non-zero exit: an exit code is an answer,
 * and a caller that has to wrap every invocation in try/catch to read one
 * writes worse error messages than one that is handed it.
 */
export function run(
  command: string, args: readonly string[], options: RunOptions,
): Promise<Ran> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      // Never a shell. See the module note.
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      timedOut = true
      stop(child)
    }, options.timeoutMs)
    timer.unref?.()

    const settle = (code: number | null): void => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    child.on('error', error => { stderr += error.message; settle(null) })
    child.on('close', code => { settle(code) })
  })
}

/**
 * Whether an executable answers at all.
 *
 * `--version` rather than a lookup on PATH: a name on PATH that cannot run —
 * a Microsoft Store alias stub, a broken shim, a wrapper pointing at a deleted
 * interpreter — is exactly the case a doctor exists to distinguish, and only
 * running it tells them apart.
 */
export async function probe(
  command: string, args: readonly string[] = ['--version'],
): Promise<string | null> {
  const ran = await run(command, args, { timeoutMs: 15_000 })
  if (ran.code !== 0) return null
  const line = `${ran.stdout}${ran.stderr}`.split('\n')[0]?.trim() ?? ''
  return line === '' ? null : line
}

/**
 * Stop a child, then insist.
 *
 * `SIGTERM` first, so a supervised process runs its own shutdown; `SIGKILL`
 * after a grace period, because a process that ignores a term signal must not
 * be able to keep the CLI alive. On Windows neither signal exists and Node
 * maps both to a terminate, which is the right end state either way.
 */
export function stop(child: ChildProcess, graceMs = 5_000): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    // Already gone between the check and the call.
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      // Likewise.
    }
  }, graceMs)
  timer.unref?.()
  child.once('exit', () => { clearTimeout(timer) })
}

/**
 * Run a long-lived child in the foreground, forwarding what happens to it.
 *
 * The signals a person sends this CLI belong to the thing it started: Ctrl-C
 * on a running Web host should stop the host, not orphan it and return a
 * prompt. Both handlers are removed on exit so a second command in the same
 * process is not shut down by the first one's listeners.
 */
export function supervise(
  command: string, args: readonly string[], options: { cwd?: string, env?: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? process.env,
      shell: false,
      stdio: 'inherit',
      windowsHide: true,
    })

    const forward = (signal: NodeJS.Signals) => () => { stop(child) ; void signal }
    const onInt = forward('SIGINT')
    const onTerm = forward('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)

    const done = (code: number): void => {
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)
      resolve(code)
    }
    child.on('error', () => { done(1) })
    child.on('close', code => { done(code ?? 0) })
  })
}
