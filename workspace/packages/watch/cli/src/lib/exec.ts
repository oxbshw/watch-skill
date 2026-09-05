/**
 * Running other programs — the one place in this product that creates a
 * process, and the rules that make doing so safe.
 *
 * **No shell, ever, on the ordinary path.** Every command here is an
 * executable and an argument array. Building a command string and handing it
 * to a shell is how a path with a space becomes two arguments and how a
 * filename becomes an injection, and neither failure is visible until
 * somebody's directory is named wrong.
 *
 * **No `.cmd`, no `.bat`.** Node has refused to spawn a Windows batch shim
 * without a shell since the CVE-2024-27980 hardening, and every Node version
 * this CLI declares support for enforces it. A boundary that spawns `npm.cmd`
 * with `shell: false` does not fail on review, it fails on a user's Windows
 * machine with `spawn EINVAL` and nothing else to go on — which is exactly
 * what shipped. So {@link run} *refuses* a batch shim with a typed error
 * naming the fix, and {@link resolveNodeCli} provides that fix: the `.js`
 * entry point the shim would have run, invoked with the Node already running
 * us. Windows then takes the same shell-free path as everywhere else.
 *
 * Where a shim is genuinely unavoidable, {@link launchWindowsShim} is the only
 * way through, and it validates every argument against a strict allowlist
 * before a command interpreter ever sees one. It is deliberately harder to
 * reach than the safe path.
 *
 * **No unbounded wait.** Every call carries a deadline. A CLI that hangs
 * because a child never wrote to a pipe is indistinguishable from one that is
 * working, and the person waiting has no way to tell which.
 *
 * **A spawn failure is not an exit code.** A program that could not be started
 * and a program that ran and returned 1 are different facts, and code that
 * cannot tell them apart writes error messages that send people to the wrong
 * place. {@link Ran.failure} keeps them apart.
 *
 * This module is the boundary the release tooling shares — see
 * `scripts/lib/process.mjs`, which re-exports it rather than keeping a second
 * copy. The two drifted once already: the pack tooling handled Windows and the
 * CLI did not, and the CLI is the half a user runs.
 *
 * @module @deepwatch/cli/lib/exec
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/** Why a command produced no exit code of its own. */
export type LaunchFailure = 'spawn-failed' | 'timeout' | 'cancelled' | 'unsafe-argument'

/** What a finished command left behind. */
export interface Ran {
  /** Null when the process never ran, or was killed rather than exiting. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  /** True when the deadline elapsed and the child was stopped. */
  readonly timedOut: boolean
  /**
   * Present when there is no exit code to read, saying which way it failed.
   *
   * Absent means the program ran and `code` is its own answer, including a
   * non-zero one. A caller that treats "did not start" as "exited non-zero"
   * tells people to debug a program that never ran.
   */
  readonly failure?: LaunchFailure
}

/** How to run one command. */
export interface RunOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** Milliseconds. Required: a command with no deadline is a hang waiting. */
  readonly timeoutMs: number
  /** Abort to cancel. The child is stopped the same way a timeout stops it. */
  readonly signal?: AbortSignal
}

/**
 * A command as it should appear in a log: executable and arguments apart,
 * never concatenated, with anything that looks like a credential removed.
 */
export interface CommandDescription {
  readonly executable: string
  readonly arguments: readonly string[]
}

/** A Windows batch shim, which Node will not spawn without a shell. */
const BATCH_SHIM = /\.(cmd|bat)$/i

/**
 * Arguments a command interpreter cannot misread.
 *
 * Deliberately narrow: letters, digits, and the punctuation that appears in
 * real package specs, version ranges, flags and Windows paths. Everything a
 * `cmd.exe` command line gives meaning to — `& | < > ^ " % ! ( )`, a newline,
 * a bare space — is outside it and is refused rather than escaped. Escaping
 * `cmd.exe` correctly is famously not a solved problem, and this product does
 * not need it to be.
 */
const SAFE_SHIM_ARGUMENT = /^[A-Za-z0-9_@./\\:=+,~-]+$/

/**
 * Argument shapes that carry a secret, by the form they arrive in.
 *
 * Matched on the whole argument so `--registry=https://…` survives intact and
 * `--//registry.npmjs.org/:_authToken=…` does not. A log that quotes a
 * credential has published it.
 */
const SECRET_ARGUMENT = [
  /_authToken=/i,
  /(^|[^A-Za-z])(--)?(password|passwd|secret|token|api[-_]?key|auth)=/i,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /^Bearer\s+\S+$/i,
]

/** Environment names whose values are never written anywhere. */
const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)$/i

/**
 * A command as it may be logged.
 *
 * Executable and arguments stay separate structured values. Reassembling them
 * into one string is what turns a log line into something that looks runnable
 * and is subtly not, and it is also how a quoted path stops being one
 * argument.
 */
export function describeCommand(
  command: string, args: readonly string[] = [],
): CommandDescription {
  return {
    executable: command,
    arguments: args.map(argument =>
      SECRET_ARGUMENT.some(pattern => pattern.test(argument)) ? '«redacted»' : argument),
  }
}

/**
 * An environment as it may be logged: names kept, secret values removed.
 *
 * Names are worth keeping — which variables were set is usually the answer —
 * and no value matching a credential-shaped name ever is.
 */
export function describeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue
    out[name] = SECRET_ENV.test(name) ? '«redacted»' : value
  }
  return out
}

/** A refusal raised before any process is created. */
export class UnsafeCommandError extends Error {
  /** The failure kind, so a caller can act without parsing a sentence. */
  readonly failure: LaunchFailure = 'unsafe-argument'
  /** What to do about it. */
  readonly fix: string

  constructor(message: string, fix: string) {
    super(message)
    this.name = 'UnsafeCommandError'
    this.fix = fix
  }
}

/**
 * The `.js` entry point behind a command-line tool, so it can be run by Node
 * directly instead of through a platform shim.
 *
 * This is what makes the Windows path shell-free. `npm` on Windows is
 * `npm.cmd`, a batch file whose entire job is to run
 * `node <somewhere>/node_modules/npm/bin/npm-cli.js`. Resolving that `.js` and
 * running it with `process.execPath` is the same program by the same code path
 * on every platform, with no interpreter in between and no argument ever
 * reinterpreted.
 *
 * Looked for in the layouts Node itself ships:
 *
 * - beside the executable (`<node>/node_modules/<tool>/…`) — the Windows and
 *   unpacked-tarball layout;
 * - one level up under `lib` (`<prefix>/lib/node_modules/<tool>/…`) — the
 *   POSIX prefix layout;
 * - resolvable from this module, for a tool that is an ordinary dependency;
 * - anywhere on `PATH` that holds the shim, whose own directory carries the
 *   same `node_modules` tree.
 *
 * @param tool - the package name, e.g. `npm`.
 * @param relative - the entry inside that package, e.g. `bin/npm-cli.js`.
 * @param env - the environment whose `PATH` is searched.
 * @returns the absolute path of the entry, or null when it is not there.
 */
export function resolveNodeCli(
  tool: string, relative: string, env: NodeJS.ProcessEnv = process.env,
): string | null {
  const nodeDir = dirname(process.execPath)
  for (const candidate of [
    join(nodeDir, 'node_modules', tool, relative),
    join(dirname(nodeDir), 'node_modules', tool, relative),
    join(dirname(nodeDir), 'lib', 'node_modules', tool, relative),
  ]) {
    if (existsSync(candidate)) return candidate
  }

  try {
    const resolved = createRequire(import.meta.url).resolve(`${tool}/${relative}`)
    if (existsSync(resolved)) return resolved
  } catch {
    // Not a dependency of this package, which is the normal case for npm.
  }

  // A tool installed somewhere else entirely: find its shim on PATH, then the
  // tree beside it. `where`/`which` are not used — that is another process,
  // and on Windows it is another shim.
  const path = env['PATH'] ?? env['Path'] ?? ''
  for (const entry of path.split(delimiter)) {
    if (entry === '') continue
    const shims = process.platform === 'win32'
      ? [join(entry, `${tool}.cmd`), join(entry, `${tool}.exe`), join(entry, tool)]
      : [join(entry, tool)]
    if (!shims.some(shim => existsSync(shim))) continue
    for (const near of [
      join(entry, 'node_modules', tool, relative),
      join(dirname(entry), 'lib', 'node_modules', tool, relative),
    ]) {
      if (existsSync(near)) return near
    }
  }
  return null
}

/** How to invoke a package manager: an executable and the arguments before yours. */
export interface Launcher {
  readonly command: string
  readonly prefix: readonly string[]
  /**
   * `node-entry` is the shell-free path — Node running the tool's own `.js`.
   * `executable` is a real binary, also shell-free. There is no third kind on
   * the ordinary path.
   */
  readonly kind: 'node-entry' | 'executable'
}

/**
 * npm, in the form this product is willing to run it in.
 *
 * Always Node plus `npm-cli.js` where that can be found, which is every
 * ordinary installation. A POSIX `npm` that is a real executable rather than a
 * shim is accepted as a fallback; a Windows `npm.cmd` is not, because that is
 * the shape that cannot be spawned safely and pretending otherwise is how this
 * broke the first time.
 *
 * @returns the launcher, or null when no npm this product can run was found.
 */
export function resolveNpm(env: NodeJS.ProcessEnv = process.env): Launcher | null {
  const entry = resolveNodeCli('npm', join('bin', 'npm-cli.js'), env)
  if (entry !== null) {
    return { command: process.execPath, prefix: [entry], kind: 'node-entry' }
  }
  if (process.platform !== 'win32') {
    return { command: 'npm', prefix: [], kind: 'executable' }
  }
  return null
}

/**
 * pnpm, in the form this product is willing to run it in.
 *
 * Two shapes are in the wild and both are a `.js` behind a shim: a real pnpm
 * install (`pnpm/bin/pnpm.cjs`) and a Corepack shim, which is what a Node
 * distribution with `packageManager` honoured gives you
 * (`corepack/dist/pnpm.js`). Either is run by Node directly, so the Windows
 * path is shell-free here too.
 *
 * The CLI itself never spawns pnpm — the Harness does that, and it is
 * upstream's to do. This exists so the release tooling shares one boundary
 * with the CLI rather than keeping a second, differently-correct copy, which
 * is the drift that let the Windows defect ship.
 *
 * @returns the launcher, or null when no pnpm this product can run was found.
 */
export function resolvePnpm(env: NodeJS.ProcessEnv = process.env): Launcher | null {
  for (const [tool, relative] of [
    ['pnpm', join('bin', 'pnpm.cjs')],
    ['corepack', join('dist', 'pnpm.js')],
  ] as const) {
    const entry = resolveNodeCli(tool, relative, env)
    if (entry !== null) {
      return { command: process.execPath, prefix: [entry], kind: 'node-entry' }
    }
  }
  if (process.platform !== 'win32') {
    return { command: 'pnpm', prefix: [], kind: 'executable' }
  }
  return null
}

/**
 * Refuse an argument a command interpreter could reinterpret.
 *
 * Only reached by {@link launchWindowsShim}. The shell-free path needs none of
 * this, which is the point of preferring it.
 *
 * @throws UnsafeCommandError naming what to do instead.
 */
export function assertSafeShimArgument(argument: string): void {
  if (SAFE_SHIM_ARGUMENT.test(argument)) return
  throw new UnsafeCommandError(
    'an argument contains characters a Windows command interpreter would reinterpret',
    'Run the tool through its Node entry point instead — see resolveNodeCli — or '
    + 'move the path somewhere without shell metacharacters or spaces in it.',
  )
}

/**
 * Run a command to completion, capturing what it said.
 *
 * Resolves rather than rejects on a non-zero exit: an exit code is an answer,
 * and a caller that has to wrap every invocation in try/catch to read one
 * writes worse error messages than one that is handed it.
 *
 * @throws UnsafeCommandError when handed a Windows batch shim. That is a
 * programming error in this repository rather than a runtime condition, and it
 * is raised where it can be fixed rather than returned as a failed run.
 */
export function run(
  command: string, args: readonly string[], options: RunOptions,
): Promise<Ran> {
  if (BATCH_SHIM.test(command)) {
    return Promise.reject(new UnsafeCommandError(
      `refusing to spawn the batch shim ${command} — Node cannot start one without a shell`,
      "Resolve the tool's Node entry point with resolveNodeCli and run it with "
      + 'process.execPath, or use launchWindowsShim if a shim is genuinely required.',
    ))
  }
  return spawnCaptured(command, args, options)
}

/**
 * Run a Windows shim, when there is genuinely no Node entry behind it.
 *
 * Every argument is checked against the safe-argument policy first and the
 * call is refused before a process exists if any could be reinterpreted, so
 * nothing user-controlled can become command syntax. `cmd.exe /d /s /c` with
 * each part quoted is the form that gets quoting right for paths containing
 * spaces — though a path with a space is refused here anyway, because the
 * allowlist is what carries the safety claim rather than the quoting.
 *
 * Prefer {@link resolveNodeCli}. This exists so that the one case which needs
 * a shim is written once, in the open, with its argument policy visible.
 */
export function launchWindowsShim(
  shim: string, args: readonly string[], options: RunOptions,
): Promise<Ran> {
  try {
    assertSafeShimArgument(shim)
    for (const argument of args) assertSafeShimArgument(argument)
  } catch (error) {
    // Narrowed rather than re-thrown as-is: a rejection reason that is not an
    // Error loses its message the moment anything tries to read one.
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  const comspec = process.env['ComSpec'] ?? 'cmd.exe'
  // `cmd /d /s /c "…"`, with the whole command line inside one more pair of
  // quotes: `/s` strips exactly the first and last quote of what follows `/c`,
  // which is how a quoted executable path survives. Without the outer pair,
  // `cmd` reads `"C:\…\deepwatch.cmd"` as the entire command and reports that
  // it is not recognised. `windowsVerbatimArguments` then stops Node adding its
  // own quoting on top, which would break it a second, different way.
  const line = `"${[shim, ...args].map(part => `"${part}"`).join(' ')}"`
  return spawnCaptured(comspec, ['/d', '/s', '/c', line], options, true)
}

/**
 * The one place a child process is created with its output captured.
 *
 * @param verbatim - pass the argument array to Windows exactly as written,
 * which only {@link launchWindowsShim} needs and only because `cmd.exe` has
 * quoting rules of its own that Node's would fight with.
 */
function spawnCaptured(
  command: string, args: readonly string[], options: RunOptions, verbatim = false,
): Promise<Ran> {
  return new Promise(resolve => {
    if (options.signal?.aborted === true) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, failure: 'cancelled' })
      return
    }

    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        // Never a shell. See the module note.
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
      })
    } catch (error) {
      // spawn can throw synchronously — EINVAL for a batch shim is exactly
      // this path — and a throw here must still be an answer, not a crash.
      resolve({
        code: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        failure: 'spawn-failed',
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let spawnFailed = false
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk })

    const timer = setTimeout(() => {
      timedOut = true
      stop(child)
    }, options.timeoutMs)
    timer.unref?.()

    const onAbort = (): void => {
      cancelled = true
      stop(child)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const settle = (code: number | null): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const failure: LaunchFailure | undefined = spawnFailed
        ? 'spawn-failed'
        : cancelled ? 'cancelled' : timedOut ? 'timeout' : undefined
      resolve(failure === undefined
        ? { code, stdout, stderr, timedOut }
        : { code, stdout, stderr, timedOut, failure })
    }
    child.on('error', error => {
      // Asynchronous spawn failure: ENOENT for a missing executable.
      spawnFailed = true
      stderr += error.message
      settle(null)
    })
    child.on('close', code => { settle(code) })
  })
}

/** What a started-and-watched process did before it was stopped. */
export interface Watched {
  /** The first text that matched, or null when nothing did. */
  readonly match: string | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the child exited on its own before matching. */
  readonly code?: number | null
  readonly failure?: LaunchFailure
}

/**
 * Start a long-lived process, wait for it to say something, then stop it.
 *
 * A server is ready when it says so, and asking whether a port is open answers
 * a different question: a port that is not listening *yet* and one that never
 * will look identical from outside, and telling those apart is the whole point
 * of a readiness check. So this reads the child's own output and returns as
 * soon as a line matches — or when it exits, or when the deadline passes, both
 * of which are answers too.
 *
 * The child is always stopped before this resolves. A readiness probe that
 * leaves a server running has started something nobody is going to stop.
 */
export function startAndWaitFor(
  command: string, args: readonly string[], options: RunOptions, pattern: RegExp,
): Promise<Watched> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({
        match: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        failure: 'spawn-failed',
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (result: Watched): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      stop(child)
      resolve(result)
    }

    const look = (): void => {
      const found = pattern.exec(`${stdout}\n${stderr}`)
      if (found !== null) finish({ match: found[0], stdout, stderr })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; look() })
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; look() })

    const timer = setTimeout(() => {
      finish({ match: null, stdout, stderr, failure: 'timeout' })
    }, options.timeoutMs)
    timer.unref?.()

    const onAbort = (): void => {
      finish({ match: null, stdout, stderr, failure: 'cancelled' })
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    child.on('error', error => {
      stderr += error.message
      finish({ match: null, stdout, stderr, failure: 'spawn-failed' })
    })
    // Exiting before it said anything is a failure to start, not a timeout.
    child.on('close', code => { finish({ match: null, stdout, stderr, code }) })
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
  const ran = await run(command, args, { timeoutMs: 15_000 }).catch(() => null)
  if (ran === null || ran.code !== 0) return null
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
