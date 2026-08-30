/**
 * Where DeepWatch keeps things, and what a person may say about it.
 *
 * One prefix for the application's own variables, `DEEPWATCH_*`, because the
 * product they configure is DeepWatch. The one exception is deliberate and
 * documented: `WATCH_CORE_BIN` names where the *Watch Skill* engine is, and it
 * keeps its name because it is a statement about Watch Skill rather than about
 * DeepWatch. Renaming it would have made the boundary between the two products
 * harder to see rather than easier.
 *
 * `DSH_HOME` is DeepSeek Harness's own variable and is passed through
 * unchanged. It is not ours to rename.
 *
 * @module @deepwatch/cli/lib/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The platform's directory for durable per-user application state. */
export function stateRoot(
  env: NodeJS.ProcessEnv = process.env, platform: string = process.platform,
): string {
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']
    return typeof local === 'string' && local !== ''
      ? local
      : join(homedir(), 'AppData', 'Local')
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  const xdg = env['XDG_STATE_HOME']
  return typeof xdg === 'string' && xdg !== ''
    ? xdg
    : join(homedir(), '.local', 'state')
}

/**
 * Everything DeepWatch writes lives under one directory.
 *
 * `DEEPWATCH_HOME` moves all of it, which is what a second profile on one
 * machine needs, and what makes an uninstall a single directory to delete.
 */
export function deepwatchHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DEEPWATCH_HOME']
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return join(stateRoot(env), 'deepwatch')
}

/** The DeepSeek Harness home DeepWatch composes its profile inside. */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DSH_HOME']
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return join(deepwatchHome(env), 'dsh-home')
}

/** The profile name DeepWatch composes into, overridable for a second one. */
export function profileName(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DEEPWATCH_PROFILE']
  return typeof explicit === 'string' && explicit !== '' ? explicit : 'deepwatch'
}

/**
 * Where the Watch Skill engine is, when it is not on PATH.
 *
 * `WATCH_CORE_BIN` keeps its prefix on purpose: it names a Watch Skill
 * executable, not a DeepWatch setting. See the module note.
 */
export function watchCoreBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env['WATCH_CORE_BIN']
  return typeof explicit === 'string' && explicit !== '' ? explicit : null
}
