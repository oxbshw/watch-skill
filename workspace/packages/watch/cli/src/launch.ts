/**
 * Running DeepWatch, in the browser or as the desktop app.
 *
 * Both commands are supervisors and nothing more. They start a process that
 * already exists — the Harness Web host, or the packaged Electron shell — hand
 * it the profile DeepWatch composed, and forward the signals a person sends
 * so Ctrl-C stops the thing they started rather than orphaning it.
 *
 * Neither reaches a provider. `web` binds loopback unless a host is named,
 * because a workspace that reads a person's evidence should not become
 * reachable from their network because a default said so.
 *
 * @module @deepwatch/cli/launch
 */

import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { Invocation } from './args.js'
import { ensureHarness } from './lib/harness.js'
import { supervise } from './lib/exec.js'
import { dshHome, profileName } from './lib/paths.js'

/**
 * The environment variable every layer reads the canonical workspace from.
 *
 * Mirrors `WORKSPACE_ENV` in `@deepwatch/dsh-contracts/workspace`. Restated
 * rather than imported because the CLI's dependency closure is part of what
 * ships: this module needs one string, not a package edge, and a test holds
 * the pair together.
 */
export const WORKSPACE_ENV = 'DEEPWATCH_WORKSPACE'

/** Refuse to start something that was never composed, and say what to run. */
function profileMissing(env: NodeJS.ProcessEnv): string | null {
  const profile = profileName(env)
  const manifest = join(dshHome(env), 'profiles', profile, 'package.json')
  return existsSync(manifest) ? null : profile
}

/** A canonical workspace root, or the reason there isn't one. */
export type WorkspaceChoice =
  | {
    readonly ok: true
    readonly root: string
    readonly origin: 'flag' | 'environment' | 'invocation'
  }
  | { readonly ok: false, readonly detail: string }

/**
 * Decide the one directory this run works in.
 *
 * The Harness derives its session workspace from the directory the host
 * process is invoked in, Watch Core inherits the cwd it is spawned with, and
 * the verifier falls back to its own. Left alone those are three answers, and
 * a real owner session wrote `owner-test/totals.json` into one of them and
 * verified against another. So the workspace is decided here, once, and every
 * layer below is *told* rather than left to derive.
 *
 * `realpathSync.native` is what makes the answer canonical rather than merely
 * absolute: a junction on Windows and a symlink elsewhere are two spellings of
 * one directory, and a containment check comparing an unresolved spelling
 * against a resolved one reports a file outside a workspace it is plainly
 * inside. Resolving once here means every consumer compares the same string.
 *
 * A missing directory is refused rather than created. Starting a workspace by
 * inventing the directory it names is how a typo becomes an empty workspace
 * that looks like it worked.
 */
export function chooseWorkspace(
  invocation: Pick<Invocation, 'workspace'>, env: NodeJS.ProcessEnv, cwd: string,
): WorkspaceChoice {
  const named = invocation.workspace
  const inherited = env[WORKSPACE_ENV]
  const [candidate, origin] = named !== null && named !== ''
    ? [named, 'flag' as const]
    : typeof inherited === 'string' && inherited !== ''
      ? [inherited, 'environment' as const]
      : [cwd, 'invocation' as const]

  // An inherited value is the one place a relative path is a configuration
  // error rather than a convenience: it was written by whoever composed the
  // environment, and resolving it against this process's cwd would reintroduce
  // the ambiguity this function exists to remove.
  if (origin === 'environment' && !isAbsolute(candidate)) {
    return {
      ok: false,
      detail: `${WORKSPACE_ENV} is set to "${candidate}", which is not an absolute path`,
    }
  }

  const absolute = resolve(cwd, candidate)
  if (!existsSync(absolute)) return { ok: false, detail: `there is no directory at ${absolute}` }
  if (!statSync(absolute).isDirectory()) {
    return { ok: false, detail: `${absolute} is not a directory` }
  }
  return { ok: true, root: realpathSync.native(absolute), origin }
}

/** `deepwatch: …` with the fix under it, the way the rest of this CLI reports. */
export function workspaceRefusal(detail: string): string {
  return `deepwatch: ${detail}.\n`
    + '           --workspace names the one directory DeepWatch works in: the\n'
    + "           agent's files, the shell, Watch containment and the verifier\n"
    + '           all resolve relative paths there. Pass a directory that\n'
    + '           exists, or omit the flag to use the current one.\n'
}

/** `deepwatch web`. */
export async function runWeb(invocation: Invocation): Promise<number> {
  const env = { ...process.env }
  if (invocation.profile !== null) env['DEEPWATCH_PROFILE'] = invocation.profile

  // The invocation is checked before the machine is. A person who mistyped
  // `--workspace` and has no profile yet should be told about the typo they can
  // fix now, rather than sent to run `setup` and told about it afterwards.
  //
  // Fail closed on purpose: a run whose workspace cannot be established is the
  // run that wrote a file nobody could verify. Refusing here costs a restart;
  // not refusing cost an owner evaluation.
  const workspace = chooseWorkspace(invocation, env, process.cwd())
  if (!workspace.ok) {
    process.stderr.write(workspaceRefusal(workspace.detail))
    return 2
  }

  const missing = profileMissing(env)
  if (missing !== null) {
    process.stderr.write(
      `deepwatch: there is no profile named "${missing}" to run.\n`
      + '           Run `deepwatch setup` first.\n')
    return 2
  }

  // Port 0 by default: the OS picks one, so this never collides with a server
  // the person already has open, and the Harness prints the URL it chose.
  const port = invocation.port ?? '0'
  const host = env['DEEPWATCH_HOST'] ?? '127.0.0.1'

  // Detection only, which is all this module can do now: starting the app is
  // never a reason to fetch anything, `setup` is the one command that builds a
  // runtime, and there is no longer a flag here to get that wrong with.
  const provisioned = await ensureHarness({ env })
  const dsh = provisioned.harness
  if (dsh === null) {
    process.stderr.write(
      `deepwatch: ${provisioned.detail}.\n`
      + '           Run `deepwatch setup` first.\n')
    return 1
  }

  process.stdout.write(`Starting DeepWatch on ${host}. Press Ctrl-C to stop.\n`)
  // The Harness takes its session workspace from the directory it is invoked
  // in, so `cwd` here is not a detail of process spawning — it *is* the
  // workspace the agent's tools will resolve against. Passing the same value
  // in the environment is what lets Watch Core, containment and the verifier
  // agree with it instead of each deriving a root of their own.
  return supervise(
    dsh.command,
    [...dsh.prefix, '--profile', profileName(env), '--no-open', '--host', host, '--port', port],
    {
      cwd: workspace.root,
      env: { ...env, DSH_HOME: dshHome(env), [WORKSPACE_ENV]: workspace.root },
    },
  )
}

/**
 * `deepwatch desktop`.
 *
 * The desktop application is distributed as a signed installer per platform
 * rather than through npm, so this does not download one. It launches an
 * installed DeepWatch if `DEEPWATCH_DESKTOP_BIN` names it, and otherwise says
 * where to get it — which is the honest answer for a command that cannot
 * fabricate an application.
 */
export function runDesktop(invocation: Invocation): Promise<number> {
  const binary = process.env['DEEPWATCH_DESKTOP_BIN']
  if (typeof binary !== 'string' || binary === '') {
    process.stderr.write(
      'deepwatch: the DeepWatch desktop app is installed from a platform installer,\n'
      + '           not from npm, so there is nothing here to start.\n\n'
      + '           Install it from the project releases, then run it from your\n'
      + '           applications list — or set DEEPWATCH_DESKTOP_BIN to its\n'
      + '           executable and run this again.\n\n'
      + '           `deepwatch web` runs the same workspace in your browser now.\n')
    return Promise.resolve(2)
  }
  // The desktop shell hosts the same Harness, so it needs the same one root.
  // A workspace established for `web` and not for `desktop` would be the same
  // defect with a different entry point.
  const workspace = chooseWorkspace(invocation, process.env, process.cwd())
  if (!workspace.ok) {
    process.stderr.write(workspaceRefusal(workspace.detail))
    return Promise.resolve(2)
  }

  process.stdout.write('Starting the DeepWatch desktop app. Press Ctrl-C to stop.\n')
  return supervise(binary, [], {
    cwd: workspace.root,
    env: { ...process.env, DSH_HOME: dshHome(), [WORKSPACE_ENV]: workspace.root },
  })
}
