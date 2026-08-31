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

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { Invocation } from './args.js'
import { ensureHarness } from './lib/harness.js'
import { supervise } from './lib/exec.js'
import { dshHome, profileName } from './lib/paths.js'

/** Refuse to start something that was never composed, and say what to run. */
function profileMissing(env: NodeJS.ProcessEnv): string | null {
  const profile = profileName(env)
  const manifest = join(dshHome(env), 'profiles', profile, 'package.json')
  return existsSync(manifest) ? null : profile
}

/** `deepwatch web`. */
export async function runWeb(invocation: Invocation): Promise<number> {
  const env = { ...process.env }
  if (invocation.profile !== null) env['DEEPWATCH_PROFILE'] = invocation.profile

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
  return supervise(
    dsh.command,
    [...dsh.prefix, '--profile', profileName(env), '--no-open', '--host', host, '--port', port],
    { env: { ...env, DSH_HOME: dshHome(env) } },
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
  void invocation
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
  process.stdout.write('Starting the DeepWatch desktop app. Press Ctrl-C to stop.\n')
  return supervise(binary, [], { env: { ...process.env, DSH_HOME: dshHome() } })
}
