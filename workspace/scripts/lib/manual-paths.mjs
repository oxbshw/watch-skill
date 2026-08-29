/**
 * Where the manual-QA profile, its fixtures, logs and captures live.
 *
 * These paths used to default to `G:/watch-manual`, which is a drive on one
 * maintainer's machine. `verify-portability.mjs` allowed it: scripts never
 * ship, and the rule it holds them to is only that a default be overridable.
 * That reasoning is sound and the default was still wrong. Anyone else running
 * `npm run smoke:boot` got a failure naming a drive they do not have, and the
 * fix -- set WATCH_MANUAL_HOME -- was discoverable only by reading the script.
 *
 * The default is derived from the platform's own convention instead, so the
 * scripts work on a clean checkout and the environment variables stay as the
 * override they always were.
 *
 * @module scripts/lib/manual-paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The directory the platform intends for durable per-user application state. */
export function stateRoot(env = process.env, platform = process.platform) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    return typeof local === 'string' && local !== ''
      ? local
      : join(homedir(), 'AppData', 'Local')
  }
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  const xdg = env.XDG_STATE_HOME
  return typeof xdg === 'string' && xdg !== ''
    ? xdg
    : join(homedir(), '.local', 'state')
}

/**
 * The root every manual-QA artefact hangs off.
 *
 * `WATCH_MANUAL_ROOT` moves all of them at once, which is what a second
 * concurrent QA run needs; the per-artefact variables below still win over it.
 */
export function manualRoot(env = process.env, platform = process.platform) {
  const explicit = env.WATCH_MANUAL_ROOT
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return join(stateRoot(env, platform), 'watch-manual')
}

/** Read `name` from the environment, falling back to `<manual root>/<...parts>`. */
export function manualPath(name, parts, env = process.env, platform = process.platform) {
  const explicit = env[name]
  if (typeof explicit === 'string' && explicit !== '') return explicit
  return join(manualRoot(env, platform), ...parts)
}
