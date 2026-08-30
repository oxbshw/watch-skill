/**
 * The DeepSeek Harness DeepWatch runs on: finding it, and installing it once.
 *
 * It is not a dependency of this package, and that is deliberate. Declaring it
 * would pull its whole transitive tree into everything `@deepwatch/cli`
 * publishes — including native image and sandbox addons whose licences this
 * distribution has not reviewed, which the SBOM gate refuses on sight. A
 * licence surface is not a thing to acquire by accident in a dependency line.
 *
 * So it is installed on the first `deepwatch setup`, into DeepWatch's own home,
 * at the exact version this distribution was measured against. That is what
 * `scripts/lib/dsh-cli.mjs` already does for the repository's own gates, for
 * the same reason: parity, the slot inventory and every composition check were
 * measured against one version, and running a newer one would be running a
 * product nobody tested.
 *
 * Resolution order, and each step exists because somebody will be in that
 * state: an explicit `DEEPWATCH_DSH_BIN`, then the copy setup installed, then
 * nothing — reported as nothing, never guessed at.
 *
 * @module @deepwatch/cli/lib/harness
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { run } from './exec.js'
import { deepwatchHome } from './paths.js'
import { HARNESS_VERSION } from '../version.js'

/** How to invoke the Harness: an executable and the arguments that precede yours. */
export interface Harness {
  readonly command: string
  readonly prefix: readonly string[]
  /** Where it came from, so a report can say. */
  readonly source: 'installed' | 'override'
}

/** Where `setup` puts the Harness it installed. */
export function harnessDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(deepwatchHome(env), 'harness')
}

/** The Harness entry point inside that directory, whether or not it is there. */
function installedEntry(env: NodeJS.ProcessEnv): string {
  return join(harnessDir(env), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/**
 * The Harness, or null when there is not one yet.
 *
 * Null rather than a throw: the doctor's whole job is to report a missing
 * dependency as a finding, and it cannot do that if looking for one crashes.
 */
export function harness(env: NodeJS.ProcessEnv = process.env): Harness | null {
  const override = env['DEEPWATCH_DSH_BIN']
  if (typeof override === 'string' && override !== '') {
    return { command: override, prefix: [], source: 'override' }
  }
  const entry = installedEntry(env)
  return existsSync(entry)
    // Run it with the Node running us, so the Harness cannot end up on a
    // different runtime from the one this CLI declares it supports.
    ? { command: process.execPath, prefix: [entry], source: 'installed' }
    : null
}

/** How long the Harness install may take before it is a hang rather than work. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

/** What `ensureHarness` found or did. */
export interface Provisioned {
  readonly harness: Harness | null
  /** True only where this call performed the install. */
  readonly installed: boolean
  /** A version, a source, or why it could not be installed. Never a stack. */
  readonly detail: string
}

/**
 * Install the pinned Harness into DeepWatch's home, if it is not already there.
 *
 * Idempotent by inspection rather than by reinstalling: an install that ran on
 * every invocation would turn `deepwatch setup` from something safe to repeat
 * into several minutes and a network round trip.
 *
 * It writes a manifest of its own first so the installer treats that directory
 * as a project rather than walking up and installing into whatever is above it
 * — which, run from inside a checkout, is somebody's repository.
 */
export async function ensureHarness(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Provisioned> {
  const found = harness(env)
  if (found !== null) return { harness: found, installed: false, detail: found.source }

  const dir = harnessDir(env)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'deepwatch-harness', private: true, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  )

  const ran = await run(
    npmCommand(),
    ['install', '--no-audit', '--no-fund', `@deepseek-ai/dsh@${HARNESS_VERSION}`],
    { cwd: dir, env, timeoutMs: INSTALL_TIMEOUT_MS },
  )
  if (ran.code !== 0) {
    return {
      harness: null,
      installed: false,
      detail: ran.timedOut
        ? 'the install did not finish in time'
        : firstLine(ran.stderr === '' ? ran.stdout : ran.stderr),
    }
  }
  return { harness: harness(env), installed: true, detail: HARNESS_VERSION }
}

/**
 * npm, by the name this platform knows it as.
 *
 * `.cmd` on Windows because `spawn` without a shell will not find `npm`
 * otherwise, and this module does not build shell strings to work around that.
 */
function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** The first line of a child's output, for a message a person will read. */
function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line !== '') ?? 'no output'
}
